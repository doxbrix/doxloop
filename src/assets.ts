import { statSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join, relative, resolve, sep } from 'node:path'
import { applyDirectEdit } from './direct-edit.js'
import { DoxloopError } from './errors.js'
import { assertInside, listFiles, pathExists, resolveContainedDirectory } from './fs.js'
import type { GeneratorAdapter } from './generator-api.js'
import { loadGeneratorAdapter } from './generators.js'
import { loadPages, loadProject, relativePath, ROOT_CONTENT_IGNORED_DIRECTORIES } from './project.js'
import { runWorkspace } from './sync-runs.js'
import type { DoxloopProject } from './types.js'

/**
 * Images and downloadable files that documentation pages reference. Uploads
 * land in the generator's conventional asset directory and are referenced by
 * a public path pages can use directly; the library lists every asset with the
 * pages that embed it so alt text can be edited and unused files deleted.
 */
export const ASSET_IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.avif', '.ico'])
export const ASSET_FILE_EXTENSIONS = new Set(['.pdf', '.mp4', '.webm', '.mov', '.zip'])
export const MAX_ASSET_BYTES = 10 * 1024 * 1024

const IGNORED_DIRECTORIES = new Set([...ROOT_CONTENT_IGNORED_DIRECTORIES, 'node_modules', '.doxloop', '.git', 'build', 'dist', 'site', '_site', '.vitepress', '.astro', '.next', 'venv', '.venv'])

const DEFAULT_ASSET_LOCATIONS: Record<string, (contentDir: string) => { directory: string; publicPrefix: string }> = {
  doxbrix: (contentDir) => ({ directory: portable(join(contentDir, 'assets')), publicPrefix: '/assets' }),
  docusaurus: () => ({ directory: 'static/img', publicPrefix: '/img' }),
  mkdocs: (contentDir) => ({ directory: portable(join(contentDir, 'assets')), publicPrefix: '/assets' }),
  sphinx: (contentDir) => ({ directory: portable(join(contentDir, '_static')), publicPrefix: '/_static' }),
  hugo: () => ({ directory: 'static/images', publicPrefix: '/images' }),
  vitepress: (contentDir) => ({ directory: portable(join(contentDir, 'public')), publicPrefix: '/' }),
  starlight: () => ({ directory: 'public', publicPrefix: '/' }),
  nextra: () => ({ directory: 'public', publicPrefix: '/' }),
  markdoc: () => ({ directory: 'public', publicPrefix: '/' }),
  jekyll: () => ({ directory: 'assets/images', publicPrefix: '/assets/images' }),
  static: () => ({ directory: 'assets', publicPrefix: '/assets' }),
}

export interface AssetReference {
  page: string
  alt: string
}

export interface AssetEntry {
  /** Project-relative path. */
  path: string
  name: string
  /** The address a page uses to embed the asset. */
  publicPath: string
  kind: 'image' | 'file'
  bytes: number
  modifiedAt: string
  references: AssetReference[]
}

export interface AssetLibrary {
  /** Project-relative directory uploads go to. */
  directory: string
  publicPrefix: string
  maxBytes: number
  assets: AssetEntry[]
}

export function assetLocation(project: DoxloopProject, adapter?: GeneratorAdapter): { directory: string; publicPrefix: string } {
  if (adapter?.project.assets) return adapter.project.assets
  const defaults = DEFAULT_ASSET_LOCATIONS[project.generator] ?? DEFAULT_ASSET_LOCATIONS.doxbrix!
  return defaults(project.contentDir)
}

export async function readAssetLibrary(root: string): Promise<AssetLibrary> {
  const project = await loadProject(root)
  const adapter = project.generator === 'doxbrix' ? undefined : await loadGeneratorAdapter(root, project)
  const location = assetLocation(project, adapter)
  return { ...location, maxBytes: MAX_ASSET_BYTES, assets: await listAssets(root, project, adapter) }
}

export async function listAssets(root: string, loaded?: DoxloopProject, loadedAdapter?: GeneratorAdapter): Promise<AssetEntry[]> {
  const project = loaded ?? (await loadProject(root))
  const adapter = loadedAdapter ?? (project.generator === 'doxbrix' ? undefined : await loadGeneratorAdapter(root, project))
  const contentRoot = await contentDirectory(root, project)
  const location = assetLocation(project, adapter)
  const extensions = new Set([...ASSET_IMAGE_EXTENSIONS, ...ASSET_FILE_EXTENSIONS])
  const roots = new Set<string>([contentRoot])
  const assetRoot = resolve(root, location.directory)
  if (containedBy(root, assetRoot) && !containedBy(contentRoot, assetRoot) && (await pathExists(assetRoot))) roots.add(assetRoot)
  const files = new Set<string>()
  for (const directory of roots) {
    if (!(await pathExists(directory))) continue
    for (const file of await listFiles(directory, extensions, { ignoredDirectories: IGNORED_DIRECTORIES })) files.add(file)
  }
  const references = await collectReferences(root, project, adapter, contentRoot)
  const entries: AssetEntry[] = []
  for (const absolute of [...files].sort()) {
    const path = relativePath(root, absolute)
    const info = await stat(absolute)
    entries.push({
      path,
      name: basename(absolute),
      publicPath: publicPathFor(path, contentRoot, root, location),
      kind: ASSET_IMAGE_EXTENSIONS.has(extname(absolute).toLowerCase()) ? 'image' : 'file',
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
      references: references.get(path) ?? [],
    })
  }
  return entries
}

export interface AssetUpload {
  name: string
  /** Base64 file content, with or without a data-URL prefix. */
  data: string
  /** Project-relative directory inside the content or asset folder; defaults to the generator's asset directory. */
  directory?: string
  /** Overwrite an existing file with the same name. */
  replace?: boolean
}

export async function uploadAsset(root: string, raw: unknown): Promise<AssetEntry> {
  const input = parseUpload(raw)
  const project = await loadProject(root)
  const adapter = project.generator === 'doxbrix' ? undefined : await loadGeneratorAdapter(root, project)
  const contentRoot = await contentDirectory(root, project)
  const location = assetLocation(project, adapter)
  const name = safeAssetName(input.name)
  const bytes = decodeUpload(input.data, name)
  const directory = input.directory ? assetDirectory(root, contentRoot, location, input.directory) : resolve(root, location.directory)
  const target = assertInside(root, join(directory, name))
  const path = relativePath(root, target)
  if ((await pathExists(target)) && !input.replace) {
    throw new DoxloopError(`"${path}" already exists. Choose another name or replace the existing file.`)
  }
  await applyDirectEdit(root, {
    kind: 'asset',
    requestText: `${input.replace ? 'Replaced' : 'Uploaded'} ${path}`,
    files: [path],
    apply: async () => {
      await mkdir(directory, { recursive: true })
      await writeFile(target, bytes)
    },
  })
  const entry = (await listAssets(root, project, adapter)).find((asset) => asset.path === path)
  if (!entry) throw new DoxloopError(`"${path}" was written but is not listed as an asset.`)
  return entry
}

export async function deleteAsset(root: string, raw: unknown): Promise<{ removed: string }> {
  const body = record(raw)
  const path = normalizedPath(body.path)
  const project = await loadProject(root)
  const adapter = project.generator === 'doxbrix' ? undefined : await loadGeneratorAdapter(root, project)
  const asset = (await listAssets(root, project, adapter)).find((entry) => entry.path === path)
  if (!asset) throw new DoxloopError(`"${path}" is not an asset in this project.`, 2)
  if (asset.references.length > 0) {
    // Validation treats a missing link target as an error, so a forced delete
    // would only be rolled back; the pages have to drop the image first.
    const pages = [...new Set(asset.references.map((reference) => reference.page))]
    throw new DoxloopError(`"${asset.name}" is still used by ${pages.join(', ')}. Ask the agent to remove or replace the image on ${pages.length === 1 ? 'that page' : 'those pages'} first.`)
  }
  await applyDirectEdit(root, {
    kind: 'asset',
    requestText: `Deleted ${path}`,
    files: [path],
    apply: () => rm(join(root, path), { force: true }),
  })
  return { removed: path }
}

/** Rewrite the alt text of every reference to one asset across the pages that embed it. */
export async function updateAssetAlt(root: string, raw: unknown): Promise<AssetEntry> {
  const body = record(raw)
  const path = normalizedPath(body.path)
  if (typeof body.alt !== 'string') throw new DoxloopError('Alt text must be a string.', 2)
  const alt = body.alt.trim().replace(/\s+/g, ' ')
  if (alt.length > 300) throw new DoxloopError('Alt text must be 300 characters or fewer.', 2)
  if (/[[\]()<>"]/.test(alt)) throw new DoxloopError('Alt text cannot contain brackets, parentheses, angle brackets, or quotes.', 2)
  const project = await loadProject(root)
  const adapter = project.generator === 'doxbrix' ? undefined : await loadGeneratorAdapter(root, project)
  const contentRoot = await contentDirectory(root, project)
  const asset = (await listAssets(root, project, adapter)).find((entry) => entry.path === path)
  if (!asset) throw new DoxloopError(`"${path}" is not an asset in this project.`, 2)
  if (asset.references.length === 0) throw new DoxloopError(`"${asset.name}" is not embedded in any page, so there is no alt text to change.`, 2)
  const pages = [...new Set(asset.references.map((reference) => reference.page))]
  const rewrites = new Map<string, string>()
  for (const page of pages) {
    const source = await readFile(join(root, page), 'utf8')
    const next = rewriteAlt(source, alt, (reference) => resolveReference(root, contentRoot, page, reference, adapter) === path)
    if (next !== source) rewrites.set(page, next)
  }
  await applyDirectEdit(root, {
    kind: 'asset',
    requestText: `Set alt text for ${asset.name}`,
    files: [...rewrites.keys()],
    pagesChanged: rewrites.size,
    apply: async () => {
      for (const [page, content] of rewrites) await writeFile(join(root, page), content, 'utf8')
    },
  })
  const updated = (await listAssets(root, project, adapter)).find((entry) => entry.path === path)
  return updated ?? asset
}

/** Replace one screenshot in a proposal workspace before the proposal is accepted. */
export async function replaceRunCapture(root: string, raw: unknown): Promise<{ run: string; path: string; bytes: number }> {
  const body = record(raw)
  const runId = typeof body.run === 'string' ? body.run.trim() : ''
  if (!/^[a-z0-9-]+$/.test(runId)) throw new DoxloopError('A capture replacement needs a run id.', 2)
  const file = normalizedPath(body.path)
  if (extname(file).toLowerCase() !== '.png') throw new DoxloopError('Only PNG screenshots can be replaced.', 2)
  const workspace = runWorkspace(root, runId)
  const target = assertInside(workspace, resolve(workspace, file))
  if (!(await pathExists(target))) throw new DoxloopError('That capture no longer exists.', 2)
  const bytes = decodeUpload(typeof body.data === 'string' ? body.data : '', basename(file))
  await writeFile(target, bytes)
  return { run: runId, path: file, bytes: bytes.length }
}

/**
 * Markdown image references and HTML `img`/`source` tags with their alt text.
 * Exposed so the page service and the library agree on what counts as a
 * reference.
 */
export function pageAssetReferences(raw: string): Array<{ reference: string; alt: string }> {
  const output: Array<{ reference: string; alt: string }> = []
  for (const match of raw.matchAll(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    output.push({ reference: match[2]!.trim(), alt: match[1]!.trim() })
  }
  for (const match of raw.matchAll(/<(?:img|source|Image|Frame)\b([^>]*)>/g)) {
    const attributes = match[1]!
    const src = /\bsrc=["']([^"']+)["']/.exec(attributes)?.[1]?.trim()
    if (!src) continue
    output.push({ reference: src, alt: /\balt=["']([^"']*)["']/.exec(attributes)?.[1]?.trim() ?? '' })
  }
  return output.filter((entry) => !/^(?:https?:|data:|#|mailto:)/i.test(entry.reference))
}

function rewriteAlt(source: string, alt: string, matches: (reference: string) => boolean): string {
  let output = source.replace(/!\[([^\]]*)\]\(([^)\s]+)((?:\s+[^)]*)?)\)/g, (whole, _old: string, reference: string, rest: string) => (
    matches(reference.trim()) ? `![${alt}](${reference}${rest})` : whole
  ))
  output = output.replace(/<(img|source|Image|Frame)\b([^>]*)>/g, (whole, tag: string, attributes: string) => {
    const src = /\bsrc=["']([^"']+)["']/.exec(attributes)?.[1]?.trim()
    if (!src || !matches(src)) return whole
    const escaped = alt.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    if (/\balt=["'][^"']*["']/.test(attributes)) return `<${tag}${attributes.replace(/\balt=["'][^"']*["']/, `alt="${escaped}"`)}>`
    const selfClosing = /\/\s*$/.test(attributes)
    const body = selfClosing ? attributes.replace(/\s*\/\s*$/, '') : attributes.replace(/\s+$/, '')
    return `<${tag}${body} alt="${escaped}"${selfClosing ? ' /' : ''}>`
  })
  return output
}

async function collectReferences(
  root: string,
  project: DoxloopProject,
  adapter: GeneratorAdapter | undefined,
  contentRoot: string,
): Promise<Map<string, AssetReference[]>> {
  const references = new Map<string, AssetReference[]>()
  let pages: string[] = []
  try { pages = await loadPages(root, project) } catch { return references }
  for (const absolute of pages) {
    const page = relativePath(root, absolute)
    const raw = await readFile(absolute, 'utf8')
    for (const { reference, alt } of pageAssetReferences(raw)) {
      const resolved = resolveReference(root, contentRoot, page, reference, adapter)
      if (!resolved) continue
      const list = references.get(resolved) ?? []
      list.push({ page, alt })
      references.set(resolved, list)
    }
  }
  return references
}

function resolveReference(
  root: string,
  contentRoot: string,
  page: string,
  reference: string,
  adapter: GeneratorAdapter | undefined,
): string | undefined {
  const clean = reference.split(/[?#]/)[0]!
  if (!clean) return undefined
  const candidates = [
    adapter?.resolveLocalAsset?.({ root, contentRoot, pagePath: join(root, page), reference: clean }),
    clean.startsWith('/') ? resolve(contentRoot, clean.slice(1)) : resolve(join(root, page, '..'), clean),
    clean.startsWith('/') ? resolve(root, clean.slice(1)) : undefined,
    clean.startsWith('/') ? resolve(root, 'static', clean.slice(1)) : undefined,
    clean.startsWith('/') ? resolve(root, 'public', clean.slice(1)) : undefined,
  ].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    if (!containedBy(root, candidate) || !isFile(candidate)) continue
    const rel = relativePath(root, candidate)
    if (rel) return rel
  }
  return undefined
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile()
  } catch {
    return false
  }
}

function publicPathFor(path: string, contentRoot: string, root: string, location: { directory: string; publicPrefix: string }): string {
  const absolute = resolve(root, path)
  const assetRoot = resolve(root, location.directory)
  if (containedBy(assetRoot, absolute)) {
    const rel = portable(relative(assetRoot, absolute))
    return `${location.publicPrefix.replace(/\/$/, '')}/${rel}`.replace(/\/{2,}/g, '/')
  }
  if (containedBy(contentRoot, absolute)) return `/${portable(relative(contentRoot, absolute))}`
  return `/${path}`
}

function assetDirectory(root: string, contentRoot: string, location: { directory: string }, requested: string): string {
  const candidate = assertInside(root, resolve(root, requested))
  const assetRoot = resolve(root, location.directory)
  if (!containedBy(contentRoot, candidate) && !containedBy(assetRoot, candidate)) {
    throw new DoxloopError(`Uploads must stay inside ${location.directory} or the documentation content directory.`, 2)
  }
  if (candidate.split(sep).some((part) => IGNORED_DIRECTORIES.has(part))) throw new DoxloopError('That directory is not part of the documentation.', 2)
  return candidate
}

function parseUpload(raw: unknown): AssetUpload {
  const body = record(raw)
  if (typeof body.name !== 'string' || !body.name.trim()) throw new DoxloopError('An upload needs a file name.', 2)
  if (typeof body.data !== 'string' || !body.data) throw new DoxloopError('An upload needs file content.', 2)
  return {
    name: body.name,
    data: body.data,
    ...(typeof body.directory === 'string' && body.directory.trim() ? { directory: body.directory.trim() } : {}),
    replace: body.replace === true,
  }
}

export function safeAssetName(raw: string): string {
  const name = basename(raw.trim()).replace(/\s+/g, '-').replace(/[^A-Za-z0-9._-]/g, '').replace(/^\.+/, '')
  const extension = extname(name).toLowerCase()
  if (!name || name === extension) throw new DoxloopError('File names may use letters, numbers, dots, hyphens, and underscores.', 2)
  if (!ASSET_IMAGE_EXTENSIONS.has(extension) && !ASSET_FILE_EXTENSIONS.has(extension)) {
    throw new DoxloopError(`"${extension || 'files without an extension'}" is not an accepted asset type. Upload PNG, JPEG, GIF, WebP, SVG, AVIF, ICO, PDF, MP4, WebM, MOV, or ZIP files.`, 2)
  }
  if (name.length > 120) throw new DoxloopError('File names must be 120 characters or fewer.', 2)
  return name
}

export function decodeUpload(data: string, name: string): Buffer {
  const encoded = data.replace(/^data:[^;]+;base64,/, '').replace(/\s+/g, '')
  if (!encoded || !/^[A-Za-z0-9+/]+=*$/.test(encoded)) throw new DoxloopError('File content must be base64 encoded.', 2)
  if ((encoded.length * 3) / 4 > MAX_ASSET_BYTES + 4) throw new DoxloopError(`Files must be ${Math.round(MAX_ASSET_BYTES / (1024 * 1024))} MB or smaller.`, 2)
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length === 0) throw new DoxloopError('The uploaded file is empty.', 2)
  if (bytes.length > MAX_ASSET_BYTES) throw new DoxloopError(`Files must be ${Math.round(MAX_ASSET_BYTES / (1024 * 1024))} MB or smaller.`, 2)
  assertContentMatchesExtension(bytes, extname(name).toLowerCase())
  return bytes
}

function assertContentMatchesExtension(bytes: Buffer, extension: string): void {
  const head = bytes.subarray(0, 16)
  const startsWith = (...signature: number[]) => signature.every((byte, index) => head[index] === byte)
  const text = bytes.subarray(0, 4096).toString('utf8')
  const ok = (() => {
    switch (extension) {
      case '.png': return startsWith(0x89, 0x50, 0x4e, 0x47)
      case '.jpg':
      case '.jpeg': return startsWith(0xff, 0xd8, 0xff)
      case '.gif': return startsWith(0x47, 0x49, 0x46, 0x38)
      case '.webp': return startsWith(0x52, 0x49, 0x46, 0x46) && head.subarray(8, 12).toString('ascii') === 'WEBP'
      case '.avif': return head.subarray(4, 8).toString('ascii') === 'ftyp'
      case '.ico': return startsWith(0x00, 0x00, 0x01, 0x00)
      case '.pdf': return startsWith(0x25, 0x50, 0x44, 0x46)
      case '.zip': return startsWith(0x50, 0x4b)
      case '.mp4':
      case '.mov': return head.subarray(4, 8).toString('ascii') === 'ftyp'
      case '.webm': return startsWith(0x1a, 0x45, 0xdf, 0xa3)
      case '.svg': return /<svg[\s>]/i.test(text) && !/<script[\s>]|\bon[a-z]+\s*=|javascript:/i.test(bytes.toString('utf8'))
      default: return false
    }
  })()
  if (!ok) {
    throw new DoxloopError(extension === '.svg'
      ? 'SVG files must contain an <svg> element and no scripts or event handlers.'
      : `The file content does not look like a ${extension.slice(1).toUpperCase()} file.`, 2)
  }
}

function normalizedPath(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new DoxloopError('An asset request needs a project-relative path.', 2)
  const path = portable(value.trim()).replace(/^\.?\//, '')
  if (!path || path.split('/').some((part) => part === '..' || part === '')) throw new DoxloopError('Asset paths cannot leave the project.', 2)
  return path
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

async function contentDirectory(root: string, project: DoxloopProject): Promise<string> {
  return resolveContainedDirectory(root, project.contentDir, 'Documentation content directory', {
    allowRoot: project.generator === 'doxbrix',
  })
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith('/'))
}

function portable(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
