import { createHash } from 'node:crypto'
import { lookup } from 'node:dns/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { parseDocument } from 'yaml'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import { isSpecUrl } from './project.js'
import type { ApiStructuralDiff, OpenApiSnapshot, OpenApiSummary, SourceBinding } from './types.js'

const OPENAPI_CACHE_DIRECTORY = join('.doxloop', 'cache', 'openapi')
const MAX_SPEC_BYTES = 5 * 1024 * 1024
const MAX_REDIRECTS = 3
const METHODS = ['get', 'put', 'post', 'delete', 'patch', 'options', 'head', 'trace'] as const

export interface LoadedOpenApi {
  content: string
  hash: string
  document: Record<string, unknown>
  summary: OpenApiSummary
  snapshot: OpenApiSnapshot
  etag?: string
  lastModified?: string
  notModified?: boolean
}

export interface RemoteOpenApiCache {
  url: string
  content: string
  hash: string
  etag?: string
  lastModified?: string
}

export interface RemoteFetchOptions {
  fetch?: typeof globalThis.fetch
  resolveHostname?: (hostname: string) => Promise<string[]>
  validators?: { etag?: string; lastModified?: string }
  cached?: RemoteOpenApiCache
  maxBytes?: number
}

/** Parse and validate a JSON or YAML OpenAPI/Swagger document. */
export function parseOpenApi(content: string, location = 'OpenAPI specification'): LoadedOpenApi {
  if (Buffer.byteLength(content, 'utf8') > MAX_SPEC_BYTES) {
    throw new DoxloopError(`${location} exceeds the 5 MB OpenAPI safety limit.`)
  }
  let raw: unknown
  try {
    if (content.trimStart().startsWith('{')) raw = JSON.parse(content)
    else {
      const yaml = parseDocument(content, { prettyErrors: true })
      if (yaml.errors.length > 0) throw yaml.errors[0]
      raw = yaml.toJS({ maxAliasCount: 50 })
    }
  } catch (error) {
    throw new DoxloopError(`${location} is not valid JSON or YAML: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!isRecord(raw)) throw new DoxloopError(`${location} must contain an object at the document root.`)
  const version = text(raw.openapi) ?? text(raw.swagger)
  if (!version || (!/^3\.\d+(?:\.\d+)?(?:[-+].*)?$/.test(version) && version !== '2.0')) {
    throw new DoxloopError(`${location} must declare OpenAPI 3.x with "openapi" or Swagger 2.0 with "swagger".`)
  }
  const info = record(raw.info)
  const title = text(info.title)
  const apiVersion = text(info.version)
  if (!title) throw new DoxloopError(`${location} is missing the required info.title.`)
  if (!apiVersion) throw new DoxloopError(`${location} is missing the required info.version.`)
  const paths = record(raw.paths)
  if (Object.keys(paths).some((path) => !path.startsWith('/'))) {
    throw new DoxloopError(`${location} contains a path key that does not start with "/".`)
  }
  const snapshot = openApiSnapshot(raw, version)
  const servers = array(raw.servers).flatMap((item) => text(record(item).url) ?? [])
  if (version === '2.0' && text(raw.host)) servers.push(`${array(raw.schemes).flatMap(text)[0] ?? 'https'}://${text(raw.host)}${text(raw.basePath) ?? ''}`)
  const summary: OpenApiSummary = {
    title,
    version: apiVersion,
    specificationVersion: version,
    servers,
    securitySchemes: Object.keys(snapshot.securitySchemes).sort(),
    schemas: Object.keys(snapshot.schemas).sort(),
    operationCount: Object.keys(snapshot.operations).length,
  }
  return {
    content,
    hash: createHash('sha256').update(content).digest('hex'),
    document: raw,
    summary,
    snapshot,
  }
}

/** Load and validate either a local file or a safely fetched remote specification. */
export async function loadOpenApiSource(
  root: string,
  source: SourceBinding,
  validators?: { etag?: string; lastModified?: string },
): Promise<LoadedOpenApi> {
  if (!isSpecUrl(source.path)) {
    const path = resolve(root, source.path)
    let content: string
    try {
      content = await readFile(path, 'utf8')
    } catch {
      throw new DoxloopError(`The API specification does not exist or cannot be read: ${path}`)
    }
    return parseOpenApi(content, source.path)
  }
  const cached = await readRemoteCache(root, source.path)
  const effectiveValidators = validators ?? (cached ? { ...(cached.etag ? { etag: cached.etag } : {}), ...(cached.lastModified ? { lastModified: cached.lastModified } : {}) } : undefined)
  const remote = await fetchRemoteOpenApi(source.path, { ...(effectiveValidators ? { validators: effectiveValidators } : {}), ...(cached ? { cached } : {}) })
  const parsed = parseOpenApi(remote.content, source.path)
  const result: LoadedOpenApi = {
    ...parsed,
    ...(remote.etag ? { etag: remote.etag } : {}),
    ...(remote.lastModified ? { lastModified: remote.lastModified } : {}),
    ...(remote.notModified ? { notModified: true } : {}),
  }
  await writeRemoteCache(root, source.path, result)
  return result
}

/** Fetch a remote specification with redirect, SSRF, validator, type, and size controls. */
export async function fetchRemoteOpenApi(url: string, options: RemoteFetchOptions = {}): Promise<RemoteOpenApiCache & { notModified?: boolean }> {
  const fetcher = options.fetch ?? globalThis.fetch
  const resolveHostname = options.resolveHostname ?? defaultResolveHostname
  const maxBytes = options.maxBytes ?? MAX_SPEC_BYTES
  let current = safeRemoteUrl(url)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    await assertPublicRemote(current, resolveHostname)
    const headers = new Headers({ accept: 'application/json, application/yaml, application/x-yaml, text/yaml, text/plain;q=0.5' })
    if (redirects === 0 && options.validators?.etag) headers.set('if-none-match', options.validators.etag)
    if (redirects === 0 && options.validators?.lastModified) headers.set('if-modified-since', options.validators.lastModified)
    const response = await fetcher(current, { method: 'GET', redirect: 'manual', headers, signal: AbortSignal.timeout(15_000) })
    if (response.status === 304) {
      if (!options.cached) throw new DoxloopError(`Remote OpenAPI returned 304 but no cached document is available.`)
      return { ...options.cached, notModified: true }
    }
    if (response.status >= 300 && response.status < 400) {
      if (redirects === MAX_REDIRECTS) throw new DoxloopError(`Remote OpenAPI redirect limit exceeded for ${url}.`)
      const location = response.headers.get('location')
      if (!location) throw new DoxloopError(`Remote OpenAPI redirect from ${current} did not include a location.`)
      current = safeRemoteUrl(new URL(location, current).toString())
      continue
    }
    if (response.status === 401 || response.status === 403) {
      throw new DoxloopError(`Remote OpenAPI credentials are required. Configure a credential-free or pre-signed HTTPS URL; credentials are never stored by Doxloop.`)
    }
    if (!response.ok) throw new DoxloopError(`Remote OpenAPI request failed with HTTP ${response.status}.`)
    assertOpenApiContentType(response.headers.get('content-type'), current)
    const declared = Number(response.headers.get('content-length'))
    if (Number.isFinite(declared) && declared > maxBytes) throw new DoxloopError(`Remote OpenAPI exceeds the ${formatBytes(maxBytes)} safety limit.`)
    const content = await boundedResponseText(response, maxBytes)
    return {
      url: current,
      content,
      hash: createHash('sha256').update(content).digest('hex'),
      ...(response.headers.get('etag') ? { etag: response.headers.get('etag')! } : {}),
      ...(response.headers.get('last-modified') ? { lastModified: response.headers.get('last-modified')! } : {}),
    }
  }
  throw new DoxloopError(`Remote OpenAPI request could not be completed.`)
}

export function diffOpenApi(previous: OpenApiSnapshot | undefined, current: OpenApiSnapshot): ApiStructuralDiff {
  if (!previous) {
    return {
      operations: { added: Object.keys(current.operations), removed: [], changed: [] },
      schemas: { added: Object.keys(current.schemas), removed: [], changed: [] },
      securitySchemes: { added: Object.keys(current.securitySchemes), removed: [], changed: [] },
    }
  }
  return {
    operations: diffSnapshotRecords(previous.operations, current.operations, operationFacets),
    schemas: diffSnapshotRecords(previous.schemas, current.schemas),
    securitySchemes: diffSnapshotRecords(previous.securitySchemes, current.securitySchemes),
  }
}

export function openApiChangedIdentifiers(diff: ApiStructuralDiff): string[] {
  return [
    ...diff.operations.added,
    ...diff.operations.removed,
    ...diff.operations.changed.map((item) => item.id),
    ...diff.schemas.added.map((item) => `schema:${item}`),
    ...diff.schemas.removed.map((item) => `schema:${item}`),
    ...diff.schemas.changed.map((item) => `schema:${item.id}`),
    ...diff.securitySchemes.added.map((item) => `security:${item}`),
    ...diff.securitySchemes.removed.map((item) => `security:${item}`),
    ...diff.securitySchemes.changed.map((item) => `security:${item.id}`),
  ]
}

function openApiSnapshot(document: Record<string, unknown>, specificationVersion: string): OpenApiSnapshot {
  const operations: OpenApiSnapshot['operations'] = {}
  for (const [path, rawPath] of Object.entries(record(document.paths))) {
    const pathItem = record(rawPath)
    for (const method of METHODS) {
      if (!(method in pathItem) || !isRecord(pathItem[method])) continue
      const operation = record(pathItem[method])
      const id = `${method.toUpperCase()} ${path}`
      const parameters = [...array(pathItem.parameters), ...array(operation.parameters)]
      operations[id] = {
        operationId: text(operation.operationId) ?? '',
        parameters: stableHash(parameters),
        requestBody: stableHash(operation.requestBody),
        responses: stableHash(operation.responses),
        security: stableHash(operation.security ?? document.security),
        examples: stableHash(operationExamples(operation)),
        full: stableHash(operation),
      }
    }
  }
  const schemasSource = specificationVersion === '2.0'
    ? record(document.definitions)
    : record(record(document.components).schemas)
  const securitySource = specificationVersion === '2.0'
    ? record(document.securityDefinitions)
    : record(record(document.components).securitySchemes)
  return {
    schemaVersion: 1,
    specificationVersion,
    operations,
    schemas: hashRecord(schemasSource),
    securitySchemes: hashRecord(securitySource),
  }
}

function operationFacets(before: Record<string, string>, after: Record<string, string>): string[] {
  return ['operationId', 'parameters', 'requestBody', 'responses', 'security', 'examples']
    .filter((facet) => before[facet] !== after[facet])
}

function diffSnapshotRecords(
  before: Record<string, string | Record<string, string>>,
  after: Record<string, string | Record<string, string>>,
  facets?: (before: Record<string, string>, after: Record<string, string>) => string[],
): { added: string[]; removed: string[]; changed: Array<{ id: string; facets: string[] }> } {
  const beforeKeys = new Set(Object.keys(before))
  const afterKeys = new Set(Object.keys(after))
  const added = [...afterKeys].filter((key) => !beforeKeys.has(key)).sort()
  const removed = [...beforeKeys].filter((key) => !afterKeys.has(key)).sort()
  const changed = [...beforeKeys].filter((key) => afterKeys.has(key) && stableHash(before[key]) !== stableHash(after[key])).sort().map((id) => ({
    id,
    facets: facets && isRecord(before[id]) && isRecord(after[id]) ? facets(before[id], after[id]) : ['definition'],
  }))
  return { added, removed, changed }
}

function hashRecord(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => [key, stableHash(item)]))
}

function operationExamples(operation: Record<string, unknown>): unknown {
  return {
    examples: operation.examples,
    requestBody: record(operation.requestBody).content,
    responses: Object.fromEntries(Object.entries(record(operation.responses)).map(([status, response]) => [status, record(response).content])),
  }
}

function stableHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`
  return JSON.stringify(value) ?? 'null'
}

async function boundedResponseText(response: Response, maximum: number): Promise<string> {
  if (!response.body) return ''
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const next = await reader.read()
    if (next.done) break
    size += next.value.byteLength
    if (size > maximum) {
      await reader.cancel()
      throw new DoxloopError(`Remote OpenAPI exceeds the ${formatBytes(maximum)} safety limit.`)
    }
    chunks.push(next.value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function safeRemoteUrl(raw: string): string {
  let url: URL
  try { url = new URL(raw) } catch { throw new DoxloopError(`Invalid remote OpenAPI URL: ${raw}`) }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new DoxloopError('Remote OpenAPI URLs must use HTTP or HTTPS.')
  if (url.username || url.password) throw new DoxloopError('Remote OpenAPI URLs cannot contain embedded credentials.')
  if (url.hash) url.hash = ''
  return url.toString()
}

async function assertPublicRemote(url: string, resolver: (hostname: string) => Promise<string[]>): Promise<void> {
  const parsed = new URL(url)
  const hostname = parsed.hostname.toLowerCase()
  if (hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new DoxloopError('Remote OpenAPI URLs cannot target localhost or private networks.')
  }
  const addresses = isIP(hostname) ? [hostname] : await resolver(hostname)
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new DoxloopError('Remote OpenAPI URLs cannot target localhost or private networks.')
  }
}

async function defaultResolveHostname(hostname: string): Promise<string[]> {
  try { return (await lookup(hostname, { all: true })).map((item) => item.address) } catch { throw new DoxloopError(`Remote OpenAPI host could not be resolved: ${hostname}`) }
}

function isPrivateAddress(address: string): boolean {
  const normalized = address.toLowerCase().replace(/^::ffff:/, '')
  if (normalized === '::1' || normalized === '::' || normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) return true
  const parts = normalized.split('.').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part))) return false
  const first = parts[0] ?? -1
  return first === 0 || first === 10 || first === 127 || (first === 169 && parts[1] === 254) || (first === 172 && (parts[1] ?? 0) >= 16 && (parts[1] ?? 0) <= 31) || (first === 192 && parts[1] === 168) || first >= 224
}

function assertOpenApiContentType(raw: string | null, url: string): void {
  const type = raw?.split(';')[0]?.trim().toLowerCase()
  const supported = new Set(['application/json', 'application/yaml', 'application/x-yaml', 'text/yaml', 'text/x-yaml', 'text/plain', 'application/octet-stream'])
  if (type && !supported.has(type) && !/\.(json|ya?ml)$/i.test(new URL(url).pathname)) {
    throw new DoxloopError(`Remote OpenAPI returned unsupported content type "${type}". Expected JSON or YAML.`)
  }
}

async function readRemoteCache(root: string, url: string): Promise<RemoteOpenApiCache | undefined> {
  const path = remoteCachePath(root, url)
  if (!(await pathExists(path))) return undefined
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as RemoteOpenApiCache
    return value.url === url && typeof value.content === 'string' && typeof value.hash === 'string' ? value : undefined
  } catch { return undefined }
}

async function writeRemoteCache(root: string, url: string, loaded: LoadedOpenApi): Promise<void> {
  const path = remoteCachePath(root, url)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify({ url, content: loaded.content, hash: loaded.hash, etag: loaded.etag, lastModified: loaded.lastModified }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function remoteCachePath(root: string, url: string): string {
  return join(root, OPENAPI_CACHE_DIRECTORY, `${createHash('sha256').update(url).digest('hex')}.json`)
}

function formatBytes(value: number): string { return `${Math.round(value / 1024 / 1024)} MB` }
function record(value: unknown): Record<string, unknown> { return isRecord(value) ? value : {} }
function isRecord(value: unknown): value is Record<string, any> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
function array(value: unknown): unknown[] { return Array.isArray(value) ? value : [] }
function text(value: unknown): string | undefined { return typeof value === 'string' && value.trim() ? value.trim() : undefined }
