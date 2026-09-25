import { createHash } from 'node:crypto'
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { extname, join, relative, resolve } from 'node:path'
import { matchesAnyGlob } from './globs.js'
import { readDocsSiteManifest } from './docs-site.js'
import { loadOpenApiSource } from './openapi.js'
import { loadPages, loadProject, sourceKind } from './project.js'
import { sourceSnapshotFingerprints } from './sync.js'
import type { DoxloopProject, SourceBinding, SourceKind } from './types.js'

const DISCOVERY_SCHEMA_VERSION = 1 as const
/** Bump when inventory rules change so cached inventories are rebuilt. */
const DISCOVERY_RULES_VERSION = 6
const DISCOVERY_CACHE_DIRECTORY = join('.doxloop', 'cache', 'discovery')
/**
 * Inspectable text files per source. The cap applies after product code is
 * placed first, so a repository whose `public/` folder holds hundreds of
 * icons still has its `src/` routes, screens, and configuration inventoried.
 */
const MAX_FILES_PER_SOURCE = 2500
/**
 * Inventory rows sent to the planner. Public-surface kinds are kept ahead of
 * file-level kinds so a large repository's documentation and test files do not
 * crowd out its commands, routes, and configuration.
 */
const MAX_SIGNALS_PER_SOURCE = 800
const KIND_PRIORITY: DiscoveryEvidenceKind[] = ['package', 'command', 'route', 'operation', 'export', 'configuration', 'authentication', 'authorization', 'error', 'event', 'integration', 'example', 'documentation', 'test', 'asset']
const MAX_FILE_BYTES = 128 * 1024
const MAX_TEXT_BYTES_PER_SOURCE = 12 * 1024 * 1024
/**
 * Inspection order. Product code carries the public surface; prose, examples,
 * and tests are supporting evidence; assets never produce a signal worth a
 * reader's attention, so they are inventoried last and never inspected.
 */
const ROLE_PRIORITY: Record<SourceFileRole, number> = { code: 0, other: 1, infrastructure: 2, documentation: 3, example: 4, test: 5, fixture: 6, asset: 7 }
/** English UI message catalogs that hold the strings a reader actually sees. */
const LABEL_CATALOG_PATH = /(^|\/)(?:lang|langs|locales?|i18n|intl\/messages|intl|translations?|messages|l10n)\/(?:en|en[-_][A-Za-z]{2})\.(?:json|ya?ml)$/i

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
  kind: SourceKind
  location: string
  revision: string | null
  filesScanned: number
  filesAvailable: number
  truncated: boolean
  languages: string[]
  packageNames: string[]
  evidence: DiscoveryEvidence[]
  /**
   * English UI message catalogs (for example `src/lang/en.json` or
   * `public/intl/messages/en-US.json`). Authors quote displayed strings from
   * these files instead of translation keys or guessed labels.
   */
  uiLabelCatalogs: string[]
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
  // Pages of an existing documentation site describe the product second-hand.
  // They are listed so the planner can account for every one of them, but they
  // are not public product surface and must not inflate the suggested size.
  const publicSignals = sources.filter((source) => source.kind !== 'docs-site').reduce((total, source) => total + source.evidence.length, 0)
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

/** Compact JSON for prompt injection; the on-disk cache stays pretty-printed. */
/**
 * Evidence kinds whose rows are regex hits on code lines (`const oauth =
 * require('./oauth.js')`, `update:modelValue`). Hundreds of them tell the
 * planner nothing a file list does not, so they are summarised per file.
 */
const SUMMARISED_EVIDENCE_KINDS: ReadonlySet<DiscoveryEvidenceKind> = new Set(['authentication', 'authorization', 'event', 'integration'])
const MAXIMUM_LISTED_ROWS_PER_KIND = 160
const MAXIMUM_SUMMARISED_FILES_PER_KIND = 24

/**
 * The inventory as the planner reads it: grouped text instead of one JSON
 * line. The same JSON for a mid-sized product ran to 120k characters and was
 * re-sent on every planning turn; grouping rows by kind and file keeps every
 * citation (source, path, kind, label, line) at a fraction of the size.
 */
export function formatDiscoveryInventory(inventory: DocumentationDiscoveryInventory): string {
  const lines: string[] = []
  const { totals, suggestedPages } = inventory
  lines.push(`Inventory ${inventory.cacheKey.slice(0, 12)} generated ${inventory.generatedAt}: ${totals.sources} source${totals.sources === 1 ? '' : 's'}, ${totals.filesScanned} files scanned, ${totals.publicSignals} public signals, ${totals.existingPages} existing documentation page${totals.existingPages === 1 ? '' : 's'}. Suggested page counts: starter ${suggestedPages.starter}, standard ${suggestedPages.standard}, comprehensive ${suggestedPages.comprehensive}.`)
  if (inventory.existingPages.length > 0) lines.push(`Existing documentation pages: ${inventory.existingPages.join(', ')}`)
  if (inventory.navigationFiles.length > 0) lines.push(`Navigation files: ${inventory.navigationFiles.join(', ')}`)
  for (const source of inventory.sources) {
    lines.push('')
    const coverage = source.truncated
      ? `${source.filesScanned} of ${source.filesAvailable} files scanned (partial)`
      : `${source.filesScanned} file${source.filesScanned === 1 ? '' : 's'} scanned`
    const facts = [
      source.languages.length > 0 ? source.languages.join(', ') : undefined,
      source.packageNames.length > 0 ? `packages ${source.packageNames.join(', ')}` : undefined,
      coverage,
      source.revision ? `revision ${source.revision.slice(0, 12)}` : undefined,
    ].filter((item): item is string => Boolean(item))
    lines.push(`Source "${source.name}" (${source.kind}, ${source.location}): ${facts.join('; ')}. Cite rows as source "${source.name}" with the path, kind, label, and line shown.`)
    if (source.uiLabelCatalogs.length > 0) lines.push(`  UI label catalogs: ${source.uiLabelCatalogs.join(', ')}`)
    for (const warning of source.warnings) lines.push(`  Warning: ${warning}`)
    const byKind = new Map<DiscoveryEvidenceKind, DiscoveryEvidence[]>()
    for (const row of source.evidence) {
      const rows = byKind.get(row.kind) ?? []
      rows.push(row)
      byKind.set(row.kind, rows)
    }
    for (const [kind, rows] of byKind) {
      lines.push(SUMMARISED_EVIDENCE_KINDS.has(kind) ? summarisedKindLine(kind, rows) : listedKindLines(kind, rows))
    }
  }
  return lines.join('\n')
}

function summarisedKindLine(kind: DiscoveryEvidenceKind, rows: DiscoveryEvidence[]): string {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.path, (counts.get(row.path) ?? 0) + 1)
  const files = [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
  const shown = files.slice(0, MAXIMUM_SUMMARISED_FILES_PER_KIND).map(([path, count]) => (count === 1 ? path : `${path} (${count})`))
  const rest = files.length - shown.length
  return `  ${kind} (${rows.length} matches in ${files.length} file${files.length === 1 ? '' : 's'}; read the files for the behavior): ${shown.join(', ')}${rest > 0 ? `, +${rest} more files` : ''}`
}

function listedKindLines(kind: DiscoveryEvidenceKind, rows: DiscoveryEvidence[]): string {
  const byPath = new Map<string, DiscoveryEvidence[]>()
  let listed = 0
  for (const row of rows) {
    if (listed >= MAXIMUM_LISTED_ROWS_PER_KIND) break
    const group = byPath.get(row.path) ?? []
    group.push(row)
    byPath.set(row.path, group)
    listed += 1
  }
  const groups = [...byPath.entries()].map(([path, group]) =>
    `${path}: ${group.map((row) => (row.line === undefined ? row.label : `${row.label} @${row.line}`)).join('; ')}`,
  )
  const rest = rows.length - listed
  const header = `  ${kind} (${rows.length})${rest > 0 ? `, first ${listed} shown, +${rest} more` : ''}:`
  return `${header}\n${groups.map((group) => `    ${group}`).join('\n')}`
}

async function discoverSource(
  root: string,
  project: DoxloopProject,
  source: SourceBinding,
  revision: string | null,
): Promise<SourceDiscoveryResult> {
  if (sourceKind(source) === 'openapi') return discoverOpenApiSource(root, source, revision)
  if (sourceKind(source) === 'docs-site') return discoverDocsSiteSource(root, source, revision)
  const sourceRoot = resolve(root, source.path)
  const files = await safeSourceFiles(sourceRoot, project.sync.ignore)
  const evidence: DiscoveryEvidence[] = []
  const languages = new Set<string>()
  const packageNames = new Set<string>()
  const warnings: string[] = []
  const uiLabelCatalogs: string[] = []
  let textBytes = 0
  let filesScanned = 0
  // Only text files can yield a signal, and product code must be read before
  // anything else: an alphabetical cap once spent the whole budget on a
  // `public/` folder of icons and never opened `src/`.
  const inspectable = files
    .map((path) => ({ path, sourcePath: portable(relative(sourceRoot, path)) }))
    .filter(({ path, sourcePath }) => TEXT_EXTENSIONS.has(extname(path).toLowerCase()) || sourcePath.toLowerCase().endsWith('.env.example'))
    .map((entry) => ({ ...entry, role: classifySourceFile(entry.sourcePath) }))
    .filter((entry) => entry.role !== 'asset' || LABEL_CATALOG_PATH.test(entry.sourcePath))
    .sort((left, right) => ROLE_PRIORITY[left.role] - ROLE_PRIORITY[right.role] || left.sourcePath.localeCompare(right.sourcePath))
  const candidates = inspectable.slice(0, MAX_FILES_PER_SOURCE)
  // Package entry points decide which exports count as public surface, and a
  // package manifest can sort after the code it describes, so read them first.
  const packageFolders: PackageFolder[] = []
  const entryPoints = await packageEntryPoints(sourceRoot, candidates.map((entry) => entry.path), packageFolders)
  const noEntryPoints = new Set<string>()
  let budgetExhausted = false
  for (const { path, sourcePath } of candidates) {
    const extension = extname(path).toLowerCase()
    if (LABEL_CATALOG_PATH.test(sourcePath)) uiLabelCatalogs.push(sourcePath)
    const size = (await lstat(path)).size
    if (size > MAX_FILE_BYTES) continue
    if (textBytes + size > MAX_TEXT_BYTES_PER_SOURCE) { budgetExhausted = true; break }
    let content: string
    try {
      content = await readFile(path, 'utf8')
    } catch {
      continue
    }
    textBytes += size
    filesScanned += 1
    languages.add(languageForExtension(extension))
    inspectTextFile(source.name, sourcePath, content, evidence, packageNames, exportsArePublic(sourcePath, packageFolders) ? entryPoints : noEntryPoints)
  }
  const truncated = inspectable.length > MAX_FILES_PER_SOURCE || budgetExhausted
  if (inspectable.length > MAX_FILES_PER_SOURCE) warnings.push(`Inventory inspected ${filesScanned} of ${inspectable.length} inspectable files; product code was read first and supporting files were cut off.`)
  if (budgetExhausted) warnings.push(`Inventory text budget reached after ${filesScanned} of ${inspectable.length} inspectable files; product code was read first.`)
  return {
    name: source.name,
    kind: 'directory',
    location: source.path,
    revision,
    filesScanned,
    filesAvailable: files.length,
    truncated,
    languages: [...languages].filter(Boolean).sort(),
    packageNames: [...packageNames].sort(),
    evidence: uniqueEvidence(evidence),
    uiLabelCatalogs: uiLabelCatalogs.sort(),
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
    uiLabelCatalogs: [],
    warnings: [],
    ...(source.scope ? { scope: source.scope } : {}),
  }
}

/**
 * One `documentation` row per crawled page, labeled with the page title, so
 * the planner sees the whole existing site map without opening every file.
 * The snapshot's `index.md` carries the same table with original URLs.
 */
async function discoverDocsSiteSource(root: string, source: SourceBinding, revision: string | null): Promise<SourceDiscoveryResult> {
  const manifest = await readDocsSiteManifest(root, source)
  const evidence: DiscoveryEvidence[] = [
    { source: source.name, path: 'index.md', kind: 'documentation', label: `Existing documentation site ${manifest.url} (${manifest.totals.pages} pages)` },
    ...manifest.pages.slice(0, MAX_SIGNALS_PER_SOURCE - 1).map((page): DiscoveryEvidence => ({ source: source.name, path: page.file, kind: 'documentation', label: page.title })),
  ]
  const warnings = [...manifest.warnings]
  if (manifest.brokenLinks.length > 0) warnings.push(`${manifest.brokenLinks.length} internal links on the existing site point at pages that failed to load; see index.md.`)
  return {
    name: source.name,
    kind: 'docs-site',
    location: manifest.url,
    revision: revision ?? manifest.hash,
    filesScanned: manifest.pages.length,
    filesAvailable: manifest.pages.length,
    truncated: Boolean(manifest.truncated),
    languages: ['Markdown'],
    packageNames: [],
    evidence,
    uiLabelCatalogs: [],
    warnings,
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
export type SourceFileRole = 'code' | 'infrastructure' | 'documentation' | 'test' | 'example' | 'fixture' | 'asset' | 'other'

const FIXTURE_PATH = /(^|\/)(?:evals?|evaluations?|fixtures?|__fixtures__|__mocks__|mocks?|testdata|test-data|snapshots?|__snapshots__|e2e|benchmarks?|playground|sandbox|scripts?|tools?|\.?storybook|stories)(\/|$)/i
/**
 * Deployment, database, and maintenance code. Its environment variables are
 * real operator configuration, but a migration that creates an `api_key`
 * table or a helper that exits with status 1 is not a reader-facing
 * authentication surface or command.
 */
const INFRASTRUCTURE_PATH = /(^|\/)(?:db|database|migrations?|migrate|seeds?|prisma|drizzle|docker|podman|k8s|kubernetes|helm|charts?|deploy|deployment|infra|infrastructure|terraform|ansible|extra|extras|ci|\.github|\.gitlab|\.circleci)(\/|$)/i
// Test files by each ecosystem's own convention: `*.test.ts`, Go's
// `*_test.go`, Python's `test_*.py` / `*_test.py`, Ruby's `*_spec.rb`,
// Java/C#'s `*Test.java` / `*Tests.cs`.
const TEST_PATH = /(^|\/)(?:__tests__|tests?|specs?)(\/|$)|\.(?:test|spec|stories)\.[^.]+$|_test\.(?:go|py|rb|exs?)$|(^|\/)test_[^/]+\.py$|_spec\.rb$|Tests?\.(?:java|kt|cs)$/
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
  if (INFRASTRUCTURE_PATH.test(path)) return 'infrastructure'
  return CODE_EXTENSIONS.has(extname(path).toLowerCase()) ? 'code' : 'other'
}

/**
 * Front-end source of a web app or admin dashboard. Its components mention
 * sign-in, providers, and events on every screen without being an API or
 * integration surface of their own; what the reader sees there is covered by
 * UI journeys and screenshots, so keyword families do not apply to it.
 */
const FRONTEND_PATH = /(^|\/)(?:ui|web|webapp|frontend|client|dashboard|admin|app-ui|desktop|components|pages|views|layouts|composables|stores|[\w-]*-(?:web|desktop|ui|frontend))\/.*\.(?:jsx?|tsx?|mjs|vue|svelte)$|\.(?:vue|svelte|jsx|tsx)$/i

/** Keyword-derived signal kinds, counted once per folder rather than per file. */
export const KEYWORD_SIGNAL_KINDS: ReadonlySet<DiscoveryEvidenceKind> = new Set(['authentication', 'authorization', 'integration', 'event'])

/** Build and shell variables every toolchain reads; not product configuration. */
export const TOOLCHAIN_ENV = /^(?:NODE_ENV|CI|HOME|PATH|PWD|SHELL|TERM|USER|LANG|TZ|TMPDIR|npm_\w+|TAURI_\w+|VITEST\w*|JEST_\w+|GITHUB_\w+|RUNNER_\w+)$/

const MONOREPO_ROOTS = new Set(['packages', 'apps', 'libs', 'services', 'crates', 'modules', 'plugins', 'extensions'])

/**
 * The module a file belongs to, for counting keyword signals once per module:
 * a folder at most three levels deep, or four inside a monorepo's
 * `packages/<name>/src/<module>`. A page citing any file in the module covers
 * it. Shared by discovery and coverage so both group the same way.
 */
export function signalModule(path: string): string {
  const segments = path.split('/').slice(0, -1)
  if (segments.length === 0) return '.'
  const depth = MONOREPO_ROOTS.has(segments[0]!) ? 4 : 3
  return segments.slice(0, depth).join('/')
}

/**
 * Framework-owned HTTP routes that no `app.get(...)` line declares. A Next.js
 * App Router handler lives at `app/api/users/[id]/route.ts` and exports one
 * function per method, so the route is derived from the file path.
 */
export function frameworkRoutes(path: string, content: string): string[] {
  const match = /(?:^|\/)app\/(.*?)\/?route\.(?:ts|tsx|js|jsx|mjs)$/.exec(path)
  if (!match) return []
  const route = `/${match[1]!
    .split('/')
    .filter((segment) => segment && !/^\(.*\)$/.test(segment) && !/^@/.test(segment))
    .map((segment) => segment.replace(/^\[\[?\.\.\.([^\]]+)\]?\]$/, ':$1*').replace(/^\[([^\]]+)\]$/, ':$1'))
    .join('/')}`
  const methods = [...content.matchAll(/\bexport\s+(?:async\s+)?function\s+(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b/g)].map((item) => item[1]!)
  const aliased = [...content.matchAll(/\bexport\s*\{[^}]*\b(?:as\s+)?(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\b[^}]*\}/g)].map((item) => item[1]!)
  return [...new Set([...methods, ...aliased])].map((method) => `${method} ${route}`)
}

/**
 * Lines that mention authentication or providers without being behavior:
 * comments, markup, translated UI strings, and SQL. A Vue template that
 * renders `$t("Add API Key")` is a label, not an authentication surface.
 */
function isProseLine(line: string, inTemplate: boolean): boolean {
  const trimmed = line.trim()
  return inTemplate
    || /^(?:\/\/|#|\*|\/\*|<!--|--|\{\/\*)/.test(trimmed)
    || /^<[A-Za-z!/]/.test(trimmed)
    || /\$t\(|\bt\(\s*['"`]|i18n|\btranslate\(/.test(trimmed)
    || /^\s*(?:CREATE|ALTER|DROP|INSERT|UPDATE|SELECT)\s/i.test(trimmed)
}

/**
 * Files that a package manifest publishes (`main`, `module`, `types`, `bin`,
 * `exports`), by extension-less stem, plus conventional entry names. Exports
 * from any other module are internal wiring, not public surface.
 */
/** Package manifests by folder, and whether each is private (never published). */
type PackageFolder = { dir: string; private: boolean }

/**
 * Exports are public surface only in a package people install. A monorepo's
 * apps and internal libraries are `"private": true`, and their hundreds of
 * index exports read as undocumented API to a coverage count.
 */
function exportsArePublic(sourcePath: string, packages: readonly PackageFolder[]): boolean {
  let nearest: PackageFolder | undefined
  for (const entry of packages) {
    if (entry.dir === '' || sourcePath.startsWith(`${entry.dir}/`)) {
      if (!nearest || entry.dir.length > nearest.dir.length) nearest = entry
    }
  }
  return !nearest?.private
}

async function packageEntryPoints(sourceRoot: string, files: string[], packages: PackageFolder[] = []): Promise<Set<string>> {
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
    const manifest = portable(relative(sourceRoot, path))
    packages.push({ dir: manifest.includes('/') ? manifest.slice(0, manifest.lastIndexOf('/')) : '', private: json.private === true })
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
    // Operator-facing scripts only. A repository's forty `test-*`, `lint`,
    // and `build-docker-nightly` scripts are contributor tooling, and each
    // one counted as an undocumented public command.
    // Only the repository's own package: `ui/package.json` scripts build the
    // bundled dashboard and are contributor tooling, not reader commands.
    for (const script of (path === 'package.json' ? Object.keys(record(json?.scripts)) : []).filter((item) => /^(?:start|dev|serve|build|migrate|deploy|preview|setup)(?::[a-z0-9-]+)?$/.test(item))) {
      evidence.push({ source, path, kind: 'command', label: `npm run ${script}` })
    }
  }
  const fileKind: DiscoveryEvidenceKind | undefined =
    role === 'example' ? 'example'
      : role === 'test' || role === 'fixture' ? 'test'
        : role === 'documentation' ? 'documentation'
            : undefined
  if (fileKind) evidence.push({ source, path, kind: fileKind, label: path })
  // Key extraction applies to data configuration files (YAML, TOML, JSON,
  // .env.example). A `vitest.config.ts` is build tooling, and its keys are
  // not product configuration.
  const configurationFile = role !== 'code' && /(?:^|\/)(?:config|configuration|settings)(?:[./_-]|$)|\.env\.example$/i.test(path)
  // Prose, fixtures, tests, and examples are evidence about behavior, never
  // behavior themselves. Only product code and configuration files below.
  if (role !== 'code' && role !== 'infrastructure' && !(role === 'other' && configurationFile)) return
  // Deployment and database code contributes operator configuration only.
  if (role === 'infrastructure') {
    content.split(/\r?\n/).forEach((line, index) => {
      for (const match of line.matchAll(/\b(?:process\.env\.|env\[['"`]|ENV\[['"`])([A-Z][A-Z0-9_]{2,})/g)) {
        if (!TOOLCHAIN_ENV.test(match[1]!)) evidence.push({ source, path, kind: 'configuration', label: match[1]!, line: index + 1 })
      }
    })
    return
  }
  for (const route of frameworkRoutes(path, content)) evidence.push({ source, path, kind: 'route', label: route })
  const publicExports = isPublicEntryPoint(path, entryPoints)
  // One signal per keyword family per file: "this module authenticates" is a
  // public-surface fact; the forty lines that mention a token are not.
  const seenKeywords = new Set<string>()
  const frontend = FRONTEND_PATH.test(path)
  const lines = content.split(/\r?\n/)
  let inTemplate = false
  lines.forEach((line, index) => {
    if (path.endsWith('.vue')) {
      if (/^\s*<template\b/.test(line)) inTemplate = true
      else if (/^\s*<\/template>/.test(line)) inTemplate = false
    }
    const prose = isProseLine(line, inTemplate)
    const exported = /\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/.exec(line)?.[1]
      ?? /\bpub\s+(?:async\s+)?(?:fn|struct|enum|trait|type)\s+([A-Za-z_][\w]*)/.exec(line)?.[1]
    if (exported && publicExports) evidence.push({ source, path, kind: 'export', label: exported, line: index + 1 })
    const route = /\b(?:app|router|server)\.(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)/i.exec(line)
      ?? /\bmap(get|post|put|patch|delete|options|head)\s*\(\s*['"`]([^'"`]+)/i.exec(line)
      ?? /@(get|post|put|patch|delete|request)mapping\s*\(\s*(?:value\s*=\s*)?['"`]([^'"`]+)/i.exec(line)
      // Go routers (net/http 1.22 patterns aside): `rg.GET("/records", h)`,
      // gin/echo/chi/PocketBase style, with an upper-case method name.
      ?? /\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s*\(\s*["'`](\/[^"'`]*)/.exec(line)
    if (route) evidence.push({ source, path, kind: 'route', label: `${route[1]!.toUpperCase()} ${route[2]}`, line: index + 1 })
    const command = /\.(?:command|option)\(\s*['"`]([^'"`]+)/.exec(line)?.[1]
    if (command) evidence.push({ source, path, kind: 'command', label: command, line: index + 1 })
    const configuration = /\b(?:interface|type|class)\s+([A-Za-z_$][\w$]*(?:Config|Options|Settings))\b/.exec(line)?.[1]
    if (configuration && publicExports) evidence.push({ source, path, kind: 'configuration', label: configuration, line: index + 1 })
    for (const match of line.matchAll(/\b(?:process\.env\.|env\[['"`]|ENV\[['"`])([A-Z][A-Z0-9_]{2,})/g)) {
      if (!TOOLCHAIN_ENV.test(match[1]!)) evidence.push({ source, path, kind: 'configuration', label: match[1]!, line: index + 1 })
    }
    const option = /(?:add_argument|addOption|option)\(\s*['"`](-{1,2}[a-z0-9][\w-]*)/i.exec(line)?.[1]
      ?? /\b(?:flag\.(?:String|Bool|Int|Duration)|StringVar|BoolVar|IntVar)\s*\([^,]*,?\s*['"`]([a-z0-9][\w-]*)/i.exec(line)?.[1]
    if (option) evidence.push({ source, path, kind: 'command', label: option, line: index + 1 })
    // Comments, markup, and translated strings mention these words without
    // implementing anything; keyword families below apply to code lines only.
    if (prose || frontend) return
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

/**
 * Keyword signals ("this file mentions OAuth") count once per folder and
 * family: a module that authenticates is one surface to document, not one
 * per file. The signal's path is the folder, and its label names the
 * keywords found there, so the gap reads as "Authentication in apis".
 */
export function groupKeywordSignals(items: DiscoveryEvidence[]): DiscoveryEvidence[] {
  const groups = new Map<string, { item: DiscoveryEvidence; keywords: Set<string> }>()
  const out: DiscoveryEvidence[] = []
  for (const item of items) {
    if (!KEYWORD_SIGNAL_KINDS.has(item.kind)) { out.push(item); continue }
    const folder = signalModule(item.path)
    const key = `${item.source}\0${item.kind}\0${folder}`
    const keyword = item.kind === 'event' ? item.label.slice(0, 40) : keywordOf(item.label)
    const group = groups.get(key)
    if (group) { if (keyword) group.keywords.add(keyword); continue }
    const created = { item: { source: item.source, kind: item.kind, path: folder, label: '' } as DiscoveryEvidence, keywords: new Set(keyword ? [keyword] : []) }
    groups.set(key, created)
    out.push(created.item)
  }
  for (const { item, keywords } of groups.values()) {
    const family = item.kind === 'authentication' ? 'Authentication' : item.kind === 'authorization' ? 'Permissions' : item.kind === 'event' ? 'Events' : 'Integrations'
    const found = [...keywords].slice(0, 4).join(', ')
    item.label = `${family} in ${item.path === '.' ? 'the project root' : item.path}${found ? ` (${found})` : ''}`
  }
  return out
}

function keywordOf(label: string): string | undefined {
  return /\b(oauth2?|oidc|sso|bearer|api[_ -]?key|access[_ -]?token|refresh[_ -]?token|authenticate|authentication|sign[ -]?in|login|authori[sz]e|authorization|permissions?|rbac|roles?|scopes?|policy|webhook|integration|connector|plugin|provider|adapter)/i.exec(label)?.[1]?.toLowerCase()
}

function uniqueEvidence(items: DiscoveryEvidence[]): DiscoveryEvidence[] {
  const seen = new Set<string>()
  return groupKeywordSignals(items).filter((item) => {
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

/**
 * What the planner must know about the inventory beyond its rows: which
 * files hold the strings readers see, and whether the inventory is partial.
 */
export function discoveryGuidance(discovery: DocumentationDiscoveryInventory): string {
  const lines: string[] = []
  const catalogs = discovery.sources.flatMap((source) => (source.uiLabelCatalogs ?? []).map((path) => `${source.name}: ${path}`))
  if (catalogs.length > 0) {
    lines.push(`UI label catalogs (the exact English strings the product displays; read them before naming any button, tab, field, or menu, and quote the displayed value rather than its key):\n${catalogs.map((item) => `- ${item}`).join('\n')}`)
  }
  const partial = discovery.sources.filter((source) => source.truncated)
  if (partial.length > 0) {
    lines.push(`Partial inventory: ${partial.map((source) => `${source.name} (${source.filesScanned} of ${source.filesAvailable} files)`).join(', ')}. Product code was inventoried first; read the source directly for any surface the inventory may have cut off before deciding it does not exist.`)
  }
  return lines.length ? `${lines.join('\n\n')}\n` : ''
}
