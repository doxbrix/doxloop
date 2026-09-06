import { contentLinks } from './content-links.js'
import { lookup } from 'node:dns/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { join } from 'node:path'
import { isPrivateAddress } from './capture.js'
import { pathExists } from './fs.js'
import { loadPages, relativePath } from './project.js'
import { QUALITY_CODES } from './quality-contract.js'
import type { DoxloopProject, QualityCheck, QualityConfig } from './types.js'

const CACHE_FILE = join('.doxloop', 'cache', 'external-links.json')
const MAX_REDIRECTS = 5

interface LinkCacheEntry { checkedAt: string; status: number; finalUrl: string }
interface LinkCache { schemaVersion: 1; links: Record<string, LinkCacheEntry> }

export async function checkExternalLinks(
  root: string,
  project: DoxloopProject,
  config: QualityConfig,
  options: { offline?: boolean; fetch?: typeof globalThis.fetch; resolveHostname?: (hostname: string) => Promise<string[]> } = {},
): Promise<QualityCheck[]> {
  const references = await externalReferences(root, project)
  if (references.size === 0) return [{ code: QUALITY_CODES.linkOk, category: 'links', status: 'pass', message: 'No literal external links were found in Markdown, HTML attributes, or reStructuredText. Dynamic links and cross-reference roles require the native generator check.' }]
  const cache = await readCache(root)
  const checks: QualityCheck[] = []
  const links = config.links ?? {}
  const offline = options.offline ?? links.mode === 'offline'
  const maxAge = (links.cacheHours ?? 24) * 3_600_000
  for (const [url, files] of references) {
    const file = [...files].sort().join(', ')
    if (ignored(url, links.ignore ?? []) || !allowed(url, links.allowHosts ?? [])) {
      checks.push({ code: QUALITY_CODES.linkSkipped, category: 'links', status: 'skipped', message: `External link is excluded by policy: ${url}`, file })
      continue
    }
    const cached = cache.links[url]
    const fresh = cached && Date.now() - Date.parse(cached.checkedAt) <= maxAge
    if (offline) {
      checks.push(cached
        ? resultForStatus(url, file, cached.status, `Cached result from ${cached.checkedAt}.`)
        : { code: QUALITY_CODES.linkSkipped, category: 'links', status: 'skipped', message: `External link was not checked in offline mode: ${url}`, file, detail: 'Run without --offline to populate the cache.' })
      continue
    }
    if (fresh) {
      checks.push(resultForStatus(url, file, cached.status, `Cached result from ${cached.checkedAt}.`))
      continue
    }
    try {
      const result = await fetchLink(url, {
        fetch: options.fetch ?? globalThis.fetch,
        resolveHostname: options.resolveHostname ?? resolvePublicHostname,
        timeoutMs: links.timeoutMs ?? 8_000,
        retries: links.retries ?? 2,
      })
      cache.links[url] = { checkedAt: new Date().toISOString(), status: result.status, finalUrl: result.url }
      checks.push(resultForStatus(url, file, result.status))
    } catch (error) {
      checks.push({ code: QUALITY_CODES.linkUnavailable, category: 'links', status: 'warning', message: `External link could not be confirmed: ${url}`, file, detail: error instanceof Error ? error.message : String(error) })
    }
  }
  if (!offline) await writeCache(root, cache)
  return checks
}

async function externalReferences(root: string, project: DoxloopProject): Promise<Map<string, Set<string>>> {
  const output = new Map<string, Set<string>>()
  for (const path of await loadPages(root, project)) {
    const raw = await readFile(path, 'utf8')
    for (const rawUrl of contentLinks(raw)) {
      if (!/^https?:\/\//i.test(rawUrl)) continue
      let url: URL
      try { url = new URL(rawUrl) } catch { continue }
      url.hash = ''
      const key = url.toString()
      const files = output.get(key) ?? new Set<string>()
      files.add(relativePath(root, path))
      output.set(key, files)
    }
  }
  return output
}

async function fetchLink(url: string, options: { fetch: typeof globalThis.fetch; resolveHostname: (hostname: string) => Promise<string[]>; timeoutMs: number; retries: number }): Promise<{ status: number; url: string }> {
  let lastError: unknown
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      return await fetchLinkOnce(url, options)
    } catch (error) {
      lastError = error
      if (attempt === options.retries) break
    }
  }
  throw lastError
}

async function fetchLinkOnce(raw: string, options: { fetch: typeof globalThis.fetch; resolveHostname: (hostname: string) => Promise<string[]>; timeoutMs: number }): Promise<{ status: number; url: string }> {
  let current = new URL(raw)
  for (let count = 0; count <= MAX_REDIRECTS; count += 1) {
    if (!['http:', 'https:'].includes(current.protocol) || current.username || current.password) throw new Error('Only credential-free HTTP and HTTPS links are allowed.')
    const addresses = await options.resolveHostname(current.hostname)
    if (addresses.length === 0 || addresses.some(isPrivateAddress)) throw new Error(`Private or unresolved host blocked: ${current.hostname}`)
    const response = await options.fetch(current, { method: 'HEAD', redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs), headers: { 'user-agent': 'Doxloop-Link-Checker/1' } })
    if (response.status >= 300 && response.status < 400) {
      if (count === MAX_REDIRECTS) throw new Error('Redirect limit exceeded.')
      const location = response.headers.get('location')
      if (!location) return { status: response.status, url: current.toString() }
      current = new URL(location, current)
      continue
    }
    if (response.status === 405) {
      const get = await options.fetch(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(options.timeoutMs), headers: { range: 'bytes=0-0', 'user-agent': 'Doxloop-Link-Checker/1' } })
      return { status: get.status, url: current.toString() }
    }
    if (response.status >= 500 || response.status === 408 || response.status === 429) throw new Error(`Temporary HTTP ${response.status}.`)
    return { status: response.status, url: current.toString() }
  }
  throw new Error('Redirect limit exceeded.')
}

function resultForStatus(url: string, file: string, status: number, detail?: string): QualityCheck {
  if (status >= 200 && status < 400) return { code: QUALITY_CODES.linkOk, category: 'links', status: 'pass', message: `External link responded with HTTP ${status}: ${url}`, file, ...(detail ? { detail } : {}) }
  if (status === 401 || status === 403) return { code: QUALITY_CODES.linkUnavailable, category: 'links', status: 'warning', message: `External link requires authentication (HTTP ${status}): ${url}`, file, ...(detail ? { detail } : {}) }
  return { code: QUALITY_CODES.linkBroken, category: 'links', status: 'fail', message: `External link responded with HTTP ${status}: ${url}`, file, ...(detail ? { detail } : {}) }
}

function allowed(raw: string, hosts: string[]): boolean { return hosts.length === 0 || hosts.includes(new URL(raw).hostname) }
function ignored(raw: string, patterns: string[]): boolean { return patterns.some((pattern) => raw === pattern || raw.startsWith(pattern)) }
async function resolvePublicHostname(hostname: string): Promise<string[]> { return isIP(hostname) ? [hostname] : (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address) }

async function readCache(root: string): Promise<LinkCache> {
  const path = join(root, CACHE_FILE)
  if (!(await pathExists(path))) return { schemaVersion: 1, links: {} }
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as LinkCache
    return value.schemaVersion === 1 && value.links && typeof value.links === 'object' ? value : { schemaVersion: 1, links: {} }
  } catch { return { schemaVersion: 1, links: {} } }
}

async function writeCache(root: string, cache: LinkCache): Promise<void> {
  const path = join(root, CACHE_FILE)
  await mkdir(join(root, '.doxloop', 'cache'), { recursive: true })
  await writeFile(path, `${JSON.stringify(cache, null, 2)}\n`, 'utf8')
}
