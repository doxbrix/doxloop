/**
 * Bounded crawler for existing documentation websites.
 *
 * A docs-site source points at a live documentation URL. The crawler discovers
 * pages through the sitemap, `llms.txt`, and same-scope link following, then
 * converts each HTML page into Markdown so the authoring agent can read the
 * existing documentation as evidence alongside product source code.
 *
 * Safety controls mirror the remote OpenAPI fetcher: HTTPS/HTTP only, no
 * embedded credentials, public hosts only, redirect and size limits, and a hard
 * page cap. The crawler never executes page scripts.
 */
import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'
import { isPrivateAddress } from './capture.js'
import { DoxloopError } from './errors.js'
import { summarizeHtmlDocument, decodeEntities } from './html-markdown.js'

export const DEFAULT_DOCS_CRAWL_PAGE_LIMIT = 150
export const MAX_DOCS_CRAWL_PAGE_LIMIT = 500
const MAX_PAGE_BYTES = 2 * 1024 * 1024
const MAX_SITEMAP_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 3
const MAX_SITEMAP_FILES = 8
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_CONCURRENCY = 4
const USER_AGENT = 'doxloop-docs-crawler/1 (+https://github.com/doxbrix/doxloop)'
const NON_PAGE_EXTENSIONS = /\.(png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|gz|tgz|tar|mp4|mp3|webm|woff2?|ttf|otf|css|js|mjs|json|xml|txt|yaml|yml|csv|rss|atom)$/i

export type DocsCrawlDiscovery = 'sitemap' | 'llms-txt' | 'links'

export interface DocsSitePage {
  /** Normalized absolute URL. */
  url: string
  /** Path relative to the crawl scope, without a leading slash. Empty for the entry page. */
  path: string
  title: string
  description?: string
  language?: string
  headings: Array<{ level: number; text: string }>
  words: number
  /** Same-scope documentation links (normalized absolute URLs). */
  internalLinks: string[]
  /** Links outside the crawl scope. */
  externalLinks: string[]
  images: string[]
  markdown: string
  hash: string
  fetchedAt: string
}

export interface DocsSiteSkippedPage {
  url: string
  reason: string
  status?: number
}

export interface DocsSiteSnapshot {
  schemaVersion: 1
  /** Entry URL exactly as configured. */
  url: string
  origin: string
  /** Scope prefix (path of the entry URL, normalized to end with `/`). */
  scope: string
  crawledAt: string
  generator?: string
  discovery: DocsCrawlDiscovery[]
  pageLimit: number
  /** True when discovery found more pages than the crawl limit allowed. */
  truncated: boolean
  pages: DocsSitePage[]
  skipped: DocsSiteSkippedPage[]
  /** Same-scope links that pointed at pages which failed to load. */
  brokenLinks: Array<{ url: string; from: string; status?: number }>
  warnings: string[]
  totals: { pages: number; words: number; images: number; discovered: number }
  hash: string
}

export interface DocsCrawlOptions {
  fetch?: typeof globalThis.fetch
  resolveHostname?: (hostname: string) => Promise<string[]>
  pageLimit?: number
  timeoutMs?: number
  concurrency?: number
  /** Cookie header from a recorded sign-in session for protected documentation. */
  cookieHeader?: string
  onProgress?: (progress: { fetched: number; discovered: number; url: string }) => void
  signal?: AbortSignal
}

interface CrawlContext {
  fetcher: typeof globalThis.fetch
  resolveHostname: (hostname: string) => Promise<string[]>
  timeoutMs: number
  cookieHeader?: string
  robots: RobotsRules
  signal?: AbortSignal
}

interface RobotsRules { disallow: string[]; allow: string[]; sitemaps?: string[] }

interface FetchResult { url: string; status: number; contentType: string; body: string }

export interface DocsCrawlScope { origin: string; scope: string; entry: string }

/** Validate and normalize a documentation site URL into a crawl scope. */
export function docsSiteScope(raw: string): DocsCrawlScope {
  let url: URL
  try { url = new URL(raw.trim()) } catch { throw new DoxloopError(`Invalid documentation site URL: ${raw}`) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new DoxloopError('Documentation site URLs must use HTTP or HTTPS.')
  if (url.username || url.password) throw new DoxloopError('Documentation site URLs cannot contain embedded credentials.')
  url.hash = ''
  url.search = ''
  const entry = url.toString()
  let scope = url.pathname
  if (NON_PAGE_EXTENSIONS.test(scope) || /\.html?$/i.test(scope)) scope = scope.slice(0, scope.lastIndexOf('/') + 1)
  if (!scope.endsWith('/')) scope = `${scope}/`
  return { origin: url.origin, scope, entry }
}

export function isDocsSiteUrl(location: string): boolean {
  return /^https?:\/\//i.test(location)
}

/** Crawl a documentation website into a Markdown snapshot. */
export async function crawlDocumentationSite(rawUrl: string, options: DocsCrawlOptions = {}): Promise<DocsSiteSnapshot> {
  const { origin, scope, entry } = docsSiteScope(rawUrl)
  const pageLimit = Math.min(MAX_DOCS_CRAWL_PAGE_LIMIT, Math.max(1, options.pageLimit ?? DEFAULT_DOCS_CRAWL_PAGE_LIMIT))
  const context: CrawlContext = {
    fetcher: options.fetch ?? globalThis.fetch,
    resolveHostname: options.resolveHostname ?? defaultResolveHostname,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    ...(options.cookieHeader ? { cookieHeader: options.cookieHeader } : {}),
    robots: { disallow: [], allow: [], sitemaps: [] },
    ...(options.signal ? { signal: options.signal } : {}),
  }
  await assertPublicHost(new URL(entry), context.resolveHostname)
  context.robots = await loadRobots(origin, context)

  const warnings: string[] = []
  const discovery: DocsCrawlDiscovery[] = []
  const scopeRoot = scope.length > 1 ? scope.slice(0, -1) : scope
  const inScope = (url: string): boolean => {
    if (!url.startsWith(origin)) return false
    const pathname = new URL(url).pathname
    return pathname === scopeRoot || pathname.startsWith(scope)
  }
  const normalize = (raw: string, base: string): string | undefined => normalizeUrl(raw, base)

  const queue: string[] = []
  const seen = new Set<string>()
  const enqueue = (url: string | undefined): void => {
    if (!url || seen.has(url) || !inScope(url)) return
    if (NON_PAGE_EXTENSIONS.test(new URL(url).pathname)) return
    if (!robotsAllows(context.robots, new URL(url).pathname)) return
    seen.add(url)
    queue.push(url)
  }
  enqueue(normalize(entry, entry))

  const sitemapUrls = await discoverSitemap(origin, scope, context, warnings)
  if (sitemapUrls.length > 0) {
    discovery.push('sitemap')
    for (const url of sitemapUrls) enqueue(normalize(url, origin))
  }
  const llmsUrls = await discoverLlmsText(origin, scope, context)
  if (llmsUrls.length > 0) {
    discovery.push('llms-txt')
    for (const url of llmsUrls) enqueue(normalize(url, origin))
  }

  const pages: DocsSitePage[] = []
  const skipped: DocsSiteSkippedPage[] = []
  const linkSources = new Map<string, string>()
  let generator: string | undefined
  let fetched = 0
  let followedLinks = false
  let inFlight = 0

  // A worker with nothing queued waits while another worker's page is still
  // loading, because that page may link to more pages; it stops only when the
  // queue is empty and nothing is in flight.
  const worker = async (): Promise<void> => {
    while (pages.length < pageLimit) {
      if (queue.length === 0) {
        if (inFlight === 0) break
        await new Promise((resolveWait) => setTimeout(resolveWait, 25))
        continue
      }
      const url = queue.shift()!
      inFlight += 1
      try {
        await crawlOne(url)
      } finally {
        inFlight -= 1
      }
    }
  }

  const crawlOne = async (url: string): Promise<void> => {
      fetched += 1
      options.onProgress?.({ fetched, discovered: seen.size, url })
      let result: FetchResult
      try {
        result = await fetchPage(url, context)
      } catch (error) {
        skipped.push({ url, reason: error instanceof Error ? error.message : String(error) })
        return
      }
      if (result.status >= 400) {
        skipped.push({ url, reason: `HTTP ${result.status}`, status: result.status })
        return
      }
      if (!result.contentType.includes('text/html') && !result.contentType.includes('application/xhtml')) {
        skipped.push({ url, reason: `Unsupported content type ${result.contentType || 'unknown'}` })
        return
      }
      const finalUrl = normalize(result.url, url) ?? url
      if (finalUrl !== url) {
        if (seen.has(finalUrl) && pages.some((page) => page.url === finalUrl)) return
        seen.add(finalUrl)
        if (!inScope(finalUrl)) {
          skipped.push({ url, reason: `Redirected outside the documentation scope to ${finalUrl}` })
          return
        }
      }
      if (pages.some((page) => page.url === finalUrl)) return
      const summary = summarizeHtmlDocument(result.body)
      if (!generator && summary.generator) generator = summary.generator
      const internal: string[] = []
      const external: string[] = []
      for (const link of summary.links) {
        const resolved = normalize(link, finalUrl)
        if (!resolved) continue
        if (inScope(resolved)) {
          if (!internal.includes(resolved)) internal.push(resolved)
          if (!seen.has(resolved)) { followedLinks = true; linkSources.set(resolved, finalUrl) }
          enqueue(resolved)
        } else if (!external.includes(resolved)) external.push(resolved)
      }
      const images = summary.images.map((image) => normalize(image, finalUrl) ?? image)
      const title = summary.title?.replace(/\s*[|·–-]\s*[^|·–-]+$/, '').trim() || summary.headings.find((heading) => heading.level === 1)?.text || summary.headings[0]?.text || relativePath(finalUrl, origin, scope) || 'Home'
      pages.push({
        url: finalUrl,
        path: relativePath(finalUrl, origin, scope),
        title,
        ...(summary.description ? { description: summary.description } : {}),
        ...(summary.language ? { language: summary.language } : {}),
        headings: summary.headings,
        words: summary.words,
        internalLinks: internal,
        externalLinks: external,
        images,
        markdown: summary.markdown,
        hash: createHash('sha256').update(summary.markdown).digest('hex'),
        fetchedAt: new Date().toISOString(),
      })
  }
  const concurrency = Math.max(1, Math.min(8, options.concurrency ?? DEFAULT_CONCURRENCY))
  await Promise.all(Array.from({ length: concurrency }, () => worker()))
  if (followedLinks) discovery.push('links')

  const truncated = queue.length > 0 || pages.length >= pageLimit && seen.size > pages.length + skipped.length
  if (truncated) warnings.push(`Crawl stopped at the ${pageLimit}-page limit; ${seen.size - pages.length - skipped.length} discovered pages were not fetched.`)
  if (pages.length === 0) throw new DoxloopError(`No documentation pages could be read from ${entry}. ${skipped[0]?.reason ?? 'The site returned no HTML pages.'}`)

  const brokenLinks = skipped
    .filter((item) => item.status !== undefined && item.status >= 400 && linkSources.has(item.url))
    .map((item) => ({ url: item.url, from: linkSources.get(item.url)!, ...(item.status !== undefined ? { status: item.status } : {}) }))

  pages.sort((left, right) => left.path.localeCompare(right.path))
  const hash = createHash('sha256').update(pages.map((page) => `${page.url}\n${page.hash}`).join('\n')).digest('hex')
  return {
    schemaVersion: 1,
    url: rawUrl.trim(),
    origin,
    scope,
    crawledAt: new Date().toISOString(),
    ...(generator ? { generator: normalizeGenerator(generator) } : {}),
    discovery,
    pageLimit,
    truncated,
    pages,
    skipped,
    brokenLinks,
    warnings,
    totals: {
      pages: pages.length,
      words: pages.reduce((sum, page) => sum + page.words, 0),
      images: pages.reduce((sum, page) => sum + page.images.length, 0),
      discovered: seen.size,
    },
    hash,
  }
}

function relativePath(url: string, origin: string, scope: string): string {
  const pathname = new URL(url).pathname
  const scopeRoot = scope.length > 1 ? scope.slice(0, -1) : scope
  const relative = pathname === scopeRoot ? '' : pathname.startsWith(scope) ? pathname.slice(scope.length) : pathname.replace(/^\//, '')
  try { return decodeURIComponent(relative).replace(/\/$/, '') } catch { return relative.replace(/\/$/, '') }
}

function normalizeUrl(raw: string, base: string): string | undefined {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.startsWith('#') || /^(mailto|tel|javascript|data):/i.test(trimmed)) return undefined
  let url: URL
  try { url = new URL(trimmed, base) } catch { return undefined }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return undefined
  url.hash = ''
  url.search = ''
  url.username = ''
  url.password = ''
  let pathname = url.pathname.replace(/\/{2,}/g, '/')
  if (/\/index\.html?$/i.test(pathname)) pathname = pathname.replace(/index\.html?$/i, '')
  if (pathname.length > 1 && pathname.endsWith('/')) pathname = pathname.slice(0, -1)
  url.pathname = pathname
  return url.toString()
}

function normalizeGenerator(raw: string): string {
  const value = raw.toLowerCase()
  if (value.includes('docusaurus')) return 'docusaurus'
  if (value.includes('mkdocs')) return 'mkdocs'
  if (value.includes('sphinx')) return 'sphinx'
  if (value.includes('hugo')) return 'hugo'
  if (value.includes('vitepress')) return 'vitepress'
  if (value.includes('gitbook')) return 'gitbook'
  if (value.includes('mintlify')) return 'mintlify'
  if (value.includes('starlight') || value.includes('astro')) return 'starlight'
  if (value.includes('nextra') || value.includes('next.js')) return 'nextra'
  if (value.includes('jekyll')) return 'jekyll'
  if (value.includes('readme')) return 'readme'
  return raw.trim()
}

async function discoverSitemap(origin: string, scope: string, context: CrawlContext, warnings: string[]): Promise<string[]> {
  const candidates = unique([...(context.robots.sitemaps ?? []), `${origin}${scope}sitemap.xml`, `${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`])
  const urls: string[] = []
  let files = 0
  const visit = async (sitemapUrl: string): Promise<void> => {
    if (files >= MAX_SITEMAP_FILES) return
    files += 1
    let result: FetchResult
    try { result = await fetchText(sitemapUrl, context, MAX_SITEMAP_BYTES, 'application/xml, text/xml, text/plain;q=0.5') } catch { return }
    if (result.status >= 400 || !result.body.includes('<')) return
    const locations = [...result.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((match) => decodeEntities(match[1]!))
    if (/<sitemapindex/i.test(result.body)) {
      for (const child of locations) await visit(child)
      return
    }
    urls.push(...locations)
  }
  for (const candidate of candidates) {
    await visit(candidate)
    if (urls.length > 0) break
  }
  if (urls.length > 0 && !urls.some((url) => url.startsWith(origin) && new URL(url, origin).pathname.startsWith(scope))) {
    warnings.push('The sitemap did not list any pages inside the documentation scope; pages were discovered by following links instead.')
  }
  return urls
}

async function discoverLlmsText(origin: string, scope: string, context: CrawlContext): Promise<string[]> {
  for (const candidate of unique([`${origin}${scope}llms.txt`, `${origin}/llms.txt`])) {
    let result: FetchResult
    try { result = await fetchText(candidate, context, MAX_SITEMAP_BYTES, 'text/plain, text/markdown;q=0.9') } catch { continue }
    if (result.status >= 400 || result.contentType.includes('text/html')) continue
    const links = [...result.body.matchAll(/\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g)].map((match) => match[1]!)
    if (links.length > 0) return links.map((link) => new URL(link, origin).toString())
  }
  return []
}

async function loadRobots(origin: string, context: CrawlContext): Promise<RobotsRules> {
  const rules: RobotsRules = { disallow: [], allow: [], sitemaps: [] }
  let result: FetchResult
  try { result = await fetchText(`${origin}/robots.txt`, context, 512 * 1024, 'text/plain') } catch { return rules }
  if (result.status >= 400 || result.contentType.includes('text/html')) return rules
  let applies = false
  for (const rawLine of result.body.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim()
    if (!line) continue
    const separator = line.indexOf(':')
    if (separator === -1) continue
    const field = line.slice(0, separator).trim().toLowerCase()
    const value = line.slice(separator + 1).trim()
    if (field === 'user-agent') applies = value === '*' || value.toLowerCase().includes('doxloop')
    else if (field === 'sitemap') rules.sitemaps!.push(value)
    else if (applies && field === 'disallow' && value) rules.disallow.push(value)
    else if (applies && field === 'allow' && value) rules.allow.push(value)
  }
  return rules
}

function robotsAllows(rules: RobotsRules, pathname: string): boolean {
  const matches = (pattern: string): boolean => {
    const anchored = pattern.endsWith('$')
    const body = anchored ? pattern.slice(0, -1) : pattern
    const escaped = body.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
    return new RegExp(`^${escaped}${anchored ? '$' : ''}`).test(pathname)
  }
  const disallowed = rules.disallow.filter(matches).sort((left, right) => right.length - left.length)[0]
  if (!disallowed) return true
  const allowed = rules.allow.filter(matches).sort((left, right) => right.length - left.length)[0]
  return Boolean(allowed && allowed.length >= disallowed.length)
}

async function fetchPage(url: string, context: CrawlContext): Promise<FetchResult> {
  return fetchText(url, context, MAX_PAGE_BYTES, 'text/html, application/xhtml+xml;q=0.9, */*;q=0.1')
}

async function fetchText(url: string, context: CrawlContext, maxBytes: number, accept: string): Promise<FetchResult> {
  let current = url
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    const parsed = new URL(current)
    await assertPublicHost(parsed, context.resolveHostname)
    const headers = new Headers({ accept, 'user-agent': USER_AGENT, 'accept-language': 'en' })
    if (context.cookieHeader) headers.set('cookie', context.cookieHeader)
    const signal = context.signal ? AbortSignal.any([context.signal, AbortSignal.timeout(context.timeoutMs)]) : AbortSignal.timeout(context.timeoutMs)
    const response = await context.fetcher(current, { method: 'GET', redirect: 'manual', headers, signal })
    if (response.status >= 300 && response.status < 400) {
      if (redirects === MAX_REDIRECTS) throw new DoxloopError(`Redirect limit exceeded for ${url}.`)
      const location = response.headers.get('location')
      if (!location) throw new DoxloopError(`Redirect from ${current} did not include a location.`)
      current = new URL(location, current).toString()
      continue
    }
    const contentType = (response.headers.get('content-type') ?? '').toLowerCase()
    if (!response.ok) {
      try { await response.body?.cancel() } catch { /* ignore */ }
      return { url: current, status: response.status, contentType, body: '' }
    }
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new DoxloopError(`${current} exceeds the ${Math.round(maxBytes / 1024 / 1024)} MB page limit.`)
    const body = await boundedResponseText(response, maxBytes, current)
    return { url: current, status: response.status, contentType, body }
  }
  throw new DoxloopError(`Request for ${url} could not be completed.`)
}

async function boundedResponseText(response: Response, maximum: number, url: string): Promise<string> {
  if (!response.body) return await response.text()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maximum) {
      await reader.cancel()
      throw new DoxloopError(`${url} exceeds the ${Math.round(maximum / 1024 / 1024)} MB page limit.`)
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function assertPublicHost(url: URL, resolver: (hostname: string) => Promise<string[]>): Promise<void> {
  const hostname = url.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new DoxloopError('Documentation site URLs cannot target localhost or private networks.')
  }
  const addresses = isIP(hostname) ? [hostname] : await resolver(hostname)
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new DoxloopError('Documentation site URLs cannot target localhost or private networks.')
  }
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  try { return (await lookup(hostname, { all: true })).map((item) => item.address) } catch { throw new DoxloopError(`Documentation site host could not be resolved: ${hostname}`) }
}

function unique(values: string[]): string[] { return [...new Set(values)] }
