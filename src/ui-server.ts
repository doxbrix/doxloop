import { randomBytes } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import { access, appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installAgent, installSkill, parseAgent, skillStatus, detectAgents, agentAuthenticationStatus } from './agents.js'
import { applySyncConfig, computeConfiguredDrift, disableSync, formatSyncStatus, parseSyncMode, parseTriggerList } from './autosync.js'
import { authenticatedRequest, loadUserConfig, logout } from './auth.js'
import { DoxloopError } from './errors.js'
import { addGenerator } from './generator-manager.js'
import { installedGeneratorEntries, parseGenerator } from './generators.js'
import { runDoctor } from './doctor.js'
import {
  assertNewProjectDirectory,
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
import { testRemoteSource } from './remote-monitor.js'
import {
  acceptSyncChanges,
  listSyncRuns,
  readSyncRun,
  rejectSyncRun,
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
  child?: ChildProcess | undefined
}

interface UiRuntime {
  cwd: string
  root?: string | undefined
  jobs: Map<string, UiJob>
  previewJobId?: string | undefined
  jobSubscribers: Set<ServerResponse>
  jobPersistTimer?: ReturnType<typeof setTimeout> | undefined
  jobPersistQueue: Promise<void>
  jobLogQueues: Map<string, Promise<void>>
}

const UI_ROOT = resolve(fileURLToPath(new URL('./ui', import.meta.url)))
const PACKAGE_ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)))
const CLI_PATH = fileURLToPath(new URL('./cli.js', import.meta.url))
const DOXBRIX_CSS = resolve(PACKAGE_ROOT, 'assets', 'doxbrix-preview.css')
const MAX_BODY_BYTES = 1_000_000
const MAX_JOB_LINES = 800
const MAX_PERSISTED_JOBS = 50
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
    job.lines.push('The previous Doxloop UI server stopped before this run completed. Partial logs were preserved; start the documentation update again.')
    if (job.lines.length > MAX_JOB_LINES) job.lines.splice(0, job.lines.length - MAX_JOB_LINES)
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
  const url = `http://${host}:${port}${page === 'home' ? '/' : `/${page}`}`
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
      requireSession(request, session)
      if (request.method !== 'GET') requireSameOrigin(request, port)
      await handleApi(request, response, url, runtime)
      return
    }
    if (url.pathname.startsWith('/review-preview/')) {
      requireSession(request, session)
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
    response.setHeader('Set-Cookie', `doxloop_ui=${session}; HttpOnly; SameSite=Strict; Path=/`)
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
  const jobAction = /^\/api\/jobs\/([a-f0-9]+)\/(cancel)$/.exec(url.pathname)
  if (request.method === 'POST' && jobAction) {
    const job = runtime.jobs.get(jobAction[1]!)
    if (!job) throw new DoxloopError('The requested job does not exist.')
    if (job.status === 'running') {
      job.status = 'cancelled'
      job.finishedAt = new Date().toISOString()
      job.lines.push('The run was cancelled from the Doxloop UI.')
      if (job.lines.length > MAX_JOB_LINES) job.lines.splice(0, job.lines.length - MAX_JOB_LINES)
      queueUiJobLog(runtime, job.id, '\nThe run was cancelled from the Doxloop UI.\n')
      job.child?.kill('SIGTERM')
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
    const project = await loadProject(requireProject(runtime))
    const source = project.sources.find((item) => item.name === decodeURIComponent(sourceTest[1]!))
    if (!source?.remote) throw new DoxloopError('Save a remote GitHub connection before testing it.')
    sendJson(response, 200, await testRemoteSource(source.remote))
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
  if (request.method === 'GET' && url.pathname === '/api/proposals') {
    sendJson(response, 200, await listSyncRuns(requireProject(runtime)))
    return
  }
  const proposal = /^\/api\/proposals\/([a-z0-9-]+)$/.exec(url.pathname)
  if (request.method === 'GET' && proposal) {
    sendJson(response, 200, await readSyncRun(requireProject(runtime), proposal[1]!))
    return
  }
  const proposalDiff = /^\/api\/proposals\/([a-z0-9-]+)\/changes\/(change-\d+)\/diff$/.exec(url.pathname)
  if (request.method === 'GET' && proposalDiff) {
    const root = requireProject(runtime)
    const run = await readSyncRun(root, proposalDiff[1]!)
    sendJson(response, 200, await syncReviewSourceDiff(root, run, requireSyncReviewChange(run, proposalDiff[2]!)))
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
    sendJson(response, 200, await acceptSyncChanges(root, run.id, selections))
    return
  }
  if (request.method === 'POST' && url.pathname === '/api/validate') {
    sendJson(response, 200, await validateProject(requireProject(runtime)))
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
    const root = requireProject(runtime)
    const project = await loadProject(root)
    const requestedAgent = parseAgent(optionalString(body.agent))
    const effectiveAgent = requestedAgent ?? project.defaultAgent
    const args = [mode]
    const requestText = optionalString(body.request)
    if (requestText) args.push(requestText)
    appendOption(args, 'agent', requestedAgent)
    appendOption(args, 'model', optionalString(body.model))
    if (effectiveAgent === 'codex') appendOption(args, 'reasoning', optionalString(body.reasoning))
    if (effectiveAgent === 'claude') appendOption(args, 'effort', optionalString(body.effort))
    if (body.screenshots === true && mode !== 'review') args.push('--screenshots')
    if (body.screenshots === false && mode !== 'review') args.push('--no-screenshots')
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
    if (runtime.previewJobId) {
      const existing = runtime.jobs.get(runtime.previewJobId)
      if (existing?.status === 'running') {
        sendJson(response, 200, publicJob(existing))
        return
      }
    }
    const root = requireProject(runtime)
    const job = startCliJob(runtime, 'preview', ['preview', '--host', '127.0.0.1', '--port', '4321', '--cwd', root], root)
    runtime.previewJobId = job.id
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
    sendJson(response, 200, await installAgent(agent))
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
    sendJson(response, 202, publicJob(startCliJob(runtime, 'login', args, runtime.root ?? runtime.cwd)))
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
    return {
      projectFound: false,
      cwd: runtime.cwd,
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
    generators: await installedGeneratorEntries(root),
    jobs: [...runtime.jobs.values()].map(publicJob).reverse(),
    preview: {
      running: runtime.previewJobId
        ? runtime.jobs.get(runtime.previewJobId)?.status === 'running'
        : false,
      url: 'http://127.0.0.1:4321',
    },
  }
}

async function agentState(root: string, preferred: AgentName | undefined): Promise<unknown[]> {
  const detected = await detectAgents()
  return Promise.all(detected.map(async (agent) => ({
    ...agent,
    preferred: agent.name === preferred,
    authentication: await agentAuthenticationStatus(agent),
    skills: await skillStatus(root, agent.name),
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

async function createProjectFromUi(runtime: UiRuntime, raw: unknown): Promise<void> {
  if (runtime.root) throw new DoxloopError('A Doxloop project is already open.')
  const body = recordBody(raw)
  const directory = stringValue(body.directory)
  const title = optionalString(body.title)
  const generator = parseGenerator(optionalString(body.generator)) ?? 'doxbrix'
  const root = resolve(runtime.cwd, directory)
  await assertNewProjectDirectory(root)
  const sourceKind = optionalString(body.sourceKind)
  const sourcePath = optionalString(body.sourcePath)
  const sources: SourceBinding[] = []
  if (sourceKind === 'directory' && sourcePath) {
    const absolute = resolve(runtime.cwd, sourcePath)
    sources.push({ name: optionalString(body.sourceName) ?? 'product', path: portableRelative(root, absolute) })
  } else if (sourceKind === 'openapi' && sourcePath) {
    const parsed = parseSpec(`${optionalString(body.sourceName) ?? 'api'}=${sourcePath}`)
    sources.push(isSpecUrl(parsed.path) ? parsed : { ...parsed, path: portableRelative(root, resolve(runtime.cwd, parsed.path)) })
  }
  await validateProjectSourceBoundaries(root, sources)
  if (generator !== 'doxbrix') {
    await mkdir(root, { recursive: true })
    await addGenerator(root, generator)
  }
  await scaffoldProject({ directory: root, ...(title ? { title } : {}), sources, generator })
  const agent = parseAgent(optionalString(body.agent))
  await installSkill({ root, ...(agent ? { agent } : {}) })
  if (agent) await saveProjectSettings(root, { defaultAgent: agent })
  runtime.root = root
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
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(name)) throw new DoxloopError('Evidence name may use letters, numbers, underscores, and hyphens.')
  if (project.sources.some((source) => source.name === name)) throw new DoxloopError(`Evidence "${name}" already exists.`)
  const kind = stringValue(body.kind)
  const location = stringValue(body.path)
  let source: SourceBinding
  if (kind === 'openapi') {
    const parsed = parseSpec(`${name}=${location}`)
    source = isSpecUrl(parsed.path) ? parsed : { ...parsed, path: portableRelative(root, resolve(root, parsed.path)) }
  } else if (kind === 'directory') {
    source = { name, path: portableRelative(root, resolve(root, location)) }
  } else {
    throw new DoxloopError('Evidence kind must be directory or openapi.')
  }
  const sources = [...project.sources, source]
  await validateProjectSourceBoundaries(root, sources)
  await saveProjectSettings(root, { sources })
  await setPendingSourceInReceipt(root, name, true)
}

async function updateSourceFromUi(root: string, name: string, raw: unknown): Promise<void> {
  const body = recordBody(raw)
  const project = await loadProject(root)
  const index = project.sources.findIndex((source) => source.name === name)
  if (index < 0) throw new DoxloopError(`Evidence "${name}" does not exist.`)
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
      throw new DoxloopError('Evidence kind must be directory or openapi.')
    }
    sources[index] = source
  }
  if (body.remote === null) {
    const { remote: _remote, ...withoutRemote } = source
    sources[index] = withoutRemote
  } else if (body.remote !== undefined) {
    const remote = recordBody(body.remote)
    const repository = stringValue(remote.repository)
    if (!/^[^/\s]+\/[^/\s]+$/.test(repository)) throw new DoxloopError('GitHub repository must use owner/name format.')
    const branch = stringValue(remote.branch)
    sources[index] = {
      ...source,
      remote: {
        provider: 'github',
        repository,
        branch,
        ...(optionalString(remote.tokenEnv) ? { tokenEnv: optionalString(remote.tokenEnv)! } : {}),
        ...(optionalString(remote.apiBaseUrl) ? { apiBaseUrl: optionalString(remote.apiBaseUrl)! } : {}),
      },
    }
  }
  await validateProjectSourceBoundaries(root, sources)
  await saveProjectSettings(root, { sources })
}

async function removeSourceFromUi(root: string, name: string): Promise<void> {
  const project = await loadProject(root)
  if (!project.sources.some((source) => source.name === name)) throw new DoxloopError(`Evidence "${name}" does not exist.`)
  const sources = project.sources.filter((source) => source.name !== name)
  let application = project.application
  if (project.application?.source === name) {
    const { source: _source, startCommand: _startCommand, ...remaining } = project.application
    application = remaining
  }
  await saveProjectSettings(root, { sources, application })
  await setPendingSourceInReceipt(root, name, false)
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
  return { mode, ...(branch ? { branch } : {}), on, watch, ignore, ...(budget ? { budget } : {}) }
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
  const experienceLevel = optionalString(body.experienceLevel) ?? current.experienceLevel
  if (experienceLevel === 'beginner' || experienceLevel === 'intermediate' || experienceLevel === 'advanced' || experienceLevel === 'mixed') {
    result.experienceLevel = experienceLevel
  }
  const priorityOutcomes = body.priorityOutcomes === undefined ? current.priorityOutcomes : stringArray(body.priorityOutcomes)
  if (priorityOutcomes) result.priorityOutcomes = priorityOutcomes
  return result
}

function applicationFromBody(raw: unknown, project: DoxloopProject): ApplicationConfig {
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
  if (source && !project.sources.some((item) => item.name === source)) {
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
      },
    } : {}),
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
  })
  send(response, 200, 'text/html; charset=utf-8', html, reviewHeaders())
}

function startCliJob(
  runtime: UiRuntime,
  type: string,
  args: string[],
  cwd: string,
  agent?: AgentName,
): UiJob {
  const id = randomBytes(8).toString('hex')
  const job: UiJob = {
    id,
    type,
    ...(agent ? { agent } : {}),
    status: 'running',
    startedAt: new Date().toISOString(),
    lines: [],
  }
  const child = spawn(process.execPath, [CLI_PATH, ...args], {
    cwd,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  job.child = child
  const append = (chunk: Buffer | string): void => {
    const text = chunk.toString()
    const lines = text.split(/\r?\n/).filter(Boolean)
    job.lines.push(...lines)
    job.lastOutputAt = new Date().toISOString()
    if (job.lines.length > MAX_JOB_LINES) job.lines.splice(0, job.lines.length - MAX_JOB_LINES)
    queueUiJobLog(runtime, job.id, text)
    publishJobs(runtime)
  }
  child.stdout?.on('data', append)
  child.stderr?.on('data', append)
  child.once('error', (error) => {
    append(error.message)
    job.status = 'failed'
    job.finishedAt = new Date().toISOString()
    publishJobs(runtime)
  })
  child.once('exit', (code, signal) => {
    if (job.status === 'cancelled') return
    job.exitCode = code ?? 1
    job.status = code === 0 && !signal ? 'succeeded' : 'failed'
    job.finishedAt = new Date().toISOString()
    delete job.child
    publishJobs(runtime)
  })
  runtime.jobs.set(id, job)
  publishJobs(runtime)
  return job
}

function publicJob(job: UiJob): Omit<UiJob, 'child'> {
  const { child: _child, ...rest } = job
  return rest
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

function broadcastJobs(runtime: UiRuntime): void {
  const event = jobEvent(runtime)
  for (const response of runtime.jobSubscribers) {
    if (response.destroyed || response.writableEnded) {
      runtime.jobSubscribers.delete(response)
      continue
    }
    try {
      response.write(event)
    } catch {
      runtime.jobSubscribers.delete(response)
    }
  }
}

function publishJobs(runtime: UiRuntime): void {
  broadcastJobs(runtime)
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
  const path = join(runtime.root, UI_JOBS_FILE)
  const temporary = `${path}.${process.pid}.tmp`
  const jobs = [...runtime.jobs.values()]
    .slice(-MAX_PERSISTED_JOBS)
    .map(publicJob)
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
    .map(parsePersistedUiJob)
    .filter((job): job is UiJob => job !== undefined)
    .slice(-MAX_PERSISTED_JOBS)
  return new Map(jobs.map((job) => [job.id, job]))
}

function parsePersistedUiJob(raw: unknown): UiJob | undefined {
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
  const lines = job.lines
    .filter((line): line is string => typeof line === 'string')
    .slice(-MAX_JOB_LINES)
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
    lines,
  }
}

async function optionalProjectRoot(cwd: string): Promise<string | undefined> {
  try {
    return await findProjectRoot(resolve(cwd))
  } catch {
    return undefined
  }
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

function requireSession(request: IncomingMessage, session: string): void {
  const cookie = request.headers.cookie ?? ''
  const valid = cookie.split(';').some((entry) => entry.trim() === `doxloop_ui=${session}`)
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
    'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-src 'self' http://127.0.0.1:4321; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
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

function normalizeInitialPage(value: string | undefined): string {
  const page = value ?? 'home'
  const allowed = new Set(['home', 'sources', 'authoring', 'sync', 'proposals', 'quality', 'preview', 'publish', 'settings'])
  if (!allowed.has(page)) throw new DoxloopError(`Unknown UI page "${page}".`)
  return page
}

function openBrowser(url: string): void {
  const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open'
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  const child = spawn(command, args, { detached: true, stdio: 'ignore' })
  child.unref()
}

function appendOption(args: string[], name: string, value: string | undefined): void {
  if (value) args.push(`--${name}`, value)
}

function recordBody(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new DoxloopError('Expected an object.')
  return value as Record<string, unknown>
}

function stringValue(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new DoxloopError('A required value is missing.')
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
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
