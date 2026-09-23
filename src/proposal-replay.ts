/**
 * Replay the end-of-run checks over a recorded run workspace.
 *
 * Every "the run succeeded but the proposal is blocked" failure came from the
 * interaction of steps that each had unit tests: reuse of planning captures,
 * the screenshot validator, the retake, the tolerant downgrade, the post-pass
 * and the accept check. They were only ever exercised together on a real
 * half-hour run. A replay runs exactly that pipeline over a copy of a run's
 * workspace in seconds, so a change to any gate is verified against real
 * manifests and pages before the next run — and a run folder that failed
 * becomes a permanent regression fixture.
 */
import { cp, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { applyAuthoringPostPass, removeSupersededStarterPages } from './authoring-postpass.js'
import { normalizeCaptureManifest } from './batch-artifacts.js'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import { loadProject } from './project.js'
import {
  SCREENSHOT_MANIFEST_FILE,
  adoptCapturedImages,
  collapseDuplicateCaptures,
  embedMissingCaptures,
  validateScreenshotManifest,
} from './screenshot-workflow.js'
import { formatValidation, validateProject } from './validation.js'
import type { DocumentationPlan, ValidationIssue } from './types.js'

export interface ReplayResult {
  /** Where the copy the checks ran on was left (removed unless `keep`). */
  workspace: string
  /** Validation errors before any repair; what the run itself would have shown. */
  before: { errors: number; warnings: number; issues: ValidationIssue[] }
  /** Doxloop's repairs, in order. */
  repairs: string[]
  /** Screenshot defects the tolerant check recorded. */
  screenshotDefects: string[]
  /** Validation after every repair; what the accept check sees. */
  after: { errors: number; warnings: number; issues: ValidationIssue[] }
}

export interface ReplayOptions {
  /** Leave the working copy in place for inspection. */
  keep?: boolean
  log?: (line: string) => void
}

/**
 * Run the post-authoring pipeline over a copy of `<run-dir>/workspace` using
 * the run's approved plan. The original run folder is never modified.
 */
export async function replayRun(runDirectory: string, options: ReplayOptions = {}): Promise<ReplayResult> {
  const log = options.log ?? (() => {})
  const source = resolve(runDirectory)
  const workspaceSource = join(source, 'workspace')
  if (!(await pathExists(workspaceSource))) throw new DoxloopError(`${runDirectory} has no workspace folder to replay.`)
  let plan: DocumentationPlan
  try {
    plan = JSON.parse(await readFile(join(source, 'approved-plan.json'), 'utf8')) as DocumentationPlan
  } catch {
    throw new DoxloopError(`${runDirectory} has no readable approved-plan.json; only plan-first runs can be replayed.`)
  }
  const workspace = await mkdtemp(join(tmpdir(), 'doxloop-replay-'))
  await cp(workspaceSource, workspace, { recursive: true })
  const repairs: string[] = []
  const say = (line: string): void => { repairs.push(line); log(line) }
  try {
    const project = await loadProject(workspace)
    const before = await validateProject(workspace)
    log(`Before repairs: ${before.errors} error${before.errors === 1 ? '' : 's'}, ${before.warnings} warning${before.warnings === 1 ? '' : 's'}.`)

    // 1. Screenshots: the same order as the end of a generation run.
    const normalized = await normalizeCaptureManifest(workspace, SCREENSHOT_MANIFEST_FILE)
    for (const step of normalized.verified) say(`manifest: ${step} verified on disk.`)
    for (const reset of normalized.reset) say(`manifest: ${reset.step} reset to planned (${reset.reason}).`)
    const adopted = await adoptCapturedImages(workspace, project.generator, plan)
    if (adopted.length > 0) say(`captures: adopted ${adopted.length} unrecorded image${adopted.length === 1 ? '' : 's'}.`)
    const dropped = await collapseDuplicateCaptures(workspace, plan)
    if (dropped.length > 0) say(`captures: quarantined ${dropped.length} duplicate${dropped.length === 1 ? '' : 's'}.`)
    const placed = await embedMissingCaptures(workspace, plan)
    if (placed.length > 0) say(`captures: embedded ${placed.length} unplaced image${placed.length === 1 ? '' : 's'}.`)
    const screenshots = await validateScreenshotManifest(workspace, plan, plan.execution?.screenshots ?? 'auto', { tolerateDefects: true })
    for (const defect of screenshots.defects) say(`screenshot defect: ${defect}`)

    // 2. The deterministic repairs the accept path relies on.
    const report = await applyAuthoringPostPass({ workspace, project, plan, pages: plan.pages, unlinkUnresolved: true, pruneEmptySpaces: true })
    for (const line of report.repairs) say(`post-pass: ${line}`)
    for (const line of report.problems) say(`post-pass note: ${line}`)
    const middle = await validateProject(workspace)
    const starters = await removeSupersededStarterPages(workspace, middle.issues)
    if (starters.length > 0) {
      for (const file of starters) say(`starter: removed ${file}.`)
      const again = await applyAuthoringPostPass({ workspace, project, plan, pages: plan.pages, unlinkUnresolved: true, pruneEmptySpaces: true })
      for (const line of again.repairs) say(`post-pass: ${line}`)
    }

    // 3. What "Accept all" checks.
    const after = await validateProject(workspace)
    log(`After repairs: ${after.errors} error${after.errors === 1 ? '' : 's'}, ${after.warnings} warning${after.warnings === 1 ? '' : 's'}.`)
    if (after.errors > 0) log(formatValidation({ ...after, issues: after.issues.filter((issue) => issue.severity === 'error') }))
    return {
      workspace,
      before: { errors: before.errors, warnings: before.warnings, issues: before.issues },
      repairs,
      screenshotDefects: screenshots.defects,
      after: { errors: after.errors, warnings: after.warnings, issues: after.issues },
    }
  } finally {
    if (!options.keep) await rm(workspace, { recursive: true, force: true })
  }
}
