import { createHash, randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, appendFile, mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
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
import { applyWorkflowStageLine, finishWorkflowStages, parseWorkflowStage, type WorkflowStage } from './job-events.js'
import { createProposalBranch, publishProposalBranch } from './git-delivery.js'
import { addGenerator } from './generator-manager.js'
import {
  backfillHistory,
  listDeployments,
  listRequests,
  pageHistory,
  requestPages,
} from './history.js'
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
import { effectiveDeployment } from './settings.js'
import { assertScreenshotPlanningReadiness, checkApplicationReadiness, normalizeScreenshotIntent } from './screenshot-workflow.js'
import { checkScreenCaptureBrowser } from './screen-capture-provider.js'
import { discoverDocumentationSources } from './source-discovery.js'
import { buildSourceIntelligence } from './source-intelligence.js'
import { resolveCoverageItem, type CoverageResolutionAction } from './coverage-actions.js'
import { connectorForSource } from './source-connectors.js'
import { assertInside, ensureGitignoreEntries, pathExists } from './fs.js'
import { loadOpenApiSource, parseOpenApi } from './openapi.js'
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
  editSyncRunChange,
  listSyncRuns,
  pruneSyncRuns,
  readSyncRun,
  recoverSyncRun,
  runWorkspace,
  readSyncRunChangeContent,
  rejectSyncRun,
  undoSyncRun,
} from './sync-runs.js'
import {
  requireSyncReviewChange,
  syncReviewComparisonDocument,
  syncReviewSelectionsFromBody,
  syncReviewSourceDiff,
} from './sync-review.js'
import type {
  AgentName,
  ApplicationConfig,
  DeploymentConfig,
  DocumentationBrief,
  DoxloopProject,
  RemoteSource,
  SourceBinding,
  SyncConfig,
} from './types.js'
import { validateProject } from './validation.js'

export interface UiServerOptions {
  cwd: string
  host?: string
  port?: number
  open?: boolean
  page?: string
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
}

interface UiRuntime {
  cwd: string
  root?: string | undefined
  jobs: Map<string, UiJob>
  previewJobId?: string | undefined
  proposalPreviewJobId?: string | undefined
  proposalPreviewRunId?: string | undefined
  jobSubscribers: Set<ServerResponse>
  jobBroadcastTimer?: ReturnType<typeof setTimeout> | undefined
  jobPersistTimer?: ReturnType<typeof setTimeout> | undefined
  jobPersistQueue: Promise<void>
  jobLogQueues: Map<string, Promise<void>>
}

const UI_ROOT = resolve(fileURLToPath(new URL('./ui', import.meta.url)))
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url))
const DOXBRIX_CSS = resolve(PACKAGE_ROOT, 'assets', 'doxbrix-preview.css')
const MAX_BODY_BYTES = 1_000_000
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

export async function startUiServer(options: UiServerOptions): Promise<void> {
  const host = options.host ?? '127.0.0.1'
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new DoxloopError('The Doxloop UI is local-only and must bind to 127.0.0.1.')
  }
  const port = options.port ?? 4317
  const page = normalizeInitialPage(options.page)
  const root = await optionalProjectRoot(options.cwd)
  const jobs = root ? await loadUiJobs(root) : new Map<string, UiJob>()
  let recoveredJobs = false
  for (const job of jobs.values()) {
    if (job.status !== 'running') continue
    job.status = 'failed'
    job.finishedAt = new Date().toISOString()
    job.recovered = true
    job.lines.push('The previous Doxloop UI server stopped before this run completed. Partial logs were preserved and this stage can be retried safely.')
    recoveredJobs = true
  }
  const runtime: UiRuntime = {
    cwd: resolve(options.cwd),
    root,
    jobs,
    jobSubscribers: new Set(),
    jobPersistQueue: Promise.resolve(),
    jobLogQueues: new Map(),
  }
  if (recoveredJobs) await persistUiJobs(runtime)
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
      job.child?.kill('SIGTERM')
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
    const status = error instanceof DoxloopError ? 409 : 500
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
    sendJson(response, 200, { path: await chooseLocalDirectory() ?? null })
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
      job.child?.kill('SIGTERM')
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
    const project = await loadProject(requireProject(runtime))
    sendJson(response, 200, await checkApplicationReadiness(project.application))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/application/readiness') {
    const project = await loadProject(requireProject(runtime))
    const application = applicationFromBody(await readJsonBody(request), project)
    sendJson(response, 200, await checkApplicationReadiness(application))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/setup/application/readiness') {
    const application = applicationFromBody(await readJsonBody(request))
    sendJson(response, 200, await checkApplicationReadiness(application))
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
    const requestedAgent = parseAgent(optionalString(body.agent))
    const clarificationMode = optionalString(body.clarificationMode) ?? 'review'
    if (!['review', 'defaults', 'stop'].includes(clarificationMode)) throw new DoxloopError('Clarification mode must be review, defaults, or stop.')
    const screenshotIntent = normalizeScreenshotIntent(body.screenshots)
    await assertScreenshotPlanningReadiness(project.application, screenshotIntent)
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
      ...(optionalString(body.request) ? { request: optionalString(body.request)! } : {}),
      clarificationMode: clarificationMode as 'review' | 'defaults' | 'stop',
      execution: {
        ...(requestedAgent ?? project.defaultAgent ? { agent: (requestedAgent ?? project.defaultAgent)! } : {}),
        ...(optionalString(body.model) ? { model: optionalString(body.model)! } : {}),
        ...(optionalString(body.reasoning) ? { reasoning: parseReasoning(optionalString(body.reasoning))! } : {}),
        ...(optionalString(body.effort) ? { effort: parseClaudeEffort(optionalString(body.effort))! } : {}),
        screenshots: screenshotIntent,
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
    const run = await readSyncRun(root, proposalPreview[1]!)
    const existing = runtime.proposalPreviewJobId
      ? runtime.jobs.get(runtime.proposalPreviewJobId)
      : undefined
    if (existing?.status === 'running' && runtime.proposalPreviewRunId === run.id) {
      await waitForPreviewServer('http://127.0.0.1:4322', existing)
      if (open) openBrowser('http://127.0.0.1:4322')
      sendJson(response, 200, { job: publicJob(existing), url: 'http://127.0.0.1:4322' })
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
    const args = ['preview', '--host', '127.0.0.1', '--port', '4322', '--cwd', workspace]
    const job = startCliJob(runtime, `proposal-preview:${run.id}`, args, workspace)
    runtime.proposalPreviewJobId = job.id
    runtime.proposalPreviewRunId = run.id
    await waitForPreviewServer('http://127.0.0.1:4322', job)
    if (open) openBrowser('http://127.0.0.1:4322')
    sendJson(response, 202, { job: publicJob(job), url: 'http://127.0.0.1:4322' })
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
    const disposition = body.evidenceDisposition === 'needs-review' ? 'needs-review' : 'preserved'
    sendJson(response, 200, await editSyncRunChange(
      requireProject(runtime),
      proposalContent[1]!,
      proposalContent[2]!,
      stringValue(body.content),
      disposition,
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
  const proposalDecision = /^\/api\/proposals\/([a-z0-9-]+)\/(accept|reject)$/.exec(url.pathname)
  if (request.method === 'POST' && proposalDecision) {
    const root = requireProject(runtime)
    if (proposalDecision[2] === 'reject') {
      sendJson(response, 200, await rejectSyncRun(root, proposalDecision[1]!))
      return
    }
    const run = await readSyncRun(root, proposalDecision[1]!)
    const selections = syncReviewSelectionsFromBody(run, await readJsonBody(request))
    const result = await acceptSyncChanges(root, run.id, selections)
    if (result.status === 'applied') await clearPendingSourceChangesInReceipt(root)
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
    if (runtime.previewJobId) {
      const existing = runtime.jobs.get(runtime.previewJobId)
      if (existing?.status === 'running') {
        await waitForPreviewServer('http://127.0.0.1:4321', existing)
        if (open) openBrowser('http://127.0.0.1:4321')
        sendJson(response, 200, publicJob(existing))
        return
      }
    }
    const root = requireProject(runtime)
    const args = ['preview', '--host', '127.0.0.1', '--port', '4321', '--cwd', root]
    if (open) args.push('--open')
    const job = startCliJob(runtime, 'preview', args, root)
    runtime.previewJobId = job.id
    await waitForPreviewServer('http://127.0.0.1:4321', job)
    sendJson(response, 202, publicJob(job))
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
    sendJson(response, 202, publicJob(startCliJob(runtime, body.dryRun === true ? 'deploy:dry-run' : 'deploy', args, root)))
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
    }
  }
  const project = await loadProject(root)
  const [validation, doctor, runs, syncStatus, drift, agents, account, receipt] = await Promise.all([
    safe(() => validateProject(root)),
    safe(() => runDoctor({ cwd: root })),
    safe(() => listSyncRuns(root)),
    safe(() => formatSyncStatus(root, project)),
    safe(() => computeConfiguredDrift(root, project)),
    agentState(root, project.defaultAgent),
    accountState(project),
    readOptionalJson(join(root, '.doxloop', 'last-run.json')),
  ])
  return {
    projectFound: true,
    cwd: runtime.cwd,
    root,
    project,
    effectiveDeployment: effectiveDeployment(project),
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
    preview: {
      running: runtime.previewJobId
        ? runtime.jobs.get(runtime.previewJobId)?.status === 'running'
        : false,
      url: 'http://127.0.0.1:4321',
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
    const destination = project.deployment?.apiUrl ?? config.apiUrl
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
  if (runtime.root) throw new DoxloopError('A Doxloop project is already open.')
  const body = recordBody(raw)
  const title = optionalString(body.title)
  const generator = parseGenerator(optionalString(body.generator)) ?? 'doxbrix'
  const application = body.application !== undefined ? applicationFromBody(body.application) : undefined
  const root = resolveUiDocumentationDirectory(runtime.cwd, stringValue(body.directory))
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
  runtime.root = root
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
      root = resolveUiDocumentationDirectory(runtime.cwd, directory)
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
  const budget = maxRunsPerDay || maxMinutes ? { ...(maxRunsPerDay ? { maxRunsPerDay } : {}), ...(maxMinutes ? { maxMinutes } : {}) } : undefined
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
  return {
    baseUrl: parsed.toString().replace(/\/$/, ''),
    ...(source ? { source } : {}),
    ...(startCommand ? { startCommand } : {}),
    ...(readyPath ? { readyPath } : {}),
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
    ...(optionalString(body.name) ? { name: optionalString(body.name)! } : {}),
    ...(optionalString(body.slug) ? { slug: optionalString(body.slug)! } : {}),
    ...(validVisibility ? { visibility: validVisibility } : {}),
    ...(validApiUrl ? { apiUrl: validApiUrl } : {}),
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
    env: { ...process.env, ...remoteCredentialEnvironment() },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.child = child
  const append = (chunk: Buffer | string): void => {
    const text = chunk.toString()
    const lines = text.split(/\r?\n/).filter(Boolean)
    appendJobLines(job, lines)
    for (const line of lines) applyWorkflowStageLine(job.stages, line)
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

function publicJob(job: UiJob): Omit<UiJob, 'child' | 'retry'> & { retryable: boolean } {
  const { child: _child, retry, ...rest } = job
  return { ...rest, retryable: Boolean(retry) && job.status !== 'running' }
}

function persistedJob(job: UiJob): Omit<UiJob, 'child'> {
  const { child: _child, ...rest } = job
  return rest
}

function assertNoActiveDocumentationJob(runtime: UiRuntime): void {
  const active = [...runtime.jobs.values()].find(
    (job) => job.status === 'running' && (job.type.startsWith('author:') || job.type.startsWith('plan:') || job.type.startsWith('proposal:')),
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

async function waitForPreviewServer(url: string, job: UiJob): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (job.status !== 'running') {
      throw new DoxloopError(job.lines.at(-1) ?? 'The documentation preview failed to start.')
    }
    try {
      const response = await fetch(url, { cache: 'no-store' })
      await response.body?.cancel()
      if (response.ok) return
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
  if (type === 'author:review') return 'review'
  return ['sync', 'capture', 'generator', 'deploy', 'deploy:dry-run'].includes(type) ? type.split(':')[0] : undefined
}

function containedBy(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel !== '..' && !rel.startsWith(`..${sep}`)
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

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += value.length
    if (size > MAX_BODY_BYTES) throw new DoxloopError('The UI request is too large.')
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
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-src 'self' http://127.0.0.1:4321; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

export function normalizeInitialPage(value: string | undefined): string {
  const page = value ?? 'overview'
  const allowed = new Set(['overview', 'sources', 'authoring', 'proposals', 'publish', 'settings'])
  if (!allowed.has(page)) throw new DoxloopError(`Unknown UI page "${page}".`)
  return page
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

async function chooseLocalDirectory(): Promise<string | undefined> {
  const picker = process.platform === 'darwin'
    ? { command: 'osascript', args: ['-e', 'POSIX path of (choose folder with prompt "Choose product source directory")'] }
    : process.platform === 'win32'
      ? {
          command: 'powershell.exe',
          args: ['-NoProfile', '-STA', '-Command', 'Add-Type -AssemblyName System.Windows.Forms; $picker = New-Object System.Windows.Forms.FolderBrowserDialog; $picker.Description = "Choose product source directory"; if ($picker.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picker.SelectedPath }'],
        }
      : { command: 'zenity', args: ['--file-selection', '--directory', '--title=Choose product source directory'] }

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
