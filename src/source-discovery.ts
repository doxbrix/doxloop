import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { matchesAnyGlob } from './globs.js'
import { loadOpenApiSource } from './openapi.js'
import { loadPages, loadProject, sourceKind } from './project.js'
import { sourceSnapshotFingerprints } from './sync.js'
import type { DoxloopProject, SourceBinding } from './types.js'

const DISCOVERY_SCHEMA_VERSION = 1 as const
/** Bump when inventory rules change so cached inventories are rebuilt. */
const DISCOVERY_RULES_VERSION = 2
const DISCOVERY_CACHE_DIRECTORY = join('.doxloop', 'cache', 'discovery')
const MAX_FILES_PER_SOURCE = 500
/**
 * Inventory rows sent to the planner. Public-surface kinds are kept ahead of
 * file-level kinds so a large repository's documentation and test files do not
 * crowd out its commands, routes, and configuration.
 */
const MAX_SIGNALS_PER_SOURCE = 800
const KIND_PRIORITY: DiscoveryEvidenceKind[] = ['package', 'command', 'route', 'operation', 'export', 'configuration', 'authentication', 'authorization', 'error', 'event', 'integration', 'example', 'documentation', 'test', 'asset']
const MAX_FILE_BYTES = 128 * 1024
const MAX_TEXT_BYTES_PER_SOURCE = 4 * 1024 * 1024

const TEXT_EXTENSIONS = new Set([
  '.c', '.cc', '.cpp', '.cs', '.go', '.graphql', '.gql', '.h', '.hpp', '.html',
  '.java', '.js', '.json', '.jsx', '.kt', '.md', '.mdx', '.php', '.proto',
  '.py', '.rb', '.rs', '.rst', '.sh', '.sql', '.swift', '.toml', '.ts', '.tsx',
  '.vue', '.xml', '.yaml', '.yml',
])

const IGNORED_DIRECTORIES = new Set([
  '.git', '.hg', '.svn', '.turbo', '.next', '.nuxt', '.output', '.cache',
  'build', 'coverage', 'dist', 'node_modules', 'target', 'vendor',
])

export type DiscoveryEvidenceKind =
  | 'package'
  | 'command'
  | 'export'
  | 'route'
  | 'operation'
  | 'configuration'
  | 'authentication'
  | 'authorization'
  | 'error'
  | 'event'
  | 'integration'
  | 'example'
  | 'test'
  | 'documentation'
  | 'asset'

export interface DiscoveryEvidence {
  source: string
  path: string
  kind: DiscoveryEvidenceKind
  label: string
  line?: number
}

export interface SourceDiscoveryResult {
  name: string
  kind: 'directory' | 'openapi'
  location: string
  revision: string | null
  filesScanned: number
  filesAvailable: number
  truncated: boolean
  languages: string[]
  packageNames: string[]
  evidence: DiscoveryEvidence[]
  warnings: string[]
  scope?: SourceBinding['scope']
}

export interface DocumentationDiscoveryInventory {
  schemaVersion: typeof DISCOVERY_SCHEMA_VERSION
  cacheKey: string
  generatedAt: string
  sources: SourceDiscoveryResult[]
  existingPages: string[]
  navigationFiles: string[]
  totals: {
    sources: number
    filesScanned: number
    publicSignals: number
    existingPages: number
  }
  suggestedPages: { starter: number; standard: number; comprehensive: number }
}

export interface DiscoveryResult {
  inventory: DocumentationDiscoveryInventory
  cacheHit: boolean
}

/**
 * Build a bounded, deterministic public-surface inventory. The cache key is
 * derived from configured sources, safe source fingerprints, and discovery
 * rules so unchanged sources do not consume another planning pass.
 */
export async function discoverDocumentationSources(root: string): Promise<DiscoveryResult> {
  const project = await loadProject(root)
  const syncFingerprints = await sourceSnapshotFingerprints(root, project.sources)
  const fingerprints: Record<string, string | null> = {}
  for (const source of project.sources) {
    fingerprints[source.name] = sourceKind(source) === 'directory'
      ? await safeDirectoryFingerprint(resolve(root, source.path), project.sync.ignore)
      : syncFingerprints[source.name] ?? null
  }
  const cacheKey = createHash('sha256').update(JSON.stringify({
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    rulesVersion: DISCOVERY_RULES_VERSION,
    sources: project.sources,
    fingerprints,
    ignore: project.sync.ignore,
  })).digest('hex')
  const cachePath = join(root, DISCOVERY_CACHE_DIRECTORY, `${cacheKey}.json`)
  try {
    const cached = JSON.parse(await readFile(cachePath, 'utf8')) as DocumentationDiscoveryInventory
    if (isDiscoveryInventory(cached, cacheKey)) return { inventory: cached, cacheHit: true }
  } catch {
    // A missing or malformed cache is replaced by deterministic discovery.
  }

  const sources: SourceDiscoveryResult[] = []
  for (const source of project.sources) {
    sources.push(await discoverSource(root, project, source, fingerprints[source.name] ?? null))
  }
  const pages = await safeExistingPages(root, project)
  const existingPages = pages.map((page) => portable(relative(root, page)))
  const navigationFiles = await existingNavigationFiles(root, project)
  const publicSignals = sources.reduce((total, source) => total + source.evidence.length, 0)
  const inventory: DocumentationDiscoveryInventory = {
    schemaVersion: DISCOVERY_SCHEMA_VERSION,
    cacheKey,
    generatedAt: new Date().toISOString(),
    sources,
    existingPages,
    navigationFiles,
    totals: {
      sources: sources.length,
      filesScanned: sources.reduce((total, source) => total + source.filesScanned, 0),
      publicSignals,
      existingPages: existingPages.length,
    },
    suggestedPages: suggestedPageCounts(publicSignals, existingPages.length),
  }
  await mkdir(join(root, DISCOVERY_CACHE_DIRECTORY), { recursive: true })
  await writeFile(cachePath, `${JSON.stringify(inventory, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return { inventory, cacheHit: false }
}

export function formatDiscoveryInventory(inventory: DocumentationDiscoveryInventory): string {
  return JSON.stringify(inventory, null, 2)
}

async function discoverSource(
  root: string,
  project: DoxloopProject,
  source: SourceBinding,
  revision: string | null,
): Promise<SourceDiscoveryResult> {
  if (sourceKind(source) === 'openapi') return discoverOpenApiSource(root, source, revision)
  const sourceRoot = resolve(root, source.path)
  const files = await safeSourceFiles(sourceRoot, project.sync.ignore)
  const evidence: DiscoveryEvidence[] = []
  const languages = new Set<string>()
  const packageNames = new Set<string>()
  const warnings: string[] = []
  let textBytes = 0
  let filesScanned = 0
  const candidates = files.slice(0, MAX_FILES_PER_SOURCE)
  // Package entry points decide which exports count as public surface, and a
  // package manifest can sort after the code it describes, so read them first.
  const entryPoints = await packageEntryPoints(sourceRoot, candidates)
  for (const path of candidates) {
    const sourcePath = portable(relative(sourceRoot, path))
    const extension = extname(path).toLowerCase()
    const size = (await lstat(path)).size
    if ((!TEXT_EXTENSIONS.has(extension) && !sourcePath.toLowerCase().endsWith('.env.example')) || size > MAX_FILE_BYTES || textBytes + size > MAX_TEXT_BYTES_PER_SOURCE) continue
    let content: string
    try {
      content = await readFile(path, 'utf8')
    } catch {
      continue
    }
    textBytes += size
    filesScanned += 1
    languages.add(languageForExtension(extension))
    inspectTextFile(source.name, sourcePath, content, evidence, packageNames, entryPoints)
  }
  if (files.length > MAX_FILES_PER_SOURCE) warnings.push(`Inventory limited to the first ${MAX_FILES_PER_SOURCE} safe files.`)
  if (textBytes >= MAX_TEXT_BYTES_PER_SOURCE) warnings.push('Inventory text budget reached before every safe file could be inspected.')
  return {
    name: source.name,
    kind: 'directory',
    location: source.path,
    revision,
    filesScanned,
    filesAvailable: files.length,
    truncated: files.length > MAX_FILES_PER_SOURCE || textBytes >= MAX_TEXT_BYTES_PER_SOURCE,
    languages: [...languages].filter(Boolean).sort(),
    packageNames: [...packageNames].sort(),
    evidence: uniqueEvidence(evidence),
    warnings,
    ...(source.scope ? { scope: source.scope } : {}),
  }
}

async function discoverOpenApiSource(root: string, source: SourceBinding, revision: string | null): Promise<SourceDiscoveryResult> {
  const loaded = await loadOpenApiSource(root, source)
  const evidence: DiscoveryEvidence[] = [
    { source: source.name, path: portable(source.path), kind: 'package', label: loaded.summary.title },
    ...Object.keys(loaded.snapshot.operations).map((label): DiscoveryEvidence => ({ source: source.name, path: portable(source.path), kind: 'operation', label })),
    ...Object.keys(loaded.snapshot.schemas).map((schema): DiscoveryEvidence => ({ source: source.name, path: portable(source.path), kind: 'export', label: `Schema ${schema}` })),
    ...loaded.summary.securitySchemes.map((scheme): DiscoveryEvidence => ({ source: source.name, path: portable(source.path), kind: 'authentication', label: scheme })),
    ...Object.entries(loaded.snapshot.operations).flatMap(([operation, details]): DiscoveryEvidence[] => {
      try {
        const responses = JSON.parse(details.responses) as Record<string, unknown>
        return Object.keys(responses).filter((status) => /^[45]\d\d$/.test(status)).map((status) => ({ source: source.name, path: portable(source.path), kind: 'error', label: `${operation} ${status}` }))
      } catch { return [] }
    }),
    ...Object.keys(loaded.snapshot.operations).filter((operation) => /webhook|event|callback/i.test(operation)).map((operation): DiscoveryEvidence => ({ source: source.name, path: portable(source.path), kind: 'integration', label: operation })),
    ...Object.keys(record(record(loaded.document).webhooks)).flatMap((webhook): DiscoveryEvidence[] => [
      { source: source.name, path: portable(source.path), kind: 'event', label: webhook },
      { source: source.name, path: portable(source.path), kind: 'integration', label: `Webhook ${webhook}` },
    ]),
  ]
  return {
    name: source.name,
    kind: 'openapi',
    location: source.path,
    revision,
    filesScanned: 1,
    filesAvailable: 1,
    truncated: false,
    languages: ['OpenAPI'],
    packageNames: [],
    evidence: uniqueEvidence(evidence),
    warnings: [],
    ...(source.scope ? { scope: source.scope } : {}),
  }
}

async function safeSourceFiles(root: string, ignoredGlobs: string[]): Promise<string[]> {
  const files: string[] = []
  await walk(root, root, ignoredGlobs, files)
  return files.sort()
}

async function safeDirectoryFingerprint(root: string, ignoredGlobs: string[]): Promise<string | null> {
  const files = await safeSourceFiles(root, ignoredGlobs)
  const hash = createHash('sha256')
  for (const path of files) {
    const sourcePath = portable(relative(root, path))
    hash.update(sourcePath)
    hash.update('\0')
    try {
      hash.update(await readFile(path))
    } catch {
      hash.update('unreadable')
    }
    hash.update('\0')
  }
  return files.length ? hash.digest('hex') : null
}

async function walk(root: string, directory: string, ignoredGlobs: string[], files: string[]): Promise<void> {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const path = join(directory, entry.name)
    const relativePath = portable(relative(root, path))
    if (entry.isSymbolicLink() || isSensitiveSourcePath(relativePath) || matchesAnyGlob(relativePath, ignoredGlobs)) continue
    if (entry.isDirectory()) {
      if (!IGNORED_DIRECTORIES.has(entry.name) && !entry.name.startsWith('.')) await walk(root, path, ignoredGlobs, files)
    } else if (entry.isFile()) files.push(path)
  }
}

/**
 * Which part of the product a file belongs to. Only product code contributes
 * keyword-derived public-surface signals: prose, fixtures, tests, and examples
 * mention authentication, roles, and integrations constantly without being
 * reader-facing behavior, and counting every such line turned a 16-page site
 * into a "30% covered" one with a hundred junk gaps to resolve by hand.
 */
export type SourceFileRole = 'code' | 'documentation' | 'test' | 'example' | 'fixture' | 'asset' | 'other'

const FIXTURE_PATH = /(^|\/)(?:evals?|evaluations?|fixtures?|__fixtures__|__mocks__|mocks?|testdata|test-data|snapshots?|__snapshots__|e2e|benchmarks?|playground|sandbox|scripts?|tools?|\.?storybook|stories)(\/|$)/i
const TEST_PATH = /(^|\/)(?:__tests__|tests?|specs?)(\/|$)|\.(?:test|spec|stories)\.[^.]+$/i
const EXAMPLE_PATH = /(^|\/)(?:examples?|demos?|samples?|recipes?)(\/|$)/i
const DOCUMENTATION_PATH = /(^|\/)(?:docs?|documentation|skills?|prompts?|references?|guides?|wiki|adr|rfcs?|proposals?)(\/|$)|\.(?:md|mdx|rst|txt)$/i
const ASSET_PATH = /(^|\/)(?:assets?|public|static|images?|fonts?|media)(\/|$)/i
const CODE_EXTENSIONS = new Set(['.c', '.cc', '.cpp', '.cs', '.go', '.graphql', '.gql', '.h', '.hpp', '.java', '.js', '.jsx', '.kt', '.php', '.proto', '.py', '.rb', '.rs', '.swift', '.ts', '.tsx', '.vue'])

export function classifySourceFile(path: string): SourceFileRole {
  if (FIXTURE_PATH.test(path)) return 'fixture'
  if (TEST_PATH.test(path)) return 'test'
  if (EXAMPLE_PATH.test(path)) return 'example'
  if (DOCUMENTATION_PATH.test(path)) return 'documentation'
  if (ASSET_PATH.test(path)) return 'asset'
  return CODE_EXTENSIONS.has(extname(path).toLowerCase()) ? 'code' : 'other'
}

/**
 * Files that a package manifest publishes (`main`, `module`, `types`, `bin`,
 * `exports`), by extension-less stem, plus conventional entry names. Exports
 * from any other module are internal wiring, not public surface.
 */
async function packageEntryPoints(sourceRoot: string, files: string[]): Promise<Set<string>> {
  const stems = new Set(['index', 'main', 'lib', 'mod', 'public-api', '__init__'])
  for (const path of files) {
    if (path.split(/[\\/]/).at(-1) !== 'package.json' || classifySourceFile(portable(relative(sourceRoot, path))) === 'fixture') continue
    let json: Record<string, unknown> | undefined
    try {
      json = safeJson(await readFile(path, 'utf8'))
    } catch {
      continue
    }
    if (!json) continue
    const values: unknown[] = [json.main, json.module, json.types, json.typings, json.browser]
    values.push(...Object.values(record(json.bin)))
    const walkExports = (value: unknown): void => {
      if (typeof value === 'string') values.push(value)
      else if (value && typeof value === 'object') Object.values(value as Record<string, unknown>).forEach(walkExports)
    }
    walkExports(json.exports)
    for (const value of values) {
      if (typeof value !== 'string') continue
      const stem = value.replace(/\\/g, '/').split('/').at(-1)?.replace(/\.[^.]+$/, '').replace(/\.d$/, '')
      if (stem && stem !== '.' && stem !== '*') stems.add(stem)
    }
  }
  return stems
}

function isPublicEntryPoint(path: string, entryPoints: Set<string>): boolean {
  const stem = path.split('/').at(-1)?.replace(/\.[^.]+$/, '').replace(/\.d$/, '') ?? ''
  return entryPoints.has(stem)
}

function inspectTextFile(
  source: string,
  path: string,
  content: string,
  evidence: DiscoveryEvidence[],
  packages: Set<string>,
  entryPoints: Set<string> = new Set(['index', 'main', 'lib', 'mod']),
): void {
  const base = path.split('/').at(-1)?.toLowerCase() ?? ''
  const role = classifySourceFile(path)
  if (base === 'package.json' && role !== 'fixture') {
    const json = safeJson(content)
    const name = text(json?.name)
    if (name) packages.add(name)
    if (name) evidence.push({ source, path, kind: 'package', label: name })
    for (const command of Object.keys(record(json?.bin))) evidence.push({ source, path, kind: 'command', label: command })
    for (const exported of Object.keys(record(json?.exports))) evidence.push({ source, path, kind: 'export', label: exported })
    for (const script of Object.keys(record(json?.scripts)).filter((item) => /^(start|dev|serve|build|test|lint|migrate|deploy)/.test(item))) {
      evidence.push({ source, path, kind: 'command', label: `npm run ${script}` })
    }
  }
  const fileKind: DiscoveryEvidenceKind | undefined =
    role === 'example' ? 'example'
      : role === 'test' || role === 'fixture' ? 'test'
        : role === 'documentation' ? 'documentation'
          : role === 'asset' ? 'asset'
            : undefined
  if (fileKind) evidence.push({ source, path, kind: fileKind, label: path })
  // Key extraction applies to data configuration files (YAML, TOML, JSON,
  // .env.example). A `vitest.config.ts` is build tooling, and its keys are
  // not product configuration.
  const configurationFile = role !== 'code' && /(?:^|\/)(?:config|configuration|settings)(?:[./_-]|$)|\.env\.example$/i.test(path)
  // Prose, fixtures, tests, and examples are evidence about behavior, never
  // behavior themselves. Only product code and configuration files below.
  if (role !== 'code' && !(role === 'other' && configurationFile)) return
  const publicExports = isPublicEntryPoint(path, entryPoints)
  // One signal per keyword family per file: "this module authenticates" is a
  // public-surface fact; the forty lines that mention a token are not.
  const seenKeywords = new Set<string>()
  const lines = content.split(/\r?\n/)
  lines.forEach((line, index) => {
    const exported = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1]
      ?? /\bpub\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_][\w]*)/.exec(line)?.[1]
    if (exported && publicExports) evidence.push({ source, path, kind: 'export', label: exported, line: index + 1 })
    const route = /\b(?:app|router|server)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)/i.exec(line)
      ?? /\bmap(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)/i.exec(line)
      ?? /@(get|post|put|patch|delete|request)mapping\s*\(\s*(?:value\s*=\s*)?['"`]([^'"`]+)/i.exec(line)
    if (route) evidence.push({ source, path, kind: 'route', label: `${route[1]!.toUpperCase()} ${route[2]}`, line: index + 1 })
    const command = /\.(?:command|option)\(\s*['"`]([^'"`]+)/.exec(line)?.[1]
    if (command) evidence.push({ source, path, kind: 'command', label: command, line: index + 1 })
    const configuration = /\b(?:interface|type|class)\s+([A-Za-z_$][\w$]*(?:Config|Options|Settings))\b/.exec(line)?.[1]
    if (configuration && publicExports) evidence.push({ source, path, kind: 'configuration', label: configuration, line: index + 1 })
    for (const match of line.matchAll(/\b(?:process\.env\.|env\[['"`]|ENV\[['"`])([A-Z][A-Z0-9_]{2,})/g)) {
      evidence.push({ source, path, kind: 'configuration', label: match[1]!, line: index + 1 })
    }
    const option = /(?:add_argument|addOption|option)\(\s*['"`](-{1,2}[a-z0-9][\w-]*)/i.exec(line)?.[1]
      ?? /\b(?:flag\.(?:String|Bool|Int|Duration)|StringVar|BoolVar|IntVar)\s*\([^,]*,?\s*['"`]([a-z0-9][\w-]*)/i.exec(line)?.[1]
    if (option) evidence.push({ source, path, kind: 'command', label: option, line: index + 1 })
    const exit = /\b(?:process\.exit|sys\.exit|exit)\(\s*(\d{1,3})\s*\)/.exec(line)?.[1]
    if (exit) evidence.push({ source, path, kind: 'command', label: `exit ${exit}`, line: index + 1 })
    const authentication = /\b(oauth2?|oidc|sso|bearer|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authenticate|authentication|sign[ -]?in|login)(?:\b|(?=[A-Z_]))/i.exec(line)?.[1]
    if (authentication && keywordOnce(seenKeywords, 'authentication', authentication)) evidence.push({ source, path, kind: 'authentication', label: conciseLabel(line, authentication), line: index + 1 })
    // Bare "scope", "policy", and "role" are ordinary vocabulary in most code;
    // count them only beside an access-control word.
    const authorization = /\b(authori[sz]e|authorization|permission|permissions|rbac)\b/i.exec(line)?.[1]
      ?? (/\b(?:auth|token|grant|access|permission|admin|user)/i.test(line) ? /\b(role|roles|scope|scopes|policy)\b/i.exec(line)?.[1] : undefined)
    if (authorization && keywordOnce(seenKeywords, 'authorization', authorization)) evidence.push({ source, path, kind: 'authorization', label: conciseLabel(line, authorization), line: index + 1 })
    const error = /\b(?:throw\s+new\s+([A-Za-z_$][\w$]*Error)|raise\s+([A-Za-z_$][\w$]*(?:Error|Exception))|status\s*[:=]\s*(4\d\d|5\d\d)|HTTPException\s*\(\s*status_code\s*=\s*(\d{3}))/i.exec(line)
    const errorLabel = error ? error.slice(1).find(Boolean) ?? 'error contract' : undefined
    if (errorLabel && keywordOnce(seenKeywords, 'error', errorLabel)) evidence.push({ source, path, kind: 'error', label: errorLabel, line: index + 1 })
    const event = /\b(?:emit|publish|dispatch|subscribe)\(\s*['"`]([^'"`]+)['"`]/i.exec(line)?.[1]
      ?? /\b(event|webhook)\s*[:=]\s*['"`]([^'"`]+)['"`]/i.exec(line)?.[2]
    if (event) evidence.push({ source, path, kind: 'event', label: event, line: index + 1 })
    const integration = /(webhook|integration|connector|plugin|provider|adapter)/i.exec(line)?.[1]
    if (integration && keywordOnce(seenKeywords, 'integration', integration)) evidence.push({ source, path, kind: 'integration', label: conciseLabel(line, integration), line: index + 1 })
    if (configurationFile) {
      const key = /^\s{0,4}([A-Za-z][A-Za-z0-9_.-]{2,})\s*[:=]/.exec(line)?.[1]
      if (key && !['const', 'export', 'function', 'import', 'return'].includes(key.toLowerCase())) evidence.push({ source, path, kind: 'configuration', label: key, line: index + 1 })
    }
  })
}

function keywordOnce(seen: Set<string>, family: string, keyword: string): boolean {
  const key = `${family}:${keyword.toLowerCase()}`
  if (seen.has(key)) return false
  seen.add(key)
  return true
}

function conciseLabel(line: string, fallback: string): string {
  const normalized = line.trim().replace(/\s+/g, ' ')
  return normalized.length > 100 ? fallback.toLowerCase() : normalized
}

async function safeExistingPages(root: string, project: DoxloopProject): Promise<string[]> {
  try { return await loadPages(root, project) } catch { return [] }
}

async function existingNavigationFiles(root: string, project: DoxloopProject): Promise<string[]> {
  const candidates = ['docs.json', 'sidebars.js', 'sidebars.ts', 'mkdocs.yml', 'mkdocs.yaml', 'astro.config.mjs', 'docusaurus.config.js', 'docusaurus.config.ts', 'nav.yml', 'nav.yaml']
  const roots = [root, resolve(root, project.contentDir)]
  const found: string[] = []
  for (const directory of roots) {
    for (const candidate of candidates) {
      const path = join(directory, candidate)
      try {
        if ((await lstat(path)).isFile()) found.push(portable(relative(root, path)))
      } catch { /* absent candidates are expected */ }
    }
  }
  return [...new Set(found)].sort()
}

/**
 * Evidence-derived page estimates. Comprehensive scales with the public
 * surface instead of stopping at a fixed ceiling: a product with sixty
 * commands, routes, and configuration groups needs more than thirty pages, and
 * the reviewer can raise or lower the target page count on the plan anyway.
 */
export const MAXIMUM_SUGGESTED_PAGES = 120

export function suggestedPageCounts(signals: number, existingPages: number): { starter: number; standard: number; comprehensive: number } {
  const complexity = Math.max(1, Math.ceil(signals / 6), Math.ceil(existingPages / 2))
  return {
    starter: Math.min(5, Math.max(3, 2 + Math.ceil(complexity / 4))),
    standard: Math.min(MAXIMUM_SUGGESTED_PAGES, Math.max(7, 6 + Math.ceil(complexity / 2))),
    comprehensive: Math.min(MAXIMUM_SUGGESTED_PAGES, Math.max(12, 11 + complexity)),
  }
}

function uniqueEvidence(items: DiscoveryEvidence[]): DiscoveryEvidence[] {
  const seen = new Set<string>()
  return items.filter((item) => {
    const key = `${item.source}\0${item.path}\0${item.kind}\0${item.label}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  }).sort((left, right) => evidencePriority(left.kind) - evidencePriority(right.kind)).slice(0, MAX_SIGNALS_PER_SOURCE)
}

function isSensitiveSourcePath(path: string): boolean {
  const segments = path.toLowerCase().split(/[\\/]/)
  const name = segments.at(-1) ?? ''
  return segments.includes('.ssh') || name === '.env' || (name.startsWith('.env.') && name !== '.env.example') ||
    name === 'credentials' || name === 'credentials.json' || name === 'id_rsa' || name === 'id_ed25519' ||
    name.endsWith('.key') || name.endsWith('.pem') || name.endsWith('.p12') || name.endsWith('.pfx')
}

function languageForExtension(extension: string): string {
  return ({ '.js': 'JavaScript', '.jsx': 'JavaScript', '.ts': 'TypeScript', '.tsx': 'TypeScript', '.py': 'Python', '.go': 'Go', '.rs': 'Rust', '.java': 'Java', '.kt': 'Kotlin', '.rb': 'Ruby', '.php': 'PHP', '.cs': 'C#', '.swift': 'Swift', '.proto': 'Protocol Buffers', '.graphql': 'GraphQL', '.gql': 'GraphQL', '.yaml': 'YAML', '.yml': 'YAML', '.json': 'JSON', '.md': 'Markdown', '.mdx': 'MDX', '.rst': 'reStructuredText' } as Record<string, string>)[extension] ?? extension.replace(/^\./, '').toUpperCase()
}

function safeJson(content: string): Record<string, unknown> | undefined {
  try { return record(JSON.parse(content)) } catch { return undefined }
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function portable(path: string): string { return path.split('\\').join('/') }

function isDiscoveryInventory(value: DocumentationDiscoveryInventory, cacheKey: string): boolean {
  return value?.schemaVersion === DISCOVERY_SCHEMA_VERSION && value.cacheKey === cacheKey && Array.isArray(value.sources)
}

function evidencePriority(kind: DiscoveryEvidenceKind): number {
  const index = KIND_PRIORITY.indexOf(kind)
  return index === -1 ? KIND_PRIORITY.length : index
}
