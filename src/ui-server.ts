import { documentationCollections, createDocumentationCollection } from './documentation-collections.js'
import { pageComments, savePageComment, searchPageText, auditDocumentation, backfillEvidence, readerVerification, authoringEstimate } from './workspace-tools.js'
import { updateBulkPageMetadata } from './page-metadata.js'
import { batchLimits } from './batch-limits.js'
import { readPageContent, savePageContent, previewPageContent, changePageLifecycle } from './page-operations.js'
import { listDirectEdits, undoDirectEdit } from './direct-edit.js'
import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { AGENT_STOP_GRACE_MS, signalTree } from './agent-process.js'
import { access, appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { createServer as createNetServer } from 'node:net'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AGENT_CATALOG, installAgent, installSkill, parseAgent, skillStatus, detectAgents, agentAuthenticationStatus } from './agents.js'
import { applySyncConfig, computeConfiguredDrift, disableSync, formatSyncStatus, parseSyncMode, parseTriggerList } from './autosync.js'
import { authenticatedRequest, authenticatedRequestOptional, loadUserConfig, logout } from './auth.js'
import { parseClaudeEffort, parseReasoning } from './author.js'
import { historyAvailable } from './db.js'
import {
  approveDocumentationPlan,
  beginDocumentationPlanRevision,
  cancelDocumentationPlan,
  continueDocumentationPlanGeneration,
  createDocumentationPlan,
  documentationPlanClarificationFeedback,
  editDocumentationPlan,
  ignoreDocumentationPlanError,
  latestDocumentationPlan,
  listDocumentationPlanVersions,
  readDocumentationPlan,
  resumeDocumentationPlan,
  retryDocumentationPlan,
} from './documentation-plan.js'
import { DoxloopError } from './errors.js'
import { deployCredentialState, saveDeployCredential } from './deploy-credentials.js'
import { applyWorkflowStageLine, finishWorkflowStages, parseJobOutcome, parseJobOutcomeLine, parseWorkflowStage, type JobOutcome, type WorkflowStage } from './job-events.js'
import { createProposalBranch, publishProposalBranch } from './git-delivery.js'
import { addGenerator } from './generator-manager.js'
import {
  backfillHistory,
  listDeployments,
  listRequests,
  pageHistory,
  requestPages,
} from './history.js'
import { generatorPreflight } from './generator-preflight.js'
import { installedGeneratorEntries, parseGenerator } from './generators.js'
import { runDoctor } from './doctor.js'
import {
  assertNewProjectDirectory,
  completeDocumentationBriefForCreate,
  defaultDocumentationBrief,
  findProjectRoot,
  isSpecUrl,
  loadProject,
  parseDesignReference,
  parseSpec,
  saveProjectSettings,
  scaffoldProject,
  validateProjectSourceBoundaries,
} from './project.js'
import { importExistingDocumentation, inspectExistingDocumentation } from './project-import.js'
import { forgetProject, listRecentProjects, rememberProject } from './project-registry.js'
import { effectiveDeployment } from './settings.js'
import { assertScreenshotPlanningReadiness, checkApplicationReadiness, normalizeScreenshotIntent } from './screenshot-workflow.js'
import { checkScreenCaptureBrowser, startCaptureSignIn, type CaptureSignInSession } from './screen-capture-provider.js'
import {
  captureAuthContext,
  captureAuthStatus,
  removeCaptureCredentials,
  removeCaptureSession,
  saveCaptureCredentials,
  saveCaptureSession,
  type CaptureStorageState,
} from './capture-auth.js'
import { discoverDocumentationSources } from './source-discovery.js'
import { buildSourceIntelligence } from './source-intelligence.js'
import { resolveCoverageItem, type CoverageResolutionAction } from './coverage-actions.js'
import { connectorForSource } from './source-connectors.js'
import { assertInside, ensureGitignoreEntries, pathExists } from './fs.js'
import { loadOpenApiSource, parseOpenApi } from './openapi.js'
import { listPages as listDocumentationPages, resolveEditScope } from './pages.js'
import { readNavigation, writeNavigation } from './navigation.js'
import { readBranding, writeBranding } from './branding.js'
import { ASSET_FILE_EXTENSIONS, ASSET_IMAGE_EXTENSIONS, deleteAsset, readAssetLibrary, replaceRunCapture, updateAssetAlt, uploadAsset } from './assets.js'
import { readPageMetadata, updatePageMetadata } from './page-metadata.js'
import { generateGlossaryPage, readGlossary } from './glossary.js'
import { gitBackedSources, listSourceRefs, type ReleaseTemplateInput } from './release-notes.js'
import { testRemoteSource } from './remote-monitor.js'
import {
  listRemoteBranches,
  listRemoteDirectories,
  materializeRemoteSource,
  parseGitRepository,
  portableSourcePath,
  rememberRemoteCredential,
  remoteCredentialEnvironment,
  remoteHead,
} from './remote-source.js'
import {
  acceptSyncChanges,
  archiveSyncRun,
  createRunId,
  editSyncRunChange,
  listSyncRuns,
  pruneSyncRuns,
  readSyncRun,
  recoverSyncRun,
  runWorkspace,
  readSyncRunChangeContent,
  rejectSyncRun,
  rejectSyncChanges,
  undoSyncRun,
} from './sync-runs.js'
import {
  requireSyncReviewChange,
  syncReviewComparisonDocument,
  syncReviewAcceptOptions,
  syncReviewSelectionsFromBody,
  syncReviewSourceDiff,
} from './sync-review.js'
import type {
  AgentName,
  ApplicationConfig,
  DeploymentConfig,
  DocumentationBrief,
  DoxloopProject,
  GeneratorName,
  RemoteSource,
  SourceBinding,
  SyncConfig,
  SyncRun,
} from './types.js'
import { validateProject } from './validation.js'

export interface UiServerOptions {
  cwd: string
  host?: string
  port?: number
  open?: boolean
  page?: string
  /** Open this project instead of the one found from `cwd`. */
  project?: string
}

interface UiJob {
  id: string
  type: string
  agent?: AgentName
  status: 'running' | 'succeeded' | 'failed' | 'cancelled'
  startedAt: string
  lastOutputAt?: string
  finishedAt?: string
  exitCode?: number
  lines: string[]
  stages: WorkflowStage[]
  planId?: string
  child?: ChildProcess | undefined
  retry?: { args: string[]; cwd: string; agent?: AgentName; planId?: string }
  recovered?: boolean
  /** What the job concluded, once its CLI reported it. */
  outcome?: JobOutcome
}

interface UiRuntime {
  controlCenterUrl?: string
  cwd: string
  root?: string | undefined
  jobs: Map<string, UiJob>
  previewJobId?: string | undefined
  previewUrl?: string | undefined
  proposalPreviewJobId?: string | undefined
  proposalPreviewRunId?: string | undefined
  proposalPreviewUrl?: string | undefined
  jobSubscribers: Set<ServerResponse>
  jobBroadcastTimer?: ReturnType<typeof setTimeout> | undefined
  jobPersistTimer?: ReturnType<typeof setTimeout> | undefined
  jobPersistQueue: Promise<void>
  jobLogQueues: Map<string, Promise<void>>
  /** The visible Chrome window a person is signing in to for screenshot capture. */
  captureSignIn?: { session: CaptureSignInSession; scope: 'project' | 'setup'; origin: string } | undefined
  /** A session recorded during setup, persisted once the project exists. */
  pendingCaptureSession?: { origin: string; savedAt: string; state: CaptureStorageState } | undefined
}

const UI_ROOT = resolve(fileURLToPath(new URL('./ui', import.meta.url)))
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url))
const DOXBRIX_CSS = resolve(PACKAGE_ROOT, 'assets', 'doxbrix-preview.css')
const MAX_BODY_BYTES = 1_000_000
/** Base64 image uploads: a 10 MB asset plus JSON framing. */
const MAX_ASSET_BODY_BYTES = 15_000_000
const MAX_PERSISTED_JOBS = 50
// Agents stream one JSON line per token delta, so a single planning run leaves
// megabytes of output behind. The full log stays on disk under
// UI_JOB_LOG_DIRECTORY and is served by /api/jobs/:id/log; the in-memory copy
// that every state snapshot, job-stream event, and ui-jobs.json write carries
// keeps only a recent tail. Without this cap a finished 2 MB job was
// re-serialized on every output chunk of the next run, which pinned the server
// and left the control center unresponsive.
const MAX_JOB_LINES = 400
const MAX_JOB_LINE_LENGTH = 4_000
const JOB_BROADCAST_INTERVAL_MS = 150
const UI_JOBS_FILE = join('.doxloop', 'ui-jobs.json')
const UI_JOB_LOG_DIRECTORY = join('.doxloop', 'ui-job-logs')
// The CLI gets the agent's own grace period plus a margin to write its exit.
const JOB_STOP_GRACE_MS = AGENT_STOP_GRACE_MS + 5_000

export async function startUiServer(options: UiServerOptions): Promise<void> {
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new DoxloopError('The Doxloop UI is local-only and must bind to 127.0.0.1.')
  }
  const port = options.port ?? 4317
  const page = normalizeInitialPage(options.page)
  const root = options.project
    ? await findProjectRoot(resolve(options.cwd, options.project))
    : await optionalProjectRoot(options.cwd)
  const { jobs, recovered: recoveredJobs } = root ? await loadRuntimeJobs(root) : { jobs: new Map<string, UiJob>(), recovered: false }
  const runtime: UiRuntime = {
    controlCenterUrl: `http://127.0.0.1:${port}`,
    cwd: resolve(options.cwd),
    root,
    jobs,
    jobSubscribers: new Set(),
    jobPersistQueue: Promise.resolve(),
    jobLogQueues: new Map(),
  }
  if (recoveredJobs) await persistUiJobs(runtime)
  if (root) await rememberOpenProject(root)
  const session = randomBytes(32).toString('hex')
  const server = createServer((request, response) => {
    void handleUiRequest(request, response, runtime, session, port)
  })

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen)
    server.listen(port, host, resolveListen)
  })
  const url = `http://${host}:${port}/${page}`
  process.stdout.write(
    `Doxloop UI: ${url}\nLocal project data stays on this computer.\nPress Ctrl+C to stop.\n`,
  )
  if (options.open !== false) openBrowser(url)

  let stopping = false
  const stop = async (): Promise<void> => {
    if (stopping) return
    stopping = true
    for (const job of runtime.jobs.values()) {
      if (job.status !== 'running') continue
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      job.lines.push('The Doxloop UI server stopped and cancelled this run.')
      queueUiJobLog(runtime, job.id, '\nThe Doxloop UI server stopped and cancelled this run.\n')
      stopJobChild(job.child)
      if (runtime.root && job.planId) await cancelDocumentationPlan(runtime.root, job.planId).catch(() => undefined)
    }
    broadcastJobs(runtime)
    await flushUiJobLogs(runtime)
    await flushUiJobs(runtime)
    for (const response of runtime.jobSubscribers) response.end()
    runtime.jobSubscribers.clear()
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()))
  }
  process.once('SIGINT', () => void stop())
  process.once('SIGTERM', () => void stop())
}

async function handleUiRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: UiRuntime,
  session: string,
  port: number,
): Promise<void> {
  try {
    requireLocalHost(request, port)
    const url = new URL(request.url ?? '/', `http://127.0.0.1:${port}`)
    if (url.pathname.startsWith('/api/')) {
      requireSession(request, session, port)
      if (request.method !== 'GET') requireSameOrigin(request, port)
      await handleApi(request, response, url, runtime)
      return
    }
    if (url.pathname.startsWith('/review-preview/')) {
      requireSession(request, session, port)
      await handleProposalPreview(response, url, runtime)
      return
    }
    if (url.pathname.startsWith('/assets/')) {
      await serveStatic(response, UI_ROOT, url.pathname.slice(1), false)
      return
    }
    if (url.pathname === '/reader.css') {
      await serveFile(response, DOXBRIX_CSS, false)
      return
    }
    if (url.pathname === '/brand/favicon.png') {
      await serveFile(response, join(PACKAGE_ROOT, 'assets', 'brand', 'doxloop-favicon.png'), false)
      return
    }
    response.setHeader('Set-Cookie', `${uiSessionCookieName(port)}=${session}; HttpOnly; SameSite=Strict; Path=/`)
    await serveFile(response, join(UI_ROOT, 'index.html'), true)
  } catch (error) {
    const status = uiErrorStatus(error)
    sendJson(response, status, { error: error instanceof Error ? error.message : String(error) })
  }
}

async function handleApi(
  request: IncomingMessage,
  response: ServerResponse,
  url: URL,
  runtime: UiRuntime,
): Promise<void> {
  if (request.method === 'GET' && url.pathname === '/api/state') {
    sendJson(response, 200, await buildUiState(runtime))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/setup/browse-directory') {
    sendJson(response, 200, { path: await chooseLocalDirectory('Choose product source directory') ?? null })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/projects') {
    sendJson(response, 200, {
      current: runtime.root ?? null,
      recent: await listRecentProjects(),
      // The full catalog, not the open project's generator, so the import dialog can correct a wrong guess.
      generators: await installedGeneratorEntries(runtime.cwd),
    })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/projects/browse') {
    sendJson(response, 200, { path: await chooseLocalDirectory('Choose a documentation folder') ?? null })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/projects/open') {
    const body = recordBody(await readJsonBody(request))
    await switchProject(runtime, await resolveProjectToOpen(runtime, stringValue(body.path)))
    sendJson(response, 200, await buildUiState(runtime))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/projects/forget') {
    const body = recordBody(await readJsonBody(request))
    sendJson(response, 200, { recent: await forgetProject(resolve(runtime.cwd, stringValue(body.path))) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/projects/inspect') {
    const body = recordBody(await readJsonBody(request))
    sendJson(response, 200, await inspectExistingDocumentation(resolve(runtime.cwd, stringValue(body.path)), importOverrides(body)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/projects/import') {
    const body = recordBody(await readJsonBody(request))
    assertProjectSwitchAllowed(runtime.jobs.values())
    const directory = resolve(runtime.cwd, stringValue(body.path))
    const overrides = importOverrides(body)
    if (body.installGenerator === true) {
      const inspection = await inspectExistingDocumentation(directory, overrides)
      if (inspection.generator && !inspection.generatorInstalled) await addGenerator(directory, inspection.generator)
    }
    const agent = parseAgent(optionalString(body.agent))
    const imported = await importExistingDocumentation({
      directory,
      ...overrides,
      ...(optionalString(body.title) ? { title: optionalString(body.title)! } : {}),
      ...(agent ? { agent } : {}),
    })
    if (agent) await saveProjectSettings(imported.root, { defaultAgent: agent })
    await switchProject(runtime, imported.root)
    sendJson(response, 201, { ...(await buildUiState(runtime)), imported })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/setup/validate') {
    sendJson(response, 200, await validateSetupPaths(runtime, await readJsonBody(request)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/setup/git/test') {
    const body = recordBody(await readJsonBody(request))
    const repository = parseGitRepository(stringValue(body.repository))
    configureGitAccess(body, repository)
    const seed = {
      provider: 'git' as const,
      repository,
      branch: optionalString(body.branch) ?? 'main',
    }
    const branches = await listRemoteBranches(seed)
    if (branches.length === 0) throw new DoxloopError('The repository has no readable branches.')
    const requested = optionalString(body.branch)
    const selected = branches.find((branch) => branch.name === requested)
      ?? branches[0]!
    sendJson(response, 200, { repository, branch: selected.name, head: selected.head, branches: branches.map((branch) => branch.name) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/setup/git/folders') {
    const body = recordBody(await readJsonBody(request))
    const remote = remoteSourceFromSetupBody(body)
    sendJson(response, 200, { directories: await listRemoteDirectories(remote) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/jobs') {
    sendJson(response, 200, [...runtime.jobs.values()].map(publicJob).reverse())
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/jobs/stream') {
    streamJobs(request, response, runtime)
    return
  }
  const jobLog = /^\/api\/jobs\/([a-f0-9]+)\/log$/.exec(url.pathname)
  if (request.method === 'GET' && jobLog) {
    const job = runtime.jobs.get(jobLog[1]!)
    if (!job) throw new DoxloopError('The requested job does not exist.')
    let log: string
    try {
      log = await readFile(join(requireProject(runtime), UI_JOB_LOG_DIRECTORY, `${job.id}.log`), 'utf8')
    } catch {
      log = job.lines.join('\n')
    }
    send(response, 200, 'text/plain; charset=utf-8', log, baseHeaders())
    return
  }
  const jobAction = /^\/api\/jobs\/([a-f0-9]+)\/(cancel|retry)$/.exec(url.pathname)
  if (request.method === 'POST' && jobAction) {
    const job = runtime.jobs.get(jobAction[1]!)
    if (!job) throw new DoxloopError('The requested job does not exist.')
    if (jobAction[2] === 'retry') {
      if (job.status === 'running' || !job.retry) throw new DoxloopError('This job does not have a safe retry checkpoint.')
      assertNoActiveDocumentationJob(runtime)
      // A continuation resumes from the plan's own failure record, so it needs
      // no stage reset; the other plan stages restore their durable state first.
      if (job.planId && runtime.root && job.type.startsWith('plan:') && job.type !== 'plan:continue') {
        const stage = job.type === 'plan:generate' ? 'generate' : job.type === 'plan:revise' ? 'revise' : 'propose'
        await retryDocumentationPlan(runtime.root, job.planId, stage)
      }
      const retry = job.retry
      const next = startCliJob(runtime, job.type, retry.args, retry.cwd, retry.agent, retry.planId)
      next.lines.push(`Retrying interrupted run ${job.id} from its last durable stage.`)
      sendJson(response, 202, publicJob(next))
      return
    }
    if (job.status === 'running') {
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      job.lines.push('The run was cancelled from the Doxloop UI.')
      queueUiJobLog(runtime, job.id, '\nThe run was cancelled from the Doxloop UI.\n')
      stopJobChild(job.child)
      if (runtime.root && job.planId) await cancelDocumentationPlan(runtime.root, job.planId)
      delete job.child
      publishJobs(runtime)
    }
    sendJson(response, 200, publicJob(job))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/project') {
    await createProjectFromUi(runtime, await readJsonBody(request))
    sendJson(response, 201, await buildUiState(runtime))
    return
  }
  if (request.method === 'PATCH' && url.pathname === '/api/project') {
    const root = requireProject(runtime)
    await updateProjectFromUi(root, await readJsonBody(request))
    sendJson(response, 200, await buildUiState(runtime))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/sources') {
    const root = requireProject(runtime)
    await addSourceFromUi(root, await readJsonBody(request))
    sendJson(response, 201, await loadProject(root))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/source-intelligence') {
    sendJson(response, 200, await buildSourceIntelligence(requireProject(runtime)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/coverage/resolve') {
    const body = recordBody(await readJsonBody(request))
    const action = optionalString(body.action)
    if (!action || !['link', 'exclude', 'needs-human', 'remove-priority', 'reset'].includes(action)) throw new DoxloopError('Choose a valid coverage resolution action.')
    await resolveCoverageItem(requireProject(runtime), {
      id: stringValue(body.id),
      action: action as CoverageResolutionAction,
      ...(optionalString(body.page) ? { page: optionalString(body.page)! } : {}),
      ...(optionalString(body.reason) ? { reason: optionalString(body.reason)! } : {}),
    })
    sendJson(response, 200, await buildSourceIntelligence(requireProject(runtime)))
    return
  }
  const sourceAction = /^\/api\/sources\/([^/]+)$/.exec(url.pathname)
  if (sourceAction && request.method === 'PATCH') {
    const root = requireProject(runtime)
    await updateSourceFromUi(root, decodeURIComponent(sourceAction[1]!), await readJsonBody(request))
    sendJson(response, 200, await loadProject(root))
    return
  }
  if (sourceAction && request.method === 'DELETE') {
    const root = requireProject(runtime)
    await removeSourceFromUi(root, decodeURIComponent(sourceAction[1]!))
    sendJson(response, 200, await loadProject(root))
    return
  }
  const sourceTest = /^\/api\/sources\/([^/]+)\/test$/.exec(url.pathname)
  if (sourceTest && request.method === 'POST') {
    const root = requireProject(runtime)
    const project = await loadProject(root)
    const source = project.sources.find((item) => item.name === decodeURIComponent(sourceTest[1]!))
    if (!source) throw new DoxloopError('The requested source does not exist.')
    const remote = source.remote ? await testRemoteSource(source.remote) : undefined
    sendJson(response, 200, { health: await connectorForSource(source).health(root, source), ...(remote ? { remote } : {}) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/sync/configure') {
    const root = requireProject(runtime)
    const project = await loadProject(root)
    const sync = syncConfigFromBody(await readJsonBody(request), project.sync)
    sendJson(response, 200, { messages: await applySyncConfig(root, project, sync), sync })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/sync/off') {
    const root = requireProject(runtime)
    sendJson(response, 200, { messages: await disableSync(root, await loadProject(root)) })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/sync/now') {
    const root = requireProject(runtime)
    sendJson(response, 202, publicJob(startCliJob(runtime, 'sync', ['sync', 'now', '--trigger', 'manual', '--cwd', root], root)))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/collections') { const root = requireProject(runtime); sendJson(response, 200, await documentationCollections(root, await loadProject(root))); return }
  if (request.method === 'POST' && url.pathname === '/api/collections') {
    const body = recordBody(await readJsonBody(request))
    sendJson(response, 200, await createDocumentationCollection(requireProject(runtime), { sourceDirectory: rawText(body.sourceDirectory), version: stringValue(body.version), locale: stringValue(body.locale) })); return
  }
  if (request.method === 'GET' && url.pathname === '/api/pages/search') {
    sendJson(response, 200, await searchPageText(requireProject(runtime), url.searchParams.get('q') ?? '')); return
  }
  if (request.method === 'GET' && url.pathname === '/api/comments') {
    sendJson(response, 200, await pageComments(requireProject(runtime))); return
  }
  if (request.method === 'POST' && url.pathname === '/api/comments') {
    const body = recordBody(await readJsonBody(request))
    sendJson(response, 200, await savePageComment(requireProject(runtime), { path: typeof body.resolveId === 'string' ? '' : stringValue(body.path), text: typeof body.resolveId === 'string' ? '' : stringValue(body.text), ...(typeof body.proposalId === 'string' ? { proposalId: body.proposalId } : {}), ...(typeof body.changeId === 'string' ? { changeId: body.changeId } : {}), ...(typeof body.hunkId === 'string' ? { hunkId: body.hunkId } : {}), ...(typeof body.resolveId === 'string' ? { resolveId: body.resolveId } : {}) })); return
  }
  if (request.method === 'PUT' && url.pathname === '/api/pages/bulk-metadata') {
    const body = recordBody(await readJsonBody(request))
    if (!Array.isArray(body.writes)) throw new DoxloopError('Supply metadata writes for the selected pages.')
    sendJson(response, 200, await updateBulkPageMetadata(requireProject(runtime), body.writes)); return
  }
  if (request.method === 'GET' && url.pathname === '/api/audit') { sendJson(response, 200, await auditDocumentation(requireProject(runtime))); return }
  if (request.method === 'POST' && url.pathname === '/api/audit/backfill') { sendJson(response, 200, await backfillEvidence(requireProject(runtime))); return }
  if (url.pathname === '/api/reader-verification' && (request.method === 'GET' || request.method === 'PUT')) {
    const body = request.method === 'PUT' ? recordBody(await readJsonBody(request)) : undefined
    if (body && typeof body.enabled !== 'boolean') throw new DoxloopError('Choose whether to show reader verification.')
    sendJson(response, 200, await readerVerification(requireProject(runtime), body?.enabled as boolean | undefined)); return
  }
  if (request.method === 'GET' && url.pathname === '/api/authoring-estimate') {
    sendJson(response, 200, await authoringEstimate(requireProject(runtime), Math.max(1, Math.min(500, Number(url.searchParams.get('pages')) || 1)), url.searchParams.get('agent') ?? undefined, url.searchParams.get('model') ?? undefined)); return
  }
  if (request.method === 'GET' && url.pathname === '/api/pages') {
    sendJson(response, 200, await listDocumentationPages(requireProject(runtime)))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/pages/content') {
    const root = requireProject(runtime)
    const path = url.searchParams.get('path')?.trim()
    if (!path) throw new DoxloopError('A page content request needs a path.', 2)
    sendJson(response, 200, await readPageContent(root, path))
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/pages/content') {
    const body = recordBody(await readJsonBody(request))
    sendJson(response, 200, await savePageContent(requireProject(runtime), { path: stringValue(body.path), content: rawText(body.content), fingerprint: stringValue(body.fingerprint), evidenceDisposition: body.evidenceDisposition === 'preserved' ? 'preserved' : 'needs-review' }))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/pages/preview') {
    sendJson(response, 200, previewPageContent(rawText(recordBody(await readJsonBody(request)).content)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/pages/lifecycle') {
    const body = recordBody(await readJsonBody(request))
    if (!['create', 'rename', 'delete'].includes(String(body.action))) throw new DoxloopError('Choose create, rename, or delete.')
    sendJson(response, 200, await changePageLifecycle(requireProject(runtime), {
      action: body.action as 'create' | 'rename' | 'delete', path: stringValue(body.path),
      ...(typeof body.fingerprint === 'string' ? { fingerprint: body.fingerprint } : {}),
      ...(typeof body.to === 'string' ? { to: body.to } : {}),
      ...(typeof body.title === 'string' ? { title: body.title } : {}),
      ...(typeof body.content === 'string' ? { content: body.content } : {}),
      ...(typeof body.replacement === 'string' && body.replacement ? { replacement: body.replacement } : {}),
    }))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/direct-edits') {
    sendJson(response, 200, await listDirectEdits(requireProject(runtime)))
    return
  }
  const directUndo = /^\/api\/direct-edits\/([a-f0-9-]{36})\/undo$/.exec(url.pathname)
  if (request.method === 'POST' && directUndo) {
    sendJson(response, 200, await undoDirectEdit(requireProject(runtime), directUndo[1]!))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/pages/edit') {
    assertNoActiveDocumentationJob(runtime)
    const root = requireProject(runtime)
    const project = await loadProject(root)
    const runId = createRunId()
    const spec = pageEditJobSpec(root, project, runId, await readJsonBody(request))
    await resolveEditScope(root, project, spec.paths, spec.allowRelated)
    const job = startCliJob(runtime, spec.type, spec.args, root, spec.agent)
    sendJson(response, 202, { job: publicJob(job) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/pages/metadata') {
    sendJson(response, 200, await readPageMetadata(requireProject(runtime), url.searchParams.get('path')))
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/pages/metadata') {
    assertNoActiveDocumentationJob(runtime)
    sendJson(response, 200, await updatePageMetadata(requireProject(runtime), await readJsonBody(request)))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/navigation') {
    sendJson(response, 200, await readNavigation(requireProject(runtime)))
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/navigation') {
    assertNoActiveDocumentationJob(runtime)
    sendJson(response, 200, await writeNavigation(requireProject(runtime), await readJsonBody(request)))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/branding') {
    sendJson(response, 200, await readBranding(requireProject(runtime)))
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/branding') {
    assertNoActiveDocumentationJob(runtime)
    sendJson(response, 200, await writeBranding(requireProject(runtime), await readJsonBody(request)))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/assets') {
    sendJson(response, 200, await readAssetLibrary(requireProject(runtime)))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/assets/file') {
    const root = requireProject(runtime)
    const path = url.searchParams.get('path') ?? ''
    const file = assertInside(root, resolve(root, path))
    const extension = extname(file).toLowerCase()
    if (!path || path.split('/').some((part) => part === '..' || part === '.doxloop' || part === 'node_modules') || (!ASSET_IMAGE_EXTENSIONS.has(extension) && !ASSET_FILE_EXTENSIONS.has(extension)) || !(await pathExists(file))) {
      sendJson(response, 404, { error: 'That asset does not exist.' })
      return
    }
    send(response, 200, mimeType(file), await readFile(file), { ...baseHeaders(), 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'" })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/assets') {
    assertNoActiveDocumentationJob(runtime)
    sendJson(response, 201, await uploadAsset(requireProject(runtime), await readJsonBody(request, MAX_ASSET_BODY_BYTES)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/assets/delete') {
    assertNoActiveDocumentationJob(runtime)
    sendJson(response, 200, await deleteAsset(requireProject(runtime), await readJsonBody(request)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/assets/alt') {
    assertNoActiveDocumentationJob(runtime)
    sendJson(response, 200, await updateAssetAlt(requireProject(runtime), await readJsonBody(request)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/captures/replace') {
    sendJson(response, 200, await replaceRunCapture(requireProject(runtime), await readJsonBody(request, MAX_ASSET_BODY_BYTES)))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/glossary') {
    sendJson(response, 200, await readGlossary(requireProject(runtime)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/glossary/generate') {
    assertNoActiveDocumentationJob(runtime)
    sendJson(response, 200, await generateGlossaryPage(requireProject(runtime), await readJsonBody(request)))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/sources/git') {
    const root = requireProject(runtime)
    sendJson(response, 200, { sources: (await gitBackedSources(root, await loadProject(root))).map((source) => source.name) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/sources/refs') {
    sendJson(response, 200, await listSourceRefs(requireProject(runtime), url.searchParams.get('source') ?? ''))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/history') {
    const root = requireProject(runtime)
    await backfillHistory(root)
    const path = url.searchParams.get('page')
    const limit = historyLimit(url.searchParams.get('limit'))
    const available = await historyAvailable()
    if (path) {
      sendJson(response, 200, { available, entries: await pageHistory(root, path, limit) })
      return
    }
    const requests = await listRequests(root, limit)
    const pages = await requestPages(root, requests.map((entry) => entry.id))
    sendJson(response, 200, {
      available,
      requests: requests.map((entry) => ({ ...entry, pages: pages[entry.id] ?? [] })),
    })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/history/deployments') {
    const root = requireProject(runtime)
    await backfillHistory(root)
    sendJson(response, 200, {
      available: await historyAvailable(),
      deployments: await listDeployments(root, historyLimit(url.searchParams.get('limit'))),
    })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/deployment/site') {
    sendJson(response, 200, { url: await deployedSiteUrl(requireProject(runtime)) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/deployment/credentials') {
    sendJson(response, 200, await deployCredentialState())
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/deployment/credentials') {
    const body = recordBody(await readJsonBody(request))
    const target = stringValue(body.target)
    if (target !== 'netlify' && target !== 'vercel') throw new DoxloopError('Credentials can be saved for Netlify or Vercel.')
    await saveDeployCredential(target, stringValue(body.token))
    sendJson(response, 200, { saved: true, target })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/proposals') {
    sendJson(response, 200, await listSyncRuns(requireProject(runtime)))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/plans/discovery') {
    const discovery = await discoverDocumentationSources(requireProject(runtime))
    sendJson(response, 200, {
      suggestedPages: discovery.inventory.suggestedPages,
      publicSignals: discovery.inventory.totals.publicSignals,
      generatedAt: discovery.inventory.generatedAt,
      cacheHit: discovery.cacheHit,
    })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/application/readiness') {
    const root = requireProject(runtime)
    const project = await loadProject(root)
    sendJson(response, 200, await checkApplicationReadiness(project.application, await captureAuthContext(root)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/application/readiness') {
    const root = requireProject(runtime)
    const project = await loadProject(root)
    const application = applicationFromBody(await readJsonBody(request), project)
    sendJson(response, 200, await checkApplicationReadiness(application, await captureAuthContext(root)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/setup/application/readiness') {
    const body = recordBody(await readJsonBody(request))
    const application = applicationFromBody(body)
    // Setup has no project yet: the session recorded in this wizard and the
    // credentials typed into it stand in for the stored ones.
    sendJson(response, 200, await checkApplicationReadiness(application, {
      ...(runtime.pendingCaptureSession ? { session: runtime.pendingCaptureSession.state } : {}),
      credentials: body.hasCredentials === true,
    }))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/application/auth') {
    sendJson(response, 200, await captureAuthState(runtime, requireProject(runtime)))
    return
  }
  if (request.method === 'PUT' && url.pathname === '/api/application/credentials') {
    const root = requireProject(runtime)
    const body = recordBody(await readJsonBody(request))
    await saveCaptureCredentials(root, { username: stringValue(body.username), password: typeof body.password === 'string' ? body.password : '' })
    sendJson(response, 200, await captureAuthState(runtime, root))
    return
  }
  if (request.method === 'DELETE' && url.pathname === '/api/application/credentials') {
    const root = requireProject(runtime)
    await removeCaptureCredentials(root)
    sendJson(response, 200, await captureAuthState(runtime, root))
    return
  }
  if (request.method === 'DELETE' && url.pathname === '/api/application/session') {
    const root = requireProject(runtime)
    await removeCaptureSession(root)
    sendJson(response, 200, await captureAuthState(runtime, root))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/application/sign-in') {
    const root = requireProject(runtime)
    const project = await loadProject(root)
    const body = await readJsonBody(request)
    // The form may hold an unsaved URL; signing in against it is still useful.
    const application = body && typeof body === 'object' && 'baseUrl' in (body as Record<string, unknown>)
      ? applicationFromBody(body, project)
      : project.application
    if (!application) throw new DoxloopError('Configure the application base URL before signing in.')
    await beginCaptureSignIn(runtime, application, 'project')
    sendJson(response, 200, await captureAuthState(runtime, root))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/application/sign-in/finish') {
    const root = requireProject(runtime)
    const active = runtime.captureSignIn
    if (!active || active.scope !== 'project') throw new DoxloopError('No browser sign-in is in progress. Choose "Sign in with browser" first.')
    const state = await active.session.finish()
    runtime.captureSignIn = undefined
    await saveCaptureSession(root, active.origin, state)
    sendJson(response, 200, await captureAuthState(runtime, root))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/application/sign-in/cancel') {
    const root = requireProject(runtime)
    await cancelCaptureSignIn(runtime)
    sendJson(response, 200, await captureAuthState(runtime, root))
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/setup/application/auth') {
    sendJson(response, 200, setupCaptureAuthState(runtime))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/setup/application/sign-in') {
    const application = applicationFromBody(await readJsonBody(request))
    await beginCaptureSignIn(runtime, application, 'setup')
    sendJson(response, 200, setupCaptureAuthState(runtime))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/setup/application/sign-in/finish') {
    const active = runtime.captureSignIn
    if (!active || active.scope !== 'setup') throw new DoxloopError('No browser sign-in is in progress. Choose "Sign in with browser" first.')
    const state = await active.session.finish()
    runtime.captureSignIn = undefined
    if (state.cookies.length === 0 && state.origins.every((item) => item.localStorage.length === 0)) {
      throw new DoxloopError('The browser session holds no cookies or local storage yet. Complete the sign-in in the Chrome window before saving.')
    }
    runtime.pendingCaptureSession = { origin: active.origin, savedAt: new Date().toISOString(), state }
    sendJson(response, 200, setupCaptureAuthState(runtime))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/setup/application/sign-in/cancel') {
    await cancelCaptureSignIn(runtime)
    sendJson(response, 200, setupCaptureAuthState(runtime))
    return
  }
  if (request.method === 'DELETE' && url.pathname === '/api/setup/application/session') {
    runtime.pendingCaptureSession = undefined
    sendJson(response, 200, setupCaptureAuthState(runtime))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/setup/generator/preflight') {
    const body = recordBody(await readJsonBody(request))
    const generator = parseGenerator(optionalString(body.generator)) ?? 'doxbrix'
    sendJson(response, 200, await generatorPreflight(generator))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/plans') {
    assertNoActiveDocumentationJob(runtime)
    const root = requireProject(runtime)
    const body = recordBody(await readJsonBody(request))
    const mode = optionalString(body.mode)
    if (mode !== 'create' && mode !== 'update') throw new DoxloopError('Plan mode must be create or update.')
    const scope = optionalString(body.scope) ?? 'standard'
    if (!['starter', 'standard', 'comprehensive', 'custom'].includes(scope)) {
      throw new DoxloopError('Plan scope must be starter, standard, comprehensive, or custom.')
    }
    const project = await loadProject(root)
    const template = releaseTemplateFromBody(body.template)
    const requestedAgent = parseAgent(optionalString(body.agent))
    const clarificationMode = optionalString(body.clarificationMode) ?? 'review'
    if (!['review', 'defaults', 'stop'].includes(clarificationMode)) throw new DoxloopError('Clarification mode must be review, defaults, or stop.')
    const screenshotIntent = normalizeScreenshotIntent(body.screenshots)
    await assertScreenshotPlanningReadiness(project.application, screenshotIntent, await captureAuthContext(root))
    if (screenshotIntent === 'enabled') {
      const browserReadiness = await checkScreenCaptureBrowser()
      if (!browserReadiness.available) throw new DoxloopError(`Screenshots are selected, but the capture browser cannot start. ${browserReadiness.message}`)
    }
    const targetPages = body.targetPages === undefined || body.targetPages === null || body.targetPages === '' ? undefined : Number(body.targetPages)
    if (targetPages !== undefined && (!Number.isInteger(targetPages) || targetPages < 1 || targetPages > 500)) {
      throw new DoxloopError('Target page count must be a whole number between 1 and 500.')
    }
    const plan = await createDocumentationPlan(root, {
      mode,
      scope: scope as 'starter' | 'standard' | 'comprehensive' | 'custom',
      ...(targetPages !== undefined ? { targetPages } : {}),
      ...(template ? { template } : {}),
      ...(optionalString(body.request) ? { request: optionalString(body.request)! } : {}),
      clarificationMode: clarificationMode as 'review' | 'defaults' | 'stop',
      execution: {
        ...(requestedAgent ?? project.defaultAgent ? { agent: (requestedAgent ?? project.defaultAgent)! } : {}),
        ...(optionalString(body.model) ? { model: optionalString(body.model)! } : {}),
        ...(optionalString(body.reasoning) ? { reasoning: parseReasoning(optionalString(body.reasoning))! } : {}),
        ...(optionalString(body.effort) ? { effort: parseClaudeEffort(optionalString(body.effort))! } : {}),
        screenshots: screenshotIntent,
        limits: batchLimits(body.limits, { maxPages: 5, maxScreenshots: screenshotIntent === 'disabled' ? 0 : 8, maxMinutes: 15 }),
      },
    })
    const job = startCliJob(runtime, 'plan:propose', ['plan', 'propose', '--id', plan.id, '--cwd', root], root, requestedAgent ?? project.defaultAgent, plan.id)
    sendJson(response, 202, { plan, job: publicJob(job) })
    return
  }
  const planRoute = /^\/api\/plans\/(plan-[a-z0-9-]+)$/.exec(url.pathname)
  if (request.method === 'GET' && planRoute) {
    sendJson(response, 200, await readDocumentationPlan(requireProject(runtime), planRoute[1]!))
    return
  }
  if (request.method === 'PATCH' && planRoute) {
    sendJson(response, 200, await editDocumentationPlan(requireProject(runtime), planRoute[1]!, await readJsonBody(request)))
    return
  }
  const planVersionsRoute = /^\/api\/plans\/(plan-[a-z0-9-]+)\/versions$/.exec(url.pathname)
  if (request.method === 'GET' && planVersionsRoute) {
    sendJson(response, 200, await listDocumentationPlanVersions(requireProject(runtime), planVersionsRoute[1]!))
    return
  }
  const planAction = /^\/api\/plans\/(plan-[a-z0-9-]+)\/(revise|clarify|approve|generate|resume|continue)$/.exec(url.pathname)
  if (request.method === 'POST' && planAction) {
    const root = requireProject(runtime)
    const id = planAction[1]!
    const action = planAction[2]!
    if (action === 'approve') {
      sendJson(response, 200, await approveDocumentationPlan(root, id))
      return
    }
    if (action === 'resume') {
      sendJson(response, 200, await resumeDocumentationPlan(root, id))
      return
    }
    const plan = await readDocumentationPlan(root, id)
    if (action === 'continue') {
      // Pick up a failed run where it stopped instead of starting over: a
      // planning failure keeps the plan the agent proposed; a generation
      // failure keeps the pages and screenshots already in the workspace.
      const strategy = optionalString(recordBody(await readJsonBody(request)).strategy) ?? 'resume'
      if (strategy !== 'resume' && strategy !== 'ignore-errors') throw new DoxloopError('Continuation strategy must be resume or ignore-errors.')
      // The job may complete after the browser rendered failed-plan actions.
      // Return the completed plan instead of turning that stale click into an
      // error; the normal action reload will then replace the stale screen.
      if (plan.status === 'generated') {
        sendJson(response, 200, { plan })
        return
      }
      assertNoActiveDocumentationJob(runtime)
      if (plan.failure?.stage !== 'generate') {
        if (strategy !== 'ignore-errors') throw new DoxloopError('A planning run cannot be resumed. Retry planning, or continue with the plan it left behind.')
        sendJson(response, 200, { plan: await ignoreDocumentationPlanError(root, id) })
        return
      }
      const job = startCliJob(runtime, 'plan:continue', ['plan', 'continue', '--id', id, '--strategy', strategy, '--cwd', root], root, plan.execution.agent, id)
      sendJson(response, 202, { job: publicJob(job) })
      return
    }
    assertNoActiveDocumentationJob(runtime)
    if (action === 'clarify') {
      const body = recordBody(await readJsonBody(request))
      const answers = stringRecord(body.answers)
      const useRecommendations = body.useRecommendations === true
      const feedback = documentationPlanClarificationFeedback(plan, answers, useRecommendations)
      const effectiveAnswers = Object.fromEntries(plan.questions.map((question) => [question.id, answers[question.id] ?? question.recommendation ?? '']))
      await beginDocumentationPlanRevision(root, id, effectiveAnswers)
      const job = startCliJob(runtime, 'plan:revise', ['plan', 'revise', '--id', id, '--feedback', feedback, '--cwd', root], root, plan.execution.agent, id)
      sendJson(response, 202, publicJob(job))
      return
    }
    if (action === 'revise') {
      const feedback = optionalString(recordBody(await readJsonBody(request)).feedback)
      if (!feedback) throw new DoxloopError('Describe how the documentation plan should change.')
      await beginDocumentationPlanRevision(root, id)
      const job = startCliJob(runtime, 'plan:revise', ['plan', 'revise', '--id', id, '--feedback', feedback, '--cwd', root], root, plan.execution.agent, id)
      sendJson(response, 202, publicJob(job))
      return
    }
    const job = startCliJob(runtime, 'plan:generate', ['plan', 'generate', '--id', id, '--cwd', root], root, plan.execution.agent, id)
    sendJson(response, 202, publicJob(job))
    return
  }
  const proposal = /^\/api\/proposals\/([a-z0-9-]+)$/.exec(url.pathname)
  if (request.method === 'GET' && proposal) {
    sendJson(response, 200, await readSyncRun(requireProject(runtime), proposal[1]!))
    return
  }
  const proposalDelivery = /^\/api\/proposals\/([a-z0-9-]+)\/delivery\/branch$/.exec(url.pathname)
  if (request.method === 'POST' && proposalDelivery) {
    const body = recordBody(await readJsonBody(request))
    sendJson(response, 201, await createProposalBranch(requireProject(runtime), proposalDelivery[1]!, optionalString(body.branch)))
    return
  }
  const proposalPublish = /^\/api\/proposals\/([a-z0-9-]+)\/delivery\/publish$/.exec(url.pathname)
  if (request.method === 'POST' && proposalPublish) {
    const body = recordBody(await readJsonBody(request))
    sendJson(response, 200, await publishProposalBranch(requireProject(runtime), proposalPublish[1]!, body.createPullRequest === true))
    return
  }
  const proposalPreview = /^\/api\/proposals\/([a-z0-9-]+)\/preview\/start$/.exec(url.pathname)
  if (request.method === 'POST' && proposalPreview) {
    const body = recordBody(await readJsonBody(request))
    const open = body.open === true
    const root = requireProject(runtime)
    const project = await loadProject(root)
    const run = await readSyncRun(root, proposalPreview[1]!)
    const existing = runtime.proposalPreviewJobId
      ? runtime.jobs.get(runtime.proposalPreviewJobId)
      : undefined
    if (existing?.status === 'running' && runtime.proposalPreviewRunId === run.id && runtime.proposalPreviewUrl) {
      await waitForPreviewServer(runtime.proposalPreviewUrl, existing, projectPreviewIdentity(project.generator, join(root, '.doxloop', 'runs', run.id, 'workspace')))
      if (open) openBrowser(runtime.proposalPreviewUrl)
      sendJson(response, 200, { job: publicJob(existing), url: runtime.proposalPreviewUrl })
      return
    }
    if (existing?.status === 'running') {
      existing.status = 'cancelled'
      existing.finishedAt = new Date().toISOString()
      const child = existing.child
      child?.kill('SIGTERM')
      if (child) await new Promise<void>((resolveExit) => child.once('exit', () => resolveExit()))
    }
    const workspace = join(root, '.doxloop', 'runs', run.id, 'workspace')
    const previewPort = await availableLocalPort()
    const previewUrl = `http://127.0.0.1:${previewPort}`
    const args = ['preview', '--host', '127.0.0.1', '--port', String(previewPort), '--cwd', workspace]
    const job = startCliJob(runtime, `proposal-preview:${run.id}`, args, workspace)
    runtime.proposalPreviewJobId = job.id
    runtime.proposalPreviewRunId = run.id
    runtime.proposalPreviewUrl = previewUrl
    await waitForPreviewServer(previewUrl, job, projectPreviewIdentity(project.generator, workspace))
    if (open) openBrowser(previewUrl)
    sendJson(response, 202, { job: publicJob(job), url: previewUrl })
    return
  }
  const proposalDiff = /^\/api\/proposals\/([a-z0-9-]+)\/changes\/(change-\d+)\/diff$/.exec(url.pathname)
  if (request.method === 'GET' && proposalDiff) {
    const root = requireProject(runtime)
    const run = await readSyncRun(root, proposalDiff[1]!)
    sendJson(response, 200, await syncReviewSourceDiff(root, run, requireSyncReviewChange(run, proposalDiff[2]!)))
    return
  }
  const proposalContent = /^\/api\/proposals\/([a-z0-9-]+)\/changes\/(change-\d+)\/content$/.exec(url.pathname)
  if (request.method === 'GET' && proposalContent) {
    sendJson(response, 200, await readSyncRunChangeContent(requireProject(runtime), proposalContent[1]!, proposalContent[2]!))
    return
  }
  if (request.method === 'PATCH' && proposalContent) {
    const body = recordBody(await readJsonBody(request))
    if (typeof body.fingerprint !== 'string' || !body.fingerprint) throw new DoxloopError('Reload the proposal before editing; a fingerprint is required.')
    const disposition = body.evidenceDisposition === 'preserved' ? 'preserved' : 'needs-review'
    sendJson(response, 200, await editSyncRunChange(
      requireProject(runtime),
      proposalContent[1]!,
      proposalContent[2]!,
      stringValue(body.content),
      disposition,
      body.fingerprint,
    ))
    return
  }
  const proposalRevision = /^\/api\/proposals\/([a-z0-9-]+)\/(revise|regenerate)$/.exec(url.pathname)
  if (request.method === 'POST' && proposalRevision) {
    assertNoActiveDocumentationJob(runtime)
    const root = requireProject(runtime)
    const run = await readSyncRun(root, proposalRevision[1]!)
    const body = recordBody(await readJsonBody(request))
    const changeIds = proposalRevision[2] === 'regenerate'
      ? run.changes.map((change) => change.id)
      : stringArray(body.changeIds)
    const instruction = proposalRevision[2] === 'regenerate'
      ? optionalString(body.instruction) ?? 'Regenerate this proposal using the current approved plan and evidence.'
      : optionalString(body.instruction) ?? ''
    if (!instruction) throw new DoxloopError('Describe how the selected documentation should change.')
    if (changeIds.length === 0) throw new DoxloopError('Select at least one file to revise.')
    const args = ['proposal', 'revise', '--id', run.id, '--request', instruction, '--cwd', root]
    for (const changeId of changeIds) args.push('--change', changeId)
    for (const hunkId of stringArray(body.hunkIds)) args.push('--hunk', hunkId)
    const job = startCliJob(runtime, `proposal:revise:${run.id}`, args, root)
    sendJson(response, 202, publicJob(job))
    return
  }
  const proposalRefine = /^\/api\/proposals\/([a-z0-9-]+)\/refine$/.exec(url.pathname)
  if (request.method === 'POST' && proposalRefine) {
    assertNoActiveDocumentationJob(runtime)
    const root = requireProject(runtime)
    const run = await readSyncRun(root, proposalRefine[1]!)
    const spec = pageRefineJobSpec(root, run, await readJsonBody(request))
    const job = startCliJob(runtime, spec.type, spec.args, root)
    sendJson(response, 202, { job: publicJob(job) })
    return
  }
  const proposalLifecycle = /^\/api\/proposals\/([a-z0-9-]+)\/(undo|archive|recover)$/.exec(url.pathname)
  if (request.method === 'POST' && proposalLifecycle) {
    const root = requireProject(runtime)
    const result = proposalLifecycle[2] === 'undo'
      ? await undoSyncRun(root, proposalLifecycle[1]!)
      : proposalLifecycle[2] === 'recover'
        ? await recoverSyncRun(root, proposalLifecycle[1]!, {
            ignoreScreenshotProblems: recordBody(await readJsonBody(request)).ignoreScreenshotProblems === true,
          })
        : await archiveSyncRun(root, proposalLifecycle[1]!)
    sendJson(response, 200, result)
    return
  }
  const proposalResume = /^\/api\/proposals\/([a-z0-9-]+)\/resume$/.exec(url.pathname)
  if (request.method === 'POST' && proposalResume) {
    assertNoActiveDocumentationJob(runtime)
    const root = requireProject(runtime)
    const run = await readSyncRun(root, proposalResume[1]!)
    if (run.status !== 'failed' && run.status !== 'generating') throw new DoxloopError(`Only a failed or interrupted proposal can be resumed; ${run.id} is ${run.status}.`)
    const job = startCliJob(runtime, `proposal:resume:${run.id}`, ['proposal', 'resume', '--id', run.id, '--cwd', root], root)
    sendJson(response, 202, publicJob(job))
    return
  }
  // Captured screenshots are served straight from the isolated run workspace so
  // reviewers can watch them appear during a run, before anything is applied.
  if (request.method === 'GET' && url.pathname === '/api/captures') {
    const root = requireProject(runtime)
    sendJson(response, 200, { captures: await listRunCaptures(root, url.searchParams.get('run') ?? undefined) })
    return
  }
  if (request.method === 'GET' && url.pathname === '/api/captures/file') {
    const root = requireProject(runtime)
    const runId = url.searchParams.get('run')
    const file = url.searchParams.get('path')
    if (!runId || !file) throw new DoxloopError('A capture request needs a run and a project-relative path.')
    const workspace = runWorkspace(root, runId)
    const image = assertInside(workspace, resolve(workspace, file))
    if (extname(image).toLowerCase() !== '.png' || !(await pathExists(image))) {
      sendJson(response, 404, { error: 'That capture no longer exists.' })
      return
    }
    send(response, 200, 'image/png', await readFile(image), { ...baseHeaders(), 'Cache-Control': 'no-store' })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/proposals/cleanup') {
    sendJson(response, 200, { removed: await pruneSyncRuns(requireProject(runtime)) })
    return
  }
  const proposalRejectChanges = /^\/api\/proposals\/([a-z0-9-]+)\/reject-changes$/.exec(url.pathname)
  if (request.method === 'POST' && proposalRejectChanges) {
    const body = recordBody(await readJsonBody(request))
    const selections = body.scope === 'folder' ? syncReviewSelectionsFromBody(await readSyncRun(requireProject(runtime), proposalRejectChanges[1]!), body) : [{ changeId: stringValue(body.changeId), ...(Array.isArray(body.hunkIds) ? { hunkIds: body.hunkIds.map(stringValue) } : {}) }]
    sendJson(response, 200, await rejectSyncChanges(requireProject(runtime), proposalRejectChanges[1]!, selections, optionalString(body.reason) ?? ''))
    return
  }
  const proposalDecision = /^\/api\/proposals\/([a-z0-9-]+)\/(accept|reject)$/.exec(url.pathname)
  if (request.method === 'POST' && proposalDecision) {
    const root = requireProject(runtime)
    if (proposalDecision[2] === 'reject') {
      sendJson(response, 200, await rejectSyncRun(root, proposalDecision[1]!))
      return
    }
    const run = await readSyncRun(root, proposalDecision[1]!)
    const body = await readJsonBody(request)
    const selections = syncReviewSelectionsFromBody(run, body)
    const result = await acceptSyncChanges(root, run.id, selections, syncReviewAcceptOptions(body))
    if (result.status === 'applied' && !run.editRequest) await clearPendingSourceChangesInReceipt(root)
    sendJson(response, 200, result)
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/author') {
    const activeAuthoringJob = [...runtime.jobs.values()].find(
      (job) => job.status === 'running' && job.type.startsWith('author:'),
    )
    if (activeAuthoringJob) {
      throw new DoxloopError('A documentation run is already in progress. Wait for it to finish or cancel it before starting another.')
    }
    const body = recordBody(await readJsonBody(request))
    const mode = stringValue(body.mode)
    if (mode !== 'create' && mode !== 'update' && mode !== 'review') {
      throw new DoxloopError('Authoring mode must be create, update, or review.')
    }
    requirePlanFirstAuthoring(mode)
    const root = requireProject(runtime)
    let project = await loadProject(root)
    if (
      mode === 'create' &&
      (!project.documentation.primaryAudience ||
        !project.documentation.priorityOutcomes?.length)
    ) {
      const documentation = completeDocumentationBriefForCreate(
        project.documentation,
      )
      await saveProjectSettings(root, { documentation })
      project = { ...project, documentation }
    }
    const requestedAgent = parseAgent(optionalString(body.agent))
    const effectiveAgent = requestedAgent ?? project.defaultAgent
    const receipt = await readOptionalJson(join(root, '.doxloop', 'last-run.json'))
    const pendingRemovedSources = receipt && typeof receipt === 'object' && !Array.isArray(receipt)
      ? (receipt as Record<string, unknown>).pendingRemovedSources
      : undefined
    const removedSources = Array.isArray(pendingRemovedSources)
      ? pendingRemovedSources.filter((entry): entry is string => typeof entry === 'string')
      : []
    const removalRequest = removedSources.length > 0
      ? `The following configured sources were removed since the last accepted update: ${removedSources.join(', ')}. Delete documentation pages grounded exclusively in those sources. For pages supported by other active sources, remove the deleted-source evidence and any claims that are no longer supported. Update navigation and .doxloop/evidence-map.json so no stale documentation from the removed sources remains.`
      : undefined
    const requestText = [optionalString(body.request), removalRequest].filter(Boolean).join('\n\n')
    const args = mode === 'update' ? ['sync', 'now', '--trigger', 'manual'] : [mode]
    if (mode === 'update') appendOption(args, 'request', requestText || undefined)
    else if (requestText) args.push(requestText)
    appendOption(args, 'agent', requestedAgent)
    appendOption(args, 'model', optionalString(body.model))
    if (effectiveAgent === 'codex') appendOption(args, 'reasoning', optionalString(body.reasoning))
    if (effectiveAgent === 'claude') appendOption(args, 'effort', optionalString(body.effort))
    const screenshotIntent = normalizeScreenshotIntent(body.screenshots)
    if (screenshotIntent === 'enabled' && mode !== 'review') args.push('--screenshots')
    if (screenshotIntent === 'disabled' && mode !== 'review') args.push('--no-screenshots')
    args.push('--yes', '--cwd', root)
    sendJson(
      response,
      202,
      publicJob(startCliJob(runtime, `author:${mode}`, args, root, effectiveAgent)),
    )
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/capture') {
    const body = recordBody(await readJsonBody(request))
    const urls = stringArray(body.urls)
    const root = requireProject(runtime)
    sendJson(response, 202, publicJob(startCliJob(runtime, 'capture', ['capture', ...urls, '--cwd', root], root)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/preview/start') {
    const body = recordBody(await readJsonBody(request))
    const open = body.open === true
    if (runtime.previewJobId && runtime.previewUrl) {
      const existing = runtime.jobs.get(runtime.previewJobId)
      if (existing?.status === 'running') {
        const root = requireProject(runtime)
        const project = await loadProject(root)
        await waitForPreviewServer(runtime.previewUrl, existing, projectPreviewIdentity(project.generator, root))
        if (open) openBrowser(runtime.previewUrl)
        sendJson(response, 200, { job: publicJob(existing), url: runtime.previewUrl })
        return
      }
    }
    const root = requireProject(runtime)
    const project = await loadProject(root)
    const previewPort = await availableLocalPort()
    const previewUrl = `http://127.0.0.1:${previewPort}`
    const args = ['preview', '--host', '127.0.0.1', '--port', String(previewPort), '--cwd', root]
    if (open) args.push('--open')
    const job = startCliJob(runtime, 'preview', args, root)
    runtime.previewJobId = job.id
    runtime.previewUrl = previewUrl
    await waitForPreviewServer(previewUrl, job, projectPreviewIdentity(project.generator, root))
    sendJson(response, 202, { job: publicJob(job), url: previewUrl })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/preview/stop') {
    const job = runtime.previewJobId ? runtime.jobs.get(runtime.previewJobId) : undefined
    if (job?.status === 'running') {
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      job.child?.kill('SIGTERM')
    }
    delete runtime.previewJobId
    delete runtime.previewUrl
    sendJson(response, 200, { stopped: true })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/agent/install') {
    const agent = parseAgent(optionalString(recordBody(await readJsonBody(request)).agent))
    if (!agent) throw new DoxloopError('Choose Codex, Claude Code, or Gemini.')
    const installed = (await detectAgents()).find((item) => item.name === agent)
    if (installed) {
      sendJson(response, 200, { ...installed, alreadyInstalled: true })
      return
    }
    const existing = [...runtime.jobs.values()].find((job) => job.type === 'agent:install' && job.agent === agent && job.status === 'running')
    sendJson(response, 202, publicJob(existing ?? startAgentInstallJob(runtime, agent)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/agent/skills') {
    const root = requireProject(runtime)
    const agent = parseAgent(optionalString(recordBody(await readJsonBody(request)).agent))
    if (!agent) throw new DoxloopError('Choose Codex, Claude Code, or Gemini.')
    sendJson(response, 200, await installSkill({ root, agent }))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/generator') {
    const body = recordBody(await readJsonBody(request))
    const action = stringValue(body.action)
    const generator = stringValue(body.generator)
    if (action !== 'add' && action !== 'remove') throw new DoxloopError('Generator action must be add or remove.')
    const root = requireProject(runtime)
    sendJson(response, 202, publicJob(startCliJob(runtime, 'generator', ['generator', action, generator, '--cwd', root], root)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/login') {
    const body = recordBody(await readJsonBody(request))
    const args = ['login']
    appendOption(args, 'api-url', optionalString(body.apiUrl))
    const existing = [...runtime.jobs.values()].find((job) => job.type === 'login' && job.status === 'running')
    sendJson(response, 202, publicJob(existing ?? startCliJob(runtime, 'login', args, runtime.root ?? runtime.cwd)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/auth/logout') {
    await logout()
    sendJson(response, 200, { signedOut: true })
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/deploy') {
    const body = recordBody(await readJsonBody(request))
    const root = requireProject(runtime)
    const args = ['deploy', '--yes', '--cwd', root]
    if (body.dryRun === true) args.push('--dry-run')
    if (body.public === true) args.push('--public')
    appendOption(args, 'name', optionalString(body.name))
    appendOption(args, 'slug', optionalString(body.slug))
    appendOption(args, 'api-url', optionalString(body.apiUrl))
    appendOption(args, 'target', optionalString(body.target))
    appendOption(args, 'site-id', optionalString(body.siteId))
    appendOption(args, 'project-id', optionalString(body.projectId))
    appendOption(args, 'team-id', optionalString(body.teamId))
    appendOption(args, 'branch', optionalString(body.branch))
    appendOption(args, 'base-path', optionalString(body.basePath))
    sendJson(response, 202, publicJob(startCliJob(runtime, body.dryRun === true ? 'deploy:dry-run' : 'deploy', args, root)))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/export') {
    const root = requireProject(runtime)
    await ensureGitignoreEntries(root, ['.doxloop/exports/'])
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const output = join(root, '.doxloop', 'exports', `site-${stamp}`)
    const args = ['export', '--cwd', root, '--out', output, '--zip']
    const body = recordBody(await readJsonBody(request))
    appendOption(args, 'base-path', optionalString(body.basePath))
    appendOption(args, 'site-url', optionalString(body.siteUrl))
    sendJson(response, 202, publicJob(startCliJob(runtime, 'export', args, root)))
    return
  }
  sendJson(response, 404, { error: 'Not found' })
}

async function buildUiState(runtime: UiRuntime): Promise<Record<string, unknown>> {
  const root = runtime.root
  if (!root) {
    const agents = await agentState(undefined, undefined)
    return {
      projectFound: false,
      cwd: runtime.cwd,
      agents,
      generators: await installedGeneratorEntries(runtime.cwd),
      jobs: [...runtime.jobs.values()].map(publicJob).reverse(),
      recentProjects: await listRecentProjects(),
    }
  }
  const project = await loadProject(root)
  const [validation, doctor, runs, syncStatus, drift, agents, account, receipt, recentProjects, deployments] = await Promise.all([
    safe(() => validateProject(root)),
    safe(() => runDoctor({ cwd: root })),
    safe(() => listSyncRuns(root)),
    safe(() => formatSyncStatus(root, project)),
    safe(() => computeConfiguredDrift(root, project)),
    agentState(root, project.defaultAgent),
    accountState(project),
    readOptionalJson(join(root, '.doxloop', 'last-run.json')),
    listRecentProjects(),
    listDeployments(root, 20),
  ])
  // Onboarding placeholders remain blocking in CLI validation and publication.
  // Before any accepted proposal, present them as setup guidance in the UI.
  if (!('error' in validation) && Array.isArray(runs) && !runs.some((run) => run.status === 'applied' || run.status === 'partially-applied' || run.changes.some((change) => change.hunks.some((hunk) => hunk.acceptedAt)))) {
    validation.issues = validation.issues.map((issue) => issue.code === 'starter-content' ? { ...issue, severity: 'warning' as const, message: 'Starter page: approve your first documentation proposal to replace this placeholder.' } : issue)
    validation.errors = validation.issues.filter((issue) => issue.severity === 'error').length
    validation.warnings = validation.issues.filter((issue) => issue.severity === 'warning').length
  }
  return {
    projectFound: true,
    cwd: runtime.cwd,
    root,
    project,
    effectiveDeployment: effectiveDeployment(project),
    latestDeployment: deployments.find((entry) => entry.status === 'succeeded' && entry.target === effectiveDeployment(project).target && (!effectiveDeployment(project).slug || entry.slug === effectiveDeployment(project).slug)),
    validation,
    doctor,
    runs,
    syncStatus,
    drift,
    agents,
    account,
    receipt,
    documentationPlan: await latestDocumentationPlan(root),
    generators: (await installedGeneratorEntries(root)).filter(
      (generator) => generator.id === project.generator,
    ),
    jobs: [...runtime.jobs.values()].map(publicJob).reverse(),
    recentProjects,
    preview: {
      running: runtime.previewJobId
        ? runtime.jobs.get(runtime.previewJobId)?.status === 'running'
        : false,
      ...(runtime.previewUrl ? { url: runtime.previewUrl } : {}),
    },
  }
}

async function agentState(root: string | undefined, preferred: AgentName | undefined): Promise<unknown[]> {
  const detected = await detectAgents()
  return Promise.all(detected.map(async (agent) => ({
    ...agent,
    preferred: agent.name === preferred,
    authentication: await agentAuthenticationStatus(agent),
    skills: root ? await skillStatus(root, agent.name) : [],
  })))
}

async function accountState(project: DoxloopProject): Promise<Record<string, unknown>> {
  try {
    const config = await loadUserConfig()
    const destination = (project.deployment?.target ?? 'doxbrix') === 'doxbrix'
      ? project.deployment?.apiUrl ?? config.apiUrl
      : config.apiUrl
    const user = await authenticatedRequest<{ id: string; email: string; name: string | null }>(
      '/api/v1/me',
      { method: 'GET' },
      destination,
    )
    return { signedIn: true, apiUrl: destination, user }
  } catch (error) {
    const config = await safe(() => loadUserConfig())
    return {
      signedIn: false,
      apiUrl: isFailure(config) ? 'https://app.doxbrix.com' : config.apiUrl,
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

/**
 * The rendered reader site lives on a host Doxbrix provisions (`hostedSlug`), so
 * it cannot be derived locally from the project slug. Ask Doxbrix for it, and
 * report nothing rather than failing when signed out or not yet deployed.
 */
async function deployedSiteUrl(root: string): Promise<string | null> {
  try {
    const project = await loadProject(root)
    if ((project.deployment?.target ?? 'doxbrix') !== 'doxbrix') return null
    const deployment = effectiveDeployment(project)
    const found = await authenticatedRequestOptional<{ project: { hostedUrl?: string | null } }>(
      `/api/v1/projects/${encodeURIComponent(deployment.slug)}`,
      { method: 'GET' },
      deployment.apiUrl,
    )
    return found?.project?.hostedUrl ?? null
  } catch {
    return null
  }
}

async function createProjectFromUi(runtime: UiRuntime, raw: unknown): Promise<void> {
  const body = recordBody(raw)
  // Creating a project opens it, which is a switch for an already-open workspace.
  assertProjectSwitchAllowed(runtime.jobs.values())
  const title = optionalString(body.title)
  const generator = parseGenerator(optionalString(body.generator)) ?? 'doxbrix'
  const application = body.application !== undefined ? applicationFromBody(body.application) : undefined
  const root = resolveUiDocumentationDirectory(await newProjectParent(runtime, body), stringValue(body.directory))
  await assertUiProjectDirectoryAvailable(root)
  await assertNewProjectDirectory(root)
  const sourceKind = optionalString(body.sourceKind)
  const sourceLocation = optionalString(body.sourceLocation) ?? 'local'
  const sourcePath = optionalString(body.sourcePath)
  const sources: SourceBinding[] = []
  const sourceBodies = Array.isArray(body.sources)
    ? body.sources.map(recordBody)
    : [{ ...body, sourceKind, sourceLocation, sourcePath }]
  const usedNames = new Set<string>()
  for (const sourceBody of sourceBodies) {
    const itemKind = optionalString(sourceBody.sourceKind)
    const itemLocation = optionalString(sourceBody.sourceLocation) ?? 'local'
    const itemPath = optionalString(sourceBody.sourcePath)
    const specificationContent = optionalString(sourceBody.specContent)
    const baseName = sourceIdentifier(optionalString(sourceBody.name) ?? optionalString(sourceBody.sourceName) ?? (itemKind === 'openapi' ? 'api' : 'product'))
    let name = baseName
    let suffix = 2
    while (usedNames.has(name)) name = `${baseName}-${suffix++}`
    usedNames.add(name)
    if (itemKind === 'directory' && itemLocation === 'git') {
      const remote = remoteSourceFromSetupBody(sourceBody)
      const prepared = await materializeRemoteSource(root, { name, remote })
      sources.push({ name, path: portableSourcePath(root, prepared.path), remote })
    } else if (itemKind === 'directory' && itemPath) {
      sources.push({ name, path: portableRelative(root, resolve(runtime.cwd, itemPath)) })
    } else if (itemKind === 'openapi' && specificationContent) {
      parseOpenApi(specificationContent, `OpenAPI source "${name}"`)
      const extension = specificationContent.trimStart().startsWith('{') ? 'json' : 'yaml'
      const inlineDirectory = resolve(root, '..', '.doxloop-sources', sourceIdentifier(root.split(sep).pop() ?? 'project'), 'openapi')
      const inlinePath = join(inlineDirectory, `${name}.${extension}`)
      await mkdir(inlineDirectory, { recursive: true })
      await writeFile(inlinePath, `${specificationContent.trim()}\n`, 'utf8')
      sources.push({ name, path: portableRelative(root, inlinePath), kind: 'openapi' })
    } else if (itemKind === 'openapi' && itemPath) {
      const parsed = parseSpec(`${name}=${itemPath}`)
      sources.push(isSpecUrl(parsed.path) ? parsed : { ...parsed, path: portableRelative(root, resolve(runtime.cwd, parsed.path)) })
    }
  }
  await validateProjectSourceBoundaries(root, sources)
  if (generator !== 'doxbrix') {
    await mkdir(root, { recursive: true })
    await addGenerator(root, generator)
  }
  await scaffoldProject({ directory: root, ...(title ? { title } : {}), sources, generator })
  const agent = parseAgent(optionalString(body.agent))
  await installSkill({ root, ...(agent ? { agent } : {}) })
  const documentation = completeDocumentationBriefForCreate(
    body.documentation === undefined
      ? defaultDocumentationBrief()
      : documentationFromBody(body.documentation, defaultDocumentationBrief()),
  )
  await saveProjectSettings(root, {
    ...(agent ? { defaultAgent: agent } : {}),
    documentation,
    ...(application ? { application } : {}),
  })
  // Sign-in material gathered by the wizard is stored against the new root,
  // outside the project, now that the root exists.
  if (application) {
    const credentials = body.applicationCredentials === undefined || body.applicationCredentials === null ? undefined : recordBody(body.applicationCredentials)
    const username = credentials ? optionalString(credentials.username) : undefined
    const password = credentials && typeof credentials.password === 'string' ? credentials.password : ''
    if (username && password) await saveCaptureCredentials(root, { username, password })
    if (runtime.pendingCaptureSession) await saveCaptureSession(root, runtime.pendingCaptureSession.origin, runtime.pendingCaptureSession.state)
  }
  runtime.pendingCaptureSession = undefined
  await switchProject(runtime, root)
}

async function captureAuthState(runtime: UiRuntime, root: string): Promise<Record<string, unknown>> {
  return { ...(await captureAuthStatus(root)), signIn: captureSignInState(runtime, 'project') }
}

function setupCaptureAuthState(runtime: UiRuntime): Record<string, unknown> {
  const pending = runtime.pendingCaptureSession
  return {
    ...(pending ? { session: { savedAt: pending.savedAt, origin: pending.origin, cookies: pending.state.cookies.length, origins: pending.state.origins.length } } : {}),
    signIn: captureSignInState(runtime, 'setup'),
  }
}

function captureSignInState(runtime: UiRuntime, scope: 'project' | 'setup'): { active: boolean; open?: boolean; url?: string; currentUrl?: string } {
  const active = runtime.captureSignIn
  if (!active || active.scope !== scope) return { active: false }
  return { active: true, open: active.session.open(), url: active.session.url, currentUrl: active.session.currentUrl() }
}

async function beginCaptureSignIn(runtime: UiRuntime, application: ApplicationConfig, scope: 'project' | 'setup'): Promise<void> {
  // One visible window at a time: a forgotten earlier window is closed first.
  await cancelCaptureSignIn(runtime)
  const session = await startCaptureSignIn(application)
  runtime.captureSignIn = { session, scope, origin: new URL(application.baseUrl).origin }
}

async function cancelCaptureSignIn(runtime: UiRuntime): Promise<void> {
  const active = runtime.captureSignIn
  runtime.captureSignIn = undefined
  if (active) await active.session.cancel()
}

/**
 * New projects are created next to the folder the control center was opened
 * from unless the wizard names another parent, which lets a second project
 * start from an open workspace without restarting `doxloop ui`.
 */
async function newProjectParent(runtime: UiRuntime, body: Record<string, unknown>): Promise<string> {
  const requested = optionalString(body.parentDirectory)
  if (!requested) return runtime.cwd
  const parent = resolve(runtime.cwd, requested)
  let stats
  try {
    stats = await stat(parent)
  } catch {
    throw new DoxloopError(`The location does not exist: ${parent}`, 2)
  }
  if (!stats.isDirectory()) throw new DoxloopError(`The location is not a directory: ${parent}`, 2)
  return parent
}

async function resolveProjectToOpen(runtime: UiRuntime, raw: string): Promise<string> {
  const candidate = resolve(runtime.cwd, raw)
  try {
    if (!(await stat(candidate)).isDirectory()) throw new DoxloopError(`The folder is not a directory: ${candidate}`, 2)
  } catch (error) {
    if (error instanceof DoxloopError) throw error
    throw new DoxloopError(`The folder does not exist: ${candidate}`, 2)
  }
  try {
    return await findProjectRoot(candidate)
  } catch {
    throw new DoxloopError(`${candidate} is not a Doxloop project. Import its existing documentation, or start a new project.`, 2)
  }
}

function importOverrides(body: Record<string, unknown>): { generator?: GeneratorName; contentDir?: string } {
  const generator = parseGenerator(optionalString(body.generator))
  const contentDir = typeof body.contentDir === 'string' ? body.contentDir : undefined
  return { ...(generator ? { generator } : {}), ...(contentDir !== undefined ? { contentDir } : {}) }
}

/**
 * Only one project is open at a time. Switching ends the previews, which
 * serve the project that started them, and refuses while anything else runs
 * so a job never finishes into a workspace that is no longer shown.
 */
async function switchProject(runtime: UiRuntime, root: string): Promise<void> {
  assertProjectSwitchAllowed(runtime.jobs.values())
  if (runtime.root === root) {
    await rememberOpenProject(root)
    return
  }
  // A sign-in window belongs to the project it was opened for.
  await cancelCaptureSignIn(runtime)
  for (const job of runtime.jobs.values()) {
    if (job.status !== 'running') continue
    job.status = 'cancelled'
    job.finishedAt = new Date().toISOString()
    job.lines.push('The preview stopped because another project was opened.')
    queueUiJobLog(runtime, job.id, '\nThe preview stopped because another project was opened.\n')
    job.child?.stdout?.removeAllListeners('data')
    job.child?.stderr?.removeAllListeners('data')
    stopJobChild(job.child)
    delete job.child
  }
  if (runtime.root) {
    await flushUiJobLogs(runtime)
    await flushUiJobs(runtime)
  }
  const { jobs, recovered } = await loadRuntimeJobs(root)
  runtime.root = root
  runtime.jobs = jobs
  runtime.previewJobId = undefined
  runtime.previewUrl = undefined
  runtime.proposalPreviewJobId = undefined
  runtime.proposalPreviewRunId = undefined
  runtime.proposalPreviewUrl = undefined
  if (recovered) await persistUiJobs(runtime)
  broadcastJobs(runtime)
  await rememberOpenProject(root)
}

export function assertProjectSwitchAllowed(jobs: Iterable<Pick<UiJob, 'status' | 'type'>>): void {
  const active = [...jobs].find((job) => job.status === 'running' && !isPreviewJobType(job.type))
  if (active) {
    throw new DoxloopError('A run is still in progress. Wait for it to finish or stop it before opening another project.')
  }
}

function isPreviewJobType(type: string): boolean {
  return type === 'preview' || type.startsWith('proposal-preview:')
}

async function loadRuntimeJobs(root: string): Promise<{ jobs: Map<string, UiJob>; recovered: boolean }> {
  const jobs = await loadUiJobs(root)
  let recovered = false
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue
    job.status = 'failed'
    job.finishedAt = new Date().toISOString()
    job.recovered = true
    job.lines.push('The previous Doxloop UI server stopped before this run completed. Partial logs were preserved and this stage can be retried safely.')
    recovered = true
  }
  return { jobs, recovered }
}

async function rememberOpenProject(root: string): Promise<void> {
  try {
    const project = await loadProject(root)
    await rememberProject({ path: root, title: project.title, generator: project.generator })
  } catch {
    // The recent list is a convenience. A project that cannot be read still
    // opens so its problem is shown in the workspace.
  }
}

async function validateSetupPaths(runtime: UiRuntime, raw: unknown): Promise<Record<string, unknown>> {
  const body = recordBody(raw)
  const directory = optionalString(body.directory)
  let root: string | undefined
  let directoryError: string | undefined
  if (!directory) {
    directoryError = 'Enter a documentation directory.'
  } else {
    try {
      root = resolveUiDocumentationDirectory(await newProjectParent(runtime, body), directory)
      await assertUiProjectDirectoryAvailable(root)
    } catch (error) {
      directoryError = error instanceof Error ? error.message : String(error)
    }
  }

  const sourceKind = optionalString(body.sourceKind)
  const sourceLocation = optionalString(body.sourceLocation) ?? 'local'
  const sourcePath = optionalString(body.sourcePath)
  const sourceSpecContent = optionalString(body.specContent)
  let resolvedSourcePath: string | undefined
  let sourcePathError: string | undefined
  let openapiSummary: Awaited<ReturnType<typeof loadOpenApiSource>>['summary'] | undefined
  if (sourceKind && sourceKind !== 'none') {
    if (sourceKind === 'directory' && sourceLocation === 'git') {
      try {
        await remoteHead(remoteSourceFromSetupBody(body))
      } catch (error) {
        sourcePathError = error instanceof Error ? error.message : String(error)
      }
    } else if (sourceKind === 'openapi' && sourceSpecContent) {
      try { openapiSummary = parseOpenApi(sourceSpecContent, 'Uploaded OpenAPI specification').summary }
      catch (error) { sourcePathError = error instanceof Error ? error.message : String(error) }
    } else if (!sourcePath) {
      sourcePathError = sourceKind === 'directory' ? 'Choose a product source directory.' : 'Enter an OpenAPI file path or URL.'
    } else if (root) {
      try {
        if (sourceKind === 'directory') {
          resolvedSourcePath = resolve(runtime.cwd, sourcePath)
          await validateProjectSourceBoundaries(root, [{ name: 'product', path: portableRelative(root, resolvedSourcePath) }])
        } else if (sourceKind === 'openapi') {
          const parsed = parseSpec(`api=${sourcePath}`)
          resolvedSourcePath = isSpecUrl(parsed.path) ? parsed.path : resolve(runtime.cwd, parsed.path)
          const binding = isSpecUrl(parsed.path) ? parsed : { ...parsed, path: portableRelative(root, resolvedSourcePath) }
          await validateProjectSourceBoundaries(root, [binding])
          openapiSummary = (await loadOpenApiSource(root, binding)).summary
        } else {
          sourcePathError = 'Choose a supported source type.'
        }
      } catch (error) {
        sourcePathError = error instanceof Error ? error.message : String(error)
      }
    }
  }

  return {
    ...(root ? { directoryPath: root } : {}),
    ...(directoryError ? { directoryError } : {}),
    ...(resolvedSourcePath ? { sourcePath: resolvedSourcePath } : {}),
    ...(sourcePathError ? { sourcePathError } : {}),
    ...(openapiSummary ? { openapiSummary } : {}),
  }
}

function remoteSourceFromSetupBody(body: Record<string, unknown>): RemoteSource {
  const repository = parseGitRepository(stringValue(body.repository))
  const branch = stringValue(body.branch)
  const subdirectory = optionalString(body.subdirectory)
  configureGitAccess(body, repository)
  if (subdirectory && (subdirectory.startsWith('/') || subdirectory.split(/[\\/]/).includes('..'))) {
    throw new DoxloopError('Repository subdirectory must be a safe relative directory.')
  }
  return {
    provider: 'git',
    repository,
    branch,
    ...(subdirectory ? { subdirectory } : {}),
  }
}

function configureGitAccess(body: Record<string, unknown>, repository: string): void {
  const method = optionalString(body.authMethod) ?? 'automatic'
  if (method !== 'automatic' && method !== 'credentials') throw new DoxloopError('Choose a supported repository access option.')
  const secret = method === 'credentials' ? optionalString(body.gitSecret) : undefined
  if (method === 'credentials' && !secret) throw new DoxloopError('Enter the password or access key for this private repository.')
  rememberRemoteCredential(repository, optionalString(body.gitUsername), secret)
}

async function assertUiProjectDirectoryAvailable(path: string): Promise<void> {
  try {
    await stat(path)
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT') return
    throw error
  }
  throw new DoxloopError(`The documentation path already exists: ${path}\nChoose a different directory name.`)
}

function resolveUiDocumentationDirectory(cwd: string, name: string): string {
  if (name === '.' || name === '..' || /[\\/]/.test(name)) {
    throw new DoxloopError('Enter a directory name, not a filesystem path.')
  }
  return resolve(cwd, name)
}

async function updateProjectFromUi(root: string, raw: unknown): Promise<void> {
  const body = recordBody(raw)
  const project = await loadProject(root)
  const update: Parameters<typeof saveProjectSettings>[1] = {}
  const title = optionalString(body.title)
  if (title) update.title = title
  if ('defaultAgent' in body) {
    const rawAgent = optionalString(body.defaultAgent)
    const agent = parseAgent(rawAgent)
    if (rawAgent && !agent) throw new DoxloopError('Unsupported default agent.')
    update.defaultAgent = agent
  }
  if (body.documentation !== undefined) {
    update.documentation = documentationFromBody(body.documentation, project.documentation)
  }
  if (body.designReferences !== undefined) {
    update.designReferences = stringArray(body.designReferences).map(parseDesignReference)
  }
  if (body.application !== undefined) {
    update.application = body.application === null ? undefined : applicationFromBody(body.application, project)
  }
  if (body.deployment !== undefined) {
    update.deployment = deploymentFromBody(body.deployment)
  }
  await saveProjectSettings(root, update)
}

async function addSourceFromUi(root: string, raw: unknown): Promise<void> {
  const body = recordBody(raw)
  const project = await loadProject(root)
  const name = stringValue(body.name)
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new DoxloopError('Source name may use letters, numbers, underscores, and hyphens.')
  if (project.sources.some((source) => source.name === name)) throw new DoxloopError(`Source "${name}" already exists.`)
  const kind = stringValue(body.kind)
  const location = optionalString(body.path)
  const specificationContent = optionalString(body.specContent)
  const scope = sourceScopeFromBody(body)
  let source: SourceBinding
  if (kind === 'openapi' && specificationContent) {
    parseOpenApi(specificationContent, 'Uploaded OpenAPI specification')
    const extension = specificationContent.trimStart().startsWith('{') ? 'json' : 'yaml'
    const inlineDirectory = resolve(root, '..', '.doxloop-sources', sourceIdentifier(root.split(sep).pop() ?? 'project'), 'openapi')
    const inlinePath = join(inlineDirectory, `${name}.${extension}`)
    await mkdir(inlineDirectory, { recursive: true })
    await writeFile(inlinePath, `${specificationContent.trim()}\n`, 'utf8')
    source = { name, path: portableRelative(root, inlinePath), kind: 'openapi', ...(scope ? { scope } : {}) }
  } else if (kind === 'openapi') {
    const parsed = parseSpec(`${name}=${location ?? ''}`)
    source = { ...(isSpecUrl(parsed.path) ? parsed : { ...parsed, path: portableRelative(root, resolve(root, parsed.path)) }), ...(scope ? { scope } : {}) }
  } else if (kind === 'directory') {
    if (!location) throw new DoxloopError('Choose a product source directory.')
    source = { name, path: portableRelative(root, resolve(root, location)), ...(scope ? { scope } : {}) }
  } else if (kind === 'git') {
    const remote = remoteSourceFromSetupBody(body)
    const prepared = await materializeRemoteSource(root, { name, remote })
    source = { name, path: portableSourcePath(root, prepared.path), remote, ...(scope ? { scope } : {}) }
  } else {
    throw new DoxloopError('Source type must be directory, git, or openapi.')
  }
  const sources = [...project.sources, source]
  await validateProjectSourceBoundaries(root, sources)
  await saveProjectSettings(root, { sources })
  await setPendingSourceInReceipt(root, name, true)
  await setPendingRemovedSourceInReceipt(root, name, false)
}

async function updateSourceFromUi(root: string, name: string, raw: unknown): Promise<void> {
  const body = recordBody(raw)
  const project = await loadProject(root)
  const index = project.sources.findIndex((source) => source.name === name)
  if (index < 0) throw new DoxloopError(`Source "${name}" does not exist.`)
  let source = project.sources[index]!
  const sources = [...project.sources]
  if (body.path !== undefined || body.kind !== undefined) {
    const kind = optionalString(body.kind) ?? (source.kind ?? 'directory')
    const location = optionalString(body.path) ?? source.path
    if (kind === 'openapi') {
      const parsed = parseSpec(`${source.name}=${location}`)
      source = isSpecUrl(parsed.path) ? parsed : { ...parsed, path: portableRelative(root, resolve(root, parsed.path)) }
    } else if (kind === 'directory') {
      source = {
        name: source.name,
        path: portableRelative(root, resolve(root, location)),
        ...(source.remote ? { remote: source.remote } : {}),
      }
    } else {
      throw new DoxloopError('Source type must be directory or openapi.')
    }
    sources[index] = source
  }
  if (body.scope !== undefined) {
    const scope = sourceScopeFromBody(body)
    if (scope) source = { ...source, scope }
    else {
      const { scope: _scope, ...unscoped } = source
      source = unscoped
    }
    sources[index] = source
  }
  if (body.remote === null) {
    const { remote: _remote, ...withoutRemote } = source
    sources[index] = withoutRemote
  } else if (body.remote !== undefined) {
    const remote = recordBody(body.remote)
    const provider = optionalString(remote.provider) === 'github' ? 'github' : 'git'
    const rawRepository = stringValue(remote.repository)
    const repository = provider === 'github' ? rawRepository : parseGitRepository(rawRepository)
    if (provider === 'git') configureGitAccess(remote, repository)
    if (provider === 'github' && !/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new DoxloopError('GitHub repository must use owner/name format.')
    const branch = stringValue(remote.branch)
    const nextRemote: RemoteSource = {
      provider,
      repository,
      branch,
      ...(optionalString(remote.subdirectory) ? { subdirectory: optionalString(remote.subdirectory)! } : {}),
      ...(provider === 'github' && optionalString(remote.tokenEnv) ? { tokenEnv: optionalString(remote.tokenEnv)! } : {}),
      ...(provider === 'github' && optionalString(remote.apiBaseUrl) ? { apiBaseUrl: optionalString(remote.apiBaseUrl)! } : {}),
    }
    const managed = source.path.split(/[\\/]/).includes('.doxloop-sources')
    const prepared = managed ? await materializeRemoteSource(root, { name: source.name, remote: nextRemote }) : undefined
    sources[index] = {
      ...source,
      ...(prepared ? { path: portableSourcePath(root, prepared.path) } : {}),
      remote: nextRemote,
    }
  }
  await validateProjectSourceBoundaries(root, sources)
  await saveProjectSettings(root, { sources })
}

function sourceScopeFromBody(body: Record<string, unknown>): SourceBinding['scope'] | undefined {
  if (body.scope === undefined || body.scope === null) return undefined
  const raw = recordBody(body.scope)
  const space = optionalString(raw.space)
  const routePrefix = optionalString(raw.routePrefix)
  const navigationGroup = optionalString(raw.navigationGroup)
  const sharedPages = raw.sharedPages === undefined ? undefined : stringArray(raw.sharedPages)
  if (!space && !routePrefix && !navigationGroup && !sharedPages?.length) return undefined
  return { ...(space ? { space } : {}), ...(routePrefix ? { routePrefix } : {}), ...(navigationGroup ? { navigationGroup } : {}), ...(sharedPages?.length ? { sharedPages } : {}) }
}

async function removeSourceFromUi(root: string, name: string): Promise<void> {
  const project = await loadProject(root)
  if (!project.sources.some((source) => source.name === name)) throw new DoxloopError(`Source "${name}" does not exist.`)
  const sources = project.sources.filter((source) => source.name !== name)
  let application = project.application
  if (project.application?.source === name) {
    const { source: _source, startCommand: _startCommand, ...remaining } = project.application
    application = remaining
  }
  await saveProjectSettings(root, { sources, application })
  await setPendingSourceInReceipt(root, name, false)
  await setPendingRemovedSourceInReceipt(root, name, true)
}

async function setPendingRemovedSourceInReceipt(root: string, name: string, pending: boolean): Promise<void> {
  const path = join(root, '.doxloop', 'last-run.json')
  const raw = await readOptionalJson(path)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const receipt = { ...raw } as Record<string, unknown>
  const existing = Array.isArray(receipt.pendingRemovedSources)
    ? receipt.pendingRemovedSources.filter((entry): entry is string => typeof entry === 'string')
    : []
  const pendingRemovedSources = pending
    ? [...new Set([...existing, name])]
    : existing.filter((entry) => entry !== name)
  if (pendingRemovedSources.length > 0) receipt.pendingRemovedSources = pendingRemovedSources
  else delete receipt.pendingRemovedSources
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}

async function clearPendingSourceChangesInReceipt(root: string): Promise<void> {
  const path = join(root, '.doxloop', 'last-run.json')
  const raw = await readOptionalJson(path)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const receipt = { ...raw } as Record<string, unknown>
  delete receipt.pendingSources
  delete receipt.pendingRemovedSources
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}

async function setPendingSourceInReceipt(
  root: string,
  name: string,
  pending: boolean,
): Promise<void> {
  const path = join(root, '.doxloop', 'last-run.json')
  const raw = await readOptionalJson(path)
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
  const receipt = { ...raw } as Record<string, unknown>
  const existing = Array.isArray(receipt.pendingSources)
    ? receipt.pendingSources.filter((entry): entry is string => typeof entry === 'string')
    : []
  const pendingSources = pending
    ? [...new Set([...existing, name])]
    : existing.filter((entry) => entry !== name)
  if (pendingSources.length > 0) receipt.pendingSources = pendingSources
  else delete receipt.pendingSources
  await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8')
}

function syncConfigFromBody(raw: unknown, current: SyncConfig): SyncConfig {
  const body = recordBody(raw)
  const mode = parseSyncMode(optionalString(body.mode) ?? current.mode)
  const onRaw = body.on === undefined ? current.on : stringArray(body.on)
  const on = onRaw.length === 0 ? [] : parseTriggerList(onRaw.join(','))
  const watch = body.watch === undefined ? current.watch : stringArray(body.watch)
  const ignore = body.ignore === undefined ? current.ignore : stringArray(body.ignore)
  const branch = optionalString(body.branch)
  const budgetBody = body.budget === undefined ? undefined : recordBody(body.budget)
  const maxRunsPerDay = budgetBody ? optionalPositiveNumber(budgetBody.maxRunsPerDay) : current.budget?.maxRunsPerDay
  const maxMinutes = budgetBody ? optionalPositiveNumber(budgetBody.maxMinutes) : current.budget?.maxMinutes
  const maxUsd = budgetBody ? optionalPositiveAmount(budgetBody.maxUsd) : current.budget?.maxUsd
  const budget = maxRunsPerDay || maxMinutes || maxUsd
    ? { ...(maxRunsPerDay ? { maxRunsPerDay } : {}), ...(maxMinutes ? { maxMinutes } : {}), ...(maxUsd ? { maxUsd } : {}) }
    : undefined
  const maxVerificationAgeDays = body.maxVerificationAgeDays === undefined ? current.maxVerificationAgeDays : optionalPositiveNumber(body.maxVerificationAgeDays)
  const rawSeverity = optionalString(body.maxVerificationAgeSeverity) ?? current.maxVerificationAgeSeverity
  if (rawSeverity && rawSeverity !== 'warn' && rawSeverity !== 'fail') throw new DoxloopError('Verification age severity must be warn or fail.')
  const maxVerificationAgeSeverity = rawSeverity === 'warn' || rawSeverity === 'fail' ? rawSeverity : undefined
  return { mode, ...(branch ? { branch } : {}), on, watch, ignore, ...(budget ? { budget } : {}), ...(maxVerificationAgeDays ? { maxVerificationAgeDays } : {}), ...(maxVerificationAgeSeverity ? { maxVerificationAgeSeverity } : {}) }
}

function documentationFromBody(raw: unknown, current: DocumentationBrief): DocumentationBrief {
  const body = recordBody(raw)
  const result: DocumentationBrief = {
    locale: optionalString(body.locale) ?? current.locale,
    tone: body.tone === undefined ? current.tone : stringArray(body.tone),
    standardsProfile: optionalString(body.standardsProfile) ?? current.standardsProfile,
    styleGuide: optionalString(body.styleGuide) ?? current.styleGuide,
    terminology: body.terminology === undefined ? current.terminology : stringRecord(body.terminology),
    exclusions: body.exclusions === undefined ? current.exclusions : stringArray(body.exclusions),
    accessibilityTarget: optionalString(body.accessibilityTarget) ?? current.accessibilityTarget,
  }
  const primaryAudience = optionalString(body.primaryAudience) ?? current.primaryAudience
  if (primaryAudience) result.primaryAudience = primaryAudience
  const audiences = body.audiences === undefined ? current.audiences : stringArray(body.audiences)
  if (audiences?.length) result.audiences = audiences
  const customInstructions = body.customInstructions === undefined
    ? current.customInstructions
    : optionalString(body.customInstructions)
  if (customInstructions) result.customInstructions = customInstructions
  const experienceLevel = optionalString(body.experienceLevel) ?? current.experienceLevel
  if (experienceLevel === 'beginner' || experienceLevel === 'intermediate' || experienceLevel === 'advanced' || experienceLevel === 'mixed') {
    result.experienceLevel = experienceLevel
  }
  const priorityOutcomes = body.priorityOutcomes === undefined ? current.priorityOutcomes : stringArray(body.priorityOutcomes)
  if (priorityOutcomes) result.priorityOutcomes = priorityOutcomes
  const preferredExamples = body.preferredExamples === undefined ? current.preferredExamples : stringArray(body.preferredExamples)
  if (preferredExamples) result.preferredExamples = preferredExamples
  const designDirection = body.designDirection === undefined ? current.designDirection : optionalString(body.designDirection)
  if (designDirection) result.designDirection = designDirection
  return result
}

function applicationFromBody(raw: unknown, project?: DoxloopProject): ApplicationConfig {
  const body = recordBody(raw)
  const baseUrl = stringValue(body.baseUrl)
  let parsed: URL
  try {
    parsed = new URL(baseUrl)
  } catch {
    throw new DoxloopError('Application URL is invalid.')
  }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new DoxloopError('Application URL must use HTTP(S) without credentials, query, or fragment.')
  }
  const screenshots = body.screenshots === undefined ? undefined : recordBody(body.screenshots)
  const source = optionalString(body.source)
  if (source && (!project || !project.sources.some((item) => item.name === source))) {
    throw new DoxloopError(`Application source "${source}" is not configured.`)
  }
  const startCommand = optionalString(body.startCommand)
  if (startCommand && !source) throw new DoxloopError('A start command requires a product source.')
  const readyPath = optionalString(body.readyPath)
  if (readyPath && (!readyPath.startsWith('/') || readyPath.startsWith('//'))) {
    throw new DoxloopError('Application ready path must start with one slash.')
  }
  const policy = optionalString(screenshots?.policy) ?? 'requested'
  if (!['requested', 'auto', 'off'].includes(policy)) throw new DoxloopError('Screenshot policy must be requested, auto, or off.')
  const width = screenshots ? optionalViewportNumber(screenshots.viewport, 'width', 3840) : undefined
  const height = screenshots ? optionalViewportNumber(screenshots.viewport, 'height', 2160) : undefined
  if ((width === undefined) !== (height === undefined)) throw new DoxloopError('Screenshot viewport requires both width and height.')
  const startPath = optionalString(screenshots?.startPath)
  if (startPath && !validApplicationRelativePath(startPath)) {
    throw new DoxloopError('Screenshot starting route must begin with one slash and must not include a fragment.')
  }
  const workflow = optionalString(screenshots?.workflow)
  if (workflow && workflow.length < 12) throw new DoxloopError('Screenshot workflow guidance must describe the safe state and capture process.')
  const authentication = body.authentication === undefined || body.authentication === null ? undefined : recordBody(body.authentication)
  const loginPath = optionalString(authentication?.loginPath)
  if (loginPath && !validApplicationRelativePath(loginPath)) {
    throw new DoxloopError('Sign-in route must begin with one slash and must not include a fragment.')
  }
  return {
    baseUrl: parsed.toString().replace(/\/$/, ''),
    ...(source ? { source } : {}),
    ...(startCommand ? { startCommand } : {}),
    ...(readyPath ? { readyPath } : {}),
    ...(loginPath ? { authentication: { loginPath } } : {}),
    ...(screenshots ? {
      screenshots: {
        policy: policy as 'requested' | 'auto' | 'off',
        ...(width !== undefined && height !== undefined ? { viewport: { width, height } } : {}),
        ...(screenshots.highlight === undefined ? {} : { highlight: screenshots.highlight === true }),
        ...(startPath ? { startPath } : {}),
        ...(workflow ? { workflow } : {}),
      },
    } : {}),
  }
}

function validApplicationRelativePath(value: string): boolean {
  if (!value.startsWith('/') || value.startsWith('//')) return false
  try {
    const parsed = new URL(value, 'https://application.invalid')
    return parsed.origin === 'https://application.invalid' && !parsed.hash
  } catch {
    return false
  }
}

function deploymentFromBody(raw: unknown): DeploymentConfig {
  const body = recordBody(raw)
  const target = optionalString(body.target)
  if (target && !['doxbrix', 'github-pages', 'netlify', 'vercel'].includes(target)) throw new DoxloopError('Choose Doxbrix, GitHub Pages, Netlify, or Vercel.')
  const validTarget = target as 'doxbrix' | 'github-pages' | 'netlify' | 'vercel' | undefined
  const visibility = optionalString(body.visibility)
  if (visibility && visibility !== 'private' && visibility !== 'public') throw new DoxloopError('Visibility must be private or public.')
  const validVisibility = visibility === 'private' || visibility === 'public' ? visibility : undefined
  const rawApiUrl = optionalString(body.apiUrl)
  let validApiUrl: string | undefined
  if (rawApiUrl) {
    let parsed: URL
    try {
      parsed = new URL(rawApiUrl)
    } catch {
      throw new DoxloopError('Deployment API URL is invalid.')
    }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
      throw new DoxloopError('Deployment API URL must be an HTTP(S) origin without credentials, query, or fragment.')
    }
    validApiUrl = parsed.toString().replace(/\/$/, '')
  }
  return {
    ...(validTarget ? { target: validTarget } : {}),
    ...(optionalString(body.name) ? { name: optionalString(body.name)! } : {}),
    ...(optionalString(body.slug) ? { slug: optionalString(body.slug)! } : {}),
    ...(validVisibility ? { visibility: validVisibility } : {}),
    ...(validApiUrl ? { apiUrl: validApiUrl } : {}),
    ...(optionalString(body.siteId) ? { siteId: optionalString(body.siteId)! } : {}),
    ...(optionalString(body.projectId) ? { projectId: optionalString(body.projectId)! } : {}),
    ...(optionalString(body.teamId) ? { teamId: optionalString(body.teamId)! } : {}),
    ...(optionalString(body.branch) ? { branch: optionalString(body.branch)! } : {}),
    ...(optionalString(body.basePath) ? { basePath: optionalString(body.basePath)! } : {}),
  }
}

async function handleProposalPreview(response: ServerResponse, url: URL, runtime: UiRuntime): Promise<void> {
  const match = /^\/review-preview\/([a-z0-9-]+)\/(change-\d+)$/.exec(url.pathname)
  if (!match) {
    sendJson(response, 404, { error: 'Not found' })
    return
  }
  const root = requireProject(runtime)
  const run = await readSyncRun(root, match[1]!)
  const html = await syncReviewComparisonDocument(root, run, requireSyncReviewChange(run, match[2]!), {
    layout: url.searchParams.get('layout') === 'unified' ? 'unified' : 'split',
    onlyChanges: url.searchParams.get('only') === '1',
    theme: url.searchParams.get('theme') === 'dark' ? 'dark' : 'light',
  })
  send(response, 200, 'text/html; charset=utf-8', html, reviewHeaders())
}

function startAgentInstallJob(runtime: UiRuntime, agent: AgentName): UiJob {
  const id = randomBytes(8).toString('hex')
  const displayName = AGENT_CATALOG.find((item) => item.name === agent)?.displayName ?? agent
  const job: UiJob = {
    id,
    type: 'agent:install',
    agent,
    status: 'running',
    startedAt: new Date().toISOString(),
    lastOutputAt: new Date().toISOString(),
    lines: [`Preparing to install ${displayName}…`],
    stages: [],
  }
  const append = (output: string): void => {
    const lines = output.split(/\r?\n/).filter(Boolean)
    if (lines.length === 0) return
    appendJobLines(job, lines)
    job.lastOutputAt = new Date().toISOString()
    queueUiJobLog(runtime, job.id, output.endsWith('\n') ? output : `${output}\n`)
    publishJobs(runtime)
  }
  runtime.jobs.set(id, job)
  publishJobs(runtime)
  void installAgent(agent, {
    onChild: (child) => { job.child = child },
    onOutput: append,
  }).then(({ executable }) => {
    if (job.status === 'cancelled') return
    append(`${displayName} installed successfully at ${executable}.`)
    job.exitCode = 0
    job.status = 'succeeded'
  }).catch((error: unknown) => {
    if (job.status === 'cancelled') return
    append(error instanceof Error ? error.message : String(error))
    job.exitCode = 1
    job.status = 'failed'
  }).finally(() => {
    if (!job.finishedAt) job.finishedAt = new Date().toISOString()
    delete job.child
    publishJobs(runtime)
  })
  return job
}

function startCliJob(
  runtime: UiRuntime,
  type: string,
  args: string[],
  cwd: string,
  agent?: AgentName,
  planId?: string,
): UiJob {
  const id = randomBytes(8).toString('hex')
  const retryable = expectedRetryCommand(type) !== undefined
  const job: UiJob = {
    id,
    type,
    ...(agent ? { agent } : {}),
    status: 'running',
    startedAt: new Date().toISOString(),
    lines: [],
    stages: [],
    ...(planId ? { planId } : {}),
    ...(retryable ? { retry: { args: [...args], cwd, ...(agent ? { agent } : {}), ...(planId ? { planId } : {}) } } : {}),
  }
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: { ...process.env, ...remoteCredentialEnvironment(), ...(type === 'preview' && runtime.controlCenterUrl ? { DOXLOOP_CONTROL_CENTER_URL: runtime.controlCenterUrl } : {}) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.child = child
  const append = (chunk: Buffer | string): void => {
    const text = chunk.toString()
    const lines = text.split(/\r?\n/).filter(Boolean)
    appendJobLines(job, lines)
    for (const line of lines) {
      applyWorkflowStageLine(job.stages, line)
      const outcome = parseJobOutcomeLine(line)
      if (outcome) job.outcome = outcome
    }
    job.lastOutputAt = new Date().toISOString()
    queueUiJobLog(runtime, job.id, text)
    publishJobs(runtime)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.once('error', (error) => {
    append(error.message)
    job.status = 'failed'
    finishWorkflowStages(job.stages, 'failed')
    job.finishedAt = new Date().toISOString()
    publishJobs(runtime)
  })
  child.once('exit', (code, signal) => {
    if (job.status === 'cancelled') return
    job.exitCode = code ?? 1
    job.status = code === 0 && !signal ? 'succeeded' : 'failed'
    finishWorkflowStages(job.stages, job.status === 'succeeded' ? 'completed' : 'failed')
    job.finishedAt = new Date().toISOString()
    delete job.child
    publishJobs(runtime)
  })
  runtime.jobs.set(id, job)
  publishJobs(runtime)
  return job
}

/**
 * Ask a CLI job to stop. The CLI forwards the signal to its agent and exits
 * once the agent is gone; if it does not, the job is killed outright so a
 * cancelled run can never keep the workspace busy.
 */
function stopJobChild(child: ChildProcess | undefined): void {
  if (!child) return
  signalTree(child, false, 'SIGTERM')
  const escalation = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) signalTree(child, false, 'SIGKILL')
  }, JOB_STOP_GRACE_MS)
  escalation.unref?.()
}

function publicJob(job: UiJob): Omit<UiJob, 'child' | 'retry'> & { retryable: boolean } {
  const { child: _child, retry, ...rest } = job
  return { ...rest, retryable: Boolean(retry) && job.status !== 'running' }
}

function persistedJob(job: UiJob): Omit<UiJob, 'child'> {
  const { child: _child, ...rest } = job
  return rest
}

function assertNoActiveDocumentationJob(runtime: UiRuntime): void {
  assertNoActiveDocumentationJobs(runtime.jobs.values())
}

export function assertNoActiveDocumentationJobs(jobs: Iterable<Pick<UiJob, 'status' | 'type'>>): void {
  const active = [...jobs].find(
    (job) => job.status === 'running' && (job.type.startsWith('author:') || job.type.startsWith('plan:') || job.type.startsWith('proposal:') || job.type.startsWith('page-edit:')),
  )
  if (active) {
    throw new DoxloopError('A documentation workflow is already in progress. Wait for it to finish or cancel it before starting another.')
  }
}

function requirePlanFirstAuthoring(mode: string): void {
  if (mode !== 'review') {
    throw new DoxloopError('Create and update runs must start from an approved documentation plan in the Doxloop UI.')
  }
}

function projectPreviewIdentity(generator: string, root: string): string | undefined {
  return generator === 'doxbrix' ? resolve(root) : undefined
}

export function previewIdentityMatches(value: unknown, expectedRoot: string): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const root = (value as Record<string, unknown>).root
  return typeof root === 'string' && resolve(root) === resolve(expectedRoot)
}

export async function availableLocalPort(): Promise<number> {
  const probe = createNetServer()
  probe.unref()
  await new Promise<void>((resolveListen, rejectListen) => {
    probe.once('error', rejectListen)
    probe.listen(0, '127.0.0.1', resolveListen)
  })
  const address = probe.address()
  if (!address || typeof address === 'string') {
    await new Promise<void>((resolveClose) => probe.close(() => resolveClose()))
    throw new DoxloopError('Could not allocate a local documentation preview port.')
  }
  await new Promise<void>((resolveClose, rejectClose) => {
    probe.close((error) => error ? rejectClose(error) : resolveClose())
  })
  return address.port
}

async function waitForPreviewServer(url: string, job: UiJob, expectedRoot?: string): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (job.status !== 'running') {
      throw new DoxloopError(job.lines.at(-1) ?? 'The documentation preview failed to start.')
    }
    try {
      const response = await fetch(expectedRoot ? `${url}/__doxloop/identity` : url, { cache: 'no-store' })
      if (expectedRoot) {
        const identity = await response.json().catch(() => undefined)
        if (response.ok && previewIdentityMatches(identity, expectedRoot)) return
      } else {
        await response.body?.cancel()
        if (response.ok) return
      }
    } catch {
      // The preview process may still be binding its local port.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 150))
  }
  job.child?.kill('SIGTERM')
  throw new DoxloopError('The documentation preview did not become ready. Try again.')
}

function streamJobs(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: UiRuntime,
): void {
  response.writeHead(200, {
    ...baseHeaders(),
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
  })
  response.write(jobEvent(runtime))
  runtime.jobSubscribers.add(response)
  const heartbeat = setInterval(() => response.write(': keepalive\n\n'), 20_000)
  heartbeat.unref?.()
  request.once('close', () => {
    clearInterval(heartbeat)
    runtime.jobSubscribers.delete(response)
  })
}

function jobEvent(runtime: UiRuntime): string {
  const jobs = [...runtime.jobs.values()].map(publicJob).reverse()
  return `data: ${JSON.stringify(jobs)}\n\n`
}

/** Subscribers whose socket is full; they get the newest snapshot once it drains. */
const drainingSubscribers = new WeakSet<ServerResponse>()

function broadcastJobs(runtime: UiRuntime): void {
  if (runtime.jobBroadcastTimer) {
    clearTimeout(runtime.jobBroadcastTimer)
    runtime.jobBroadcastTimer = undefined
  }
  const event = jobEvent(runtime)
  for (const response of runtime.jobSubscribers) {
    if (response.destroyed || response.writableEnded) {
      runtime.jobSubscribers.delete(response)
      continue
    }
    // A tab that cannot keep up would otherwise have every snapshot buffered
    // in server memory. Every event is a complete snapshot, so skipping this
    // one and sending the newest after the socket drains loses nothing.
    if (response.writableNeedDrain) {
      if (!drainingSubscribers.has(response)) {
        drainingSubscribers.add(response)
        response.once('drain', () => {
          drainingSubscribers.delete(response)
          if (response.destroyed || response.writableEnded) return
          try {
            response.write(jobEvent(runtime))
          } catch {
            runtime.jobSubscribers.delete(response)
          }
        })
      }
      continue
    }
    try {
      response.write(event)
    } catch {
      runtime.jobSubscribers.delete(response)
    }
  }
}

/**
 * Coalesce job updates. An agent emits hundreds of output chunks per second,
 * and each one used to serialize the full job list for every subscriber.
 */
function scheduleJobBroadcast(runtime: UiRuntime): void {
  if (runtime.jobBroadcastTimer) return
  runtime.jobBroadcastTimer = setTimeout(() => {
    runtime.jobBroadcastTimer = undefined
    broadcastJobs(runtime)
  }, JOB_BROADCAST_INTERVAL_MS)
  runtime.jobBroadcastTimer.unref?.()
}

function trimJobLines(lines: string[]): string[] {
  return lines
    .slice(-MAX_JOB_LINES)
    .map((line) => line.length > MAX_JOB_LINE_LENGTH
      ? `${line.slice(0, MAX_JOB_LINE_LENGTH)}… [line truncated; open the full log]`
      : line)
}

function appendJobLines(job: UiJob, lines: string[]): void {
  job.lines.push(...trimJobLines(lines))
  if (job.lines.length > MAX_JOB_LINES) job.lines.splice(0, job.lines.length - MAX_JOB_LINES)
}

function publishJobs(runtime: UiRuntime): void {
  scheduleJobBroadcast(runtime)
  if (!runtime.root) return
  if (runtime.jobPersistTimer) clearTimeout(runtime.jobPersistTimer)
  runtime.jobPersistTimer = setTimeout(() => {
    runtime.jobPersistTimer = undefined
    void queueUiJobPersistence(runtime)
  }, 100)
  runtime.jobPersistTimer.unref?.()
}

function queueUiJobPersistence(runtime: UiRuntime): Promise<void> {
  runtime.jobPersistQueue = runtime.jobPersistQueue
    .then(() => persistUiJobs(runtime), () => persistUiJobs(runtime))
    .catch(() => undefined)
  return runtime.jobPersistQueue
}

function queueUiJobLog(runtime: UiRuntime, id: string, text: string): void {
  if (!runtime.root || !text) return
  const previous = runtime.jobLogQueues.get(id) ?? Promise.resolve()
  const next = previous
    .then(async () => {
      const directory = join(runtime.root!, UI_JOB_LOG_DIRECTORY)
      await mkdir(directory, { recursive: true, mode: 0o700 })
      await appendFile(join(directory, `${id}.log`), text, { encoding: 'utf8', mode: 0o600 })
    })
    .catch(() => undefined)
  runtime.jobLogQueues.set(id, next)
  void next.then(() => {
    if (runtime.jobLogQueues.get(id) === next) runtime.jobLogQueues.delete(id)
  })
}

async function flushUiJobLogs(runtime: UiRuntime): Promise<void> {
  await Promise.all([...runtime.jobLogQueues.values()])
}

async function flushUiJobs(runtime: UiRuntime): Promise<void> {
  if (runtime.jobPersistTimer) {
    clearTimeout(runtime.jobPersistTimer)
    runtime.jobPersistTimer = undefined
  }
  await queueUiJobPersistence(runtime)
}

async function persistUiJobs(runtime: UiRuntime): Promise<void> {
  if (!runtime.root) return
  await ensureGitignoreEntries(runtime.root, [UI_JOBS_FILE, `${UI_JOB_LOG_DIRECTORY}/`])
  const path = join(runtime.root, UI_JOBS_FILE)
  const temporary = `${path}.${process.pid}.tmp`
  const jobs = [...runtime.jobs.values()]
    .slice(-MAX_PERSISTED_JOBS)
    .map(persistedJob)
  await mkdir(join(runtime.root, '.doxloop'), { recursive: true, mode: 0o700 })
  await writeFile(
    temporary,
    `${JSON.stringify({ schemaVersion: 1, jobs }, null, 2)}\n`,
    { encoding: 'utf8', mode: 0o600 },
  )
  await rename(temporary, path)
}

async function loadUiJobs(root: string): Promise<Map<string, UiJob>> {
  const raw = await readOptionalJson(join(root, UI_JOBS_FILE))
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return new Map()
  const record = raw as Record<string, unknown>
  if (record.schemaVersion !== 1 || !Array.isArray(record.jobs)) return new Map()
  const jobs = record.jobs
    .map((job) => parsePersistedUiJob(job, root))
    .filter((job): job is UiJob => job !== undefined)
    .slice(-MAX_PERSISTED_JOBS)
  return new Map(jobs.map((job) => [job.id, job]))
}

function parsePersistedUiJob(raw: unknown, root: string): UiJob | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const job = raw as Record<string, unknown>
  const statuses: UiJob['status'][] = ['running', 'succeeded', 'failed', 'cancelled']
  if (
    typeof job.id !== 'string' ||
    !/^[a-f0-9]+$/.test(job.id) ||
    typeof job.type !== 'string' ||
    !statuses.includes(job.status as UiJob['status']) ||
    typeof job.startedAt !== 'string' ||
    !Array.isArray(job.lines)
  ) return undefined
  const lines = trimJobLines(job.lines.filter((line): line is string => typeof line === 'string'))
  const retry = job.retry && typeof job.retry === 'object' && !Array.isArray(job.retry)
    ? parseRetry(job.retry as Record<string, unknown>, root, job.type)
    : undefined
  return {
    id: job.id,
    type: job.type,
    ...(job.agent === 'codex' || job.agent === 'claude' || job.agent === 'gemini'
      ? { agent: job.agent }
      : {}),
    status: job.status as UiJob['status'],
    startedAt: job.startedAt,
    ...(typeof job.lastOutputAt === 'string' ? { lastOutputAt: job.lastOutputAt } : {}),
    ...(typeof job.finishedAt === 'string' ? { finishedAt: job.finishedAt } : {}),
    ...(typeof job.exitCode === 'number' ? { exitCode: job.exitCode } : {}),
    ...(typeof job.planId === 'string' && /^plan-[a-z0-9-]+$/.test(job.planId) ? { planId: job.planId } : {}),
    ...(retry ? { retry } : {}),
    ...(job.recovered === true ? { recovered: true } : {}),
    ...(parseJobOutcome(job.outcome) ? { outcome: parseJobOutcome(job.outcome)! } : {}),
    lines,
    stages: Array.isArray(job.stages) ? job.stages.flatMap((stage) => parseWorkflowStage(stage) ?? []) : [],
  }
}

function parseRetry(value: Record<string, unknown>, root: string, type: string): NonNullable<UiJob['retry']> | undefined {
  if (!Array.isArray(value.args) || typeof value.cwd !== 'string') return undefined
  const args = (value.args as unknown[]).filter((item): item is string => typeof item === 'string').slice(0, 100)
  if (args.length !== value.args.length) return undefined
  const expected = expectedRetryCommand(type)
  if (!expected || args[0] !== expected) return undefined
  const cwd = resolve(value.cwd)
  if (!containedBy(root, cwd)) return undefined
  const cwdIndex = args.lastIndexOf('--cwd')
  if (cwdIndex < 0 || !args[cwdIndex + 1] || !containedBy(root, resolve(cwd, args[cwdIndex + 1]!))) return undefined
  return { args, cwd, ...(value.agent === 'codex' || value.agent === 'claude' || value.agent === 'gemini' ? { agent: value.agent } : {}), ...(typeof value.planId === 'string' ? { planId: value.planId } : {}) }
}

function expectedRetryCommand(type: string): string | undefined {
  if (type.startsWith('plan:')) return 'plan'
  if (type.startsWith('proposal:revise:') || type.startsWith('proposal:resume:')) return 'proposal'
  if (type.startsWith('page-edit:')) return 'pages'
  if (type === 'author:review') return 'review'
  return ['sync', 'capture', 'generator', 'deploy', 'deploy:dry-run', 'export'].includes(type) ? type.split(':')[0] : undefined
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel !== '..' && !rel.startsWith(`..${sep}`)
}

export function uiErrorStatus(error: unknown): number {
  return error instanceof DoxloopError ? (error.exitCode === 2 ? 400 : 409) : 500
}

/** The release-notes template a plan request carries, validated as a bad request. */
export function releaseTemplateFromBody(raw: unknown): ReleaseTemplateInput | undefined {
  if (raw === undefined || raw === null) return undefined
  const body = recordBody(raw)
  if (body.kind !== 'release-notes') throw new DoxloopError('Only the release-notes template is available.', 2)
  const version = optionalString(body.version)
  const from = optionalString(body.from)
  const to = optionalString(body.to)
  if (!version) throw new DoxloopError('Release notes need a version label, such as v0.2.0.', 2)
  if (!from || !to) throw new DoxloopError('Release notes need the starting and ending Git refs.', 2)
  const sources = stringArray(body.sources).map((name) => name.trim()).filter(Boolean)
  return { version, from, to, ...(sources.length ? { sources } : {}) }
}

export function pageEditJobSpec(
  root: string,
  project: DoxloopProject,
  runId: string,
  rawBody: unknown,
): { type: string; args: string[]; paths: string[]; allowRelated: boolean; agent?: AgentName } {
  const body = recordBody(rawBody)
  const paths = [...new Set(stringArray(body.paths).map((path) => path.trim()).filter(Boolean))]
  const instruction = optionalString(body.instruction)?.trim() ?? ''
  if (instruction.length < 8) throw new DoxloopError('Describe what should change.', 2)
  if (paths.length < 1 || paths.length > 10) throw new DoxloopError('Select between 1 and 10 pages to edit.', 2)
  const requestedAgent = parseAgent(optionalString(body.agent))
  const effectiveAgent = requestedAgent ?? project.defaultAgent
  const screenshots = optionalString(body.screenshots) ?? 'disabled'
  if (screenshots !== 'enabled' && screenshots !== 'disabled') throw new DoxloopError('Screenshots must be enabled or disabled.', 2)
  const args = ['pages', 'edit', '--run-id', runId, '--request', instruction]
  for (const path of paths) args.push('--path', path)
  if (body.allowRelated === true) args.push('--allow-related')
  if (screenshots === 'enabled') args.push('--screenshots')
  appendOption(args, 'agent', requestedAgent)
  appendOption(args, 'model', optionalString(body.model))
  if (effectiveAgent === 'codex') appendOption(args, 'reasoning', parseReasoning(optionalString(body.reasoning)))
  if (effectiveAgent === 'claude') appendOption(args, 'effort', parseClaudeEffort(optionalString(body.effort)))
  args.push('--cwd', root)
  return {
    type: `page-edit:${runId}`,
    args,
    paths,
    allowRelated: body.allowRelated === true,
    ...(effectiveAgent ? { agent: effectiveAgent } : {}),
  }
}

export function pageRefineJobSpec(root: string, run: SyncRun, rawBody: unknown): { type: string; args: string[] } {
  if (!run.editRequest) throw new DoxloopError('Only a page edit can be refined from the Pages view.', 2)
  const instruction = optionalString(recordBody(rawBody).instruction)?.trim() ?? ''
  if (instruction.length < 8) throw new DoxloopError('Describe what should be different.', 2)
  const args = ['proposal', 'revise', '--id', run.id, '--request', instruction]
  for (const change of run.changes.filter((change) => change.category === 'page')) args.push('--change', change.id)
  args.push('--cwd', root)
  return { type: `proposal:revise:${run.id}`, args }
}

async function optionalProjectRoot(cwd: string): Promise<string | undefined> {
  try {
    return await findProjectRoot(resolve(cwd))
  } catch {
    return undefined
  }
}

/** History pages are read on demand, so the page size stays small and bounded. */
function historyLimit(raw: string | null): number {
  // `Number(null)` and `Number('')` are both 0, so an absent parameter has to be
  // rejected before the numeric check or it would clamp the page down to 1 row.
  if (raw === null || raw.trim() === '') return 20
  const parsed = Number(raw)
  if (!Number.isFinite(parsed)) return 20
  return Math.min(200, Math.max(1, Math.trunc(parsed)))
}

function requireProject(runtime: UiRuntime): string {
  if (!runtime.root) throw new DoxloopError('Create or open a Doxloop project first.')
  return runtime.root
}

async function readJsonBody(request: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > limit) throw new DoxloopError('The UI request is too large.')
    chunks.push(value)
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as unknown
  } catch {
    throw new DoxloopError('The UI request is not valid JSON.')
  }
}

async function serveStatic(response: ServerResponse, root: string, relativePath: string, html: boolean): Promise<void> {
  const path = resolve(root, relativePath.replace(/^ui\//, ''))
  if (path !== root && !path.startsWith(`${root}${sep}`)) throw new DoxloopError('Invalid UI asset path.')
  await serveFile(response, path, html)
}

async function serveFile(response: ServerResponse, path: string, html: boolean): Promise<void> {
  await access(path)
  const type = html ? 'text/html; charset=utf-8' : mimeType(path)
  send(response, 200, type, await readFile(path), html ? appHeaders() : staticHeaders())
}

function requireLocalHost(request: IncomingMessage, port: number): void {
  const host = request.headers.host?.toLowerCase()
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`])
  if (!host || !allowed.has(host)) throw new DoxloopError('Invalid local UI host.')
}

export function uiSessionCookieName(port: number): string {
  return `doxloop_ui_${port}`
}

function requireSession(request: IncomingMessage, session: string, port: number): void {
  const cookie = request.headers.cookie ?? ''
  const expected = `${uiSessionCookieName(port)}=${session}`
  const valid = cookie.split(';').some((entry) => entry.trim() === expected)
  if (!valid) throw new DoxloopError('Invalid local UI session. Reload the Doxloop UI.')
}

function requireSameOrigin(request: IncomingMessage, port: number): void {
  const origin = request.headers.origin
  if (origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
    throw new DoxloopError('Invalid local UI origin.')
  }
}

function appHeaders(): Record<string, string> {
  return {
    ...baseHeaders(),
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src 'self' http://127.0.0.1:*; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  }
}

function reviewHeaders(): Record<string, string> {
  return { ...baseHeaders(), 'X-Frame-Options': 'SAMEORIGIN', 'Content-Security-Policy': "default-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'" }
}

function staticHeaders(): Record<string, string> {
  return { ...baseHeaders(), 'Cache-Control': 'no-cache' }
}

function baseHeaders(): Record<string, string> {
  return {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
  }
}

interface RunCapture {
  run: string
  file: string
  url: string
  guide?: string
  step?: string
  alt?: string
  status?: string
  /** First file with identical bytes, so the reviewer can spot faked states. */
  duplicateOf?: string
}

/**
 * List the PNGs a run has captured. The manifest supplies the reviewable
 * metadata, but images are also listed before the manifest exists so a live run
 * shows its captures as they land.
 */
async function listRunCaptures(root: string, requested?: string): Promise<RunCapture[]> {
  const runs = await listSyncRuns(root)
  const target = requested
    ? runs.find((run) => run.id === requested)
    : runs.find((run) => Boolean(run.id))
  if (!target) return []
  const workspace = runWorkspace(root, target.id)
  if (!(await pathExists(workspace))) return []

  const described = new Map<string, RunCapture>()
  try {
    const manifest = JSON.parse(
      await readFile(join(workspace, '.doxloop', 'screenshot-manifest.json'), 'utf8'),
    ) as { guides?: Array<{ page?: string; steps?: Array<Record<string, unknown>> }> }
    for (const guide of manifest.guides ?? []) {
      for (const step of guide.steps ?? []) {
        const file = typeof step.file === 'string' ? step.file : undefined
        if (!file) continue
        described.set(file, {
          run: target.id,
          file,
          url: `/api/captures/file?run=${encodeURIComponent(target.id)}&path=${encodeURIComponent(file)}`,
          ...(guide.page ? { guide: guide.page } : {}),
          ...(typeof step.id === 'string' ? { step: step.id } : {}),
          ...(typeof step.alt === 'string' ? { alt: step.alt } : {}),
          ...(typeof step.status === 'string' ? { status: step.status } : {}),
        })
      }
    }
  } catch {
    // A run that has not written its manifest yet still shows its images.
  }
  for (const file of await guideImageFiles(workspace)) {
    if (described.has(file)) continue
    described.set(file, {
      run: target.id,
      file,
      url: `/api/captures/file?run=${encodeURIComponent(target.id)}&path=${encodeURIComponent(file)}`,
    })
  }

  const seen = new Map<string, string>()
  const captures: RunCapture[] = []
  for (const capture of [...described.values()].sort((left, right) => left.file.localeCompare(right.file))) {
    const image = join(workspace, capture.file)
    if (!(await pathExists(image))) continue
    const digest = createHash('sha256').update(await readFile(image)).digest('hex')
    const original = seen.get(digest)
    if (original) capture.duplicateOf = original
    else seen.set(digest, capture.file)
    captures.push(capture)
  }
  return captures
}

/** Project-relative PNGs under any guide asset directory. */
async function guideImageFiles(workspace: string): Promise<string[]> {
  const files: string[] = []
  const stack = ['']
  while (stack.length > 0 && files.length < 500) {
    const relativeDirectory = stack.pop()!
    let entries
    try {
      entries = await readdir(join(workspace, relativeDirectory), { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const child = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        if (!['.doxloop', '.git', 'node_modules'].includes(entry.name)) stack.push(child)
      } else if (/\.png$/i.test(entry.name) && child.includes('guides/')) {
        files.push(child)
      }
    }
  }
  return files
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  send(response, status, 'application/json; charset=utf-8', JSON.stringify(value), baseHeaders())
}

function send(response: ServerResponse, status: number, type: string, body: string | Buffer, headers: Record<string, string>): void {
  if (response.headersSent) return
  response.writeHead(status, { 'Content-Type': type, ...headers })
  response.end(body)
}

function mimeType(path: string): string {
  switch (extname(path)) {
    case '.js': return 'text/javascript; charset=utf-8'
    case '.css': return 'text/css; charset=utf-8'
    case '.svg': return 'image/svg+xml'
    case '.png': return 'image/png'
    case '.map': return 'application/json; charset=utf-8'
    default: return 'application/octet-stream'
  }
}

/** The URL segment to open. Older page names still work and land on the renamed page. */
export function normalizeInitialPage(value: string | undefined): string {
  const page = value ?? 'overview'
  const legacy: Record<string, string> = { authoring: 'update', proposals: 'review', publish: 'deploy' }
  const allowed = new Set(['overview', 'sources', 'update', 'pages', 'review', 'deploy', 'settings'])
  const resolved = legacy[page] ?? page
  if (!allowed.has(resolved)) throw new DoxloopError(`Unknown UI page "${page}".`)
  return resolved
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

async function chooseLocalDirectory(prompt: string): Promise<string | undefined> {
  // Prompts are fixed strings chosen by the server, never request input.
  const picker = process.platform === 'darwin'
    ? { command: 'osascript', args: ['-e', `POSIX path of (choose folder with prompt "${prompt}")`] }
    : process.platform === 'win32'
      ? {
          command: 'powershell.exe',
          args: ['-NoProfile', '-STA', '-Command', `Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "${prompt}"; if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picker.SelectedPath }`],
        }
      : { command: 'zenity', args: ['--file-selection', '--directory', `--title=${prompt}`] }

  return new Promise<string | undefined>((resolvePicker, rejectPicker) => {
    const child = spawn(picker.command, picker.args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    let detail = ''
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8') })
    child.stderr.on('data', (chunk: Buffer) => { detail += chunk.toString('utf8') })
    child.once('error', (error) => rejectPicker(new DoxloopError(`Could not open the directory picker: ${error.message}`)))
    child.once('exit', (code) => {
      if (code === 0) {
        const selected = output.trim()
        resolvePicker(selected ? resolve(selected) : undefined)
        return
      }
      if (code === 1 || detail.toLowerCase().includes('cancel')) {
        resolvePicker(undefined)
        return
      }
      rejectPicker(new DoxloopError(`The directory picker failed${detail.trim() ? `: ${detail.trim()}` : ` with exit code ${code ?? 1}`}.`))
    })
  })
}

function appendOption(args: string[], name: string, value: string | undefined): void {
  if (value) args.push(`--${name}`, value)
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DoxloopError('Expected an object.')
  return value as Record<string, unknown>
}

function sourceIdentifier(label: string): string {
  const identifier = label.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '')
  return identifier || 'source'
}

function rawText(value: unknown): string {
  if (typeof value !== 'string') throw new DoxloopError('Page content must be text.')
  return value
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new DoxloopError('A required value is missing.')
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new DoxloopError('Expected a list of text values.')
  return value.map((entry) => entry.trim()).filter(Boolean)
}

function stringRecord(value: unknown): Record<string, string> {
  const record = recordBody(value)
  const output: Record<string, string> = {}
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== 'string') throw new DoxloopError('Terminology values must be text.')
    if (key.trim() && entry.trim()) output[key.trim()] = entry.trim()
  }
  return output
}

function optionalPositiveNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1) throw new DoxloopError('Budget values must be positive integers.')
  return number
}

function optionalPositiveAmount(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const number = Number(value)
  if (!Number.isFinite(number) || number <= 0 || number > 100_000) throw new DoxloopError('The spending cap must be a positive amount in US dollars.')
  return Math.round(number * 100) / 100
}

function optionalViewportNumber(value: unknown, key: 'width' | 'height', maximum: number): number | undefined {
  if (value === undefined || value === null) return undefined
  const record = recordBody(value)
  const raw = record[key]
  if (raw === undefined || raw === null || raw === '') return undefined
  const number = Number(raw)
  if (!Number.isInteger(number) || number < 320 || number > maximum) {
    throw new DoxloopError(`Screenshot viewport ${key} must be an integer between 320 and ${maximum}.`)
  }
  return number
}

function portableRelative(from: string, to: string): string {
  return relative(from, to).split(sep).join('/')
}

async function safe<T>(run: () => Promise<T>): Promise<T | { error: string }> {
  try {
    return await run()
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) }
  }
}

function isFailure(value: unknown): value is { error: string } {
  return Boolean(value && typeof value === 'object' && 'error' in value)
}

async function readOptionalJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown
  } catch {
    return null
  }
}
