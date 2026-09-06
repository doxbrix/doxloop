import { rewriteLinks } from './page-operations.js'
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import matter from 'gray-matter'
import { applyDirectEdit, safePath } from './direct-edit.js'
import { DoxloopError } from './errors.js'
import { listFiles, pathExists } from './fs.js'
import { readEvidenceMap, EVIDENCE_MAP_FILE } from './evidence.js'
import { loadProject, loadSiteConfig, siteConfigPath, pageId } from './project.js'
import { withProjectLock } from './project-lock.js'
import { parseDocument } from 'yaml'
import type { DoxloopProject, DoxbrixNavNode } from './types.js'

export interface DocumentationCollection { directory: string; version: string; locale: string; native: boolean }
const REGISTRY = '.doxloop/collections.json'
export async function documentationCollections(root: string, project: Pick<DoxloopProject, 'generator' | 'contentDir'>): Promise<DocumentationCollection[]> {
  const collections: DocumentationCollection[] = [{ directory: project.contentDir, version: 'current', locale: 'default', native: true }]
  if (project.generator === 'docusaurus') {
    for (const name of await directories(root, 'versioned_docs')) if (/^version-[\w.-]+$/.test(name)) collections.push({ directory: `versioned_docs/${name}`, version: name.slice(8), locale: 'default', native: true })
    for (const locale of await directories(root, 'i18n')) if (/^[\w-]+$/.test(locale)) {
      const base = `i18n/${locale}/docusaurus-plugin-content-docs`
      for (const version of await directories(root, base)) if (version === 'current' || /^version-[\w.-]+$/.test(version)) collections.push({ directory: `${base}/${version}`, version: version === 'current' ? version : version.slice(8), locale, native: true })
    }
  }
  try {
    const recorded = JSON.parse(await readFile(await safePath(root, REGISTRY), 'utf8')) as DocumentationCollection[]
    for (const item of recorded) {
      await safePath(root, item.directory)
      if (!collections.some((collection) => collection.directory === item.directory)) collections.push(item)
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  return collections
}
async function directories(root: string, path: string): Promise<string[]> {
  try { return (await readdir(await safePath(root, path), { withFileTypes: true })).filter((item) => item.isDirectory() && !item.isSymbolicLink()).map((item) => item.name) }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return [] }
}
export function collectionForPath(collections: DocumentationCollection[], path: string) {
  return [...collections].sort((a, b) => b.directory.length - a.directory.length).find((item) => !item.directory || path.startsWith(`${item.directory}/`))
}

/** Snapshot an existing version/locale; translation remains a reviewed editing task. */
export async function createDocumentationCollection(root: string, input: { sourceDirectory: string; version: string; locale: string }) {
  return withProjectLock(root, 'write', async () => {
    const project = await loadProject(root)
    if (!['doxbrix', 'mkdocs', 'docusaurus'].includes(project.generator)) throw new DoxloopError('Version and locale collections currently support Doxbrix, MkDocs, and Docusaurus.')
    for (const [label, value] of Object.entries({ version: input.version, locale: input.locale })) if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(value) || ['.', '..'].includes(value)) throw new DoxloopError(`Use a simple ${label} name with letters, numbers, dots, or hyphens.`)
    const collections = await documentationCollections(root, project)
    const source = collections.find((item) => item.directory === input.sourceDirectory)
    if (!source) throw new DoxloopError('Choose an existing source collection.')
    const native = project.generator === 'docusaurus'
    const destination = native ? input.locale === 'default' ? `versioned_docs/version-${input.version}` : `i18n/${input.locale}/docusaurus-plugin-content-docs/${input.version === 'current' ? 'current' : `version-${input.version}`}` : [project.contentDir, 'editions', input.version, input.locale].filter(Boolean).join('/')
    if (collections.some((item) => item.version === input.version && item.locale === input.locale) || (await pathExists(await safePath(root, destination)) && await hasFiles(await safePath(root, destination)))) throw new DoxloopError('That version and locale already exists.')
    const changes = new Map<string, string | Buffer>()
    const sourceRoot = resolve(root, source.directory)
    const files = await listFiles(sourceRoot, new Set(['.md', '.mdx', '.png', '.jpg', '.jpeg', '.svg', '.gif', '.webp', '.avif', '.pdf', '.json']), { ignoredDirectories: new Set(['.doxloop', 'node_modules', '.git', 'build', 'site', 'dist', 'editions']) })
    const pages: Array<{ from: string; to: string; title: string }> = []
    for (const absolute of files) {
      const from = relative(root, absolute).replace(/\\/g, '/')
      if (collectionForPath(collections, from)?.directory !== source.directory) continue
      const local = relative(sourceRoot, absolute).replace(/\\/g, '/')
      if (local.split('/').some((part) => part.startsWith('.') || ['node_modules', 'build', 'site', 'dist', 'editions'].includes(part))) continue
      if (!/\.(mdx?|png|jpe?g|svg|gif|webp|avif|pdf|json)$/i.test(local)) continue
      const to = `${destination}/${local}`
      const data = await readFile(await safePath(root, from))
      changes.set(to, data)
      if (/\.mdx?$/.test(local)) {
        const rewritten = rewriteLinks(data.toString(), (href) => {
          if (/^(?:[a-z][a-z0-9+.-]*:|#|\/)/i.test(href)) return href
          const [target, suffix = ''] = href.split(/(?=[?#])/s, 2)
          const resolved = resolve(dirname(join(root, from)), target!)
          if (resolved.startsWith(`${sourceRoot}/`)) return href
          return relative(dirname(join(root, to)), resolved).replace(/\\/g, '/') + suffix
        })
        changes.set(to, rewritten)
        const parsed = matter(rewritten)
        if (!native) {
          // The collection's directory defines the route; copied custom slugs must not collide.
          delete parsed.data.slug
          parsed.data.locale = input.locale; parsed.data.version = input.version
          changes.set(to, matter.stringify(parsed.content, parsed.data))
        }
        pages.push({ from, to, title: String(parsed.data.title ?? local) })
      }
    }
    if (!pages.length) throw new DoxloopError('The selected collection contains no Markdown pages.')
    if (native) {
      if (input.locale === 'default') {
        if (input.version === 'current') throw new DoxloopError('The current version already exists.')
        const versions = await jsonOr<string[]>(root, 'versions.json', [])
        let sidebarName = 'docs'
        for (const sidebarPath of ['sidebars.js', 'sidebars.ts', 'sidebars.json']) {
          if (!(await pathExists(join(root, sidebarPath)))) continue
          const sidebar = await readFile(await safePath(root, sidebarPath), 'utf8')
          if (!/autogenerated/.test(sidebar)) throw new DoxloopError('Custom Docusaurus sidebars require a reviewed native versioning proposal. No files were written.')
          sidebarName = /["']?([a-zA-Z][\w-]*)["']?\s*:\s*\[/.exec(sidebar)?.[1] ?? 'docs'
        }
        changes.set('versions.json', JSON.stringify([input.version, ...versions], null, 2) + '\n')
        // Autogenerated sidebars work without executing arbitrary project configuration.
        changes.set(`versioned_sidebars/version-${input.version}-sidebars.json`, JSON.stringify({ [sidebarName]: [{ type: 'autogenerated', dirName: '.' }] }, null, 2) + '\n')
      } else {
        const configPath = (await Promise.all(['docusaurus.config.js', 'docusaurus.config.ts', 'docusaurus.config.mjs', 'docusaurus.config.cjs'].map(async (path) => await pathExists(join(root, path)) ? path : undefined))).find(Boolean)
        if (!configPath) throw new DoxloopError('Docusaurus configuration was not found.')
        const text = await readFile(await safePath(root, configPath), 'utf8')
        const locales = /\blocales\s*:\s*\[([^\]]*)\]/.exec(text)
        if (!locales || !/^[\s,'"\w-]*$/.test(locales[1]!)) throw new DoxloopError('Declare a literal i18n.locales array in Docusaurus configuration before creating a locale.')
        if (!new RegExp(`['"]${input.locale}['"]`).test(locales[1]!)) changes.set(configPath, text.replace(locales[0], `locales: [${locales[1]!.trim().replace(/,$/, '')}, '${input.locale}']`))
        if (input.version !== 'current' && !(await jsonOr<string[]>(root, 'versions.json', [])).includes(input.version)) throw new DoxloopError('Create the source version before translating it.')
      }
    } else if (project.generator === 'doxbrix') {
      const site = await loadSiteConfig(root, project)
      const nav: DoxbrixNavNode[] = pages.map((page) => ({ type: 'page', file: pageId(join(root, project.contentDir), join(root, page.to)), label: page.title }))
      site.spaces.push({ name: `${input.version} · ${input.locale}`, nav })
      changes.set(relative(root, await siteConfigPath(root, project)), JSON.stringify(site, null, 2) + '\n')
    } else {
      const configPath = await pathExists(join(root, 'mkdocs.yml')) ? 'mkdocs.yml' : 'mkdocs.yaml'
      const document = parseDocument(await readFile(await safePath(root, configPath), 'utf8'))
      const nav = (document.toJS() as { nav?: unknown }).nav
      if (!Array.isArray(nav)) throw new DoxloopError('Define an explicit MkDocs nav list before creating a collection.')
      document.set('nav', [...nav, { [`${input.version} · ${input.locale}`]: pages.map((page) => ({ [page.title]: relative(join(root, project.contentDir), join(root, page.to)).replace(/\\/g, '/') })) }])
      changes.set(configPath, document.toString())
    }
    const map = await readEvidenceMap(root) ?? { schemaVersion: 1 as const, pages: {} }
    for (const page of pages) map.pages[page.to] = { sources: map.pages[page.from]?.sources ?? [], confidence: 'needs-human' }
    changes.set(EVIDENCE_MAP_FILE, JSON.stringify(map, null, 2) + '\n')
    const recorded = await jsonOr<DocumentationCollection[]>(root, REGISTRY, [])
    changes.set(REGISTRY, JSON.stringify([...recorded, { directory: destination, version: input.version, locale: input.locale, native }], null, 2) + '\n')
    const result = await applyDirectEdit(root, { kind: 'metadata', requestText: `Created ${input.version} / ${input.locale} from ${source.version} / ${source.locale}; copied text requires review`, files: [...changes.keys()], pagesChanged: pages.length, apply: async () => {
      for (const [file, text] of changes) { const absolute = await safePath(root, file); await mkdir(dirname(absolute), { recursive: true }); await writeFile(absolute, text) }
    } })
    return { ...result, directory: destination, pages: pages.map((page) => page.to), message: 'Collection created. Review or translate its copied text before publication; verification was not inherited.' }
  })
}
async function jsonOr<T>(root: string, path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(await safePath(root, path), 'utf8')) as T } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; return fallback }
}

async function hasFiles(directory: string): Promise<boolean> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || await hasFiles(join(directory, entry.name))) return true
  }
  return false
}
