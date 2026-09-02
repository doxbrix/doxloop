import { createHash, randomBytes } from 'node:crypto'
import { execFile } from 'node:child_process'
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual, promisify } from 'node:util'
import {
  agentExitMessage,
  runAuthor,
  type ClaudeEffortLevel,
  type ReasoningLevel,
  type ScreenshotIntent,
} from './author.js'
import { DoxloopError } from './errors.js'
import { computeDrift } from './drift.js'
import { assertInside, pathExists, readJson } from './fs.js'
import { matchesGlob } from './globs.js'
import {
  recordSourceSyncs,
  recordSyncRun,
  syncPageRegistry,
  type SyncRunContext,
} from './history.js'
import { loadProject, pageExtensions as documentationPageExtensions, readPage } from './project.js'
import { recordReviewPreference } from './review-learning.js'
import {
  SCREENSHOT_MANIFEST_FILE,
  adoptCapturedImages,
  collapseDuplicateCaptures,
  describeScreenshotManifestProgress,
  embedMissingCaptures,
  normalizeScreenshotIntent,
  screenshotPlanSummary,
  validateScreenshotManifest,
} from './screenshot-workflow.js'
import { changedSourcePaths, collectSourceChanges, formatSourceChanges, sourceSnapshotFingerprints } from './sync.js'
import { lineHunks, textLines } from './text-diff.js'
import { formatValidation, validateProject } from './validation.js'
import type {
  AgentName,
  DocumentationPlan,
  DoxloopProject,
  DriftResult,
  EvidenceMap,
  ScreenshotRunSummary,
  SourceChange,
  SyncChangeCategory,
  SyncFileChange,
  SyncRun,
  SyncRunTrigger,
  SyncState,
} from './types.js'

export const SYNC_RUNS_DIRECTORY = join('.doxloop', 'runs')
const RUN_FILE = 'run.json'
/** The inputs an agent run was started with, kept so the run can be continued. */
const AUTHORING_FILE = 'authoring.json'
const WORKSPACE = 'workspace'
const BEFORE = 'before'
const OPERATIONAL_BEFORE = 'operational-before'
const ACCEPTANCE_BEFORE = 'acceptance-before'
const APPLIED = 'applied'

const EXCLUDED_PREFIXES = [
  '.git',
  '.agents',
  '.claude',
  '.codex',
  '.gemini',
  'node_modules',
  '.doxloop/runs',
  // Plan manifests are workflow state. The real plan advances from generating
  // to generated after its proposal workspace is finalized, so offering that
  // snapshot as a documentation change creates an unavoidable false conflict.
  '.doxloop/plans',
  '.doxloop/cache',
  '.doxloop/last-run.json',
  '.doxloop/sync.log',
  '.doxloop/ui-jobs.json',
  '.doxloop/ui-job-logs',
  '.doxloop/review-preferences.json',
  '.doxloop/screenshot-manifest.json',
  '.doxloop/deliveries',
  // History is a derived local index. Copying it into a proposal workspace would
  // offer the database back as a binary documentation change.
  '.doxloop/doxloop.db',
  '.doxloop/doxloop.db-wal',
  '.doxloop/doxloop.db-shm',
  'build',
  'dist',
  'out',
  'site',
  '_build',
]

const INTERNAL_DIFF_PATHS = new Set([
  '.doxloop/last-run.json',
  '.doxloop/sync-state.json',
  '.doxloop/sync.log',
])
const runCommand = promisify(execFile)

const BINARY_EXTENSIONS = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.pdf',
  '.png',
  '.ttf',
  '.otf',
  '.webp',
  '.woff',
  '.woff2',
  '.zip',
])

export interface CreateSyncRunOptions {
  root: string
  project: DoxloopProject
  drift: DriftResult
  sourceChanges: SourceChange[]
  /** Isolated evidence paths used only inside the proposal workspace. */
  authoringSources?: DoxloopProject['sources']
  trigger?: SyncRunTrigger
  author?: typeof runAuthor
  /** Baseline to place in the proposal and apply only after approval. */
  nextSyncState?: SyncState
  /** Approved plan that originated this proposal, when generation is plan-first. */
  plan?: DocumentationPlan
  /** Existing proposal whose isolated workspace seeds a targeted revision. */
  revisionOf?: string
  revisionRequest?: { instruction: string; changeIds: string[]; hunkIds?: string[] }
  /** User-selected authoring controls for a manual workspace update. */
  authoring?: {
    mode?: 'create' | 'update'
    /** The user-facing instruction saved in history when the agent prompt is generated internally. */
    historyRequest?: string
    request?: string
    agent?: AgentName
    model?: string
    reasoning?: ReasoningLevel
    effort?: ClaudeEffortLevel
    screenshots?: ScreenshotIntent
  }
}

export interface AcceptSelection {
  changeId: string
  hunkIds?: string[]
}

export interface ReviseSyncRunInput {
  instruction: string
  changeIds: string[]
  hunkIds?: string[]
  author?: typeof runAuthor
}

/** Generate and validate a proposal without changing the real documentation. */
export async function createSyncRun(options: CreateSyncRunOptions): Promise<SyncRun> {
  const revisionScope = options.revisionOf
    ? await resolveRevisionScope(options.root, options.revisionOf, options.revisionRequest)
    : undefined
  const id = runId()
  const directory = runDirectory(options.root, id)
  await mkdir(directory, { recursive: true })
  await ensureRunsIgnored(options.root)
  const createdAt = new Date().toISOString()
  const sourceSnapshot = await proposalSourceSnapshot(options.root, options.project)
  await snapshotOperationalBefore(options.root, directory)
  let run: SyncRun = {
    schemaVersion: 2,
    id,
    status: 'generating',
    mode: options.project.sync.mode === 'auto' ? 'auto' : 'propose',
    trigger: options.trigger ?? 'manual',
    createdAt,
    summary: `Generating a review for ${options.drift.pages.length} stale page${options.drift.pages.length === 1 ? '' : 's'}`,
    sourceSummary: sourceSummary(options.sourceChanges),
    stalePages: options.drift.pages.map((page) => page.page),
    changes: [],
    sourceSnapshot,
    ...(options.authoring?.mode ? { authoringMode: options.authoring.mode } : {}),
    ...(options.plan ? { planId: options.plan.id } : {}),
    ...(options.revisionOf ? { revisionOf: options.revisionOf } : {}),
    retentionUntil: retentionDate(createdAt),
    revisionRequests: options.revisionRequest ? [{
      id: `revision-${randomBytes(3).toString('hex')}`,
      createdAt,
      instruction: options.revisionRequest.instruction,
      changeIds: options.revisionRequest.changeIds,
      hunkIds: options.revisionRequest.hunkIds ?? [],
    }] : [],
    humanEdits: [],
  }
  await writeRun(options.root, run)
  const history: SyncRunContext = {
    requestText: options.authoring?.historyRequest ?? options.authoring?.request,
    agent: options.authoring?.agent ?? options.project.defaultAgent,
    model: options.authoring?.model,
    reasoningEffort: options.authoring?.reasoning ?? options.authoring?.effort,
    runDir: join(SYNC_RUNS_DIRECTORY, id),
  }
  await recordSyncRun(options.root, run, history)
  const screenshotIntent = normalizeScreenshotIntent(options.authoring?.screenshots)
  const expectedScreenshots = options.plan ? screenshotPlanSummary(options.plan) : { guides: 0, captures: 0 }
  const changeSummary = options.sourceChanges.length > 0
    ? formatSourceChanges(
        options.sourceChanges.map((change) => ({
          ...change,
          path: isAbsolute(change.path)
            ? change.path
            : resolve(options.root, change.path),
        })),
      )
    : undefined
  // Everything the agent was started with is kept beside the run, so a run
  // that stops part-way can be continued with the same instructions instead
  // of being thrown away and generated again from nothing.
  const persisted: RunAuthoringRecord = {
    schemaVersion: 1,
    mode: options.authoring?.mode ?? 'update',
    trigger: options.trigger ?? 'manual',
    screenshots: screenshotIntent,
    ...(options.authoring?.request ? { request: options.authoring.request } : {}),
    ...(options.authoring?.historyRequest ? { historyRequest: options.authoring.historyRequest } : {}),
    ...(options.authoring?.agent ?? options.project.defaultAgent
      ? { agent: (options.authoring?.agent ?? options.project.defaultAgent)! }
      : {}),
    ...(options.authoring?.model ? { model: options.authoring.model } : {}),
    ...(options.authoring?.reasoning ? { reasoning: options.authoring.reasoning } : {}),
    ...(options.authoring?.effort ? { effort: options.authoring.effort } : {}),
    ...(options.project.sync.budget?.maxMinutes ? { timeoutMinutes: options.project.sync.budget.maxMinutes } : {}),
    ...(changeSummary ? { changeSummary } : {}),
    ...(options.authoringSources ? { authoringSources: options.authoringSources } : {}),
    ...(options.nextSyncState ? { nextSyncState: options.nextSyncState } : {}),
  }
  await writeFile(join(directory, AUTHORING_FILE), `${JSON.stringify(persisted, null, 2)}\n`, 'utf8')

  let workspaceCreated = false
  try {
    const originalProjectText = await readFile(
      join(options.root, '.doxloop', 'project.json'),
      'utf8',
    )
    const workspace = await createWorkspace(
      options.root,
      directory,
      options.project,
      options.authoringSources,
    )
    workspaceCreated = true
    if (options.revisionOf) {
      await seedRevisionWorkspace(options.root, options.revisionOf, workspace)
      await rewriteWorkspaceSources(workspace, options.root, {
        ...options.project,
        sources: options.authoringSources ?? options.project.sources,
      })
    }
    const revisionBaseline = revisionScope ? await collectFiles(workspace) : undefined
    const exitCode = await (options.author ?? runAuthor)({
      root: workspace,
      mode: persisted.mode,
      nonInteractive: true,
      recordHistory: false,
      ...(changeSummary ? { changeSummary } : {}),
      ...(options.project.defaultAgent ? { agent: options.project.defaultAgent } : {}),
      ...(options.project.sync.budget?.maxMinutes
        ? { timeoutMinutes: options.project.sync.budget.maxMinutes }
        : {}),
      ...options.authoring,
    })
    if (exitCode !== 0) {
      throw new DoxloopError(agentExitMessage(exitCode))
    }
    if (revisionBaseline && revisionScope) {
      await assertRevisionStayedInScope(workspace, revisionBaseline, revisionScope)
    }
    const finalized = await finalizeProposalWorkspace({
      context: options,
      directory,
      workspace,
      originalProjectText,
      screenshotIntent,
      label: 'generated',
    })
    run = {
      ...run,
      status: 'awaiting-review',
      completedAt: new Date().toISOString(),
      summary: proposalSummary(finalized.changes),
      changes: finalized.changes,
      validation: finalized.validation,
      screenshots: finalized.screenshots,
      undo: { status: 'unavailable', reason: 'Undo becomes available after the complete proposal is applied.' },
    }
    await writeRun(options.root, run)
    if (options.revisionOf) await markSuperseded(options.root, options.revisionOf, run.id)
    await recordSyncRun(options.root, run, history)
    return run
  } catch (error) {
    run = failedRun(run, error, {
      screenshotIntent,
      expectedScreenshots,
      recovery: { resumable: workspaceCreated && !options.revisionOf, ignorable: workspaceCreated },
    })
    await writeRun(options.root, run)
    await recordSyncRun(options.root, run, history)
    return run
  }
}

/** The inputs a proposal's agent run was started with, persisted beside the run. */
export interface RunAuthoringRecord {
  schemaVersion: 1
  mode: 'create' | 'update'
  trigger: SyncRunTrigger
  screenshots: ScreenshotIntent
  request?: string
  historyRequest?: string
  agent?: AgentName
  model?: string
  reasoning?: ReasoningLevel
  effort?: ClaudeEffortLevel
  timeoutMinutes?: number
  changeSummary?: string
  authoringSources?: DoxloopProject['sources']
  nextSyncState?: SyncState
}

async function readPersistedAuthoring(root: string, id: string): Promise<RunAuthoringRecord | undefined> {
  const path = join(runDirectory(root, id), AUTHORING_FILE)
  if (!(await pathExists(path))) return undefined
  try {
    const value = await readJson<RunAuthoringRecord>(path)
    if (!value || value.schemaVersion !== 1 || (value.mode !== 'create' && value.mode !== 'update')) return undefined
    return value
  } catch {
    return undefined
  }
}

function failedRun(
  run: SyncRun,
  error: unknown,
  details: {
    screenshotIntent: ScreenshotIntent
    expectedScreenshots: { guides: number; captures: number }
    recovery: NonNullable<SyncRun['recovery']>
  },
): SyncRun {
  const message = error instanceof Error ? error.message : String(error)
  return {
    ...run,
    status: 'failed',
    completedAt: new Date().toISOString(),
    error: message,
    ...(details.expectedScreenshots.guides > 0 && details.screenshotIntent !== 'disabled' ? {
      screenshots: {
        intent: details.screenshotIntent,
        status: 'failed',
        planned: details.expectedScreenshots.captures,
        captured: 0,
        textOnly: 0,
        guides: details.expectedScreenshots.guides,
        message,
      },
    } : {}),
    summary: 'Proposal generation failed',
    recovery: details.recovery,
  }
}

/**
 * The post-agent pipeline every proposal goes through before review: restore
 * the portable source bindings, check the screenshot manifest, validate the
 * documentation, and turn the workspace into reviewable changes. Shared by a
 * fresh run, a recovered run, and a resumed run so all three are judged alike.
 */
async function finalizeProposalWorkspace(input: {
  context: CreateSyncRunOptions
  directory: string
  workspace: string
  originalProjectText: string
  screenshotIntent: ScreenshotIntent
  /** Accept screenshot problems as text-only steps instead of failing. */
  tolerateScreenshotDefects?: boolean
  /** Claim, consolidate, and place captures the agent left unrecorded. */
  repairCaptures?: boolean
  label: 'generated' | 'recovered' | 'resumed'
}): Promise<{ changes: SyncFileChange[]; validation: SyncRun['validation'] & object; screenshots: ScreenshotRunSummary }> {
  const { context, workspace, directory } = input
  if (context.nextSyncState) {
    await writeFile(
      join(workspace, '.doxloop', 'sync-state.json'),
      `${JSON.stringify(context.nextSyncState, null, 2)}\n`,
      'utf8',
    )
  }
  // The staged project uses absolute sources so it can live away from the real
  // project. Restore the user's portable bindings before calculating changes.
  await restoreWorkspaceSources(workspace, context.project, input.originalProjectText)
  if (input.repairCaptures) {
    // An agent that stopped early may have left real images unrecorded or
    // unplaced; claim them the way a completed run would before judging.
    await adoptCapturedImages(workspace, context.project.generator, context.plan)
    await collapseDuplicateCaptures(workspace, context.plan)
    await embedMissingCaptures(workspace, context.plan)
  }
  const screenshotResult = await validateScreenshotManifest(workspace, context.plan, input.screenshotIntent, {
    ...(input.tolerateScreenshotDefects ? { tolerateDefects: true } : {}),
  })
  if (screenshotResult.manifest) {
    await writeFile(join(directory, 'screenshots.json'), `${JSON.stringify(screenshotResult.manifest, null, 2)}\n`, 'utf8')
  }
  const validation = await validateProject(workspace)
  if (validation.errors > 0) {
    throw new DoxloopError(
      `The ${input.label} proposal did not pass validation:\n${formatValidation(validation)}`,
    )
  }
  const collected = await collectProposalChanges(context.root, workspace, directory, context.project)
  await assertProposalSourceScopes(workspace, collected, context.project)
  const changes = await enrichProposalRationales(context.root, workspace, collected, context, validation)
  if (changes.length === 0) {
    throw new DoxloopError(
      input.label === 'generated'
        ? 'The agent completed without proposing any documentation changes.'
        : 'The preserved workspace contains no documentation changes to recover.',
    )
  }
  return {
    changes,
    validation: {
      pages: validation.pages.length,
      errors: validation.errors,
      warnings: validation.warnings,
    },
    screenshots: screenshotResult.summary,
  }
}

export interface RecoverSyncRunOptions {
  /**
   * Accept the preserved output even though its screenshots do not satisfy
   * the run's requirement. Each problem is recorded on the affected step and
   * on the proposal so the reviewer can see exactly what was skipped.
   */
  ignoreScreenshotProblems?: boolean
}

/**
 * Re-run the post-agent finalization pipeline on a failed run's preserved
 * workspace and promote it to review. This recovers completed agent work when
 * the failure happened after authoring — for example a screenshot-manifest
 * validation defect — without paying for another full agent run.
 */
export async function recoverSyncRun(root: string, id: string, options: RecoverSyncRunOptions = {}): Promise<SyncRun> {
  const run = await readSyncRun(root, id)
  if (run.archivedAt) throw new DoxloopError(`Proposal ${id} is archived and cannot be recovered.`)
  if (run.status !== 'failed' && run.status !== 'generating') {
    throw new DoxloopError(`Only a failed or interrupted proposal can be recovered; ${id} is ${run.status}.`)
  }
  const workspace = runWorkspace(root, id)
  if (!(await pathExists(workspace))) {
    throw new DoxloopError(`Proposal ${id} no longer has a preserved workspace to recover. Generate a new proposal instead.`)
  }
  const project = await loadProject(root)
  // Sources that changed while the run sat failed never block continuing it:
  // the work in the workspace is still worth reviewing, and the reviewer is
  // told to read it against the current evidence instead.
  const currentSnapshot = await proposalSourceSnapshot(root, project)
  const sourcesChanged = Boolean(run.sourceSnapshot && currentSnapshot !== run.sourceSnapshot)
  const directory = runDirectory(root, id)
  const plan = await recoveryPlan(workspace, run.planId)
  const authoring = await readPersistedAuthoring(root, id)
  const screenshotIntent = normalizeScreenshotIntent(authoring?.screenshots ?? run.screenshots?.intent ?? plan?.execution?.screenshots)
  const history = authoring ? historyContext(id, authoring, project) : {}
  try {
    const originalProjectText = await readFile(join(root, '.doxloop', 'project.json'), 'utf8')
    const context: CreateSyncRunOptions = {
      root,
      project,
      drift: await computeDrift(root, project),
      sourceChanges: await collectSourceChanges(root, project.sources),
      ...(plan ? { plan } : {}),
      ...(authoring?.nextSyncState ? { nextSyncState: authoring.nextSyncState } : {}),
      authoring: {
        ...(authoring?.mode ? { mode: authoring.mode } : {}),
        ...(authoring?.request ? { request: authoring.request } : {}),
        ...(authoring?.agent ? { agent: authoring.agent } : {}),
        ...(authoring?.model ? { model: authoring.model } : {}),
        ...(authoring?.reasoning ? { reasoning: authoring.reasoning } : {}),
        ...(authoring?.effort ? { effort: authoring.effort } : {}),
        screenshots: screenshotIntent,
      },
    }
    const finalized = await finalizeProposalWorkspace({
      context,
      directory,
      workspace,
      originalProjectText,
      screenshotIntent,
      repairCaptures: true,
      ...(options.ignoreScreenshotProblems ? { tolerateScreenshotDefects: true } : {}),
      label: 'recovered',
    })
    const { error: _previousError, recovery: _recovery, ...cleanRun } = run
    const next: SyncRun = {
      ...cleanRun,
      status: 'awaiting-review',
      completedAt: new Date().toISOString(),
      summary: proposalSummary(finalized.changes),
      changes: finalized.changes,
      validation: finalized.validation,
      screenshots: finalized.screenshots,
      sourceSnapshot: currentSnapshot,
      ...withAdvisory(run, sourcesChanged ? SOURCES_CHANGED_RECOVERED : undefined),
      undo: { status: 'unavailable', reason: 'Undo becomes available after the complete proposal is applied.' },
    }
    await writeRun(root, next)
    await recordSyncRun(root, next, history)
    return next
  } catch (error) {
    const failed: SyncRun = {
      ...run,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
      recovery: { resumable: Boolean(authoring) && !run.revisionOf, ignorable: true },
    }
    await writeRun(root, failed)
    await recordSyncRun(root, failed, history)
    throw error
  }
}

const SOURCES_CHANGED_RECOVERED = 'Configured sources changed after this run stopped. Its pages were kept as generated; review their claims against the current sources before accepting.'
const SOURCES_CHANGED_RESUMED = 'Configured sources changed after this run stopped. The resumed agent was told to re-check the pages it touched against the current sources.'
const SOURCES_CHANGED_DURING_REVIEW = 'Configured sources changed after this proposal was generated. The proposal was kept and remains editable and applicable; review its claims against the current sources.'
const LEGACY_STALE_SOURCE_ERROR = 'Configured source evidence changed after this proposal was generated.'

/** Add a reviewer note to a run without repeating one it already carries. */
function withAdvisory(run: SyncRun, advisory: string | undefined): { advisories?: string[] } {
  const existing = run.advisories ?? []
  const advisories = advisory && !existing.includes(advisory) ? [...existing, advisory] : existing
  return advisories.length > 0 ? { advisories } : {}
}

function historyContext(id: string, authoring: RunAuthoringRecord, project: DoxloopProject): SyncRunContext {
  return {
    requestText: authoring.historyRequest ?? authoring.request,
    agent: authoring.agent ?? project.defaultAgent,
    model: authoring.model,
    reasoningEffort: authoring.reasoning ?? authoring.effort,
    runDir: join(SYNC_RUNS_DIRECTORY, id),
  }
}

export interface ResumeSyncRunOptions {
  author?: typeof runAuthor
  /**
   * Instructions to continue with when the run predates the recorded
   * authoring inputs. A plan-first run can rebuild them from its approved plan.
   */
  fallbackAuthoring?: Omit<RunAuthoringRecord, 'schemaVersion'>
}

/**
 * Continue a failed or interrupted run's agent inside its preserved workspace.
 *
 * The agent is started with the same instructions as before plus a brief of
 * what already exists — verified screenshots, finished guides, the reason the
 * run stopped — so it completes only the unfinished part instead of writing
 * every page and capturing every image again. The run keeps its id, so the
 * plan that started it and its review history stay attached.
 */
export async function resumeSyncRun(root: string, id: string, options: ResumeSyncRunOptions = {}): Promise<SyncRun> {
  const run = await readSyncRun(root, id)
  if (run.archivedAt) throw new DoxloopError(`Proposal ${id} is archived and cannot be resumed.`)
  if (run.status !== 'failed' && run.status !== 'generating') {
    throw new DoxloopError(`Only a failed or interrupted proposal can be resumed; ${id} is ${run.status}.`)
  }
  if (run.revisionOf) {
    throw new DoxloopError('A targeted revision cannot be resumed. Ask for the revision again from the proposal it revises.')
  }
  const workspace = runWorkspace(root, id)
  if (!(await pathExists(workspace))) {
    throw new DoxloopError(`Proposal ${id} no longer has a preserved workspace to resume. Generate a new proposal instead.`)
  }
  const authoring = (await readPersistedAuthoring(root, id))
    ?? (options.fallbackAuthoring ? { schemaVersion: 1 as const, ...options.fallbackAuthoring } : undefined)
  if (!authoring) {
    throw new DoxloopError(`Proposal ${id} did not record the instructions it was started with, so it cannot be resumed. Recover its output or generate a new proposal instead.`)
  }
  const project = await loadProject(root)
  // A source edit made while the run was stopped is a reason to re-check the
  // pages, not to discard them: the resumed agent reads the current sources.
  const currentSnapshot = await proposalSourceSnapshot(root, project)
  const sourcesChanged = Boolean(run.sourceSnapshot && currentSnapshot !== run.sourceSnapshot)
  const directory = runDirectory(root, id)
  const plan = await recoveryPlan(workspace, run.planId)
  const screenshotIntent = normalizeScreenshotIntent(authoring.screenshots)
  const expectedScreenshots = plan ? screenshotPlanSummary(plan) : { guides: 0, captures: 0 }
  const history = historyContext(id, authoring, project)
  const {
    error: _previousError,
    recovery: _recovery,
    completedAt: _completedAt,
    validation: _validation,
    screenshots: _screenshots,
    ...cleanRun
  } = run
  let next: SyncRun = {
    ...cleanRun,
    status: 'generating',
    resumedAt: new Date().toISOString(),
    summary: 'Continuing the interrupted documentation run',
    sourceSnapshot: currentSnapshot,
    ...withAdvisory(run, sourcesChanged ? SOURCES_CHANGED_RESUMED : undefined),
  }
  await writeRun(root, next)
  await recordSyncRun(root, next, history)
  try {
    const originalProjectText = await readFile(join(root, '.doxloop', 'project.json'), 'utf8')
    await rewriteWorkspaceSources(workspace, root, {
      ...project,
      sources: authoring.authoringSources ?? project.sources,
    })
    const continuation = await continuationBrief(workspace, plan, run, screenshotIntent, authoring.request, sourcesChanged)
    const exitCode = await (options.author ?? runAuthor)({
      root: workspace,
      mode: authoring.mode,
      nonInteractive: true,
      recordHistory: false,
      request: continuation,
      screenshots: screenshotIntent,
      ...(authoring.changeSummary ? { changeSummary: authoring.changeSummary } : {}),
      ...(authoring.agent ? { agent: authoring.agent } : {}),
      ...(authoring.model ? { model: authoring.model } : {}),
      ...(authoring.reasoning ? { reasoning: authoring.reasoning } : {}),
      ...(authoring.effort ? { effort: authoring.effort } : {}),
      ...(authoring.timeoutMinutes ? { timeoutMinutes: authoring.timeoutMinutes } : {}),
    })
    if (exitCode !== 0) {
      throw new DoxloopError(agentExitMessage(exitCode))
    }
    const context: CreateSyncRunOptions = {
      root,
      project,
      drift: await computeDrift(root, project),
      sourceChanges: await collectSourceChanges(root, project.sources),
      trigger: authoring.trigger,
      ...(plan ? { plan } : {}),
      ...(authoring.authoringSources ? { authoringSources: authoring.authoringSources } : {}),
      ...(authoring.nextSyncState ? { nextSyncState: authoring.nextSyncState } : {}),
      authoring: {
        mode: authoring.mode,
        ...(authoring.request ? { request: authoring.request } : {}),
        ...(authoring.agent ? { agent: authoring.agent } : {}),
        ...(authoring.model ? { model: authoring.model } : {}),
        ...(authoring.reasoning ? { reasoning: authoring.reasoning } : {}),
        ...(authoring.effort ? { effort: authoring.effort } : {}),
        screenshots: screenshotIntent,
      },
    }
    const finalized = await finalizeProposalWorkspace({
      context,
      directory,
      workspace,
      originalProjectText,
      screenshotIntent,
      label: 'resumed',
    })
    next = {
      ...next,
      status: 'awaiting-review',
      completedAt: new Date().toISOString(),
      summary: proposalSummary(finalized.changes),
      changes: finalized.changes,
      validation: finalized.validation,
      screenshots: finalized.screenshots,
      undo: { status: 'unavailable', reason: 'Undo becomes available after the complete proposal is applied.' },
    }
    await writeRun(root, next)
    await recordSyncRun(root, next, history)
    return next
  } catch (error) {
    next = failedRun(next, error, {
      screenshotIntent,
      expectedScreenshots,
      recovery: { resumable: true, ignorable: true },
    })
    await writeRun(root, next)
    await recordSyncRun(root, next, history)
    return next
  }
}

/**
 * Tell a continuing agent what the workspace already holds and what is left.
 * Verified captures are named so they are kept, unfinished guides are named
 * with their start path, and the previous failure is quoted so the agent works
 * on the actual problem instead of rediscovering it.
 */
async function continuationBrief(
  workspace: string,
  plan: DocumentationPlan | undefined,
  run: SyncRun,
  intent: ScreenshotIntent,
  originalRequest: string | undefined,
  sourcesChanged = false,
): Promise<string> {
  const progress = await describeScreenshotManifestProgress(workspace, plan)
  let validationText = ''
  try {
    const validation = await validateProject(workspace)
    if (validation.errors > 0) validationText = formatValidation(validation)
  } catch {
    // Validation problems are reported again after the agent finishes.
  }
  const sections = [
    'This run continues an earlier authoring run in this same workspace that stopped before Doxloop could accept its output. The workspace already holds the pages, navigation, evidence map, and application screenshots that run produced. Keep that work: do not rewrite pages that are already complete, do not recapture, rename, or delete screenshots that .doxloop/screenshot-manifest.json records as verified and whose files exist, and do not rebuild that manifest from scratch. Finish only what is listed below as unfinished or wrong, bring any page you touch to full depth, then run validation and finish.',
    run.error ? `Why the previous run stopped:\n${run.error}` : '',
    sourcesChanged
      ? 'The configured sources changed after the previous run stopped. Re-check the claims of every page you touch against the current source evidence, and update .doxloop/evidence-map.json for those pages; leave pages you do not touch as they are.'
      : '',
    progress.lines.length > 0
      ? `Screenshot manifest progress (${progress.verified} verified, ${progress.unfinished} unfinished):\n${progress.lines.join('\n')}`
      : '',
    validationText ? `Documentation validation currently reports:\n${validationText}` : '',
    intent === 'enabled'
      ? 'Screenshots are required: every unfinished guide above needs at least one verified, embedded capture, or a specific text-only reason on each step whose state genuinely cannot be reached.'
      : '',
    originalRequest?.trim() ? `The original instructions for this run were:\n${originalRequest.trim()}` : '',
  ]
  return sections.filter(Boolean).join('\n\n')
}

/** The workspace's own plan copy, used when re-validating preserved agent output. */
async function recoveryPlan(workspace: string, planId?: string): Promise<DocumentationPlan | undefined> {
  const path = join(workspace, '.doxloop', 'documentation-plan.json')
  if (!(await pathExists(path))) return undefined
  try {
    const plan = await readJson<DocumentationPlan>(path)
    if (!plan || !Array.isArray(plan.pages) || !plan.target) return undefined
    if (planId && plan.id !== planId) return undefined
    return plan
  } catch {
    return undefined
  }
}

export async function listSyncRuns(root: string): Promise<SyncRun[]> {
  const directory = join(root, SYNC_RUNS_DIRECTORY)
  if (!(await pathExists(directory))) return []
  const entries = await readdir(directory, { withFileTypes: true })
  const runs: SyncRun[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    try {
      runs.push(await readSyncRun(root, entry.name))
    } catch {
      // An interrupted directory without a valid manifest is not a review run.
    }
  }
  return runs.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
}

export async function readSyncRun(root: string, id: string): Promise<SyncRun> {
  assertRunId(id)
  const raw = await readJson<unknown>(join(runDirectory(root, id), RUN_FILE))
  const { run, migrated } = normalizeSyncRun(raw, id)
  if (!run || run.id !== id || !Array.isArray(run.changes)) {
    throw new DoxloopError(`Sync run ${id} is invalid.`)
  }
  if (migrated) await writeRun(root, run)
  const changes = run.changes.filter((change) => !isExcluded(change.path))
  const excludedRuntimeConflict = run.status === 'conflicted' && Boolean(
    run.error && EXCLUDED_PREFIXES.some((prefix) =>
      run.error!.startsWith(`${prefix} `) || run.error!.startsWith(`${prefix}/`),
    ),
  )
  if (changes.length === run.changes.length && !excludedRuntimeConflict) return run
  if (excludedRuntimeConflict) {
    const { error: _excludedError, ...cleanRun } = run
    return {
      ...cleanRun,
      status: 'awaiting-review',
      changes,
      summary: proposalSummary(changes),
    }
  }
  return {
    ...run,
    changes,
    summary: proposalSummary(changes),
  }
}

export async function rejectSyncRun(root: string, id: string): Promise<SyncRun> {
  const run = await readSyncRun(root, id)
  if (run.archivedAt) throw new DoxloopError(`Proposal ${id} is archived and cannot be changed.`)
  if (!['awaiting-review', 'partially-applied', 'conflicted'].includes(run.status)) {
    throw new DoxloopError(`Sync run ${id} cannot be rejected from status ${run.status}.`)
  }
  const now = new Date().toISOString()
  const next: SyncRun = {
    ...run,
    status: 'rejected',
    rejectedAt: now,
    changes: run.changes.map((change) => ({
      ...change,
      hunks: change.hunks.map((hunk) =>
        hunk.acceptedAt || hunk.rejectedAt ? hunk : { ...hunk, rejectedAt: now },
      ),
    })),
  }
  await writeRun(root, next)
  await recordSyncRun(root, next)
  await recordReviewPreference(root, { kind: 'rejection', paths: run.changes.map((change) => change.path), instruction: 'Do not repeat this complete proposal without new evidence or explicit reviewer direction.' }).catch(() => undefined)
  return next
}

export async function reviseSyncRun(root: string, id: string, input: ReviseSyncRunInput): Promise<SyncRun> {
  const run = await readSyncRun(root, id)
  if (run.archivedAt) throw new DoxloopError(`Proposal ${id} is archived and cannot be revised.`)
  if (!['awaiting-review', 'partially-applied', 'conflicted', 'stale'].includes(run.status)) {
    throw new DoxloopError(`Proposal ${id} cannot be revised from status ${run.status}.`)
  }
  const instruction = input.instruction.trim()
  if (!instruction) throw new DoxloopError('Describe how the selected documentation should change.')
  const changeIds = [...new Set(input.changeIds)]
  if (changeIds.length === 0) throw new DoxloopError('Select at least one file or change to revise.')
  const selected = changeIds.map((changeId) => {
    const change = run.changes.find((item) => item.id === changeId)
    if (!change) throw new DoxloopError(`Unknown proposal change ${changeId}.`)
    return change
  })
  const hunkIds = [...new Set(input.hunkIds ?? [])]
  for (const hunkId of hunkIds) {
    if (!selected.some((change) => change.hunks.some((hunk) => hunk.id === hunkId))) {
      throw new DoxloopError(`Unknown selected change hunk ${hunkId}.`)
    }
  }
  const project = await loadProject(root)
  const [drift, sourceChanges] = await Promise.all([
    computeDrift(root, project),
    collectSourceChanges(root, project.sources),
  ])
  const scope = selected.map((change) => `- ${change.path}`).join('\n')
  const hunkScope = hunkIds.length > 0
    ? `\nSelected change hunks: ${hunkIds.join(', ')}. Keep unrelated parts of those files unchanged.`
    : ''
  const plan = await optionalApprovedPlan(root)
  await recordReviewPreference(root, { kind: 'revision', paths: selected.map((change) => change.path), instruction }).catch(() => undefined)
  return createSyncRun({
    root,
    project,
    drift,
    sourceChanges,
    revisionOf: run.id,
    revisionRequest: { instruction, changeIds, hunkIds },
    ...(plan ? { plan } : {}),
    ...(input.author ? { author: input.author } : {}),
    authoring: {
      mode: run.authoringMode ?? 'update',
      request: `Revise only the selected proposal scope below. Preserve every other proposed file exactly as it is.\n\nSelected files:\n${scope}${hunkScope}\n\nReviewer instruction:\n${instruction}`,
      ...(project.defaultAgent ? { agent: project.defaultAgent } : {}),
      screenshots: 'disabled',
    },
  })
}

export async function readSyncRunChangeContent(root: string, id: string, changeId: string): Promise<{ content: string; path: string; evidenceDisposition: 'preserved' | 'needs-review' }> {
  const run = await readSyncRun(root, id)
  const change = run.changes.find((item) => item.id === changeId)
  if (!change) throw new DoxloopError(`Unknown proposal change ${changeId}.`)
  if (change.binary || change.kind === 'deleted') throw new DoxloopError('Only proposed text files can be edited inline.')
  const content = await readFile(assertInside(runWorkspace(root, id), resolve(runWorkspace(root, id), change.path)), 'utf8')
  const edit = [...run.humanEdits].reverse().find((item) => item.path === change.path)
  return { content, path: change.path, evidenceDisposition: edit?.evidenceDisposition ?? 'preserved' }
}

export async function editSyncRunChange(
  root: string,
  id: string,
  changeId: string,
  content: string,
  evidenceDisposition: 'preserved' | 'needs-review',
): Promise<SyncRun> {
  let run = await readSyncRun(root, id)
  if (run.archivedAt) throw new DoxloopError(`Proposal ${id} is archived and cannot be edited.`)
  if (run.status !== 'awaiting-review') throw new DoxloopError('Inline edits require a proposal that has not been partially applied.')
  run = await refreshProposalSourceSnapshot(root, run)
  const change = run.changes.find((item) => item.id === changeId)
  if (!change) throw new DoxloopError(`Unknown proposal change ${changeId}.`)
  if (change.binary || change.kind === 'deleted' || change.category !== 'page') {
    throw new DoxloopError('Inline editing is available only for proposed text pages.')
  }
  if (Buffer.byteLength(content, 'utf8') > 1_000_000) throw new DoxloopError('Inline page edits are limited to 1 MB.')
  const workspace = runWorkspace(root, id)
  const path = assertInside(workspace, resolve(workspace, change.path))
  const previous = await readFile(path)
  const evidencePath = join(workspace, '.doxloop', 'evidence-map.json')
  const previousEvidence = (await pathExists(evidencePath)) ? await readFile(evidencePath) : undefined
  try {
    await writeAtomic(path, Buffer.from(content))
    if (evidenceDisposition === 'needs-review' && previousEvidence) {
      const evidence = JSON.parse(previousEvidence.toString('utf8')) as EvidenceMap
      const pageEvidence = evidence.pages[change.path]
      if (pageEvidence) {
        evidence.pages[change.path] = { ...pageEvidence, confidence: 'needs-human' }
        await writeAtomic(evidencePath, Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`))
      }
    }
    const validation = await validateProject(workspace)
    if (validation.errors > 0) {
      throw new DoxloopError(`The inline edit did not pass validation:\n${formatValidation(validation)}`)
    }
    const project = await loadProject(root)
    const sourceChanges = await collectSourceChanges(root, project.sources)
    const plan = await optionalApprovedPlan(root)
    const collected = await collectProposalChanges(root, workspace, runDirectory(root, id), project)
    await assertProposalSourceScopes(workspace, collected, project)
    let changes = await enrichProposalRationales(root, workspace, collected, {
      root,
      project,
      drift: await computeDrift(root, project),
      sourceChanges,
      ...(plan ? { plan } : {}),
      authoring: {
        ...(change.rationale.request ? { request: change.rationale.request } : {}),
        screenshots: 'disabled',
      },
    }, validation)
    changes = changes.map((item) => {
      const old = run.changes.find((candidate) => candidate.path === item.path)
      if (item.path !== change.path) return old ? { ...item, rationale: old.rationale } : item
      const evidencePreserved = evidenceDisposition === 'preserved'
      return {
        ...item,
        rationale: {
          ...(old?.rationale ?? item.rationale),
          reason: `A reviewer edited “${item.title}” directly before acceptance.`,
          confidence: evidencePreserved ? (old?.rationale.confidence ?? item.rationale.confidence) : 'needs-human',
          assumptions: evidencePreserved
            ? [...new Set([...(old?.rationale.assumptions ?? []), 'A reviewer changed the prose while preserving the recorded evidence associations.'])]
            : ['The reviewer marked the evidence associations for re-checking after this edit.'],
          authorship: 'human',
        },
      }
    })
    const next: SyncRun = {
      ...run,
      summary: proposalSummary(changes),
      changes,
      humanEdits: [...run.humanEdits, { changeId, path: change.path, editedAt: new Date().toISOString(), evidenceDisposition }],
      validation: { pages: validation.pages.length, errors: validation.errors, warnings: validation.warnings },
    }
    await writeRun(root, next)
    await recordSyncRun(root, next)
    await recordReviewPreference(root, { kind: 'inline-edit', paths: [change.path], instruction: evidenceDisposition === 'preserved' ? 'Preserve this reviewer-authored wording while its supporting evidence remains valid.' : 'A reviewer changed this page and requires its evidence to be checked again.' }).catch(() => undefined)
    return next
  } catch (error) {
    await writeAtomic(path, previous)
    await writeAtomic(evidencePath, previousEvidence)
    throw error
  }
}

export async function undoSyncRun(root: string, id: string): Promise<SyncRun> {
  const run = await readSyncRun(root, id)
  if (run.status !== 'applied' || run.undo?.status === 'undone') {
    throw new DoxloopError(`Proposal ${id} does not have an applied change set available to undo.`)
  }
  const originals = new Map<string, Buffer | undefined>()
  const operationalPath = join(root, '.doxloop', 'sync-state.json')
  const operationalCurrent = (await pathExists(operationalPath)) ? await readFile(operationalPath) : undefined
  try {
    for (const change of run.changes) {
      const before = await proposalAcceptanceBefore(root, id, change.path)
      const actualPath = safeRunPath(root, change.path)
      const current = (await pathExists(actualPath)) ? await readFile(actualPath) : undefined
      const appliedSnapshot = await readChangeSnapshot(join(runDirectory(root, id), APPLIED), change.path)
      const expected = appliedSnapshot.found
        ? appliedSnapshot.content
        : await materializeChange(
            await proposalBefore(root, id, change.path),
            change,
            new Set(change.hunks.map((hunk) => hunk.id)),
            runWorkspace(root, id),
          )
      if (!buffersEqual(current, expected)) {
        throw new DoxloopError(`${change.path} changed after this proposal was applied. Undo stopped without overwriting the newer edit.`)
      }
      originals.set(change.path, current)
      await writeAtomic(actualPath, before)
    }
    await restoreOperationalBefore(root, id)
    const validation = await validateProject(root)
    if (validation.errors > 0) throw new DoxloopError(`Undo would leave invalid documentation:\n${formatValidation(validation)}`)
    const undoneAt = new Date().toISOString()
    const next: SyncRun = { ...run, status: 'undone', undo: { status: 'undone', undoneAt } }
    await writeRun(root, next)
    await recordSyncRun(root, next)
    await syncPageRegistry(root, undefined, next.id)
    return next
  } catch (error) {
    for (const [path, content] of originals) await writeAtomic(safeRunPath(root, path), content)
    await writeAtomic(operationalPath, operationalCurrent)
    throw error
  }
}

export async function archiveSyncRun(root: string, id: string): Promise<SyncRun> {
  const run = await readSyncRun(root, id)
  if (run.status === 'generating') throw new DoxloopError('A generating proposal cannot be archived.')
  const next = { ...run, archivedAt: new Date().toISOString() }
  await writeRun(root, next)
  return next
}

export async function pruneSyncRuns(root: string, now = new Date()): Promise<string[]> {
  const removable = new Set<SyncRun['status']>(['rejected', 'failed', 'superseded', 'undone'])
  const removed: string[] = []
  for (const run of await listSyncRuns(root)) {
    const expired = run.retentionUntil && new Date(run.retentionUntil) <= now
    if (!(run.archivedAt || (expired && removable.has(run.status)))) continue
    await rm(runDirectory(root, run.id), { recursive: true, force: true })
    removed.push(run.id)
  }
  return removed
}

/** Apply selected hunks after proving the real files still match this proposal. */
export async function acceptSyncChanges(
  root: string,
  id: string,
  selections: AcceptSelection[],
): Promise<SyncRun> {
  let run = await readSyncRun(root, id)
  if (run.archivedAt) throw new DoxloopError(`Proposal ${id} is archived and cannot be applied.`)
  if (!['awaiting-review', 'partially-applied', 'conflicted'].includes(run.status)) {
    throw new DoxloopError(`Sync run ${id} cannot be applied from status ${run.status}.`)
  }
  run = await refreshProposalSourceSnapshot(root, run)
  const requested = new Map<string, Set<string>>()
  for (const selection of selections) {
    const change = run.changes.find((candidate) => candidate.id === selection.changeId)
    if (!change) throw new DoxloopError(`Unknown change ${selection.changeId}.`)
    const ids = new Set(
      selection.hunkIds && selection.hunkIds.length > 0
        ? selection.hunkIds
        : change.hunks.filter((hunk) => !hunk.acceptedAt && !hunk.rejectedAt).map((hunk) => hunk.id),
    )
    for (const hunkId of ids) {
      if (!change.hunks.some((hunk) => hunk.id === hunkId)) {
        throw new DoxloopError(`Unknown change hunk ${hunkId}.`)
      }
    }
    requested.set(change.id, ids)
  }
  if (requested.size === 0) throw new DoxloopError('Select at least one documentation change.')

  if (!run.changes.some((change) => change.hunks.some((hunk) => hunk.acceptedAt))) {
    await snapshotOperationalBefore(root, runDirectory(root, id), true)
    await snapshotChangeSet(root, join(runDirectory(root, id), ACCEPTANCE_BEFORE), run.changes)
  }

  const originals = new Map<string, Buffer | undefined>()
  const now = new Date().toISOString()
  let nextChanges = run.changes.map((change) => ({
    ...change,
    hunks: change.hunks.map((hunk) => ({ ...hunk })),
  }))

  try {
    for (const change of nextChanges) {
      const ids = requested.get(change.id)
      if (!ids || ids.size === 0) continue
      const actualPath = safeRunPath(root, change.path)
      const before = await proposalBefore(root, run.id, change.path)
      const current = (await pathExists(actualPath)) ? await readFile(actualPath) : undefined
      const expected = await materializeChange(
        before,
        change,
        acceptedIds(change),
        runWorkspace(root, run.id),
      )
      const accepted = new Set([...acceptedIds(change), ...ids])
      let result = await materializeChange(
        before,
        change,
        accepted,
        runWorkspace(root, run.id),
      )
      if (!buffersEqual(current, expected)) {
        const merged = change.path === '.doxloop/evidence-map.json' && expected && current && result
          ? mergeConcurrentJson(expected, current, result)
          : undefined
        if (!merged) {
          throw new DoxloopError(
            `${change.path} changed after this proposal was generated. Regenerate or review the conflict; no file was overwritten.`,
          )
        }
        result = merged
      }
      originals.set(change.path, current)
      await writeAtomic(actualPath, result)
      change.hunks = change.hunks.map((hunk) =>
        ids.has(hunk.id) && !hunk.rejectedAt ? { ...hunk, acceptedAt: now } : hunk,
      )
    }

    const validation = await validateProject(root)
    if (validation.errors > 0) {
      throw new DoxloopError(
        `The selected changes were not applied because they would leave invalid documentation:\n${formatValidation(validation)}`,
      )
    }
    const complete = nextChanges.every((change) =>
      change.hunks.every((hunk) => hunk.acceptedAt !== undefined),
    )
    if (complete) await applyStagedSyncState(root, id)
    if (complete) await snapshotChangeSet(root, join(runDirectory(root, id), APPLIED), nextChanges)
    const { error: _previousError, ...cleanRun } = run
    const next: SyncRun = {
      ...cleanRun,
      status: complete ? 'applied' : 'partially-applied',
      ...(complete ? { appliedAt: now } : {}),
      undo: complete
        ? { status: 'available' }
        : { status: 'unavailable', reason: 'Undo becomes available after the complete proposal is applied.' },
      changes: nextChanges,
      validation: {
        pages: validation.pages.length,
        errors: validation.errors,
        warnings: validation.warnings,
      },
    }
    await writeRun(root, next)
    await recordSyncRun(root, next)
    // Accepted hunks are now real files. Refresh the registry so page history
    // and the external-edit check both start from what is actually on disk.
    await syncPageRegistry(root, undefined, next.id)
    if (complete) {
      await recordSourceSyncs(root, await readOptionalSyncState(root), next.id)
      await recordAppliedAuthoringReceipt(root, next).catch(() => undefined)
    }
    return next
  } catch (error) {
    for (const [path, content] of originals) await writeAtomic(safeRunPath(root, path), content)
    await restoreOperationalBefore(root, id)
    const conflicted: SyncRun = {
      ...run,
      status: error instanceof DoxloopError && error.message.includes('changed after')
        ? 'conflicted'
        : run.status,
      error: error instanceof Error ? error.message : String(error),
    }
    await writeRun(root, conflicted)
    await recordSyncRun(root, conflicted)
    throw error
  }
}

async function readOptionalSyncState(root: string): Promise<SyncState | undefined> {
  const path = join(root, '.doxloop', 'sync-state.json')
  if (!(await pathExists(path))) return undefined
  try {
    return await readJson<SyncState>(path)
  } catch {
    return undefined
  }
}

async function recordAppliedAuthoringReceipt(root: string, run: SyncRun): Promise<void> {
  if (!run.authoringMode || !run.validation) return
  await writeAtomic(join(root, '.doxloop', 'last-run.json'), Buffer.from(`${JSON.stringify({
    schemaVersion: 1,
    mode: run.authoringMode,
    completedAt: run.appliedAt ?? new Date().toISOString(),
    proposalId: run.id,
    ...(run.planId ? { planId: run.planId } : {}),
    validation: run.validation,
  }, null, 2)}\n`))
}

const JSON_MISSING = Symbol('json-missing')

function mergeConcurrentJson(base: Buffer, current: Buffer, proposed: Buffer): Buffer | undefined {
  try {
    const merged = mergeJsonValue(
      JSON.parse(base.toString('utf8')) as unknown,
      JSON.parse(current.toString('utf8')) as unknown,
      JSON.parse(proposed.toString('utf8')) as unknown,
    )
    if (merged === JSON_MISSING) return undefined
    return Buffer.from(`${JSON.stringify(merged, null, 2)}\n`)
  } catch {
    return undefined
  }
}

function mergeJsonValue(
  base: unknown | typeof JSON_MISSING,
  current: unknown | typeof JSON_MISSING,
  proposed: unknown | typeof JSON_MISSING,
): unknown | typeof JSON_MISSING {
  if (isDeepStrictEqual(current, base)) return proposed
  if (isDeepStrictEqual(proposed, base) || isDeepStrictEqual(current, proposed)) return current
  if (isJsonRecord(base) && isJsonRecord(current) && isJsonRecord(proposed)) {
    const result: Record<string, unknown> = {}
    const keys = new Set([...Object.keys(base), ...Object.keys(current), ...Object.keys(proposed)])
    for (const key of keys) {
      const merged = mergeJsonValue(
        Object.hasOwn(base, key) ? base[key] : JSON_MISSING,
        Object.hasOwn(current, key) ? current[key] : JSON_MISSING,
        Object.hasOwn(proposed, key) ? proposed[key] : JSON_MISSING,
      )
      if (merged !== JSON_MISSING) result[key] = merged
    }
    return result
  }
  // Both sides changed the same scalar or array. Preserve the newer accepted value.
  return current
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export function formatSyncRunHistory(runs: SyncRun[]): string {
  if (runs.length === 0) return 'No documentation sync runs yet.'
  const lines = ['Documentation sync runs', '']
  for (const run of runs) {
    const counts = changeCounts(run.changes)
    lines.push(
      `  ${statusMark(run.status)} ${run.id}  ${run.status.padEnd(18)} ${counts}  ${run.createdAt}`,
      `      ${run.summary}`,
    )
  }
  lines.push('', 'Review visually with: doxloop sync review --open')
  return lines.join('\n')
}

export function pendingRunCount(runs: SyncRun[]): number {
  return runs.filter((run) =>
    ['awaiting-review', 'partially-applied', 'conflicted'].includes(run.status),
  ).length
}

export function runWorkspace(root: string, id: string): string {
  assertRunId(id)
  return join(runDirectory(root, id), WORKSPACE)
}

export function runBeforeRoot(root: string, id: string): string {
  assertRunId(id)
  return join(runDirectory(root, id), BEFORE)
}

async function createWorkspace(
  root: string,
  runRoot: string,
  project: DoxloopProject,
  authoringSources?: DoxloopProject['sources'],
): Promise<string> {
  const temporary = await mkdtemp(join(tmpdir(), 'doxloop-sync-review-'))
  const staged = join(temporary, WORKSPACE)
  try {
    await cp(root, staged, {
      recursive: true,
      preserveTimestamps: true,
      filter: (source) => {
        const rel = portable(relative(root, source))
        return rel === '' || !isExcluded(rel)
      },
    })
    await rewriteWorkspaceSources(staged, root, {
      ...project,
      sources: authoringSources ?? project.sources,
    })
    await initializeWorkspaceGit(staged)
    const target = join(runRoot, WORKSPACE)
    await rename(staged, target)
    return target
  } finally {
    await rm(temporary, { recursive: true, force: true })
  }
}

async function seedRevisionWorkspace(root: string, revisionOf: string, workspace: string): Promise<void> {
  const source = runWorkspace(root, revisionOf)
  if (!(await pathExists(source))) throw new DoxloopError(`Proposal ${revisionOf} no longer has an isolated workspace to revise.`)
  await cp(source, workspace, {
    recursive: true,
    force: true,
    preserveTimestamps: true,
    filter: (path) => portable(relative(source, path)) !== '.git' && !portable(relative(source, path)).startsWith('.git/'),
  })
}

async function initializeWorkspaceGit(workspace: string): Promise<void> {
  await runCommand('git', ['init', '--initial-branch=doxloop-review'], { cwd: workspace })
  await runCommand('git', ['add', '.'], { cwd: workspace })
  await runCommand(
    'git',
    [
      '-c',
      'user.name=Doxloop Review',
      '-c',
      'user.email=review@doxloop.local',
      'commit',
      '-m',
      'Doxloop proposal baseline',
    ],
    { cwd: workspace },
  )
}

async function rewriteWorkspaceSources(
  workspace: string,
  root: string,
  project: DoxloopProject,
): Promise<void> {
  const path = join(workspace, '.doxloop', 'project.json')
  const staged = JSON.parse(await readFile(path, 'utf8')) as DoxloopProject
  staged.sources = project.sources.map((source) => ({
    ...source,
    path: isAbsolute(source.path) ? source.path : resolve(root, source.path),
  }))
  await writeFile(path, `${JSON.stringify(staged, null, 2)}\n`, 'utf8')
}

async function restoreWorkspaceSources(
  workspace: string,
  project: DoxloopProject,
  originalText: string,
): Promise<void> {
  const path = join(workspace, '.doxloop', 'project.json')
  const staged = JSON.parse(await readFile(path, 'utf8')) as DoxloopProject
  staged.sources = project.sources
  const original = JSON.parse(originalText) as DoxloopProject
  await writeFile(
    path,
    JSON.stringify(staged) === JSON.stringify(original)
      ? originalText
      : `${JSON.stringify(staged, null, 2)}\n`,
    'utf8',
  )
}

async function collectProposalChanges(
  root: string,
  workspace: string,
  runRoot: string,
  project: DoxloopProject,
): Promise<SyncFileChange[]> {
  const [beforeFiles, afterFiles] = await Promise.all([
    collectFiles(root),
    collectFiles(workspace),
  ])
  const paths = [...new Set([...beforeFiles.keys(), ...afterFiles.keys()])].sort()
  const pageExtensions = await documentationPageExtensions(root, project)
  const changes: SyncFileChange[] = []
  for (const path of paths) {
    if (INTERNAL_DIFF_PATHS.has(path)) continue
    const before = beforeFiles.get(path)
    const after = afterFiles.get(path)
    if (buffersEqual(before, after)) continue
    if (before) {
      const target = join(runRoot, BEFORE, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, before)
    }
    const binary = isBinary(path, before, after)
    const kind = before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified'
    const changeId = `change-${changes.length + 1}`
    const hunks = binary
      ? [{ id: `${changeId}-file`, oldStart: 0, oldLines: [], newStart: 0, newLines: [] }]
      : lineHunks(before?.toString('utf8') ?? '', after?.toString('utf8') ?? '', changeId)
    changes.push({
      id: changeId,
      path,
      title: await changeTitle(
        path,
        before ? join(root, path) : join(workspace, path),
        project,
        pageExtensions,
      ),
      kind,
      category: changeCategory(path, project, pageExtensions),
      binary,
      ...(before ? { beforeHash: hash(before) } : {}),
      ...(after ? { afterHash: hash(after) } : {}),
      ...(!binary && before ? { beforeEndsWithNewline: before.toString('utf8').endsWith('\n') } : {}),
      ...(!binary && after ? { afterEndsWithNewline: after.toString('utf8').endsWith('\n') } : {}),
      hunks,
      rationale: emptyRationale(kind),
    })
  }
  return changes
}

async function assertProposalSourceScopes(workspace: string, changes: SyncFileChange[], project: DoxloopProject): Promise<void> {
  const scoped = new Map(project.sources.filter((source) => source.scope?.routePrefix).map((source) => [source.name, source]))
  if (!scoped.size) return
  let map: EvidenceMap
  try { map = await readJson<EvidenceMap>(join(workspace, '.doxloop', 'evidence-map.json')) } catch { return }
  const prefix = project.contentDir.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, '')
  for (const change of changes.filter((item) => item.category === 'page')) {
    const route = change.path.replace(/\\/g, '/').replace(new RegExp(`^${escapeRegExp(prefix)}/?`), '').replace(/\.[^.]+$/, '')
    for (const evidence of map.pages[change.path]?.sources ?? []) {
      const source = scoped.get(evidence.source)
      if (!source?.scope?.routePrefix) continue
      const owned = source.scope.routePrefix.replace(/^\/+|\/+$/g, '')
      const shared = source.scope.sharedPages?.some((pattern) => matchesGlob(change.path, pattern) || matchesGlob(route, pattern)) ?? false
      if (route !== owned && !route.startsWith(`${owned}/`) && !shared) {
        throw new DoxloopError(`Source "${source.name}" is scoped to "${owned}", but the proposal attributes "${change.path}" to it. Move the page into that route or explicitly add it to source.scope.sharedPages.`)
      }
    }
  }
}

function escapeRegExp(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') }

async function enrichProposalRationales(
  root: string,
  workspace: string,
  changes: SyncFileChange[],
  options: CreateSyncRunOptions,
  validation: Awaited<ReturnType<typeof validateProject>>,
): Promise<SyncFileChange[]> {
  let evidenceMap: EvidenceMap | undefined
  let existingEvidenceMap: EvidenceMap | undefined
  try {
    evidenceMap = await readJson<EvidenceMap>(join(workspace, '.doxloop', 'evidence-map.json'))
  } catch {
    evidenceMap = undefined
  }
  try {
    existingEvidenceMap = await readJson<EvidenceMap>(join(root, '.doxloop', 'evidence-map.json'))
  } catch {
    existingEvidenceMap = undefined
  }
  const availability = Object.fromEntries(await Promise.all(options.project.sources.map(async (source) => [
    source.name,
    /^https?:\/\//i.test(source.path) || await pathExists(isAbsolute(source.path) ? source.path : resolve(root, source.path)),
  ] as const)))
  const revisions = sourceRevisionMap(options.sourceChanges)
  const changedEvidence = options.sourceChanges.flatMap((change) => sourceChangePaths(change).map((path) => ({
    source: change.name,
    path,
    ...(revisions[change.name] ? { revision: revisions[change.name] } : {}),
    available: availability[change.name] ?? false,
  })))
  return changes.map((change) => {
    const pageEvidence = evidenceMap?.pages?.[change.path] ?? existingEvidenceMap?.pages?.[change.path]
    const planPage = matchPlanPage(options.plan, change.path)
    const capabilities = options.plan?.capabilities.filter((capability) => planPage && capability.pageIds.includes(planPage.id)) ?? []
    const preciseEvidence = pageEvidence?.sources.flatMap((source) => [
      ...(source.paths ?? []).map((path) => ({
        source: source.source,
        path,
        ...((pageEvidence.verifiedAt?.[source.source] ?? revisions[source.source])
          ? { revision: pageEvidence.verifiedAt?.[source.source] ?? revisions[source.source] }
          : {}),
        available: availability[source.source] ?? false,
      })),
      ...(source.operations ?? []).map((operation) => ({
        source: source.source,
        operation,
        ...((pageEvidence.verifiedAt?.[source.source] ?? revisions[source.source])
          ? { revision: pageEvidence.verifiedAt?.[source.source] ?? revisions[source.source] }
          : {}),
        available: availability[source.source] ?? false,
      })),
    ]) ?? []
    const evidence = uniqueRationaleEvidence(preciseEvidence.length > 0 ? preciseEvidence : [
      ...capabilities.flatMap((capability) => capability.evidence.map((item) => ({
        source: item.source,
        path: item.path,
        ...(revisions[item.source] ? { revision: revisions[item.source] } : {}),
        available: availability[item.source] ?? false,
      }))),
      ...changedEvidence,
    ])
    const claims = pageEvidence?.claims ?? []
    const confidence = pageEvidence?.confidence ?? (evidence.length > 0 ? 'inferred' : 'needs-human')
    const assumptions = confidence === 'needs-human'
      ? ['The generated claims require human verification against configured evidence.']
      : []
    const fileIssues = validation.issues.filter((issue) => !issue.file || portable(issue.file) === change.path)
    return {
      ...change,
      rationale: {
        reason: planPage?.rationale || changeReason(change),
        evidence,
        affectedInterfaces: [...new Set(capabilities.flatMap((capability) => [capability.title, ...capability.evidence.flatMap((item) => item.label ? [item.label] : [])]))],
        claims: {
          added: change.kind === 'added' ? claims : [],
          changed: change.kind === 'modified' ? claims : [],
          removed: change.kind === 'deleted' ? claims : [],
        },
        validation: {
          errors: fileIssues.filter((issue) => issue.severity === 'error').length,
          warnings: fileIssues.filter((issue) => issue.severity === 'warning').length,
        },
        confidence,
        assumptions,
        ...(options.plan ? { planId: options.plan.id } : {}),
        ...(planPage ? { planPageId: planPage.id } : {}),
        ...(options.authoring?.request ? { request: options.authoring.request } : {}),
        authorship: 'agent',
      },
    }
  })
}

async function collectFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()
  await walkFiles(root, root, files)
  return files
}

async function walkFiles(root: string, directory: string, files: Map<string, Buffer>): Promise<void> {
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const absolute = resolve(directory, entry.name)
    const path = portable(relative(root, absolute))
    if (isExcluded(path)) continue
    if (entry.isDirectory()) await walkFiles(root, absolute, files)
    else if (entry.isFile()) files.set(path, await readFile(absolute))
  }
}

function isExcluded(path: string): boolean {
  return (
    path.startsWith('.agents/skills/doxloop-') ||
    path.startsWith('.claude/skills/doxloop-') ||
    EXCLUDED_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))
  )
}

async function materializeChange(
  before: Buffer | undefined,
  change: SyncFileChange,
  accepted: Set<string>,
  workspace: string,
): Promise<Buffer | undefined> {
  if (change.binary) {
    if (!accepted.has(change.hunks[0]!.id)) return before
    if (change.kind === 'deleted') return undefined
    return readFile(join(workspace, change.path))
  }
  if (accepted.size === 0) return before
  const beforeText = before?.toString('utf8') ?? ''
  const lines = textLines(beforeText)
  const output: string[] = []
  let cursor = 0
  for (const hunk of change.hunks) {
    output.push(...lines.slice(cursor, hunk.oldStart))
    output.push(...(accepted.has(hunk.id) ? hunk.newLines : hunk.oldLines))
    cursor = hunk.oldStart + hunk.oldLines.length
  }
  output.push(...lines.slice(cursor))
  if (change.kind === 'deleted' && change.hunks.every((hunk) => accepted.has(hunk.id))) {
    return undefined
  }
  const allAccepted = change.hunks.every((hunk) => accepted.has(hunk.id))
  const trailing = allAccepted
    ? (change.afterEndsWithNewline ?? false)
    : (change.beforeEndsWithNewline ?? false)
  const text = `${output.join('\n')}${trailing && output.length > 0 ? '\n' : ''}`
  return Buffer.from(text)
}

async function proposalBefore(root: string, id: string, path: string): Promise<Buffer | undefined> {
  const before = join(runBeforeRoot(root, id), path)
  return (await pathExists(before)) ? readFile(before) : undefined
}

async function proposalAcceptanceBefore(root: string, id: string, path: string): Promise<Buffer | undefined> {
  const snapshot = await readChangeSnapshot(join(runDirectory(root, id), ACCEPTANCE_BEFORE), path)
  return snapshot.found ? snapshot.content : proposalBefore(root, id, path)
}

async function snapshotChangeSet(root: string, directory: string, changes: SyncFileChange[]): Promise<void> {
  await rm(directory, { recursive: true, force: true })
  const absent: string[] = []
  for (const change of changes) {
    const actual = safeRunPath(root, change.path)
    if (!(await pathExists(actual))) {
      absent.push(change.path)
      continue
    }
    const target = join(directory, 'files', change.path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, await readFile(actual))
  }
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'manifest.json'), `${JSON.stringify({ absent }, null, 2)}\n`, 'utf8')
}

async function readChangeSnapshot(directory: string, path: string): Promise<{ found: boolean; content: Buffer | undefined }> {
  const file = join(directory, 'files', path)
  if (await pathExists(file)) return { found: true, content: await readFile(file) }
  const manifest = join(directory, 'manifest.json')
  if (!(await pathExists(manifest))) return { found: false, content: undefined }
  const value = await readJson<{ absent?: string[] }>(manifest)
  return Array.isArray(value.absent) && value.absent.includes(path)
    ? { found: true, content: undefined }
    : { found: false, content: undefined }
}

async function applyStagedSyncState(root: string, id: string): Promise<void> {
  const source = join(runWorkspace(root, id), '.doxloop', 'sync-state.json')
  if (!(await pathExists(source))) return
  await writeAtomic(join(root, '.doxloop', 'sync-state.json'), await readFile(source))
}

async function snapshotOperationalBefore(root: string, directory: string, overwrite = false): Promise<void> {
  const targetRoot = join(directory, OPERATIONAL_BEFORE)
  const stateTarget = join(targetRoot, 'sync-state.json')
  const absentTarget = join(targetRoot, 'sync-state.absent')
  if (!overwrite && ((await pathExists(stateTarget)) || (await pathExists(absentTarget)))) return
  await mkdir(targetRoot, { recursive: true })
  await rm(stateTarget, { force: true })
  await rm(absentTarget, { force: true })
  const state = join(root, '.doxloop', 'sync-state.json')
  if (await pathExists(state)) await writeFile(stateTarget, await readFile(state))
  else await writeFile(absentTarget, '', 'utf8')
}

async function restoreOperationalBefore(root: string, id: string): Promise<void> {
  const snapshotRoot = join(runDirectory(root, id), OPERATIONAL_BEFORE)
  const state = join(snapshotRoot, 'sync-state.json')
  const target = join(root, '.doxloop', 'sync-state.json')
  if (await pathExists(state)) {
    await writeAtomic(target, await readFile(state))
    return
  }
  if (await pathExists(join(snapshotRoot, 'sync-state.absent'))) await writeAtomic(target, undefined)
}

interface RevisionScope {
  selectedPaths: Set<string>
  supportingPaths: Set<string>
  wholeProposal: boolean
  hunkRanges: Map<string, Array<{ start: number; end: number }>>
}

async function resolveRevisionScope(
  root: string,
  id: string,
  request: CreateSyncRunOptions['revisionRequest'],
): Promise<RevisionScope> {
  if (!request || request.changeIds.length === 0) {
    throw new DoxloopError('A targeted proposal revision requires at least one selected change.')
  }
  const previous = await readSyncRun(root, id)
  const selectedPaths = new Set<string>()
  const hunkRanges = new Map<string, Array<{ start: number; end: number }>>()
  for (const changeId of request.changeIds) {
    const change = previous.changes.find((item) => item.id === changeId)
    if (!change) throw new DoxloopError(`Unknown proposal change ${changeId}.`)
    selectedPaths.add(change.path)
  }
  for (const hunkId of request.hunkIds ?? []) {
    const change = previous.changes.find((item) => item.hunks.some((hunk) => hunk.id === hunkId))
    const hunk = change?.hunks.find((item) => item.id === hunkId)
    if (!change || !hunk) throw new DoxloopError(`Unknown selected change hunk ${hunkId}.`)
    const ranges = hunkRanges.get(change.path) ?? []
    ranges.push({ start: hunk.newStart, end: hunk.newStart + Math.max(1, hunk.newLines.length) })
    hunkRanges.set(change.path, ranges)
  }
  const supportingPaths = new Set(
    previous.changes
      .filter((change) => ['navigation', 'configuration', 'evidence'].includes(change.category))
      .map((change) => change.path),
  )
  return {
    selectedPaths,
    supportingPaths,
    wholeProposal: selectedPaths.size === previous.changes.length && hunkRanges.size === 0,
    hunkRanges,
  }
}

async function assertRevisionStayedInScope(
  workspace: string,
  baseline: Map<string, Buffer>,
  scope: RevisionScope,
): Promise<void> {
  const after = await collectFiles(workspace)
  const paths = new Set([...baseline.keys(), ...after.keys()])
  const selectedChanged = scope.wholeProposal
    ? [...paths].some((path) => !buffersEqual(baseline.get(path), after.get(path)))
    : [...scope.selectedPaths].some((path) => !buffersEqual(baseline.get(path), after.get(path)))
  if (!selectedChanged) {
    throw new DoxloopError('The agent did not revise the selected proposal scope. The original proposal remains available.')
  }
  if (scope.wholeProposal) return
  const outOfScope = [...paths].filter((path) =>
    !buffersEqual(baseline.get(path), after.get(path))
      && !scope.selectedPaths.has(path)
      && !scope.supportingPaths.has(path),
  )
  if (outOfScope.length > 0) {
    throw new DoxloopError(
      `The revision changed files outside the selected scope: ${outOfScope.slice(0, 8).join(', ')}${outOfScope.length > 8 ? ', …' : ''}. No proposal was replaced.`,
    )
  }
  for (const [path, ranges] of scope.hunkRanges) {
    const before = baseline.get(path)
    const current = after.get(path)
    if (!before || !current || isBinary(path, before, current)) {
      throw new DoxloopError(`The selected hunk in ${path} cannot be safely revised as text.`)
    }
    const revisionHunks = lineHunks(before.toString('utf8'), current.toString('utf8'), 'revision-scope')
    const outsideHunk = revisionHunks.some((hunk) => {
      const start = hunk.oldStart
      const end = start + Math.max(1, hunk.oldLines.length)
      return !ranges.some((range) => start < range.end + 1 && end > range.start - 1)
    })
    if (outsideHunk) {
      throw new DoxloopError(`The revision changed text outside the selected hunk in ${path}. No proposal was replaced.`)
    }
  }
}

/**
 * A proposal is a reviewed change set, so source movement while it waits must
 * not discard or lock that work. Keep its snapshot current and surface the
 * difference as review context; file-level concurrency checks still protect
 * the real documentation from being overwritten during acceptance.
 */
async function refreshProposalSourceSnapshot(root: string, run: SyncRun): Promise<SyncRun> {
  const project = await loadProject(root)
  const current = await proposalSourceSnapshot(root, project)
  if (current === run.sourceSnapshot) return run
  const sourcesChanged = Boolean(run.sourceSnapshot)
  return {
    ...run,
    sourceSnapshot: current,
    ...withAdvisory(run, sourcesChanged ? SOURCES_CHANGED_DURING_REVIEW : undefined),
  }
}

async function optionalApprovedPlan(root: string): Promise<DocumentationPlan | undefined> {
  const path = join(root, '.doxloop', 'documentation-plan.json')
  if (!(await pathExists(path))) return undefined
  try {
    const plan = await readJson<DocumentationPlan>(path)
    return plan.schemaVersion === 2 && plan.status === 'approved' ? plan : undefined
  } catch {
    return undefined
  }
}

async function writeAtomic(path: string, content: Buffer | undefined): Promise<void> {
  if (content === undefined) {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error
    })
    return
  }
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.doxloop-${process.pid}-${randomBytes(4).toString('hex')}`
  await writeFile(temporary, content)
  await rename(temporary, path)
}

function normalizeSyncRun(raw: unknown, id: string): { run?: SyncRun; migrated: boolean } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { migrated: false }
  const value = raw as Record<string, unknown>
  if ((value.schemaVersion !== 1 && value.schemaVersion !== 2) || value.id !== id || !Array.isArray(value.changes)) {
    return { migrated: false }
  }
  const changes = value.changes.flatMap((item): SyncFileChange[] => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return []
    const change = item as Partial<SyncFileChange>
    if (typeof change.id !== 'string' || typeof change.path !== 'string' || !Array.isArray(change.hunks)) return []
    return [{
      ...change,
      rationale: validRationale(change.rationale) ? change.rationale : emptyRationale(change.kind),
    } as SyncFileChange]
  })
  const { authoringMode: _authoringMode, planId: _planId, ...stored } = value
  const run = {
    ...stored,
    schemaVersion: 2,
    ...(value.authoringMode === 'create' || value.authoringMode === 'update' ? { authoringMode: value.authoringMode } : {}),
    ...(typeof value.planId === 'string' && /^plan-[a-z0-9-]+$/.test(value.planId) ? { planId: value.planId } : {}),
    changes,
    revisionRequests: Array.isArray(value.revisionRequests) ? value.revisionRequests : [],
    humanEdits: Array.isArray(value.humanEdits) ? value.humanEdits : [],
  } as unknown as SyncRun
  const legacySourceStale = run.status === 'stale' && Boolean(run.error?.includes(LEGACY_STALE_SOURCE_ERROR))
  if (legacySourceStale) {
    run.status = 'awaiting-review'
    delete run.error
    Object.assign(run, withAdvisory(run, SOURCES_CHANGED_DURING_REVIEW))
  }
  return { run, migrated: value.schemaVersion === 1 || legacySourceStale }
}

function validRationale(value: unknown): value is SyncFileChange['rationale'] {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value) && typeof (value as { reason?: unknown }).reason === 'string')
}

async function writeRun(root: string, run: SyncRun): Promise<void> {
  const path = join(runDirectory(root, run.id), RUN_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(run, null, 2)}\n`, 'utf8')
}

async function ensureRunsIgnored(root: string): Promise<void> {
  const path = join(root, '.gitignore')
  const line = '.doxloop/runs/'
  const existing = (await pathExists(path)) ? await readFile(path, 'utf8') : ''
  if (existing.split(/\r?\n/).includes(line)) return
  await writeFile(path, `${existing}${existing && !existing.endsWith('\n') ? '\n' : ''}${line}\n`, 'utf8')
}

function runDirectory(root: string, id: string): string {
  assertRunId(id)
  return join(root, SYNC_RUNS_DIRECTORY, id)
}

function safeRunPath(root: string, path: string): string {
  if (path === '' || isAbsolute(path) || path.split(/[\\/]/).includes('..')) {
    throw new DoxloopError(`Unsafe proposal path: ${path}`)
  }
  return assertInside(root, resolve(root, path))
}

function assertRunId(id: string): void {
  if (!/^[a-z0-9-]+$/.test(id)) throw new DoxloopError(`Invalid sync run id: ${id}`)
}

function runId(): string {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  return `run-${stamp.toLowerCase()}-${randomBytes(3).toString('hex')}`
}

function hash(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function buffersEqual(left: Buffer | undefined, right: Buffer | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  return left.equals(right)
}


function isBinary(path: string, before: Buffer | undefined, after: Buffer | undefined): boolean {
  if (BINARY_EXTENSIONS.has(extname(path).toLowerCase())) return true
  return [before, after].some((content) => content?.subarray(0, 8_192).includes(0))
}

function acceptedIds(change: SyncFileChange): Set<string> {
  return new Set(change.hunks.filter((hunk) => hunk.acceptedAt).map((hunk) => hunk.id))
}

const NAVIGATION_PATTERN = /nav|sidebar|menu|site\.json|docs\.json|mkdocs\.yml|docusaurus\.config/i

function changeCategory(
  path: string,
  project: DoxloopProject,
  pageExtensions: ReadonlySet<string>,
): SyncChangeCategory {
  if (path === '.doxloop/evidence-map.json') return 'evidence'
  const extension = extname(path).toLowerCase()
  const content = portable(project.contentDir).replace(/\/+$/, '')
  const insideContent = content === '' || path === content || path.startsWith(`${content}/`)
  if (insideContent) {
    if (pageExtensions.has(extension)) return 'page'
    if (BINARY_EXTENSIONS.has(extension)) return 'asset'
    // Data files inside the content directory — a Doxbrix `docs.json`, an
    // MkDocs navigation file — configure the site rather than being read as
    // pages, so they must not enter the page review flow.
    return NAVIGATION_PATTERN.test(path) ? 'navigation' : 'configuration'
  }
  if (NAVIGATION_PATTERN.test(path)) return 'navigation'
  return BINARY_EXTENSIONS.has(extension) ? 'asset' : 'configuration'
}

async function changeTitle(
  path: string,
  sourcePath: string,
  project: DoxloopProject,
  pageExtensions: ReadonlySet<string>,
): Promise<string> {
  if (changeCategory(path, project, pageExtensions) === 'page') {
    try {
      const page = await readPage(sourcePath)
      if (page.title) return page.title
    } catch {
      // Deleted or non-Markdown generator pages use their file name.
    }
  }
  return path.split('/').at(-1) ?? path
}

function sourceSummary(changes: SourceChange[]): string {
  const files = changes.flatMap((change) => [
    ...('changedFiles' in change ? change.changedFiles : []),
    ...('uncommittedFiles' in change ? change.uncommittedFiles : []),
  ])
  return files.length > 0
    ? `${files.length} changed source file${files.length === 1 ? '' : 's'}: ${files.slice(0, 12).join(', ')}${files.length > 12 ? ', …' : ''}`
    : `${changes.length} configured source${changes.length === 1 ? '' : 's'} inspected`
}

function emptyRationale(kind: SyncFileChange['kind'] | undefined): SyncFileChange['rationale'] {
  return {
    reason: kind === 'added' ? 'This file was added by the documentation request.'
      : kind === 'deleted' ? 'This file was removed by the documentation request.'
        : 'This file was changed by the documentation request.',
    evidence: [],
    affectedInterfaces: [],
    claims: { added: [], changed: [], removed: [] },
    validation: { errors: 0, warnings: 0 },
    confidence: 'needs-human',
    assumptions: ['Detailed rationale was not recorded for this legacy proposal.'],
    authorship: 'agent',
  }
}

function changeReason(change: SyncFileChange): string {
  if (change.category === 'evidence') return 'Update the evidence map for the reader-facing claims in this proposal.'
  if (change.category === 'navigation') return 'Keep navigation aligned with the proposed documentation structure.'
  if (change.category === 'configuration') return 'Keep generator configuration aligned with the proposed documentation.'
  if (change.category === 'asset') return 'Add or update a supporting reader-facing asset.'
  if (change.kind === 'added') return `Add “${change.title}” to cover an approved reader outcome.`
  if (change.kind === 'deleted') return `Remove “${change.title}” because it is no longer part of the approved documentation.`
  return `Update “${change.title}” to match the approved request and current evidence.`
}

function matchPlanPage(plan: DocumentationPlan | undefined, path: string): DocumentationPlan['pages'][number] | undefined {
  if (!plan) return undefined
  const portablePath = portable(path).replace(/^\/+/, '')
  return plan.pages.find((page) => {
    const planned = portable(page.path).replace(/^\/+|\/+$/g, '')
    return portablePath === planned || portablePath.startsWith(`${planned}.`) || portablePath.includes(`/${planned}.`)
  })
}

function sourceRevisionMap(changes: SourceChange[]): Record<string, string> {
  return Object.fromEntries(changes.flatMap((change) => {
    if ('head' in change && change.head) return [[change.name, change.head]]
    if ('baseline' in change && change.baseline) return [[change.name, change.baseline]]
    return []
  }))
}

function sourceChangePaths(change: SourceChange): string[] {
  return changedSourcePaths(change)
}

function uniqueRationaleEvidence(items: Array<{ source: string; path?: string; operation?: string; revision?: string; available: boolean }>): SyncFileChange['rationale']['evidence'] {
  const seen = new Set<string>()
  return items.flatMap((item) => {
    const normalized = {
      source: item.source,
      ...(item.path ? { path: item.path } : {}),
      ...(item.operation ? { operation: item.operation } : {}),
      ...(item.revision ? { revision: item.revision } : {}),
      available: item.available,
    }
    const key = JSON.stringify(normalized)
    if (seen.has(key)) return []
    seen.add(key)
    return [normalized]
  })
}

async function proposalSourceSnapshot(root: string, project: DoxloopProject): Promise<string> {
  const fingerprints = await sourceSnapshotFingerprints(root, project.sources)
  return hash(Buffer.from(JSON.stringify({ sources: project.sources, fingerprints })))
}

function retentionDate(createdAt: string): string {
  const date = new Date(createdAt)
  date.setUTCDate(date.getUTCDate() + 30)
  return date.toISOString()
}

async function markSuperseded(root: string, id: string, replacementId: string): Promise<void> {
  const previous = await readSyncRun(root, id)
  if (!['awaiting-review', 'partially-applied', 'conflicted', 'stale'].includes(previous.status)) return
  const next: SyncRun = { ...previous, status: 'superseded', supersededBy: replacementId }
  await writeRun(root, next)
  await recordSyncRun(root, next)
}

function proposalSummary(changes: SyncFileChange[]): string {
  const added = changes.filter((change) => change.kind === 'added').length
  const modified = changes.filter((change) => change.kind === 'modified').length
  const deleted = changes.filter((change) => change.kind === 'deleted').length
  return `${changes.length} proposed file change${changes.length === 1 ? '' : 's'} · ${added} added · ${modified} modified · ${deleted} deleted`
}

function changeCounts(changes: SyncFileChange[]): string {
  const accepted = changes.reduce(
    (count, change) => count + change.hunks.filter((hunk) => hunk.acceptedAt).length,
    0,
  )
  const total = changes.reduce((count, change) => count + change.hunks.length, 0)
  return `${changes.length} files · ${accepted}/${total} changes accepted`
}

function statusMark(status: SyncRun['status']): string {
  if (status === 'applied') return '✓'
  if (status === 'failed' || status === 'conflicted') return '✗'
  if (status === 'rejected') return '–'
  return '●'
}

function portable(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
