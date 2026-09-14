/**
 * `docs-site` sources: an existing documentation website crawled into a
 * read-only Markdown snapshot that the authoring agent reads as evidence of the
 * documentation being rewritten.
 *
 * Snapshots live beside other materialized sources under
 * `<parent>/.doxloop-sources/<projectId>/<name>/docs-<hash>/`, outside the
 * documentation deployment boundary, so the crawled third-party content can
 * never be published by accident. The layout is plain files: `snapshot.json`
 * (page metadata, skipped URLs, broken links, warnings), `index.md` (a table of
 * every page the agent can skim before opening files), and `pages/**.md` (one
 * Markdown page per crawled URL with its title and original URL in frontmatter).
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { DocsSitePage, DocsSiteSnapshot } from './docs-crawl.js'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import { REDIRECTS_FILE, readRedirects } from './page-operations.js'
import { portableSourcePath } from './remote-source.js'
import type { DocsSiteSource, DocumentationPlan, SourceBinding } from './types.js'

export const DOCS_SITE_SNAPSHOT_FILE = 'snapshot.json'
export const DOCS_SITE_INDEX_FILE = 'index.md'
export const DOCS_SITE_PAGES_DIRECTORY = 'pages'

export type DocsSiteManifestPage = Omit<DocsSitePage, 'markdown'> & { file: string }

/** `snapshot.json`: everything in the crawl result except page bodies, which live in `pages/`. */
export interface DocsSiteManifest extends Omit<DocsSiteSnapshot, 'pages'> {
  pages: DocsSiteManifestPage[]
}

export interface MaterializedDocsSite {
  /** Absolute snapshot directory. */
  path: string
  manifest: DocsSiteManifest
  site: DocsSiteSource
}

/** Write a crawl result as a snapshot directory outside the documentation project. */
export async function materializeDocsSiteSnapshot(root: string, name: string, snapshot: DocsSiteSnapshot): Promise<MaterializedDocsSite> {
  const projectId = createHash('sha256').update(resolve(root)).digest('hex').slice(0, 12)
  const destination = join(dirname(resolve(root)), '.doxloop-sources', projectId, safeSourceName(name), `docs-${snapshot.hash.slice(0, 12)}`)
  const manifest = docsSiteManifest(snapshot)
  if (!(await pathExists(destination))) {
    const parent = dirname(destination)
    await mkdir(parent, { recursive: true })
    const temporary = await mkdtemp(join(parent, '.docs-'))
    try {
      await writeFile(join(temporary, DOCS_SITE_SNAPSHOT_FILE), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
      await writeFile(join(temporary, DOCS_SITE_INDEX_FILE), docsSiteIndexMarkdown(manifest), 'utf8')
      for (const page of snapshot.pages) {
        const file = join(temporary, docsSitePageFile(page.path))
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, docsSitePageMarkdown(page), 'utf8')
      }
      await rename(temporary, destination)
    } catch (error) {
      await rm(temporary, { recursive: true, force: true })
      throw error
    }
  }
  return { path: destination, manifest, site: docsSiteSource(manifest) }
}

/** The binding stored in project.json for a materialized snapshot. */
export function docsSiteBinding(root: string, name: string, materialized: MaterializedDocsSite, scope?: SourceBinding['scope']): SourceBinding {
  return {
    name,
    path: portableSourcePath(root, materialized.path),
    kind: 'docs-site',
    site: materialized.site,
    ...(scope ? { scope } : {}),
  }
}

export function docsSiteSource(manifest: Pick<DocsSiteManifest, 'url' | 'crawledAt' | 'totals' | 'hash' | 'generator' | 'truncated'>): DocsSiteSource {
  return {
    url: manifest.url,
    crawledAt: manifest.crawledAt,
    pages: manifest.totals.pages,
    words: manifest.totals.words,
    hash: manifest.hash,
    ...(manifest.generator ? { generator: manifest.generator } : {}),
    ...(manifest.truncated ? { truncated: true } : {}),
  }
}

export function docsSiteManifest(snapshot: DocsSiteSnapshot): DocsSiteManifest {
  return {
    ...snapshot,
    pages: snapshot.pages.map(({ markdown: _markdown, ...page }) => ({ ...page, file: docsSitePageFile(page.path) })),
  }
}

/** Read the manifest of a materialized `docs-site` source. */
export async function readDocsSiteManifest(root: string, source: Pick<SourceBinding, 'path' | 'name'>): Promise<DocsSiteManifest> {
  const path = join(resolve(root, source.path), DOCS_SITE_SNAPSHOT_FILE)
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    throw new DoxloopError(`The documentation site snapshot for source "${source.name}" is missing: ${path}. Re-crawl the site from Sources.`)
  }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { throw new DoxloopError(`The documentation site snapshot for source "${source.name}" is not valid JSON: ${path}`) }
  if (!isManifest(parsed)) throw new DoxloopError(`The documentation site snapshot for source "${source.name}" is invalid: ${path}`)
  return parsed
}

export async function assertDocsSiteSnapshot(root: string, source: Pick<SourceBinding, 'path' | 'name'>): Promise<void> {
  await readDocsSiteManifest(root, source)
}

/**
 * Snapshot-relative Markdown file for a crawled page path. The entry page is
 * `pages/index.md`; nested URLs keep their folders so the agent can relate a
 * file back to the original site structure.
 */
export function docsSitePageFile(pagePath: string): string {
  const segments = pagePath.split('/').map((segment) => segment.trim()).filter((segment) => segment && segment !== '.' && segment !== '..')
    .map((segment) => segment.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^\.+/, '').replace(/\.(md|mdx|html?)$/i, '') || 'page')
  if (segments.length === 0) return `${DOCS_SITE_PAGES_DIRECTORY}/index.md`
  return `${DOCS_SITE_PAGES_DIRECTORY}/${segments.join('/')}.md`
}

export function docsSitePageMarkdown(page: DocsSitePage): string {
  const frontmatter = [
    `title: ${JSON.stringify(page.title)}`,
    `url: ${JSON.stringify(page.url)}`,
    ...(page.description ? [`description: ${JSON.stringify(page.description)}`] : []),
    `crawledAt: ${JSON.stringify(page.fetchedAt)}`,
    `words: ${page.words}`,
  ]
  return `---\n${frontmatter.join('\n')}\n---\n\n${page.markdown}\n`
}

export function docsSiteIndexMarkdown(manifest: DocsSiteManifest): string {
  const lines: string[] = [
    `# Existing documentation snapshot`,
    '',
    `- Site: ${manifest.url}`,
    `- Crawled: ${manifest.crawledAt}`,
    `- Pages: ${manifest.totals.pages} (${manifest.totals.words} words, ${manifest.totals.images} images)`,
    ...(manifest.generator ? [`- Generator: ${manifest.generator}`] : []),
    `- Discovered through: ${manifest.discovery.length > 0 ? manifest.discovery.join(', ') : 'entry page only'}`,
    ...(manifest.truncated ? [`- Truncated: the crawl stopped at ${manifest.pageLimit} pages; ${manifest.totals.discovered - manifest.totals.pages} discovered pages were not fetched.`] : []),
    '',
    'This snapshot is read-only evidence of the documentation being rewritten. Each page file records its original URL in frontmatter. Verify factual claims against the configured product sources before reusing them.',
    '',
    '## Pages',
    '',
    '| File | Title | Words | Original URL |',
    '| --- | --- | --- | --- |',
    ...manifest.pages.map((page) => `| ${page.file} | ${cell(page.title)} | ${page.words} | ${page.url} |`),
  ]
  if (manifest.brokenLinks.length > 0) {
    lines.push('', `## Broken internal links (${manifest.brokenLinks.length})`, '')
    for (const link of manifest.brokenLinks.slice(0, 100)) lines.push(`- ${link.url} (linked from ${link.from})${link.status ? ` — HTTP ${link.status}` : ''}`)
  }
  if (manifest.skipped.length > 0) {
    lines.push('', `## Skipped URLs (${manifest.skipped.length})`, '')
    for (const item of manifest.skipped.slice(0, 100)) lines.push(`- ${item.url} — ${item.reason}`)
  }
  if (manifest.warnings.length > 0) {
    lines.push('', '## Crawl warnings', '')
    for (const warning of manifest.warnings) lines.push(`- ${warning}`)
  }
  return `${lines.join('\n')}\n`
}

/** Human-readable one-line description used by health, tables, and CLI output. */
export function describeDocsSite(site: DocsSiteSource): string {
  const date = new Date(site.crawledAt)
  const when = Number.isNaN(date.getTime()) ? site.crawledAt : date.toISOString().slice(0, 10)
  return `${site.pages} page${site.pages === 1 ? '' : 's'} · crawled ${when}${site.generator ? ` · ${site.generator}` : ''}`
}

/**
 * Redirects implied by an approved plan: every existing page that a new page
 * absorbs, when the old route differs from the new one. Written to the same
 * redirect file page moves use, so the preview and the Doxbrix build honor
 * them, and exported for the old host when the new site is deployed elsewhere.
 */
export function existingDocumentationRedirects(plan: Pick<DocumentationPlan, 'pages' | 'existingDocumentation'>): Record<string, string> {
  const redirects: Record<string, string> = {}
  const pagesById = new Map(plan.pages.map((page) => [page.id, page]))
  const routeOf = (path: string): string => `/${path.replace(/^\/+/, '').replace(/\.(mdx?|rst|html?)$/i, '').replace(/(^|\/)index$/, '')}`.replace(/\/+$/, '') || '/'
  const newRoutes = new Set(plan.pages.filter((page) => page.action !== 'remove').map((page) => routeOf(page.path)))
  for (const assessment of plan.existingDocumentation ?? []) {
    for (const disposition of assessment.pages) {
      if (disposition.disposition === 'drop') continue
      const target = disposition.into.map((id: string) => pagesById.get(id)).find((page) => page !== undefined && page.action !== 'remove')
      if (!target) continue
      const from = existingPageRoute(disposition)
      const to = routeOf(target.path)
      if (!from || from === to || newRoutes.has(from) || !/^\/[a-zA-Z0-9/_-]*$/.test(from) || !/^\/[a-zA-Z0-9/_-]*$/.test(to)) continue
      redirects[from] = to
    }
  }
  return redirects
}

export async function writeExistingDocumentationRedirects(root: string, plan: Pick<DocumentationPlan, 'pages' | 'existingDocumentation'>): Promise<Record<string, string>> {
  const additions = existingDocumentationRedirects(plan)
  if (Object.keys(additions).length === 0) return {}
  const current = await readRedirects(root)
  const merged = { ...current }
  for (const [from, to] of Object.entries(additions)) if (!(from in merged)) merged[from] = to
  await mkdir(join(root, '.doxloop'), { recursive: true })
  await writeFile(join(root, REDIRECTS_FILE), `${JSON.stringify(merged, null, 2)}\n`, 'utf8')
  return additions
}

function existingPageRoute(disposition: { path: string; url?: string }): string | undefined {
  if (disposition.url) {
    try {
      const pathname = new URL(disposition.url).pathname.replace(/\/index\.html?$/i, '/').replace(/\.html?$/i, '').replace(/\/+$/, '')
      return pathname === '' ? '/' : pathname
    } catch { /* fall back to the snapshot path */ }
  }
  const relative = disposition.path.replace(/^pages\//, '').replace(/\.md$/, '').replace(/(^|\/)index$/, '')
  return `/${relative}`.replace(/\/+$/, '') || '/'
}

function safeSourceName(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^\.+/, '') || 'docs'
}

function cell(value: string): string {
  return value.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim()
}

function isManifest(value: unknown): value is DocsSiteManifest {
  if (!value || typeof value !== 'object') return false
  const manifest = value as Partial<DocsSiteManifest>
  return manifest.schemaVersion === 1 && typeof manifest.url === 'string' && typeof manifest.crawledAt === 'string' && typeof manifest.hash === 'string' &&
    Array.isArray(manifest.pages) && manifest.pages.every((page) => page && typeof page === 'object' && typeof (page as DocsSiteManifestPage).file === 'string' && typeof (page as DocsSiteManifestPage).url === 'string') &&
    Boolean(manifest.totals) && typeof manifest.totals!.pages === 'number' && Array.isArray(manifest.skipped) && Array.isArray(manifest.brokenLinks) && Array.isArray(manifest.warnings) && Array.isArray(manifest.discovery)
}
