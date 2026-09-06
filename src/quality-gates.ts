import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertPublicContract } from './contract-validation.js'
import { loadGeneratorAdapter } from './generators.js'
import { pathExists } from './fs.js'
import { loadPages, loadProject, relativePath } from './project.js'
import { reverifyClaims } from './quality-claims.js'
import { loadQualityConfig } from './quality-config.js'
import { QUALITY_CODES, QUALITY_CONTRACT_VERSION } from './quality-contract.js'
import { verifyExamples } from './quality-examples.js'
import { lintDocumentation, fixDocumentation } from './quality-lint.js'
import { checkExternalLinks } from './quality-links.js'
import { checkRenderedQuality } from './quality-rendered.js'
import { lintSchemas } from './quality-schema.js'
import { validateProject } from './validation.js'
import { buildDoxbrixStaticSite } from './doxbrix-build.js'
import type { DoxloopProject, QualityCheck, QualityReport } from './types.js'

export const QUALITY_REPORT_DIRECTORY = join('.doxloop', 'quality-reports')
export const LATEST_QUALITY_REPORT = join(QUALITY_REPORT_DIRECTORY, 'latest.json')

export interface RunQualityOptions {
  offline?: boolean
  rendered?: boolean
  examples?: boolean
  fix?: boolean
  updateVisuals?: boolean
  approveBaseline?: boolean
}

export async function runQuality(root: string, options: RunQualityOptions = {}): Promise<QualityReport> {
  const project = await loadProject(root)
  const config = await loadQualityConfig(root)
  if (options.rendered !== undefined) config.rendered = { ...config.rendered, enabled: options.rendered }
  if (options.examples !== undefined) config.examples = { ...config.examples, enabled: options.examples }
  if (options.offline !== undefined) config.links = { ...config.links, mode: options.offline ? 'offline' : 'online' }
  if (options.fix) await fixDocumentation(root, project)
  const validation = await validateProject(root)
  const checks: QualityCheck[] = validation.issues.map((issue) => ({ code: `validation.${issue.code}`, category: 'validation', status: issue.severity === 'error' ? 'fail' : 'warning', message: issue.message, ...(issue.file ? { file: issue.file } : {}) }))
  if (validation.issues.length === 0) checks.push({ code: QUALITY_CODES.validation, category: 'validation', status: 'pass', message: `${validation.pages.length} documentation pages passed deterministic validation.` })
  checks.push(await strictBuild(root, project))
  const [links, examples, schemas, lint, claims] = await Promise.all([
    checkExternalLinks(root, project, config, options.offline === undefined ? {} : { offline: options.offline }),
    verifyExamples(root, config.examples?.enabled === true),
    lintSchemas(root, project),
    lintDocumentation(root, project, config),
    reverifyClaims(root, project, config.readerVerification?.enabled === true),
  ])
  checks.push(...links, ...examples, ...schemas, ...lint, ...claims.checks)
  const rendered = await checkRenderedQuality(root, project, config, options.updateVisuals === true)
  checks.push(...rendered.checks)
  applySuppressions(checks, config)
  await applyRatchet(root, checks, config, options.approveBaseline === true)
  const counts = {
    passed: checks.filter((check) => check.status === 'pass').length,
    warnings: checks.filter((check) => check.status === 'warning').length,
    failed: checks.filter((check) => check.status === 'fail').length,
    skipped: checks.filter((check) => check.status === 'skipped').length,
  }
  const generatedAt = new Date().toISOString()
  const inputHash = await qualityInputHash(root)
  const reportName = `quality-${generatedAt.replace(/[:.]/g, '-')}.json`
  const report: QualityReport = {
    schemaVersion: 1,
    contractVersion: QUALITY_CONTRACT_VERSION,
    generatedAt,
    inputHash,
    project: project.title,
    generator: project.generator,
    status: counts.failed > 0 ? 'fail' : counts.warnings > 0 ? 'warning' : 'pass',
    checks,
    counts,
    artifacts: {
      report: join(QUALITY_REPORT_DIRECTORY, reportName),
      ...(rendered.accessibility ? { accessibility: rendered.accessibility } : {}),
      ...(rendered.visuals ? { visuals: rendered.visuals } : {}),
    },
    options: { offline: config.links?.mode === 'offline', rendered: config.rendered?.enabled === true, examples: config.examples?.enabled === true },
  }
  const directory = join(root, QUALITY_REPORT_DIRECTORY)
  await mkdir(directory, { recursive: true })
  await assertPublicContract('quality-report-v1', report)
  const serialized = `${JSON.stringify(report, null, 2)}\n`
  await Promise.all([writeFile(join(directory, reportName), serialized, 'utf8'), writeFile(join(root, LATEST_QUALITY_REPORT), serialized, 'utf8')])
  return report
}

async function applyRatchet(root: string, checks: QualityCheck[], config: import('./types.js').QualityConfig, approve: boolean): Promise<void> {
  const setting = config.ratchet
  if (!setting?.enabled && !approve) return
  const baselinePath = join(root, setting?.baselineFile ?? '.doxloop/quality-baseline.json')
  const current = checks.filter((check) => check.status === 'warning' || check.status === 'fail').map(issueIdentity)
  if (approve) {
    await mkdir(dirname(baselinePath), { recursive: true })
    await writeFile(baselinePath, `${JSON.stringify({ schemaVersion: 1, issues: current.sort() }, null, 2)}\n`, 'utf8')
    return
  }
  if (!(await pathExists(baselinePath))) {
    checks.push({ code: QUALITY_CODES.ratchetBaselineMissing, category: 'validation', status: 'warning', message: 'Quality ratcheting is enabled but no approved baseline exists.', detail: `Run doxloop quality --approve-quality-baseline after reviewing current issues.` })
    return
  }
  let known = new Set<string>()
  try {
    const value = JSON.parse(await readFile(baselinePath, 'utf8')) as { schemaVersion?: number; issues?: unknown }
    if (value.schemaVersion === 1 && Array.isArray(value.issues)) known = new Set(value.issues.filter((item): item is string => typeof item === 'string'))
  } catch { /* Malformed baselines fail open as a visible warning below. */ }
  if (known.size === 0 && current.length > 0) checks.push({ code: QUALITY_CODES.ratchetBaselineInvalid, category: 'validation', status: 'warning', message: 'The quality baseline is empty or invalid; current issues were not suppressed.' })
  for (const check of checks) {
    if ((check.status === 'warning' || check.status === 'fail') && known.has(issueIdentity(check))) {
      check.detail = [check.detail, 'Present in the approved quality baseline; kept visible for ratcheting.'].filter(Boolean).join('\n')
      check.status = 'skipped'
    }
  }
}

function applySuppressions(checks: QualityCheck[], config: import('./types.js').QualityConfig): void {
  const now = Date.now()
  for (const check of checks) {
    const suppression = config.suppressions?.find((item) => item.code === check.code && (!item.file || item.file === check.file) && (!item.expires || Date.parse(item.expires) > now))
    if (!suppression || (check.status !== 'warning' && check.status !== 'fail')) continue
    check.status = 'skipped'
    check.detail = [check.detail, `Suppressed: ${suppression.reason}${suppression.expires ? ` (expires ${suppression.expires})` : ''}`].filter(Boolean).join('\n')
  }
}

function issueIdentity(check: QualityCheck): string { return `${check.code}\0${check.file ?? ''}\0${check.message}` }

export async function readLatestQualityReport(root: string): Promise<QualityReport | undefined> {
  const path = join(root, LATEST_QUALITY_REPORT)
  if (!(await pathExists(path))) return undefined
  try {
    const value = JSON.parse(await readFile(path, 'utf8')) as QualityReport
    return value.schemaVersion === 1 && value.contractVersion === QUALITY_CONTRACT_VERSION && Array.isArray(value.checks) ? value : undefined
  } catch { return undefined }
}

export async function qualityInputHash(root: string): Promise<string> {
  const project = await loadProject(root)
  const files = await loadPages(root, project)
  const candidates = [join(root, '.doxloop', 'project.json'), join(root, '.doxloop', 'quality.json'), join(root, '.doxloop', 'examples.json'), join(root, '.doxloop', 'evidence-map.json'), ...files]
  const hash = createHash('sha256')
  for (const path of candidates.sort()) {
    if (!(await pathExists(path))) continue
    hash.update(relativePath(root, path)); hash.update('\0'); hash.update(await readFile(path)); hash.update('\0')
  }
  return hash.digest('hex')
}

export function formatQualityReport(report: QualityReport): string {
  const icon = report.status === 'pass' ? '✓' : report.status === 'warning' ? '!' : '✗'
  const lines = [`${icon} Release quality: ${report.status}`, `${report.counts.failed} failed · ${report.counts.warnings} warnings · ${report.counts.passed} passed · ${report.counts.skipped} skipped`]
  for (const category of [...new Set(report.checks.map((check) => check.category))]) {
    lines.push('', category[0]!.toUpperCase() + category.slice(1))
    for (const check of report.checks.filter((item) => item.category === category && item.status !== 'pass')) lines.push(`  ${check.status === 'fail' ? '✗' : check.status === 'warning' ? '!' : '–'} ${check.code}${check.file ? ` · ${check.file}` : ''}\n    ${check.message}${check.detail ? `\n    ${check.detail}` : ''}`)
  }
  lines.push('', `Report: ${report.artifacts.report}`)
  return lines.join('\n')
}

async function strictBuild(root: string, project: DoxloopProject): Promise<QualityCheck> {
  if (project.generator === 'doxbrix') {
    try {
      const result = await buildDoxbrixStaticSite({ root })
      return { code: QUALITY_CODES.buildPassed, category: 'build', status: 'pass', message: `Doxbrix static build passed (${result.pages} pages).` }
    } catch (error) {
      return { code: QUALITY_CODES.buildFailed, category: 'build', status: 'fail', message: 'Doxbrix static build failed.', detail: error instanceof Error ? error.message : String(error) }
    }
  }
  const adapter = await loadGeneratorAdapter(root, project)
  const result = await runShell(adapter.build.command, root)
  return result.code === 0
    ? { code: QUALITY_CODES.buildPassed, category: 'build', status: 'pass', message: `${adapter.displayName} strict build passed.` }
    : { code: QUALITY_CODES.buildFailed, category: 'build', status: 'fail', message: `${adapter.displayName} strict build failed with exit code ${result.code}.`, detail: clip(`${result.stdout}\n${result.stderr}`) }
}

function runShell(command: string, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, { cwd, env: process.env, shell: true, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''; let stderr = ''
    child.stdout.on('data', (chunk) => { if (stdout.length < 128_000) stdout += chunk })
    child.stderr.on('data', (chunk) => { if (stderr.length < 128_000) stderr += chunk })
    child.once('error', reject)
    child.once('exit', (code) => resolveRun({ code: code ?? 1, stdout, stderr }))
  })
}

function clip(value: string): string { return value.trim().slice(-4_000) }
