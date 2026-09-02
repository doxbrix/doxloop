import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertPublicContract } from './contract-validation.js'
import { readEvidenceMap } from './evidence.js'
import { pathExists } from './fs.js'
import { loadPages, loadProject, relativePath } from './project.js'
import { readLatestQualityReport } from './quality-gates.js'
import { buildSourceIntelligence } from './source-intelligence.js'
import { listSyncRuns } from './sync-runs.js'
import { validateProject } from './validation.js'

export const EVALUATION_CONTRACT_VERSION = '1.0.0' as const
export const EVALUATION_BASELINE_FILE = join('.doxloop', 'evaluation-baseline.json')

export interface EvaluationMetric { id: string; score: number; weight: number; detail: string }
export interface EvaluationReport {
  schemaVersion: 1
  contractVersion: '1.0.0'
  generatedAt: string
  mode: 'generation' | 'update'
  project: string
  score: number
  metrics: EvaluationMetric[]
  durationMs?: number
  usage?: { inputTokens?: number; outputTokens?: number; costUsd?: number }
  reviewer: { accepted: number; revised: number; rejected: number }
  regression?: { baselineScore: number; delta: number; threshold: number; blocked: boolean }
}

export async function evaluateWorkspace(root: string, options: { mode: 'generation' | 'update'; before?: string; expectedChangedPages?: string[]; maximumPages?: number; durationMs?: number; usage?: EvaluationReport['usage']; regressionThreshold?: number }): Promise<EvaluationReport> {
  const [project, validation, intelligence, evidence, quality, runs] = await Promise.all([loadProject(root), validateProject(root), buildSourceIntelligence(root), readEvidenceMap(root), readLatestQualityReport(root), listSyncRuns(root)])
  const pages = (await loadPages(root, project)).map((path) => relativePath(root, path))
  const evidencePages = Object.values(evidence?.pages ?? {})
  const claimChecks = quality?.checks.filter((check) => check.category === 'claims') ?? []
  const verifiedClaims = claimChecks.filter((check) => check.code === 'quality.claim.verified').length
  const contradictedClaims = claimChecks.filter((check) => check.code === 'quality.claim.contradicted').length
  const unresolvedClaims = claimChecks.filter((check) => check.code === 'quality.claim.needs-human').length
  const unsupported = contradictedClaims + unresolvedClaims
  const measuredCoverage = intelligence.coverage.metrics.filter((metric) => metric.status === 'measured')
  const coverage = measuredCoverage.length ? average(measuredCoverage.map((metric) => metric.percent)) : 0
  const preciseEvidence = Math.max(0, 100 - intelligence.evidenceDiagnostics.length * 10)
  const validationScore = Math.max(0, 100 - validation.errors * 25 - validation.warnings * 5)
  const expectedMaximum = options.maximumPages ?? pages.length
  const pageEconomy = Math.max(0, 100 - Math.max(pages.length - expectedMaximum, 0) * 15)
  const examples = quality?.checks.filter((check) => check.category === 'examples' && check.status !== 'skipped') ?? []
  const exampleScore = examples.length ? Math.round(100 * examples.filter((check) => check.status === 'pass').length / examples.length) : 0
  const accessibility = quality?.checks.filter((check) => check.category === 'accessibility' && check.status !== 'skipped') ?? []
  const accessibilityScore = accessibility.length ? Math.round(100 * accessibility.filter((check) => check.status === 'pass').length / accessibility.length) : 0
  const factualPrecision = claimChecks.length ? 100 * verifiedClaims / claimChecks.length : 0
  const unsupportedRateScore = claimChecks.length ? 100 * (claimChecks.length - unsupported) / claimChecks.length : 0
  const locality = options.mode === 'update' ? await updateLocality(options.before, root, options.expectedChangedPages ?? []) : 100
  const metrics: EvaluationMetric[] = [
    metric('factual-precision', factualPrecision, 18, `${verifiedClaims}/${claimChecks.length} claim checks are verified; ${contradictedClaims} contradicted.`),
    metric('unsupported-claim-rate', unsupportedRateScore, 12, `${unsupported}/${claimChecks.length} claim checks are contradicted or need human review.`),
    metric('public-surface-coverage', coverage, 13, `${measuredCoverage.length}/${intelligence.coverage.metrics.length} coverage surfaces were measurable. ${intelligence.coverage.disclaimer}`),
    metric('reader-journey-and-ia', validationScore, 10, `${validation.errors} errors and ${validation.warnings} warnings.`),
    metric('executable-examples', exampleScore, 8, examples.length ? `${examples.length} executable checks.` : 'No executable examples were run; verification is missing.'),
    metric('evidence-precision-recall', preciseEvidence, 12, `${intelligence.evidenceDiagnostics.length} evidence diagnostics.`),
    metric('page-economy', pageEconomy, 7, `${pages.length} pages; expected maximum ${expectedMaximum}.`),
    metric('update-locality-preservation', locality, 12, options.mode === 'update' ? options.before ? 'Compared candidate files with the declared update scope.' : 'No before snapshot was supplied; update locality is unverified.' : 'Generation run; locality is not applicable.'),
    metric('accessibility-validation', accessibilityScore, 8, accessibility.length ? `${accessibility.length} rendered accessibility checks.` : 'No rendered accessibility run was performed; verification is missing.'),
  ]
  const reviewer = {
    accepted: runs.filter((run) => run.status === 'applied').length,
    revised: runs.filter((run) => run.status === 'partially-applied' || run.status === 'superseded').length,
    rejected: runs.filter((run) => run.status === 'rejected').length,
  }
  const baseline = await readBaseline(root)
  const score = Math.round(metrics.reduce((total, item) => total + item.score * item.weight, 0) / metrics.reduce((total, item) => total + item.weight, 0))
  const threshold = options.regressionThreshold ?? 3
  const report: EvaluationReport = {
    schemaVersion: 1, contractVersion: EVALUATION_CONTRACT_VERSION, generatedAt: new Date().toISOString(), mode: options.mode, project: project.title, score, metrics,
    ...(options.durationMs !== undefined ? { durationMs: options.durationMs } : {}),
    ...(options.usage ? { usage: options.usage } : {}), reviewer,
    ...(baseline ? { regression: { baselineScore: baseline.score, delta: score - baseline.score, threshold, blocked: score < baseline.score - threshold } } : {}),
  }
  const directory = join(root, '.doxloop', 'evaluations')
  await mkdir(directory, { recursive: true })
  await assertPublicContract('evaluation-v1', report)
  await writeFile(join(directory, `evaluation-${report.generatedAt.replace(/[:.]/g, '-')}.json`), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  return report
}

export async function approveEvaluationBaseline(root: string, report: EvaluationReport): Promise<void> {
  await mkdir(join(root, '.doxloop'), { recursive: true })
  await writeFile(join(root, EVALUATION_BASELINE_FILE), `${JSON.stringify(report, null, 2)}\n`, 'utf8')
}

export function formatEvaluation(report: EvaluationReport): string {
  const lines = [`Documentation evaluation: ${report.score}/100`, `${report.mode} · contract ${report.contractVersion}`]
  for (const item of report.metrics) lines.push(`  ${String(Math.round(item.score)).padStart(3)}  ${item.id} — ${item.detail}`)
  lines.push(`Reviewer outcomes: ${report.reviewer.accepted} accepted · ${report.reviewer.revised} revised · ${report.reviewer.rejected} rejected`)
  if (report.regression) lines.push(`Baseline: ${report.regression.baselineScore} · delta ${report.regression.delta >= 0 ? '+' : ''}${report.regression.delta} · ${report.regression.blocked ? 'release blocked' : 'within threshold'}`)
  return lines.join('\n')
}

function metric(id: string, score: number, weight: number, detail: string): EvaluationMetric { return { id, score: Math.round(Math.max(0, Math.min(100, score)) * 10) / 10, weight, detail } }
function average(values: number[]): number { return values.reduce((sum, value) => sum + value, 0) / Math.max(values.length, 1) }

async function updateLocality(before: string | undefined, root: string, expected: string[]): Promise<number> {
  if (!before || !(await pathExists(before))) return 0
  const [previous, current] = await Promise.all([fileDigests(before), fileDigests(root)])
  const changed = new Set([...new Set([...previous.keys(), ...current.keys()])].filter((file) => previous.get(file) !== current.get(file)))
  if (changed.size === 0) return expected.length === 0 ? 100 : 40
  const intended = changed.size - [...changed].filter((file) => !expected.includes(file)).length
  const recall = expected.length ? [...changed].filter((file) => expected.includes(file)).length / expected.length : 1
  const precision = intended / changed.size
  return 100 * (precision * .7 + recall * .3)
}

async function fileDigests(root: string): Promise<Map<string, string>> {
  const project = await loadProject(root)
  const output = new Map<string, string>()
  for (const path of await loadPages(root, project)) output.set(relativePath(root, path), createHash('sha256').update(await readFile(path)).digest('hex'))
  return output
}

async function readBaseline(root: string): Promise<EvaluationReport | undefined> {
  const path = join(root, EVALUATION_BASELINE_FILE)
  if (!(await pathExists(path))) return undefined
  try { const value = JSON.parse(await readFile(path, 'utf8')) as EvaluationReport; return value.schemaVersion === 1 ? value : undefined } catch { return undefined }
}
