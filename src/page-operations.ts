import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import matter from 'gray-matter'
import { applyDirectEdit, safePath, type DirectEditResult } from './direct-edit.js'
import { renderMarkdown } from './doxbrix-markdown.js'
import { DoxloopError } from './errors.js'
import { EVIDENCE_MAP_FILE, readEvidenceMap, writeEvidenceMap } from './evidence.js'
import { pathExists } from './fs.js'
import { loadGeneratorAdapter } from './generators.js'
import { appendDoxbrixNavigationPage } from './navigation.js'
import { resolvePageRoute } from './page-routes.js'
import { resolveEditScope } from './pages.js'
import { loadPages, loadProject, loadSiteConfig, pageId, relativePath, siteConfigPath } from './project.js'
import { withProjectLock } from './project-lock.js'
import type { DoxbrixNavNode, DoxloopProject } from './types.js'

export interface PageContent { path: string; content: string; fingerprint: string }
export interface PageWrite { path: string; content: string; fingerprint: string; evidenceDisposition?: 'preserved' | 'needs-review' }
export const REDIRECTS_FILE = '.doxloop/redirects.json'
const fingerprint = (content: string) => createHash('sha256').update(content).digest('hex')

export async function readPageContent(root: string, path: string): Promise<PageContent> {
  await resolveEditScope(root, await loadProject(root), [path], false)
  const content = await readFile(await safePath(root, path), 'utf8')
  return { path, content, fingerprint: fingerprint(content) }
}

export async function savePageContent(root: string, input: PageWrite): Promise<PageContent & DirectEditResult> {
  return withProjectLock(root, 'write', async () => {
    checkContent(input.content)
    const current = await readPageContent(root, input.path)
    if (current.fingerprint !== input.fingerprint) throw new DoxloopError('The page changed since you opened it. Your draft is kept; reload the saved version and compare before saving.')
    const result = await applyDirectEdit(root, { kind: 'edit', requestText: `Edited ${input.path} directly`, files: [input.path, EVIDENCE_MAP_FILE], pagesChanged: 1, apply: async () => {
      if (fingerprint(await readFile(join(root, input.path), 'utf8')) !== input.fingerprint) throw new DoxloopError('The page changed before saving. Reload and compare your draft.')
      await writeFile(join(root, input.path), input.content, 'utf8')
      if (input.evidenceDisposition !== 'preserved') {
        const map = await readEvidenceMap(root)
        if (map?.pages[input.path]) {
          map.pages[input.path] = { sources: map.pages[input.path]!.sources, confidence: 'needs-human' }
          await writeEvidenceMap(root, map)
        }
      }
    } })
    return { ...await readPageContent(root, input.path), ...result }
  })
}

export function previewPageContent(content: string): { html: string } {
  checkContent(content)
  const body = matter(content).content
  return { html: `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https:; style-src 'unsafe-inline'"><style>body{font:16px/1.65 system-ui;max-width:760px;margin:32px auto;padding:0 24px;color:#17213a}pre{overflow:auto;padding:16px;background:#f2f4f8}img{max-width:100%}</style></head><body>${renderMarkdown(body).html}</body></html>` }
}

export interface PageLifecycleInput {
  action: 'create' | 'rename' | 'delete'
  path: string
  fingerprint?: string
  to?: string
  title?: string
  content?: string
  replacement?: string
}

/** Pages, navigation, links and evidence are one reversible write. */
export async function changePageLifecycle(root: string, input: PageLifecycleInput): Promise<DirectEditResult & { path?: string }> {
  return withProjectLock(root, 'write', async () => {
    const project = await loadProject(root)
    const adapter = project.generator === 'doxbrix' ? undefined : await loadGeneratorAdapter(root, project)
    if ((adapter?.project.contentFormat ?? 'markdown') !== 'markdown') throw new DoxloopError('Page lifecycle operations currently support Markdown and MDX. Edit this page in its native format instead.')
    const known = (await loadPages(root, project)).map((path) => relativePath(root, path))
    const destination = input.action === 'rename' ? input.to : input.path
    if (input.action !== 'delete') await validateNewPath(root, project, destination, known, adapter?.project.pageExtensions ?? ['.md', '.mdx'])
    if (project.generator === 'doxbrix' && destination && input.action !== 'delete') {
      const route = await resolvePageRoute(root, project, destination, input.content ?? '')
      if ((await readRedirects(root))[route]) throw new DoxloopError('This address redirects an older page. Choose a new address or undo the previous move first.')
    }
    const old = input.action === 'create' ? undefined : await readPageContent(root, input.path)
    if (old && old.fingerprint !== input.fingerprint) throw new DoxloopError('The page changed since it was loaded. Reload before renaming or deleting it.')
    if (input.action === 'delete' && known.length <= 1) throw new DoxloopError('Keep at least one documentation page.')
    if (input.replacement && (!known.includes(input.replacement) || input.replacement === input.path)) throw new DoxloopError('Choose a different existing page as the replacement.')
    const navFiles = project.generator === 'doxbrix' ? [relativePath(root, await siteConfigPath(root, project))] : adapter?.planning?.navigationFiles ?? []
    if (adapter && !adapter.writeNavigation && project.generator === 'docusaurus') {
      const sidebar = await readFile(join(root, 'sidebars.js'), 'utf8').catch(() => '')
      if (!/type\s*:\s*['"]autogenerated['"]/.test(sidebar) || !/dirName\s*:\s*['"].['"]/.test(sidebar)) throw new DoxloopError('This Docusaurus sidebar is custom code. Use the agent to update the page and sidebar together; direct lifecycle changes require autogenerated navigation.')
    } else if (adapter && !adapter.writeNavigation) {
      throw new DoxloopError('This generator does not expose safe navigation changes. Use an agent proposal for page lifecycle changes.')
    }
    const target = input.action === 'rename' ? input.to! : input.replacement
    const oldRoute = old ? await resolvePageRoute(root, project, input.path, old.content) : undefined
    let content = input.content ?? (old ? old.content : `---\ntitle: ${JSON.stringify(input.title?.trim() || 'New page')}\ndescription: "Describe what readers will learn on this page."\n---\n\n# ${input.title?.trim() || 'New page'}\n\nWrite the reader outcome, instructions, and supporting evidence here.\n`)
    checkContent(content)
    if (input.action === 'rename' && project.generator === 'docusaurus') {
      // File moves preserve the public URL, including custom slugs, without introducing redirects.
      const parsed = matter(content)
      if (typeof parsed.data.slug !== 'string') {
        const rootRoute = await resolvePageRoute(root, project, `${project.contentDir}/index.md`, '---\nslug: /\n---\n')
        parsed.data.slug = `/${oldRoute!.slice(rootRoute === '/' ? 0 : rootRoute.length).replace(/^\//, '')}`
      }
      content = matter.stringify(parsed.content, parsed.data)
    }
    const newRoute = target ? await resolvePageRoute(root, project, target, input.action === 'rename' ? content : undefined) : undefined
    const rewrites = new Map<string, string>()
    const inbound: string[] = []
    for (const page of known) {
      const raw = page === input.path && old ? content : await readFile(join(root, page), 'utf8')
      const moved = input.action === 'rename' && page === input.path
      const rewritten = rewriteLinks(raw, (href) => {
        if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) return href
        const [url, suffix = ''] = splitSuffix(href)
        const resolved = url.startsWith('/') ? resolve(root, project.contentDir, `.${url}`) : resolve(root, dirname(page), url)
        const matches = old && (samePage(resolved, resolve(root, input.path)) || url === oldRoute)
        if (matches && page !== input.path) inbound.push(page)
        if (matches && target) {
          if (url.startsWith('/')) return `${newRoute}${suffix}`
          return `${portable(relative(dirname(join(root, moved ? input.to! : page)), join(root, target)))}${suffix}`
        }
        if (moved && !url.startsWith('/')) return `${portable(relative(dirname(join(root, input.to!)), resolved))}${suffix}`
        return href
      })
      if (rewritten !== raw || moved) rewrites.set(moved ? input.to! : page, rewritten)
    }
    if (input.action === 'delete' && inbound.length && !target) throw new DoxloopError(`This page is linked from ${[...new Set(inbound)].join(', ')}. Choose a replacement page before deleting it.`)
    const files = [...new Set([input.path, ...(destination ? [destination] : []), ...rewrites.keys(), ...navFiles, EVIDENCE_MAP_FILE, REDIRECTS_FILE])]
    const result = await applyDirectEdit(root, { kind: 'edit', requestText: `${input.action === 'create' ? 'Created' : input.action === 'rename' ? 'Moved' : 'Deleted'} ${input.path}${target ? ` → ${target}` : ''}`, files, pagesChanged: Math.max(1, rewrites.size), apply: async () => {
      if (old && fingerprint(await readFile(join(root, input.path), 'utf8')) !== old.fingerprint) throw new DoxloopError('The page changed before the operation started.')
      for (const [path, text] of rewrites) { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), text, 'utf8') }
      if (input.action === 'create') { await mkdir(dirname(join(root, input.path)), { recursive: true }); await writeFile(join(root, input.path), content, { flag: 'wx' }) }
      else await rm(join(root, input.path))
      const title = matter(content).data.title || input.title || input.path
      if (project.generator === 'doxbrix') await updateDoxbrixNavigation(root, project, input, String(title))
      else await adapter?.writeNavigation?.({ root, contentRoot: join(root, project.contentDir), project, action: input.action === 'create' ? 'add' : input.action === 'delete' ? 'remove' : 'rename', page: { path: relative(join(root, project.contentDir), join(root, input.action === 'rename' ? input.to! : input.path)), title: String(title) }, ...(input.action === 'rename' ? { from: relative(join(root, project.contentDir), join(root, input.path)) } : {}) })
      const map = await readEvidenceMap(root) ?? { schemaVersion: 1 as const, pages: {} }
      if (input.action === 'rename') map.pages[input.to!] = map.pages[input.path] ?? { sources: [], confidence: 'needs-human' }
      if (input.action === 'create') map.pages[input.path] = { sources: [], confidence: 'needs-human' }
      else delete map.pages[input.path]
      await writeEvidenceMap(root, map)
      if (oldRoute && newRoute && oldRoute !== newRoute) {
        if (project.generator === 'doxbrix') {
          const redirects = await readRedirects(root)
          for (const [from, to] of Object.entries(redirects)) if (to === oldRoute) redirects[from] = newRoute
          redirects[oldRoute] = newRoute
          await writeFile(join(root, REDIRECTS_FILE), `${JSON.stringify(redirects, null, 2)}\n`)
        } else {
          // Native generators render this compatibility page at the old address.
          const slug = project.generator === 'docusaurus' && typeof matter(old!.content).data.slug === 'string' ? `slug: ${JSON.stringify(matter(old!.content).data.slug)}\n` : ''
          const stub = `---\n${slug}title: ${JSON.stringify(`${title} (moved)`)}\ndescription: "This documentation page has moved."\n---\n\n<meta http-equiv="refresh" content="0; url=${escapeHtml(newRoute)}" />\n\n# This page has moved\n\n[Continue to the current page](${newRoute}). Update your bookmark to use the new address.\n`
          await writeFile(join(root, input.path), stub, 'utf8')
        }
      }
    } })
    return { ...result, ...(input.action === 'delete' ? {} : { path: destination }) }
  })
}

async function validateNewPath(root: string, project: DoxloopProject, path: string | undefined, known: string[], extensions: string[]): Promise<void> {
  if (!path || /[\s?#%<>"'`]/.test(path) || path.split(/[\\/]/).some((part) => !part || part.startsWith('.')) || !extensions.includes(extname(path))) throw new DoxloopError('Use a relative Markdown path with letters, numbers, hyphens, and an allowed extension.')
  const absolute = await safePath(root, path)
  const content = resolve(root, project.contentDir)
  if (!absolute.startsWith(`${content}/`)) throw new DoxloopError('The new page must be inside the documentation content directory.')
  if (known.some((file) => file.toLowerCase() === path.toLowerCase()) || await pathExists(absolute)) throw new DoxloopError('A page or file already exists at that path.')
}
async function updateDoxbrixNavigation(root: string, project: DoxloopProject, input: PageLifecycleInput, title: string): Promise<void> {
  const contentRoot = join(root, project.contentDir)
  if (input.action === 'create') return appendDoxbrixNavigationPage(root, project, { file: pageId(contentRoot, join(root, input.path)), title })
  const site = await loadSiteConfig(root, project)
  const oldId = pageId(contentRoot, join(root, input.path))
  const walk = (nodes: DoxbrixNavNode[]): DoxbrixNavNode[] => nodes.flatMap((node): DoxbrixNavNode[] => node.type === 'page' && node.file === oldId ? input.action === 'rename' ? [{ ...node, file: pageId(contentRoot, join(root, input.to!)) }] : [] : node.type === 'group' ? [{ ...node, items: walk(node.items) }] : [node])
  site.spaces = site.spaces.map((space) => ({ ...space, nav: walk(space.nav) }))
  await writeFile(await siteConfigPath(root, project), `${JSON.stringify(site, null, 2)}\n`)
}
export async function readRedirects(root: string): Promise<Record<string, string>> {
  try {
    const raw = JSON.parse(await readFile(join(root, REDIRECTS_FILE), 'utf8')) as Record<string, unknown>
    return Object.fromEntries(Object.entries(raw).filter(([from, to]) => safeRoute(from) && typeof to === 'string' && safeRoute(to) && to !== from)) as Record<string, string>
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error }
}
function safeRoute(route: string): boolean { return /^\/(?!\/)[a-zA-Z0-9/_-]*$/.test(route) && !route.split('/').includes('..') }
function checkContent(content: string): void { if (typeof content !== 'string' || Buffer.byteLength(content) > 1_000_000 || content.includes('\0')) throw new DoxloopError('Page text must be valid text under 1 MB.') }
function samePage(a: string, b: string): boolean { return a === b || a.replace(/\.(md|mdx)$/, '') === b.replace(/\.(md|mdx)$/, '') }
function portable(path: string): string { return path.replace(/\\/g, '/') }
function splitSuffix(href: string): [string, string?] { const index = href.search(/[?#]/); return index < 0 ? [href] : [href.slice(0, index), href.slice(index)] }
export function rewriteLinks(raw: string, rewrite: (href: string) => string): string {
  // Fences and inline code are examples, not navigation. Reference definitions are links too.
  return raw.split(/(^[ \t]*```[^\n]*\n[\s\S]*?^[ \t]*```[^\n]*$|^[ \t]*~~~[^\n]*\n[\s\S]*?^[ \t]*~~~[^\n]*$|`+[^`\n]*`+)/gm).map((part, index) => index % 2 ? part : part
    .replace(/(!?\[[^\]]*\]\()([^\s)]+)([^)]*\))/g, (_, start: string, href: string, end: string) => `${start}${rewrite(href)}${end}`)
    .replace(/(^[ \t]{0,3}\[[^\]]+\]:\s*<?)([^\s>]+)(>?)/gm, (_, start: string, href: string, end: string) => `${start}${rewrite(href)}${end}`)
    .replace(/(\b(?:src|href)=["'])([^"']+)(["'])/g, (_, start: string, href: string, end: string) => `${start}${rewrite(href)}${end}`)).join('')
}
function escapeHtml(value: string): string { return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') }
