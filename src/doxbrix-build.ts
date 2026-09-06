import { readRedirects } from './page-operations.js'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import matter from 'gray-matter'
import { renderMarkdown } from './doxbrix-markdown.js'
import { DoxloopError } from './errors.js'
import { listFiles, resolveContainedDirectory } from './fs.js'
import { loadQualityConfig } from './quality-config.js'
import { reverifyClaims } from './quality-claims.js'
import {
  loadPages,
  loadProject,
  loadSiteConfig,
  pageId,
  ROOT_CONTENT_IGNORED_DIRECTORIES,
} from './project.js'
import { doxbrixDocument } from './preview.js'

const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const DOXBRIX_CSS = resolve(PACKAGE_ROOT, 'assets', 'doxbrix-preview.css')
const ASSET_EXTENSIONS = new Set([
  '.avif', '.bmp', '.eot', '.gif', '.ico', '.jpeg', '.jpg', '.mov', '.mp3',
  '.mp4', '.ogg', '.otf', '.pdf', '.png', '.svg', '.ttf', '.wav', '.webm',
  '.webp', '.woff', '.woff2',
])

export interface DoxbrixBuildOptions {
  root: string
  outDir?: string
  /** Origin-relative mount point, for example `/repository`. */
  basePath?: string
  /** Public origin used for canonical URLs and sitemap entries. */
  siteUrl?: string
  clean?: boolean
}

export interface StaticBuildResult {
  outputDir: string
  pages: number
  assets: number
  basePath: string
  siteUrl?: string
}

/** Build the built-in Doxbrix reader into portable static files. */
export async function buildDoxbrixStaticSite(
  options: DoxbrixBuildOptions,
): Promise<StaticBuildResult> {
  const root = resolve(options.root)
  const project = await loadProject(root)
  if (project.generator !== 'doxbrix') {
    throw new DoxloopError('The built-in static builder only supports Doxbrix projects.')
  }
  const outputDir = resolve(options.outDir ?? join(root, 'build'))
  if (outputDir === root) {
    throw new DoxloopError('Doxbrix build output cannot replace the project directory.')
  }
  const contentRoot = await resolveContainedDirectory(
    root,
    project.contentDir,
    'Build content directory',
    { allowRoot: true },
  )
  if (options.clean !== false) await rm(outputDir, { recursive: true, force: true })
  await mkdir(join(outputDir, '__doxloop'), { recursive: true })

  const [paths, site, css, qualityConfig, verification] = await Promise.all([
    loadPages(root, project),
    loadSiteConfig(root, project),
    readFile(DOXBRIX_CSS, 'utf8'),
    loadQualityConfig(root),
    loadQualityConfig(root).then((config) => config.readerVerification?.enabled ? reverifyClaims(root, project, false).then((result) => result.metadata) : undefined),
  ])
  if (paths.length === 0) throw new DoxloopError('Doxbrix static build found no pages.')

  const basePath = normalizeBasePath(options.basePath)
  const siteUrl = publicSiteUrl(options.siteUrl, site.site)
  const search: Array<{ title: string; description: string; href: string; text: string }> = []
  const sitemap: string[] = []
  const firstId = pageId(contentRoot, paths[0]!)

  for (const path of paths) {
    const id = pageId(contentRoot, path)
    const parsed = matter(await readFile(path, 'utf8'))
    const title = text(parsed.data.title) || labelFromId(id)
    const description = text(parsed.data.description)
    const href = `${basePath}/${id}`
    const canonical = text(parsed.data.canonical) || (siteUrl ? new URL(`${id}/`, trailingSlash(siteUrl)).toString() : undefined)
    const socialImage = resolvePublicReference(text(parsed.data.socialImage), siteUrl)
    const verificationEntry = qualityConfig.readerVerification?.enabled
      ? verification?.pages[relative(root, path).replace(/\\/g, '/')]
      : undefined
    const html = doxbrixDocument({
      site,
      title,
      ...(description ? { description } : {}),
      ...(canonical ? { canonical } : {}),
      ...(socialImage ? { socialImage } : {}),
      current: id,
      rendered: renderMarkdown(parsed.content),
      ...(verificationEntry ? { verification: verificationEntry } : {}),
      basePath,
      liveReload: false,
    })
    const pageOutput = join(outputDir, ...id.split('/'), 'index.html')
    await mkdir(dirname(pageOutput), { recursive: true })
    await writeFile(pageOutput, html, 'utf8')
    if (id.endsWith('/index')) await writeFile(join(outputDir, ...id.split('/').slice(0, -1), 'index.html'), html, 'utf8')
    if (id === firstId) await writeFile(join(outputDir, 'index.html'), html, 'utf8')
    search.push({ title, description: description ?? '', href, text: markdownSearchText(parsed.content) })
    if (siteUrl) sitemap.push(new URL(`${id}/`, trailingSlash(siteUrl)).toString())
  }

  for (const [from, to] of Object.entries(await readRedirects(root))) {
    const target = `${basePath}${to}`
    const output = join(outputDir, from.replace(/^\//, ''), 'index.html')
    await mkdir(dirname(output), { recursive: true })
    await writeFile(output, `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${target}"><link rel="canonical" href="${target}"><a href="${target}">This page has moved</a>`, 'utf8')
  }

  await writeFile(join(outputDir, '__doxloop', 'doxbrix.css'), css, 'utf8')
  await writeFile(join(outputDir, '__doxloop', 'search-index'), JSON.stringify(search), 'utf8')
  await writeFile(join(outputDir, '__doxloop', 'search-index.json'), `${JSON.stringify(search, null, 2)}\n`, 'utf8')
  await writeFile(join(outputDir, 'sitemap.xml'), sitemapXml(sitemap), 'utf8')
  await writeFile(join(outputDir, 'robots.txt'), robotsTxt(siteUrl), 'utf8')

  let assets = 0
  const ignoredDirectories = new Set(ROOT_CONTENT_IGNORED_DIRECTORIES)
  ignoredDirectories.add(relative(contentRoot, outputDir).split(/[\\/]/)[0] || 'build')
  for (const asset of await listFiles(contentRoot, ASSET_EXTENSIONS, { ignoredDirectories })) {
    const destination = join(outputDir, relative(contentRoot, asset))
    await mkdir(dirname(destination), { recursive: true })
    await cp(asset, destination)
    assets++
  }

  return {
    outputDir,
    pages: paths.length,
    assets,
    basePath,
    ...(siteUrl ? { siteUrl } : {}),
  }
}

function publicSiteUrl(explicit: string | undefined, site: Record<string, unknown> | undefined): string | undefined {
  const configured = explicit ?? process.env.DOXLOOP_SITE_URL ?? text(site?.url)
  if (!configured) return undefined
  let url: URL
  try { url = new URL(configured) } catch { throw new DoxloopError(`Invalid static site URL: ${configured}`) }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new DoxloopError('Static site URL must be an HTTP(S) URL without credentials, query, or fragment.')
  }
  return url.toString()
}

function resolvePublicReference(value: string | undefined, siteUrl: string | undefined): string | undefined {
  if (!value) return undefined
  if (/^https?:\/\//i.test(value) || !siteUrl) return value
  return new URL(value.replace(/^\//, ''), trailingSlash(siteUrl)).toString()
}

function normalizeBasePath(value = ''): string {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '/') return ''
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed) || trimmed.startsWith('//')) {
    throw new DoxloopError('Static build base path must be an origin-relative URL path.')
  }
  const normalized = `/${trimmed.replace(/^\/+|\/+$/g, '')}`
  if (normalized.split('/').some((part) => part === '..')) {
    throw new DoxloopError('Static build base path cannot leave its URL root.')
  }
  return normalized
}

function sitemapXml(urls: string[]): string {
  const body = urls.map((url) => `  <url><loc>${xml(url)}</loc></url>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}${body ? '\n' : ''}</urlset>\n`
}

function robotsTxt(siteUrl?: string): string {
  return `User-agent: *\nAllow: /\n${siteUrl ? `Sitemap: ${new URL('sitemap.xml', trailingSlash(siteUrl)).toString()}\n` : ''}`
}

function trailingSlash(value: string): string { return value.endsWith('/') ? value : `${value}/` }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
function xml(value: string): string { return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;') }
function labelFromId(id: string): string { return id.split('/').at(-1)!.replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase()) }
function markdownSearchText(markdown: string): string {
  return markdown.replace(/```[\s\S]*?```/g, ' ').replace(/`([^`]+)`/g, '$1').replace(/!\[[^\]]*\]\([^)]+\)/g, ' ').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/<[^>]+>/g, ' ').replace(/[#>*_~|=-]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 12_000)
}
