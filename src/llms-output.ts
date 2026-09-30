/**
 * AI-readable copies of a documentation site: `llms.txt` (https://llmstxt.org),
 * `llms-full.txt`, and one clean Markdown file per page next to its HTML
 * route. Assistants read these instead of scraping rendered pages, so the
 * site becomes the way they learn the product.
 */

import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { collectionForPath, documentationCollections } from './documentation-collections.js'
import { DoxloopError } from './errors.js'
import { assertInside, pathExists, resolveContainedDirectory } from './fs.js'
import { loadGeneratorAdapter } from './generators.js'
import { flattenMarkdown } from './markdown-flatten.js'
import { readNavigation, type NavigationNode } from './navigation.js'
import { resolvePageRoute } from './page-routes.js'
import { loadPages, loadProject, loadSiteConfig, pageId, readPage, relativePath } from './project.js'
import type { DoxloopProject } from './types.js'

/** llms-full.txt stays small enough for an assistant to fetch in one request. */
export const LLMS_FULL_MAX_BYTES = 8 * 1024 * 1024
/** One oversized reference page must not crowd every other page out of llms-full.txt. */
export const LLMS_FULL_PAGE_MAX_BYTES = 40 * 1024

export interface LlmsOptions {
  /** Public origin (and path) of the published site; links become absolute. */
  siteUrl?: string | undefined
  /** Origin-relative mount point such as `/repository`, used when no site URL is known. */
  basePath?: string | undefined
}

export interface DocsPage {
  /** Project-relative source file. */
  path: string
  /** Public route of the rendered page, for example `/guides/install`. */
  route: string
  title: string
  description?: string
  /** Navigation section, space, or group the page belongs to. */
  section: string
  /** Clean Markdown (frontmatter stripped, components flattened). */
  markdown: string
  /** Output-relative Markdown mirror, for example `guides/install.md`. */
  markdownFile: string
  /** Link to the Markdown mirror. */
  markdownUrl: string
  /** Link to the rendered page. */
  pageUrl: string
  /** False for other versions and locales, which llms.txt leaves out. */
  primary: boolean
}

export interface DocsSite {
  title: string
  description?: string
  pages: DocsPage[]
}

export interface LlmsOutput extends DocsSite {
  llmsTxt: string
  llmsFullTxt: string
}

/** Read every documentation page as clean Markdown, in navigation order. */
export async function readDocsSite(root: string, options: LlmsOptions = {}): Promise<DocsSite> {
  const project = await loadProject(root)
  const contentRoot = await resolveContainedDirectory(root, project.contentDir, 'Documentation content directory', {
    allowRoot: project.generator === 'doxbrix',
  })
  const [files, collections] = await Promise.all([loadPages(root, project), documentationCollections(root, project)])
  const adapter = project.generator === 'doxbrix' ? undefined : await loadGeneratorAdapter(root, project).catch(() => undefined)
  const site = project.generator === 'doxbrix' ? await loadSiteConfig(root, project) : undefined
  const siteUrl = options.siteUrl ? normalizeSiteUrl(options.siteUrl) : undefined
  const basePath = normalizeBasePath(options.basePath)
  // Native generators put their own base (Docusaurus baseUrl, MkDocs site_url)
  // into every route; the built folder is that base, so strip it for file paths.
  const nativeBase = project.generator === 'doxbrix' || !siteUrl ? '' : new URL(siteUrl).pathname.replace(/\/+$/, '')

  const loaded = await Promise.all(files.map(async (absolute) => {
    const path = relativePath(root, absolute)
    const raw = await readFile(absolute, 'utf8')
    const page = adapter?.readPage ? await adapter.readPage(absolute) : await readPage(absolute)
    const collection = collectionForPath(collections, path)
    const route = await resolvePageRoute(root, project, path, raw)
    return {
      path,
      id: pageId(contentRoot, absolute),
      raw,
      route,
      title: page.title || titleFromPath(path),
      ...(page.description ? { description: page.description } : {}),
      primary: (collection?.version ?? 'current') === 'current' && (collection?.locale ?? 'default') === 'default',
    }
  }))

  const { placement, otherVersions } = await navigationPlacement(root, project, site)
  const byPath = new Map(loaded.map((page) => [page.path, page]))
  const ordered: Array<(typeof loaded)[number] & { section: string }> = []
  const placed = new Set<string>()
  for (const { path, section } of placement) {
    const page = byPath.get(path)
    if (!page || placed.has(path)) continue
    placed.add(path)
    ordered.push({ ...page, section })
  }
  // Pages outside the navigation follow in the page list's order (title, then path).
  // A page only an older version's navigation lists still gets its Markdown copy,
  // but llms.txt describes the current documentation.
  const rest = loaded
    .filter((page) => !placed.has(page.path))
    .map((page) => (otherVersions.has(page.path) ? { ...page, primary: false } : page))
    .sort((left, right) => left.title.localeCompare(right.title) || left.path.localeCompare(right.path))
  const fallbackSection = placement.length ? 'Optional' : 'Documentation'
  for (const page of rest) ordered.push({ ...page, section: fallbackSection })

  const usedFiles = new Set<string>()
  const pages: DocsPage[] = []
  for (const page of ordered) {
    const routePath = stripBase(page.route, nativeBase)
    let markdownFile: string
    try { markdownFile = markdownFileForRoute(routePath) } catch { continue }
    // Two sources can share a route (`guides.md` and `guides/index.md`); the first keeps it.
    if (usedFiles.has(markdownFile)) markdownFile = `${page.id}.md`
    if (usedFiles.has(markdownFile)) continue
    usedFiles.add(markdownFile)
    pages.push({
      path: page.path,
      route: page.route,
      title: page.title,
      ...(page.description ? { description: page.description } : {}),
      section: page.section,
      markdown: flattenMarkdown(page.raw),
      markdownFile,
      markdownUrl: publicUrl(markdownFile, siteUrl, basePath),
      pageUrl: publicUrl(routePath.replace(/^\/+/, ''), siteUrl, basePath),
      primary: page.primary,
    })
  }

  const title = site?.name?.trim() || project.title
  const description = site?.description?.trim() || pages.find((page) => page.primary)?.description
  return { title, ...(description ? { description } : {}), pages }
}

/** Build llms.txt, llms-full.txt, and the per-page Markdown mirrors in memory. */
export async function buildLlmsOutput(root: string, options: LlmsOptions = {}): Promise<LlmsOutput> {
  const site = await readDocsSite(root, options)
  const siteUrl = options.siteUrl ? normalizeSiteUrl(options.siteUrl) : undefined
  const basePath = normalizeBasePath(options.basePath)
  return {
    ...site,
    llmsTxt: llmsTxt(site, publicUrl('llms-full.txt', siteUrl, basePath)),
    llmsFullTxt: llmsFullTxt(site),
  }
}

export function llmsTxt(site: DocsSite, fullUrl: string): string {
  const primary = site.pages.filter((page) => page.primary)
  const sections = new Map<string, DocsPage[]>()
  for (const page of primary) sections.set(page.section, [...(sections.get(page.section) ?? []), page])
  // llms.txt reserves "Optional" for links a reader may skip, so it goes last.
  const optional = sections.get('Optional')
  if (optional) { sections.delete('Optional'); sections.set('Optional', optional) }
  const lines = [`# ${oneLine(site.title)}`, '']
  if (site.description) lines.push(`> ${oneLine(site.description)}`, '')
  lines.push(`Each link below is a clean Markdown copy of a documentation page. The complete documentation is also available as a single file: [llms-full.txt](${fullUrl}).`, '')
  for (const [section, pages] of sections) {
    lines.push(`## ${oneLine(section)}`, '')
    for (const page of pages) {
      lines.push(`- [${linkText(page.title)}](${page.markdownUrl})${page.description ? `: ${oneLine(page.description)}` : ''}`)
    }
    lines.push('')
  }
  return `${lines.join('\n').trimEnd()}\n`
}

export function llmsFullTxt(site: DocsSite, limits: { total?: number; page?: number } = {}): string {
  const totalLimit = limits.total ?? LLMS_FULL_MAX_BYTES
  const pageLimit = limits.page ?? LLMS_FULL_PAGE_MAX_BYTES
  const primary = site.pages.filter((page) => page.primary)
  const header = `# ${oneLine(site.title)}\n\n${site.description ? `> ${oneLine(site.description)}\n\n` : ''}`
  const parts: string[] = [header]
  let bytes = Buffer.byteLength(header)
  for (const [index, page] of primary.entries()) {
    const body = truncateMarkdown(stripLeadingTitle(page.markdown, page.title), pageLimit, page.markdownUrl)
    const part = `---\n\n# ${oneLine(page.title)}\n\nSource: ${page.pageUrl}\n\n${body.trim()}\n\n`
    const size = Buffer.byteLength(part)
    if (bytes + size > totalLimit) {
      const remaining = primary.length - index
      parts.push(`---\n\nThis file stops at its ${Math.round(totalLimit / 1024 / 1024 * 10) / 10} MB limit. ${remaining} more page${remaining === 1 ? ' is' : 's are'} listed in llms.txt, each with its own Markdown copy.\n`)
      break
    }
    parts.push(part)
    bytes += size
  }
  return `${parts.join('').trimEnd()}\n`
}

/** Write llms.txt, llms-full.txt, and each page's Markdown mirror into a built site. */
export async function writeLlmsOutput(root: string, outputDir: string, options: LlmsOptions & { overwrite?: boolean } = {}): Promise<{ pages: number }> {
  const output = await buildLlmsOutput(root, options)
  const overwrite = options.overwrite !== false
  const write = async (relative: string, content: string): Promise<boolean> => {
    const destination = assertInside(outputDir, resolve(outputDir, ...relative.split('/')))
    if (!overwrite && await pathExists(destination)) return false
    await mkdir(dirname(destination), { recursive: true })
    await writeFile(destination, content, 'utf8')
    return true
  }
  let pages = 0
  for (const page of output.pages) {
    if (await write(page.markdownFile, markdownMirror(page))) pages++
  }
  await write('llms-full.txt', output.llmsFullTxt)
  await write('llms.txt', output.llmsTxt)
  return { pages }
}

/**
 * Static packaging for generator plugins: add the AI-readable files to a
 * native build unless the generator (or one of its plugins) already wrote an
 * llms.txt, which is never replaced. Existing files are never overwritten.
 */
export async function addLlmsOutputToBuild(root: string, outputDir: string, options: LlmsOptions = {}): Promise<boolean> {
  if (await pathExists(join(outputDir, 'llms.txt'))) return false
  try {
    // A build that lives in the pages' own folder (static HTML sites, VitePress's
    // docs/.vitepress/dist) would turn every Markdown copy into a new page.
    const project = await loadProject(root)
    const output = resolve(outputDir)
    for (const collection of await documentationCollections(root, project)) {
      const content = resolve(root, collection.directory)
      if (within(content, output) || within(output, content)) {
        process.stderr.write(`doxloop: skipped llms.txt because the build output ${relativePath(root, output) || '.'} shares the documentation folder.\n`)
        return false
      }
    }
    await writeLlmsOutput(root, outputDir, { ...options, overwrite: false })
    return true
  } catch (error) {
    // The site itself built; missing AI-readable copies must not block publishing it.
    process.stderr.write(`doxloop: skipped llms.txt: ${error instanceof Error ? error.message : String(error)}\n`)
    return false
  }
}

/** One page's Markdown mirror: its title and description, then the clean body. */
export function markdownMirror(page: Pick<DocsPage, 'title' | 'description' | 'markdown'>): string {
  const body = stripLeadingTitle(page.markdown, page.title).trim()
  return `# ${oneLine(page.title)}\n\n${page.description ? `> ${oneLine(page.description)}\n\n` : ''}${body}\n`
}

/** `/guides/install` → `guides/install.md`; `/` → `index.md`. */
export function markdownFileForRoute(route: string): string {
  const clean = route
    .split(/[?#]/)[0]!
    .replace(/\.html?$/i, '')
    .replace(/(^|\/)index$/i, '$1')
    .replace(/^\/+|\/+$/g, '')
  const segments = clean.split('/').filter(Boolean).map((segment) => {
    try { return decodeURIComponent(segment) } catch { return segment }
  })
  if (segments.some((segment) => segment === '..' || segment === '.' || segment.includes('\\'))) {
    throw new DoxloopError(`Page route cannot leave the site: ${route}`)
  }
  return `${segments.join('/') || 'index'}.md`
}

/** Which Markdown mirror a request path names, for the preview server. */
export function markdownFileForRequest(pathname: string): string | undefined {
  if (!/\.md$/i.test(pathname)) return undefined
  try {
    return markdownFileForRoute(pathname.replace(/\.md$/i, ''))
  } catch {
    return undefined
  }
}

interface Placement { path: string; section: string }

async function navigationPlacement(root: string, project: DoxloopProject, site: Awaited<ReturnType<typeof loadSiteConfig>> | undefined): Promise<{ placement: Placement[]; otherVersions: Set<string> }> {
  let tree: Awaited<ReturnType<typeof readNavigation>>
  try {
    tree = await readNavigation(root)
  } catch {
    // A generator whose navigation cannot be read still gets its pages listed.
    return { placement: [], otherVersions: new Set() }
  }
  const defaultVersion = site?.versions?.find((entry) => entry.default || entry.isDefault)?.version ?? site?.versions?.[0]?.version
  const current = (space: { version?: string }): boolean => !defaultVersion || !space.version || space.version === defaultVersion
  const spaces = tree.spaces.filter(current)
  const otherVersions = new Set<string>()
  const collect = (nodes: NavigationNode[]): void => {
    for (const node of nodes) {
      if (node.type === 'page' && node.path) otherVersions.add(node.path)
      else if (node.type === 'group') collect(node.items)
    }
  }
  for (const space of tree.spaces) if (!current(space)) collect(space.nav)
  const named = project.generator === 'doxbrix'
  const placements: Placement[] = []
  const hidden: string[] = []
  for (const space of spaces) {
    const spaceName = named ? space.name : 'Documentation'
    const visit = (nodes: NavigationNode[], section: string | undefined, concealed: boolean): void => {
      for (const node of nodes) {
        if (node.type === 'page' && node.path) {
          if (concealed || node.hidden) hidden.push(node.path)
          else placements.push({ path: node.path, section: section ?? spaceName })
        } else if (node.type === 'group') {
          const label = section ?? (spaces.length > 1 && named ? `${space.name}: ${node.label}` : node.label)
          visit(node.items, label, concealed || Boolean(node.hidden))
        }
      }
    }
    visit(space.nav, undefined, false)
  }
  return { placement: [...placements, ...hidden.map((path) => ({ path, section: 'Optional' }))], otherVersions }
}

function truncateMarkdown(markdown: string, limit: number, fullUrl: string): string {
  if (Buffer.byteLength(markdown) <= limit) return markdown
  let cut = Buffer.from(markdown).subarray(0, limit).toString('utf8').replace(/�+$/, '')
  const lastBreak = cut.lastIndexOf('\n')
  if (lastBreak > limit / 2) cut = cut.slice(0, lastBreak)
  // Close a code block the cut left open so the note is not read as code.
  const fences = cut.split('\n').filter((line) => /^\s*(```|~~~)/.test(line)).length
  if (fences % 2 === 1) cut += '\n```'
  return `${cut.trimEnd()}\n\n[This page is truncated here. The complete page is at ${fullUrl}]`
}

function stripLeadingTitle(markdown: string, title: string): string {
  const match = /^\s*#\s+(.+)\n/.exec(markdown)
  return match && match[1]!.trim().toLowerCase() === title.trim().toLowerCase() ? markdown.slice(match[0].length) : markdown
}

function within(parent: string, candidate: string): boolean {
  const relation = relative(parent, candidate)
  return relation === '' || (!relation.startsWith('..') && !isAbsolute(relation))
}

function stripBase(route: string, base: string): string {
  if (!base || base === '/') return route
  if (route === base) return '/'
  return route.startsWith(`${base}/`) ? route.slice(base.length) : route
}

function publicUrl(relative: string, siteUrl: string | undefined, basePath: string): string {
  const encoded = relative.split('/').map((segment) => encodeURIComponent(segment)).join('/')
  if (siteUrl) return new URL(encoded, siteUrl).toString()
  return `${basePath}/${encoded}`
}

function normalizeSiteUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new DoxloopError(`Invalid site URL: ${value}`) }
  url.search = ''
  url.hash = ''
  if (!url.pathname.endsWith('/')) url.pathname = `${url.pathname}/`
  return url.toString()
}

function normalizeBasePath(value = ''): string {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '')
  return trimmed ? `/${trimmed}` : ''
}

function titleFromPath(path: string): string {
  return path.split('/').at(-1)!.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}

function linkText(value: string): string {
  return oneLine(value).replace(/([[\]])/g, '\\$1')
}
