import { lstat } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { assertPublicContract } from './contract-validation.js'
import { coverageJourneyId, coverageSignalId, readCoverageResolutions, type CoverageResolutions } from './coverage-resolutions.js'
import { listDocumentationPlans } from './documentation-plan.js'
import { readEvidenceMap } from './evidence.js'
import { matchesGlob } from './globs.js'
import { loadProject } from './project.js'
import { sourceHealth } from './source-connectors.js'
import { discoverDocumentationSources, type DiscoveryEvidence } from './source-discovery.js'
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
  { id: 'verified-pages', label: 'Verified pages', denominator: 'Documentation pages with evidence-map entries; verified means confidence=verified with a verification timestamp or revision.' },
]

/** Deterministic source health, coverage, and evidence precision report. */
export async function buildSourceIntelligence(root: string): Promise<SourceIntelligenceReport> {
  const project = await loadProject(root)
  const [{ inventory }, map, plans, health, resolutions] = await Promise.all([
    discoverDocumentationSources(root),
    readEvidenceMap(root),
    listDocumentationPlans(root),
    sourceHealth(root, project.sources),
    readCoverageResolutions(root),
  ])
  const plan = plans.find((item) => ['generated', 'generating', 'approved'].includes(item.status))
  const signals = inventory.sources.flatMap((source) => source.evidence)
  const exclusions = new Set(plan?.capabilities.filter((item) => item.disposition === 'excluded').flatMap((item) => [item.id, item.title, ...item.evidence.map((entry) => entry.label ?? entry.path)]) ?? [])
  const signalMetrics = SURFACES.slice(0, 7).map((surface) => coverageForSignals(surface, signals, map, plan?.capabilities ?? [], exclusions, resolutions))
  const journeys = project.documentation.priorityOutcomes ?? []
  const plannedOutcomes = new Set(plan?.outcomes.map(normalize) ?? [])
  const mappedPages = map ? Object.values(map.pages) : []
  const pagePaths = Object.keys(map?.pages ?? {})
  const journeyItems = journeys.map((journey): CoverageItem => {
    const id = coverageJourneyId(journey)
    const resolution = resolutions.items[id]
    const linkedPage = resolution?.page && pagePaths.includes(resolution.page) ? resolution.page : undefined
    const documented = plannedOutcomes.has(normalize(journey)) || resolution?.disposition === 'documented' && linkedPage
    const suggestion = linkedPage ? undefined : suggestedPage(journey, pagePaths, plan?.pages ?? [])
    return {
      id,
      surface: 'reader-journeys',
      label: journey,
      state: documented ? 'documented' : resolution?.disposition === 'needs-human' ? 'needs-human' : 'uncovered',
      ...(linkedPage ? { page: linkedPage } : {}),
      ...(suggestion ? { suggestedPage: suggestion } : {}),
      ...(resolution?.reason ? { reason: resolution.reason } : {}),
    }
  })
  const journeyDocumented = journeyItems.filter((item) => item.state === 'documented').length
  const verifiedPages = mappedPages.filter((page) => page.confidence === 'verified' && (Object.keys(page.verifiedAt ?? {}).length > 0 || Object.keys(page.verifiedOn ?? {}).length > 0)).length
  const verifiedItems = Object.entries(map?.pages ?? {}).map(([page, evidence]): CoverageItem => ({
    id: `page-${page}`,
    surface: 'verified-pages',
    label: page,
    state: evidence.confidence === 'verified' && (Object.keys(evidence.verifiedAt ?? {}).length > 0 || Object.keys(evidence.verifiedOn ?? {}).length > 0) ? 'documented' : 'uncovered',
    page,
  }))
  const metrics: CoverageMetric[] = [
    ...signalMetrics,
    metric(SURFACES[7]!, journeyDocumented, journeys.length, 0, journeyItems),
    metric(SURFACES[8]!, verifiedPages, mappedPages.length, 0, verifiedItems),
  ]
  const groups = inventory.sources.map((source): CoverageGroup => {
    const relevant = source.evidence.filter((item) => ['command', 'export', 'operation', 'route', 'configuration', 'authentication', 'authorization', 'error', 'event', 'integration'].includes(item.kind))
    const included = relevant.filter((item) => !isSignalExcluded(item, exclusions, resolutions))
    const documented = included.filter((item) => isSignalDocumented(item, map, plan?.capabilities ?? [])).length
    return { source: source.name, ...(source.scope ? { scope: source.scope } : {}), documented, total: included.length, percent: percentage(documented, included.length), status: included.length === 0 ? 'unknown' : 'measured' }
  })
  const report: SourceIntelligenceReport = {
    generatedAt: new Date().toISOString(),
    health,
    coverage: {
      metrics,
      groups,
      pages: pagePaths,
      disclaimer: 'Coverage measures discovered surfaces linked to documentation evidence. It does not prove that prose, examples, or behavior are correct.',
    },
    evidenceDiagnostics: await evidenceDiagnostics(root, project, map, inventory.sources.flatMap((source) => source.evidence)),
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

function coverageForSignals(surface: typeof SURFACES[number], signals: DiscoveryEvidence[], map: EvidenceMap | undefined, capabilities: NonNullable<Awaited<ReturnType<typeof listDocumentationPlans>>>[number]['capabilities'], exclusions: Set<string>, resolutions: CoverageResolutions): CoverageMetric {
  const candidates = signals.filter((item) => surface.kinds?.includes(item.kind))
  const excluded = candidates.filter((item) => isSignalExcluded(item, exclusions, resolutions))
  const included = candidates.filter((item) => !excluded.includes(item))
  const documented = included.filter((item) => isSignalDocumented(item, map, capabilities)).length
  const items = candidates.map((item): CoverageItem => {
    const id = coverageSignalId(item.source, item.kind, item.path, item.label)
    const resolution = resolutions.items[id]
    const isExcluded = excluded.includes(item)
    const isDocumented = !isExcluded && isSignalDocumented(item, map, capabilities)
    return {
      id,
      surface: surface.id,
      label: item.label,
      source: item.source,
      path: item.path,
      kind: item.kind,
      state: isExcluded ? 'excluded' : isDocumented ? 'documented' : resolution?.disposition === 'needs-human' ? 'needs-human' : 'uncovered',
      ...(resolution?.page ? { page: resolution.page } : {}),
      ...(resolution?.reason ? { reason: resolution.reason } : {}),
    }
  })
  return metric(surface, documented, included.length, excluded.length, items)
}

function isSignalExcluded(signal: DiscoveryEvidence, exclusions: Set<string>, resolutions: CoverageResolutions): boolean {
  return exclusions.has(signal.label) || exclusions.has(signal.path) || resolutions.items[coverageSignalId(signal.source, signal.kind, signal.path, signal.label)]?.disposition === 'excluded'
}

function isSignalDocumented(signal: DiscoveryEvidence, map: EvidenceMap | undefined, capabilities: NonNullable<Awaited<ReturnType<typeof listDocumentationPlans>>>[number]['capabilities']): boolean {
  const inPlan = capabilities.some((capability) => (capability.disposition === 'planned' || capability.disposition === 'existing') && capability.pageIds.length > 0 && capability.evidence.some((item) => item.source === signal.source && (item.label === signal.label || item.path === signal.path)))
  if (inPlan) return true
  return Object.values(map?.pages ?? {}).some((page) => page.sources.some((entry) => entry.source === signal.source && [...(entry.paths ?? []), ...(entry.operations ?? [])].some((identifier) => evidenceMatches(signal, identifier))))
}

function evidenceMatches(signal: DiscoveryEvidence, identifier: string): boolean {
  return identifier === signal.label || identifier === signal.path || matchesGlob(signal.path, identifier) || (signal.kind === 'export' && identifier === `schema:${signal.label.replace(/^Schema /, '')}`)
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
        if (weakRelation(page, identifier)) output.push(diagnostic('warning', 'weak-relation', page, `Evidence "${identifier}" has a weak textual relationship to this page.`, `Confirm the relationship and prefer a closer identifier${closestSignal(entry.source, page, signals) ? `, such as "${closestSignal(entry.source, page, signals)}"` : ''}.`, entry.source, identifier))
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
  if (openapi || /[*?[]/.test(identifier)) return signals.some((item) => item.source === source && (matchesGlob(item.path, identifier) || matchesGlob(item.label, identifier)))
  try { return (await lstat(resolve(root, path, identifier))).isFile() || (await lstat(resolve(root, path, identifier))).isDirectory() } catch { return false }
}

function weakRelation(page: string, identifier: string): boolean {
  const pageTokens = tokens(basename(page).replace(/\.[^.]+$/, ''))
  const evidenceTokens = tokens(identifier)
  return pageTokens.length > 0 && evidenceTokens.length > 0 && !pageTokens.some((token) => evidenceTokens.includes(token))
}

function closestSignal(source: string, page: string, signals: DiscoveryEvidence[]): string | undefined {
  const wanted = tokens(page)
  return signals.filter((item) => item.source === source).map((item) => ({ label: item.label, score: tokens(item.label).filter((token) => wanted.includes(token)).length })).sort((left, right) => right.score - left.score)[0]?.label
}

function tokens(value: string): string[] { return normalize(value).split(/[^a-z0-9]+/).filter((item) => item.length >= 3 && !['docs', 'documentation', 'page', 'index'].includes(item)) }
function normalize(value: string): string { return value.trim().toLowerCase() }
function suggestedPage(outcome: string, pages: string[], plannedPages: Array<{ title: string; path: string; purpose: string }>): string | undefined {
  const wanted = tokens(outcome)
  const planned = plannedPages.map((page) => ({ page, score: tokens(`${page.title} ${page.purpose}`).filter((token) => wanted.includes(token)).length })).sort((left, right) => right.score - left.score)[0]
  const plannedPath = planned && planned.score > 0 ? pages.find((page) => page.replace(/\.[^.]+$/, '').endsWith(planned.page.path.replace(/\.[^.]+$/, ''))) : undefined
  if (plannedPath) return plannedPath
  return pages.map((page) => ({ page, score: tokens(page).filter((token) => wanted.includes(token)).length })).sort((left, right) => right.score - left.score)[0]?.page
}
function uniqueDiagnostics(items: EvidenceDiagnostic[]): EvidenceDiagnostic[] { return [...new Map(items.map((item) => [`${item.code}:${item.page}:${item.source ?? ''}:${item.identifier ?? ''}`, item])).values()] }
