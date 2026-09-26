import { lstat, readFile } from 'node:fs/promises'
import { documentedOperations } from './api-coverage.js'
import { basename, resolve } from 'node:path'
import { assertPublicContract } from './contract-validation.js'
import { coverageJourneyId, coverageSignalId, coveragePageId, readCoverageResolutions, type CoverageResolutions } from './coverage-resolutions.js'
import { listDocumentationPlans } from './documentation-plan.js'
import { readEvidenceMap } from './evidence.js'
import { matchesGlob } from './globs.js'
import { computeDrift } from './drift.js'
import { loadPages, relativePath, loadProject } from './project.js'
import { sourceHealth } from './source-connectors.js'
import { KEYWORD_SIGNAL_KINDS, discoverDocumentationSources, signalModule, type DiscoveryEvidence } from './source-discovery.js'
import type {
  CoverageGroup,
  CoverageItem,
  CoverageMetric,
  CoverageSurface,
  DoxloopProject,
  EvidenceDiagnostic,
  EvidenceMap,
  SourceIntelligenceReport,
} from './types.js'

const SURFACES: Array<{ id: CoverageSurface; label: string; kinds?: DiscoveryEvidence['kind'][]; denominator: string }> = [
  { id: 'commands', label: 'Commands', kinds: ['command'], denominator: 'Public commands discovered in configured sources, less explicit plan exclusions.' },
  { id: 'exports', label: 'Exports & schemas', kinds: ['export'], denominator: 'Public exports and OpenAPI schemas discovered in configured sources, less explicit plan exclusions.' },
  { id: 'http-operations', label: 'HTTP operations', kinds: ['operation', 'route'], denominator: 'HTTP routes and OpenAPI operations discovered in configured sources, less explicit plan exclusions.' },
  { id: 'configuration', label: 'Configuration', kinds: ['configuration'], denominator: 'Configuration keys discovered in configured sources, less explicit plan exclusions.' },
  { id: 'security', label: 'Authentication & permissions', kinds: ['authentication', 'authorization'], denominator: 'Authentication, authorization, role, permission, and security surfaces discovered in configured sources, less explicit plan exclusions.' },
  { id: 'errors', label: 'Errors & recovery', kinds: ['error'], denominator: 'Public errors and failure contracts discovered in configured sources, less explicit plan exclusions.' },
  { id: 'events-integrations', label: 'Events & integrations', kinds: ['event', 'integration'], denominator: 'Events, webhooks, connectors, providers, and integrations discovered in configured sources, less explicit plan exclusions.' },
  { id: 'reader-journeys', label: 'Reader journeys', denominator: 'Priority reader outcomes configured in the documentation brief.' },
  { id: 'verified-pages', label: 'Verified pages', denominator: 'All existing documentation pages; verified requires current source evidence and no detected drift.' },
]

/** Deterministic source health, coverage, and evidence precision report. */
export async function buildSourceIntelligence(root: string): Promise<SourceIntelligenceReport> {
  const project = await loadProject(root)
  const [{ inventory }, rawMap, plans, health, resolutions, files, drift] = await Promise.all([
    discoverDocumentationSources(root),
    readEvidenceMap(root),
    listDocumentationPlans(root),
    sourceHealth(root, project.sources),
    readCoverageResolutions(root),
    loadPages(root, project),
    computeDrift(root, project),
  ])
  const live = new Set(files.map((file) => relativePath(root, file)))
  const contents = await pageContents(root, files)
  const map = rawMap ? { ...rawMap, pages: Object.fromEntries(Object.entries(rawMap.pages).filter(([page]) => live.has(page))) } : undefined
  const stale = new Set(drift.pages.map((page) => page.page))
  const currentVerification = (page: string, evidence: NonNullable<typeof map>['pages'][string]): boolean => evidence.confidence === 'verified' && evidence.sources.length > 0 && drift.status !== 'unknown' && !stale.has(page) && evidence.sources.every((entry) => {
    const source = health.find((item) => item.name === entry.source)
    const date = evidence.verifiedOn?.[entry.source]
    const revision = evidence.verifiedAt?.[entry.source]
    // A page is verified against the commit the project is synchronized to.
    // Health reports the provider's live head, which moves on every upstream
    // push; that is drift for the sync report to raise, not a lost verification.
    const baseline = drift.sources.find((item) => item.name === entry.source)?.baseline ?? source?.revision
    return source?.status !== 'error' && Boolean(source) && (Boolean(revision && baseline === revision) || Boolean(!baseline && date && Number.isFinite(Date.parse(date)) && (!project.sync.maxVerificationAgeDays || Date.now() - Date.parse(date) <= project.sync.maxVerificationAgeDays * 86_400_000)))
  })
  // A partially inventoried source cannot support a coverage percentage the
  // reader should trust, so the cut is reported next to the source itself.
  for (const source of inventory.sources) {
    const item = health.find((entry) => entry.name === source.name)
    if (!item || !source.truncated) continue
    item.status = item.status === 'error' ? 'error' : 'warning'
    item.summary = `${item.summary}; ${source.filesScanned} of ${source.filesAvailable} files inventoried`
    item.details.push(...source.warnings)
  }
  const plan = plans.find((item) => ['generated', 'generating', 'approved'].includes(item.status))
  const signals = inventory.sources.flatMap((source) => source.evidence)
  const exclusions = new Set(plan?.capabilities.filter((item) => item.disposition === 'excluded').flatMap((item) => [item.id, item.title, ...item.evidence.map((entry) => entry.label ?? entry.path)]) ?? [])
  const signalMetrics = SURFACES.slice(0, 7).map((surface) => coverageForSignals(surface, signals, map, plan?.capabilities ?? [], exclusions, resolutions, contents))
  const journeys = project.documentation.priorityOutcomes ?? []
  const plannedOutcomes = new Set(plan?.outcomes.map(normalize) ?? [])
  const mappedPages = map ? Object.values(map.pages) : []
  const pagePaths = Object.keys(map?.pages ?? {})
  const journeyItems = journeys.map((journey): CoverageItem => {
    const id = coverageJourneyId(journey)
    const resolution = resolutions.items[id]
    const linkedPage = resolution?.page && pagePaths.includes(resolution.page) ? resolution.page : undefined
    const suggestion = linkedPage ? undefined : suggestedPage(journey, pagePaths, plan?.pages ?? [])
    // A journey the generated plan set out to serve, with a page on disk that
    // answers to it, is delivered; asking the reviewer to hand-link every
    // priority outcome left this row at zero on every finished project.
    const delivered = plan?.status === 'generated' && plannedOutcomes.has(normalize(journey)) && Boolean(suggestion)
    const documented = (resolution?.disposition === 'documented' && linkedPage) || (resolution === undefined && delivered)
    return {
      id,
      surface: 'reader-journeys',
      label: journey,
      state: documented ? 'documented' : resolution?.disposition === 'needs-human' ? 'needs-human' : plannedOutcomes.has(normalize(journey)) ? 'planned' : 'uncovered',
      ...(linkedPage ? { page: linkedPage } : documented && suggestion ? { page: suggestion } : {}),
      ...(suggestion && !documented ? { suggestedPage: suggestion } : {}),
      ...(resolution?.reason ? { reason: resolution.reason } : {}),
    }
  })
  const journeyDocumented = journeyItems.filter((item) => item.state === 'documented').length
  const verifiedItems = [...live].map((page): CoverageItem => ({
    id: coveragePageId(page),
    surface: 'verified-pages',
    label: page,
    state: resolutions.items[coveragePageId(page)]?.disposition === 'needs-human' ? 'needs-human' : map?.pages[page] && currentVerification(page, map.pages[page]!) ? 'documented' : stale.has(page) ? 'stale' : 'uncovered',
    page,
  }))
  const verifiedPages = verifiedItems.filter((item) => item.state === 'documented').length
  const metrics: CoverageMetric[] = [
    ...signalMetrics,
    metric(SURFACES[7]!, journeyDocumented, journeys.length, 0, journeyItems),
    metric(SURFACES[8]!, verifiedPages, live.size, 0, verifiedItems),
  ]
  const groups = inventory.sources.map((source): CoverageGroup => {
    const relevant = source.evidence.filter((item) => ['command', 'export', 'operation', 'route', 'configuration', 'authentication', 'authorization', 'error', 'event', 'integration'].includes(item.kind))
    const included = relevant.filter((item) => !isSignalExcluded(item, exclusions, resolutions))
    const documented = included.filter((item) => isSignalDocumented(item, map, contents)).length
    return { source: source.name, ...(source.scope ? { scope: source.scope } : {}), documented, total: included.length, percent: percentage(documented, included.length), status: included.length === 0 ? 'unknown' : 'measured' }
  })
  const report: SourceIntelligenceReport = {
    generatedAt: new Date().toISOString(),
    health,
    coverage: {
      metrics,
      groups,
      pages: pagePaths,
      disclaimer: 'Coverage counts existing pages linked to source evidence. Planned pages are shown separately and do not count as documented; verified pages require current evidence. It does not prove that prose, examples, or behavior are correct.',
    },
    evidenceDiagnostics: await evidenceDiagnostics(root, project, rawMap, inventory.sources.flatMap((source) => source.evidence)),
  }
  await assertPublicContract('coverage-v1', report)
  return report
}

export function formatSourceIntelligence(report: SourceIntelligenceReport): string {
  const lines = ['Documentation source intelligence', '']
  for (const item of report.health) lines.push(`  ${item.status === 'healthy' ? '✓' : item.status === 'warning' ? '!' : '×'} ${item.name}: ${item.summary}`)
  lines.push('', 'Coverage')
  for (const item of report.coverage.metrics) lines.push(item.status === 'unknown'
    ? `  ${item.label.padEnd(20)} none detected  (discovery completed with no items in this category)`
    : `  ${item.label.padEnd(20)} ${String(item.percent).padStart(3)}%  ${item.documented}/${item.total}${item.excluded ? ` (${item.excluded} excluded)` : ''}`)
  lines.push('', `  ${report.coverage.disclaimer}`)
  if (report.evidenceDiagnostics.length) {
    lines.push('', `Evidence precision: ${report.evidenceDiagnostics.length} issue${report.evidenceDiagnostics.length === 1 ? '' : 's'}`)
    for (const issue of report.evidenceDiagnostics) lines.push(`  ${issue.severity === 'error' ? '×' : '!'} ${issue.page}: ${issue.message}`, `    Suggestion: ${issue.suggestion}`)
  } else lines.push('', 'Evidence precision: no issues found.')
  return lines.join('\n')
}

function coverageForSignals(surface: typeof SURFACES[number], signals: DiscoveryEvidence[], map: EvidenceMap | undefined, capabilities: NonNullable<Awaited<ReturnType<typeof listDocumentationPlans>>>[number]['capabilities'], exclusions: Set<string>, resolutions: CoverageResolutions, contents: Map<string, string> = new Map()): CoverageMetric {
  const candidates = signals.filter((item) => surface.kinds?.includes(item.kind))
  const excluded = candidates.filter((item) => isSignalExcluded(item, exclusions, resolutions))
  const included = candidates.filter((item) => !excluded.includes(item))
  const documented = included.filter((item) => isSignalDocumented(item, map, contents)).length
  const items = candidates.map((item): CoverageItem => {
    const id = coverageSignalId(item.source, item.kind, item.path, item.label)
    const resolution = resolutions.items[id]
    const isExcluded = excluded.includes(item)
    const isDocumented = !isExcluded && isSignalDocumented(item, map, contents)
    return {
      id,
      surface: surface.id,
      label: item.label,
      source: item.source,
      path: item.path,
      kind: item.kind,
      state: isExcluded ? 'excluded' : isDocumented ? 'documented' : resolution?.disposition === 'needs-human' ? 'needs-human' : isSignalPlanned(item, capabilities) ? 'planned' : 'uncovered',
      ...(resolution?.page ? { page: resolution.page } : {}),
      ...(resolution?.reason ? { reason: resolution.reason } : {}),
    }
  })
  return metric(surface, documented, included.length, excluded.length, items)
}

function isSignalExcluded(signal: DiscoveryEvidence, exclusions: Set<string>, resolutions: CoverageResolutions): boolean {
  return exclusions.has(signal.label) || exclusions.has(signal.path) || resolutions.items[coverageSignalId(signal.source, signal.kind, signal.path, signal.label)]?.disposition === 'excluded'
}

function isSignalPlanned(signal: DiscoveryEvidence, capabilities: NonNullable<Awaited<ReturnType<typeof listDocumentationPlans>>>[number]['capabilities']): boolean {
  return capabilities.some((capability) => capability.disposition === 'planned' && capability.pageIds.length > 0 && capability.evidence.some((item) => item.source === signal.source && (item.label === signal.label || item.path === signal.path)))
}

function isSignalDocumented(signal: DiscoveryEvidence, map: EvidenceMap | undefined, contents: Map<string, string> = new Map()): boolean {
  return Object.entries(map?.pages ?? {}).some(([page, evidence]) => evidence.sources.some((entry) => {
    if (entry.source !== signal.source) return false
    const identifiers = [...(entry.paths ?? []), ...(entry.operations ?? [])]
    if (identifiers.some((identifier) => evidenceMatches(signal, identifier))) return true
    // Writers cite the contract file, not each operation. A page that cites
    // the spec documents the operations, schemas, schemes, and error statuses
    // its own text covers, and no others.
    if (!signal.contract || !identifiers.some((identifier) => identifier === signal.path || matchesGlob(signal.path, identifier))) return false
    const content = contents.get(page)
    return content !== undefined && contractPartDocumented(signal, content)
  }))
}

/** Whether a page's text documents one row of an API contract. */
export function contractPartDocumented(signal: Pick<DiscoveryEvidence, 'kind' | 'label'>, content: string): boolean {
  const operation = (label: string) => {
    const [method = '', ...rest] = label.split(' ')
    const path = rest.join(' ')
    return documentedOperations(content).includes(`${method} ${path}`) || content.includes(`${method} ${path}`)
  }
  if (signal.kind === 'operation' || signal.kind === 'integration') return /^[A-Z]+ \//.test(signal.label) && operation(signal.label)
  if (signal.kind === 'error') {
    const match = /^(\S+ \S+) (\d{3}|\dXX)$/i.exec(signal.label)
    return Boolean(match && operation(match[1]!) && new RegExp(`\\b${match[2]}\\b`).test(content))
  }
  const name = signal.label.replace(/^(?:Schema |Webhook )/, '')
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(content)
}

async function pageContents(root: string, files: string[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>()
  await Promise.all(files.map(async (file) => {
    try { contents.set(relativePath(root, file), await readFile(file, 'utf8')) } catch { /* A page removed mid-scan. */ }
  }))
  return contents
}

export function evidenceMatches(signal: DiscoveryEvidence, identifier: string): boolean {
  // Keyword signals stand for a folder: a page citing any file in it covers it.
  if (KEYWORD_SIGNAL_KINDS.has(signal.kind)) {
    if (signalModule(identifier) === signal.path || identifier === signal.path || identifier.startsWith(`${signal.path}/`)) return true
  }
  const schema = signal.kind === 'export' && (identifier === `schema:${signal.label.replace(/^Schema /, '')}` || identifier === signal.label.replace(/^Schema /, ''))
  // Every row of an API contract shares the spec's path; a page citing the
  // spec file documents only the operations and schemas it names.
  if (signal.contract) return identifier === signal.label || schema || (signal.kind === 'error' && signal.label.startsWith(`${identifier} `))
  return identifier === signal.label || identifier === signal.path || matchesGlob(signal.path, identifier) || schema
}

function metric(surface: typeof SURFACES[number], documented: number, total: number, excluded: number, items: CoverageItem[]): CoverageMetric {
  return { id: surface.id, label: surface.label, documented, total, excluded, percent: percentage(documented, total), status: total === 0 ? 'unknown' : 'measured', denominator: surface.denominator, items }
}

function percentage(documented: number, total: number): number { return total === 0 ? 0 : Math.round((documented / total) * 100) }

async function evidenceDiagnostics(root: string, project: DoxloopProject, map: EvidenceMap | undefined, signals: DiscoveryEvidence[]): Promise<EvidenceDiagnostic[]> {
  if (!map) return []
  const output: EvidenceDiagnostic[] = []
  const sources = new Map(project.sources.map((source) => [source.name, source]))
  for (const [page, evidence] of Object.entries(map.pages)) {
    for (const entry of evidence.sources) {
      const source = sources.get(entry.source)
      if (!source) {
        output.push(diagnostic('error', 'unknown-source', page, `Source "${entry.source}" is not configured.`, 'Remove the binding or reconnect the source.', entry.source))
        continue
      }
      const identifiers = [...(entry.paths ?? []), ...(entry.operations ?? [])]
      if (!identifiers.length) output.push(diagnostic('warning', 'source-only', page, `Evidence names source "${entry.source}" without a precise path or operation.`, 'Record the exact files, exported symbols, or HTTP operations used by this page.', entry.source))
      for (const identifier of identifiers) {
        if (isBroad(identifier)) output.push(diagnostic('warning', 'broad-pattern', page, `Evidence pattern "${identifier}" is too broad for localized drift.`, 'Replace it with the smallest relevant file, directory, operation, or schema.', entry.source, identifier))
        if (!(await identifierExists(root, source.path, source.kind === 'openapi', entry.source, identifier, signals))) output.push(diagnostic('warning', 'deleted-identifier', page, `Evidence identifier "${identifier}" was not found in the current source inventory.`, 'Choose a current identifier or remove claims that depended on the deleted surface.', entry.source, identifier))
      }
      // One relationship check per page and source: a screen component named
      // differently from its guide is normal, so only a page whose evidence
      // shares no vocabulary with it at all is worth a reviewer's attention.
      if (identifiers.length > 0 && identifiers.every((identifier) => weakRelation(page, identifier))) {
        const closest = closestSignal(entry.source, page, signals)
        output.push(diagnostic('warning', 'weak-relation', page, `None of the ${identifiers.length} evidence identifiers from "${entry.source}" share vocabulary with this page.`, `Confirm the relationship${closest ? ` or prefer a closer identifier, such as "${closest}"` : ''}.`, entry.source, identifiers[0]))
      }
    }
  }
  return uniqueDiagnostics(output)
}

function diagnostic(severity: 'error' | 'warning', code: EvidenceDiagnostic['code'], page: string, message: string, suggestion: string, source?: string, identifier?: string): EvidenceDiagnostic {
  return { severity, code, page, ...(source ? { source } : {}), ...(identifier ? { identifier } : {}), message, suggestion }
}

function isBroad(identifier: string): boolean { return identifier === '*' || identifier === '**' || identifier === '**/*' || identifier.endsWith('/**') && identifier.split('/').length <= 2 }

async function identifierExists(root: string, path: string, openapi: boolean, source: string, identifier: string, signals: DiscoveryEvidence[]): Promise<boolean> {
  if (signals.some((item) => item.source === source && evidenceMatches(item, identifier))) return true
  // A literal file wins over pattern matching: Next.js route folders such as
  // `app/(main)/websites/[websiteId]/page.tsx` contain glob characters and
  // were reported as deleted while sitting on disk.
  if (!openapi) {
    try {
      const stat = await lstat(resolve(root, path, identifier))
      if (stat.isFile() || stat.isDirectory()) return true
    } catch { /* not a literal path; fall through to pattern matching */ }
  }
  if (openapi || /[*?]/.test(identifier)) return signals.some((item) => item.source === source && (matchesGlob(item.path, identifier) || matchesGlob(item.label, identifier)))
  return false
}

function weakRelation(page: string, identifier: string): boolean {
  const pageTokens = tokens(page.replace(/\.[^.]+$/, ''))
  const evidenceTokens = tokens(identifier)
  return pageTokens.length > 0 && evidenceTokens.length > 0 && !pageTokens.some((token) => evidenceTokens.some((candidate) => candidate === token || candidate.startsWith(token) || token.startsWith(candidate)))
}

function closestSignal(source: string, page: string, signals: DiscoveryEvidence[]): string | undefined {
  const wanted = tokens(page)
  const best = signals.filter((item) => item.source === source).map((item) => ({ label: item.label, score: tokens(item.label).filter((token) => wanted.includes(token)).length })).sort((left, right) => right.score - left.score)[0]
  return best && best.score > 0 ? best.label : undefined
}

/** Lower-case words of a path, title, or symbol, with camelCase split. */
function tokens(value: string): string[] { return normalize(value.replace(/([a-z0-9])([A-Z])/g, '$1 $2')).split(/[^a-z0-9]+/).filter((item) => item.length >= 3 && !['docs', 'documentation', 'page', 'index', 'src', 'app', 'main', 'components', 'component', 'lib', 'server', 'client', 'mdx', 'tsx', 'vue'].includes(item)) }
function normalize(value: string): string { return value.trim().toLowerCase() }
function suggestedPage(outcome: string, pages: string[], plannedPages: Array<{ title: string; path: string; purpose: string }>): string | undefined {
  const wanted = tokens(outcome)
  const planned = plannedPages.map((page) => ({ page, score: tokens(`${page.title} ${page.purpose}`).filter((token) => wanted.includes(token)).length })).sort((left, right) => right.score - left.score)[0]
  const plannedPath = planned && planned.score > 0 ? pages.find((page) => page.replace(/\.[^.]+$/, '').endsWith(planned.page.path.replace(/\.[^.]+$/, ''))) : undefined
  if (plannedPath) return plannedPath
  return pages.map((page) => ({ page, score: tokens(page).filter((token) => wanted.includes(token)).length })).sort((left, right) => right.score - left.score)[0]?.page
}
function uniqueDiagnostics(items: EvidenceDiagnostic[]): EvidenceDiagnostic[] { return [...new Map(items.map((item) => [`${item.code}:${item.page}:${item.source ?? ''}:${item.identifier ?? ''}`, item])).values()] }
