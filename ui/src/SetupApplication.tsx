import { Fragment } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import './SetupApplication.css'
import { api, post, NO_TIMEOUT } from './api'
import { Badge, Button, Combo, Field, Input, Note, Select, Textarea, Toggle } from './components'
import { Icon } from './icons'
import { DocsSiteSourceFields, type DocsSiteInspection } from './DocsSiteSourceFields'
import { agentModels, defaultModelForAgent, modelReasoningLevels, preferredReasoningLevel } from './model-options'
import { ImportExistingPanel } from './ProjectSwitcher'
import { AgentCapabilityMatrix } from './agent-capabilities'
import { GeneratorPreflightPanel, GeneratorTierBadge, GeneratorTierMatrix } from './generator-tiers'
import { DEFAULT_READER_OUTCOME, batchLimitsForScope, describeBatchLimits, preferredSetupAgent, screenshotIntentFromChoice, relativeSignInRoute, setupApplicationCaptureTarget, setupCaptureProfileStatus, setupDocumentationPlanRequest, setupDraftKey, setupDraftSnapshot, setupStepIssue, signInInstruction } from './setup-plan'
import type { GeneratorPreflight, UiJob, UiState } from './types'

type OpenApiSummary = { title: string; version: string; specificationVersion: string; servers: string[]; securitySchemes: string[]; schemas: string[]; operationCount: number }
type SetupValidation = { directoryPath?: string; directoryError?: string; sourcePath?: string; sourcePathError?: string; openapiSummary?: OpenApiSummary }
type ApplicationReadiness = { configured: boolean; reachable: boolean; status: 'not-configured' | 'ready' | 'authentication-required' | 'unreachable'; url?: string; message: string; authentication?: 'none' | 'session' | 'credentials' | 'expired'; signInPath?: string }
type SetupCaptureAuth = { session?: { savedAt: string; origin: string; cookies: number; origins: number }; signIn: { active: boolean; open?: boolean; url?: string; currentUrl?: string } }

type SetupSource = {
  name: string
  sourceKind: 'directory' | 'openapi' | 'docs-site'
  sourceLocation: 'git' | 'local'
  sourcePath: string
  repository: string
  branch: string
  subdirectory: string
  authMethod: 'automatic' | 'credentials'
  gitUsername: string
  gitSecret: string
  specInput: 'file' | 'url'
  specContent: string
  openapiSummary?: OpenApiSummary
  /** docs-site: the completed crawl the source is created from. */
  inspectionId?: string
  docsSite?: DocsSiteInspection['summary']
}

type SourceFlowStep = 'closed' | 'type' | 'source-location' | 'git-access' | 'git-connect' | 'git-select' | 'local' | 'openapi-format' | 'openapi-input' | 'docs-site'

type SetupGuidancePreferences = {
  experienceLevel: 'beginner' | 'intermediate' | 'advanced' | 'mixed'
  preferredExamples: string
  locale: string
  accessibilityTarget: string
  exclusions: string
  terminology: string
  designDirection: string
  clarificationMode: 'review' | 'defaults' | 'stop'
}

function repositoryProvider(repository: string): 'github' | 'gitlab' | 'git' {
  const value = repository.toLowerCase()
  if (value.includes('gitlab.com') || value.includes('gitlab.')) return 'gitlab'
  if (value.includes('github.com') || value.includes('github.')) return 'github'
  return 'git'
}

function docsSiteHostName(url: string): string | undefined {
  try {
    const parsed = new URL(url.trim())
    const section = parsed.pathname.replace(/\/+$/, '').split('/').filter(Boolean).pop()
    return section && !/^(docs?|documentation|help|guide|guides|manual)$/i.test(section) ? `${parsed.hostname} ${section}` : parsed.hostname
  } catch {
    return undefined
  }
}

function repositoryProviderIcon(repository: string): string {
  const provider = repositoryProvider(repository)
  return provider === 'git' ? 'sources' : provider
}

const emptySetupSource = (): SetupSource => ({
  name: '', sourceKind: 'directory', sourceLocation: 'git', sourcePath: '', repository: '', branch: 'main',
  subdirectory: '', authMethod: 'automatic', gitUsername: '', gitSecret: '', specInput: 'file', specContent: '',
})

export function SetupApplication({ state, act, error, onContinue, onCancel }: { state: UiState; act: Action; error: string; onContinue: (page: 'authoring' | 'publish' | 'pages') => Promise<void>; onCancel?: () => void }) {
  // "new" scaffolds a project; "existing" adopts a folder that already holds a documentation site.
  const [mode, setMode] = useState<'new' | 'existing'>('new')
  // Answers survive leaving setup, a reload, or a crash; secrets never do.
  const draftKey = setupDraftKey(state.cwd)
  const [draft] = useState(() => readSetupDraft(draftKey))
  const freshForm = () => {
    const agent = preferredSetupAgent(state.agents)
    const model = defaultModelForAgent(agent)
    const reasoning = preferredReasoningLevel(agent, model)
    const defaults = {
      directory: 'my-product-docs',
      parentDirectory: '',
      title: 'Product documentation',
      sourceKind: 'directory',
      sourceLocation: 'git',
      sourceName: '',
      sourcePath: '',
      repository: '',
      branch: 'main',
      subdirectory: '',
      authMethod: 'automatic',
      gitUsername: '',
      gitSecret: '',
      specInput: 'file',
      specContent: '',
      generator: 'doxbrix',
      agent,
      model,
      reasoning: agent === 'codex' ? reasoning : '',
      effort: agent === 'claude' ? reasoning : '',
      screenshots: 'enabled' as 'auto' | 'enabled' | 'disabled',
      applicationBaseUrl: '',
      applicationStartPath: '/',
      applicationSignIn: 'no' as 'no' | 'yes',
      applicationLoginPath: '',
      applicationUsername: '',
      applicationPassword: '',
      audiences: [] as string[],
      scope: 'comprehensive' as 'starter' | 'standard' | 'comprehensive',
      // Empty means the default shown as the placeholder; a pre-filled value
      // made typed text land in the middle of the default sentence.
      readerOutcome: '',
      experienceLevel: 'beginner' as SetupGuidancePreferences['experienceLevel'],
      preferredExamples: '',
      locale: 'en-US',
      accessibilityTarget: 'WCAG 2.2 AA',
      exclusions: '',
      terminology: '',
      designDirection: '',
      clarificationMode: 'review' as SetupGuidancePreferences['clarificationMode'],
      customInstructions: '',
    }
    return defaults
  }
  const [form, setForm] = useState(() => draft ? { ...freshForm(), ...(draft.form as Partial<ReturnType<typeof freshForm>>) } : freshForm())
  const [step, setStep] = useState(() => draft?.step ?? 1)
  // Each step starts at its heading, not wherever the previous one was scrolled.
  useEffect(() => { scrollTo({ top: 0 }) }, [step])
  const [sources, setSources] = useState<SetupSource[]>(() => (draft?.sources as SetupSource[] | undefined) ?? [])
  const [draftRestored, setDraftRestored] = useState(Boolean(draft))
  const [projectCreated, setProjectCreated] = useState(false)
  useEffect(() => {
    if (projectCreated) return
    try { localStorage.setItem(draftKey, JSON.stringify(setupDraftSnapshot(form, sources, step))) } catch { /* A draft is a convenience; setup works without it. */ }
  }, [form, sources, step, projectCreated])
  const discardDraft = () => {
    try { localStorage.removeItem(draftKey) } catch { /* Nothing stored. */ }
    setForm(freshForm())
    setSources([])
    setStep(1)
    setDraftRestored(false)
  }
  const [sourceFlowStep, setSourceFlowStep] = useState<SourceFlowStep>('closed')
  const [sourceAddedNotice, setSourceAddedNotice] = useState('')
  // The confirmation is a toast, not a gate: it leaves on its own so it never
  // sits on top of the wizard footer on a short viewport.
  useEffect(() => {
    if (!sourceAddedNotice) return
    const timer = setTimeout(() => setSourceAddedNotice(''), 4000)
    return () => clearTimeout(timer)
  }, [sourceAddedNotice])
  useEffect(() => { setSourceAddedNotice('') }, [step])
  const [setupSpecFileName, setSetupSpecFileName] = useState('')
  const setupSpecInput = useRef<HTMLInputElement>(null)
  const [docsSiteInspection, setDocsSiteInspection] = useState<DocsSiteInspection>()
  const [savingSource, setSavingSource] = useState(false)
  const [pathErrors, setPathErrors] = useState({ directory: '', sourcePath: '' })
  // An error belongs to the step it happened on, so it is shown there and
  // nowhere else. Moving to another step and back does not lose it.
  const [setupError, setSetupErrorState] = useState<{ step: number; message: string } | null>(null)
  const failStep = (at: number, message: string) => setSetupErrorState({ step: at, message })
  const clearSetupError = () => setSetupErrorState(null)
  const [validatingPaths, setValidatingPaths] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [gitTesting, setGitTesting] = useState(false)
  const [gitBranches, setGitBranches] = useState<string[]>([])
  const [gitDirectories, setGitDirectories] = useState<string[]>([])
  const [gitHead, setGitHead] = useState('')
  const [gitFoldersLoading, setGitFoldersLoading] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [applicationReadiness, setApplicationReadiness] = useState<ApplicationReadiness>()
  const [testingApplication, setTestingApplication] = useState(false)
  const [skipSignIn, setSkipSignIn] = useState(false)
  const [setupAuth, setSetupAuth] = useState<SetupCaptureAuth>()
  const [signInBusy, setSignInBusy] = useState<'' | 'start' | 'finish' | 'cancel' | 'forget'>('')
  const [requestedAgentInstall, setRequestedAgentInstall] = useState('')
  const generators = state.generators
  const selectedGenerator = generators.find((item) => item.id === form.generator)
  const [generatorPreflight, setGeneratorPreflight] = useState<GeneratorPreflight>()
  const [checkingGenerator, setCheckingGenerator] = useState(false)
  const checkGenerator = async (generator: string) => {
    if (!generator || generator === 'doxbrix') {
      setGeneratorPreflight(undefined)
      return
    }
    setCheckingGenerator(true)
    try {
      const result = await post<GeneratorPreflight>('/api/setup/generator/preflight', { generator })
      if (result.generator === generator) setGeneratorPreflight(result)
    } catch (cause) {
      setGeneratorPreflight({ generator, tier: 'basic', ready: false, checks: [{ status: 'fail', label: 'Tool check failed', detail: message(cause) }] })
    } finally {
      setCheckingGenerator(false)
    }
  }
  useEffect(() => {
    if (step === 3) void checkGenerator(form.generator)
    // The check runs when the Tools step opens and whenever the generator changes.
  }, [step, form.generator])
  const availableModels = agentModels(form.agent)
  const supportedReasoning = modelReasoningLevels(form.agent, form.model)
  const selectedAgent = state.agents?.find((agent) => agent.name === form.agent)
  const selectedAgentInstallJob = form.agent
    ? state.jobs.find((job) => job.type === 'agent:install' && job.agent === form.agent && (job.status === 'running' || job.agent === requestedAgentInstall))
    : undefined
  const agentInstallPending = requestedAgentInstall === form.agent && !selectedAgentInstallJob
  const signedInAlternative = state.agents?.find((agent) => agent.name !== form.agent && agent.executable && agent.authentication?.status === 'authenticated')?.name
  const chooseAgent = (agent: string) => {
    const model = defaultModelForAgent(agent)
    const level = preferredReasoningLevel(agent, model)
    setRequestedAgentInstall('')
    clearSetupError()
    setForm((current) => ({ ...current, agent, model, reasoning: agent === 'codex' ? level : '', effort: agent === 'claude' ? level : '' }))
  }
  const [checkingAgents, setCheckingAgents] = useState(false)
  // Signing in happens in the user's terminal; reloading state re-reads it.
  const recheckAgents = async () => {
    setCheckingAgents(true)
    clearSetupError()
    try { await act(() => Promise.resolve(null)) } finally { setCheckingAgents(false) }
  }
  const update = (key: string, value: string) => {
    setForm((current) => ({ ...current, [key]: value }))
    clearSetupError()
    if (key === 'directory') setPathErrors((current) => ({ ...current, directory: '' }))
    if (key === 'generator') setGeneratorPreflight(undefined)
    if (key === 'sourcePath' || key === 'sourceKind') setPathErrors((current) => ({ ...current, sourcePath: '' }))
    if (key.startsWith('application')) {
      setApplicationReadiness(undefined)
      setSkipSignIn(false)
    }
    if (['repository', 'authMethod', 'gitUsername', 'gitSecret', 'sourceLocation'].includes(key)) {
      setPathErrors((current) => ({ ...current, sourcePath: '' }))
      setGitHead('')
      setGitDirectories([])
    }
  }
  const captureProfile = setupCaptureProfileStatus(form)
  const captureProfileRequired = captureProfile.required
  const captureProfileComplete = captureProfile.complete
  const captureProfileIssue = captureProfile.issue
  // Continue and Create stay enabled; on click, the first thing still missing
  // on a step is reported there instead of leaving a silently disabled button.
  const stepIssue = (at: number) => setupStepIssue(at, {
    directory: form.directory,
    title: form.title,
    sourceCount: sources.length,
    sourceDialogOpen: sourceFlowStep !== 'closed',
    agent: form.agent,
    agentInstalled: Boolean(selectedAgent),
    agentLabel: agentLabel(form.agent),
    ...(selectedAgent?.authentication ? { agentAuthentication: selectedAgent.authentication } : {}),
    reasoning: form.agent === 'claude' ? form.effort : form.reasoning,
    reasoningLevels: supportedReasoning,
    screenshots: form.screenshots,
    applicationBaseUrl: form.applicationBaseUrl,
    applicationStartPath: form.applicationStartPath,
  })
  const setupApplication = () => ({
    baseUrl: form.applicationBaseUrl,
    readyPath: form.applicationStartPath,
    screenshots: { policy: 'auto', startPath: form.applicationStartPath },
    ...(form.applicationSignIn === 'yes' && form.applicationLoginPath.trim() ? { authentication: { loginPath: form.applicationLoginPath.trim() } } : {}),
  })
  // A second project starts next to the one that is open, not inside the
  // folder the control center happened to be launched from.
  const defaultParentDirectory = state.projectFound && state.root ? state.root.replace(/[\\/][^\\/]+[\\/]?$/, '') || state.cwd : state.cwd
  // A pasted repository URL connects by itself when the field is left or
  // Enter is pressed; the link button stays for a retry.
  const autoConnectRepository = () => {
    const url = form.repository.trim()
    if (!/^(?:https?:\/\/|git@)\S+\/\S+/.test(url) || gitHead || gitTesting) return
    if (form.authMethod === 'credentials' && (!form.gitUsername.trim() || !form.gitSecret.trim())) return
    void testGitConnection()
  }
  // Sign-in details only when they matter: the check found a sign-in page,
  // details or a session already exist, a saved sign-in matches this app, or
  // the reader asks. A public app never shows three empty fields.
  const [signInOpen, setSignInOpen] = useState(false)
  const typedSetupCredentials = form.applicationSignIn === 'yes' && Boolean(form.applicationUsername.trim() && form.applicationPassword)
  // Another recent project may already hold a sign-in for this same app. The
  // wizard offers it by name; the server copies it, so no secret is typed again.
  const [savedSignIns, setSavedSignIns] = useState<SavedSignIn[]>([])
  const [reuseSignInFrom, setReuseSignInFrom] = useState('')
  const reusedSignIn = !typedSetupCredentials && !setupAuth?.session ? savedSignIns.find((match) => match.path === reuseSignInFrom) : undefined
  const hasSetupCredentials = typedSetupCredentials || Boolean(reusedSignIn)
  const showSignIn = signInOpen || form.applicationSignIn === 'yes' || Boolean(setupAuth?.session) || Boolean(setupAuth?.signIn.active) || applicationReadiness?.status === 'authentication-required' || savedSignIns.length > 0
  useEffect(() => {
    const baseUrl = form.applicationBaseUrl.trim()
    if (form.screenshots === 'disabled' || !/^https?:\/\/\S+/.test(baseUrl)) { setSavedSignIns([]); return }
    let active = true
    const timer = setTimeout(() => {
      void post<{ matches: SavedSignIn[] }>('/api/setup/application/saved-sign-ins', { baseUrl })
        .then((result) => { if (active) setSavedSignIns(result.matches) })
        .catch(() => { if (active) setSavedSignIns([]) })
    }, 400)
    return () => { active = false; clearTimeout(timer) }
  }, [form.applicationBaseUrl, form.screenshots])
  const runSignIn = async (kind: typeof signInBusy, request: () => Promise<SetupCaptureAuth>) => {
    setSignInBusy(kind)
    clearSetupError()
    try {
      setSetupAuth(await request())
      setApplicationReadiness(undefined)
    } catch (cause) {
      failStep(step, message(cause))
    } finally {
      setSignInBusy('')
    }
  }
  // While the Chrome window is open, keep an eye on whether it is still there.
  useEffect(() => {
    if (!setupAuth?.signIn.active) return
    const poll = setInterval(() => {
      void api<SetupCaptureAuth>('/api/setup/application/auth').then((next) => setSetupAuth(next)).catch(() => undefined)
    }, 2_000)
    return () => clearInterval(poll)
  }, [setupAuth?.signIn.active])
  const testApplication = async (): Promise<ApplicationReadiness> => {
    setTestingApplication(true)
    clearSetupError()
    let readiness: ApplicationReadiness
    try {
      const application = { ...setupApplication(), hasCredentials: hasSetupCredentials }
      readiness = await post<ApplicationReadiness>('/api/setup/application/readiness', application)
    } catch (cause) {
      readiness = { configured: true, reachable: false, status: 'unreachable', message: message(cause) }
    } finally {
      setTestingApplication(false)
    }
    setApplicationReadiness(readiness)
    if (readiness.status === 'authentication-required') {
      // The app shows a sign-in page first: open the sign-in choices instead
      // of letting the plan run against the sign-in screen.
      setForm((current) => ({
        ...current,
        applicationSignIn: 'yes',
        applicationLoginPath: current.applicationLoginPath || (readiness.signInPath ? relativeSignInRoute(current.applicationBaseUrl, readiness.signInPath) : ''),
      }))
    }
    return readiness
  }
  // Editing any application field clears the last check, so Continue and
  // Create run the check themselves when it has not passed yet rather than
  // making the user find the Check page button first.
  const ensureApplicationReady = async (): Promise<ApplicationReadiness> => {
    const readiness = applicationReadiness?.status === 'ready' ? applicationReadiness : await testApplication()
    // "Continue without signing in" is an explicit choice: the plan documents
    // what is reachable and keeps the rest text-only.
    return readiness.status === 'authentication-required' && skipSignIn ? { ...readiness, status: 'ready' } : readiness
  }
  const readinessIssue = (readiness: ApplicationReadiness): string =>
    readiness.status === 'authentication-required'
      ? `Your application shows a sign-in page first${readiness.signInPath ? ` (${readiness.signInPath})` : ''}. Choose "Sign in with browser" and sign in once, or enter a test account below. You can also choose "Continue without signing in" — then screenshots only show the sign-in pages.`
      : /^Application URL/.test(readiness.message) ? readiness.message : `${readiness.message} Start the application and continue again, or turn off product screenshots.`
  const sourceType = form.sourceKind === 'openapi' ? 'openapi' : form.sourceLocation === 'git' ? 'git' : 'local'
  const updateSourceType = (value: string) => {
    if (value === 'openapi') {
      update('sourceKind', value)
      return
    }
    setForm((current) => ({ ...current, sourceKind: 'directory', sourceLocation: value }))
    clearSetupError()
    setPathErrors((current) => ({ ...current, sourcePath: '' }))
    setGitHead('')
  }
  const currentSource = (): SetupSource => ({
    name: form.sourceName,
    sourceKind: form.sourceKind as SetupSource['sourceKind'],
    sourceLocation: form.sourceLocation as 'git' | 'local',
    sourcePath: form.sourcePath,
    repository: form.repository,
    branch: form.branch,
    subdirectory: form.subdirectory,
    authMethod: form.authMethod as 'automatic' | 'credentials',
    gitUsername: form.gitUsername,
    gitSecret: form.gitSecret,
    specInput: form.specInput as 'file' | 'url',
    specContent: form.specContent,
    ...(form.sourceKind === 'docs-site' && docsSiteInspection?.status === 'completed' ? { inspectionId: docsSiteInspection.id, docsSite: docsSiteInspection.summary } : {}),
  })
  const validatePaths = async (includeSource: boolean, source = currentSource()): Promise<SetupValidation | undefined> => {
    try {
      const result = await post<SetupValidation>('/api/setup/validate', {
        directory: form.directory,
        parentDirectory: form.parentDirectory || defaultParentDirectory,
        ...(includeSource ? {
          ...source,
        } : {}),
      })
      setPathErrors({ directory: result.directoryError ?? '', sourcePath: result.sourcePathError ?? '' })
      return result
    } catch (cause) {
      failStep(step, message(cause))
      return undefined
    }
  }
  const continueSetup = async () => {
    setValidatingPaths(true)
    try {
      const issue = stepIssue(step)
      if (issue) { failStep(step, issue); return }
      if (step === 1) {
        const result = await validatePaths(false)
        if (!result || result.directoryError) return
      }
      if (step === 2) {
        for (const source of sources) {
          if (source.sourceKind === 'openapi' && source.specInput === 'file' && source.specContent.trim()) continue
          const result = await validatePaths(true, source)
          if (!result) return
          if (result.directoryError) { setStep(1); return }
          // The add-source dialog is closed here, so its inline error would
          // be invisible; report the failing source on the step instead.
          if (result.sourcePathError) { failStep(2, `${source.name}: ${result.sourcePathError}`); return }
        }
      }
      if (step === 3 && captureProfileRequired) {
        // A plan with screenshots is long; do not start one that will fail
        // at capture time because the application was never reached.
        const readiness = await ensureApplicationReady()
        if (readiness.status !== 'ready') { failStep(3, readinessIssue(readiness)); return }
      }
      clearSetupError()
      setStep((value) => value + 1)
    } finally {
      setValidatingPaths(false)
    }
  }
  const installSelectedAgent = async () => {
    if (!form.agent) return
    setRequestedAgentInstall(form.agent)
    const result = await act(() => post<UiJob | { name: string; executable: string; alreadyInstalled: true }>('/api/agent/install', { agent: form.agent }))
    if (!result || !('status' in result)) setRequestedAgentInstall('')
  }
  const resetSourceDraft = () => {
    const next = emptySetupSource()
    setForm((current) => ({ ...current, sourceKind: next.sourceKind, sourceLocation: next.sourceLocation, sourceName: next.name, sourcePath: next.sourcePath, repository: next.repository, branch: next.branch, subdirectory: next.subdirectory, authMethod: next.authMethod, gitUsername: next.gitUsername, gitSecret: next.gitSecret, specInput: next.specInput, specContent: next.specContent }))
    setGitHead('')
    setGitBranches([])
    setGitDirectories([])
    setPathErrors((current) => ({ ...current, sourcePath: '' }))
    setSetupSpecFileName('')
    setDocsSiteInspection(undefined)
  }
  const readSetupSpecification = async (file: File | undefined) => {
    if (!file) return
    update('specContent', await file.text())
    update('sourcePath', '')
    update('specInput', 'file')
    setSetupSpecFileName(file.name)
  }
  const addSetupSource = async () => {
    const draft = currentSource()
    const location = draft.sourceKind === 'openapi' ? draft.sourcePath || 'OpenAPI Specification' : draft.sourceLocation === 'git' ? draft.repository : draft.sourcePath
    const fallback = draft.sourceKind === 'openapi' ? 'OpenAPI Specification' : draft.sourceKind === 'docs-site' ? 'Existing Documentation' : draft.sourceLocation === 'git' ? 'Git Repository' : 'Local Repository'
    const segment = draft.sourceKind === 'docs-site'
      ? docsSiteHostName(draft.sourcePath)
      : location.replace(/[?#].*$/, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/\.git$/i, '').replace(/\.(json|ya?ml)$/i, '')
    const baseName = segment || fallback
    const matching = sources.filter((source) => source.name === baseName || source.name.startsWith(`${baseName} `)).length
    const source = { ...draft, name: matching ? `${baseName} ${matching + 1}` : baseName }
    setSavingSource(true)
    try {
      const result = await validatePaths(true, source)
      if (!result || result.directoryError || result.sourcePathError) return
      const normalized = { ...(result.sourcePath && source.sourceLocation === 'local' ? { ...source, sourcePath: result.sourcePath } : source), ...(result.openapiSummary ? { openapiSummary: result.openapiSummary } : {}) }
      setSources((current) => [...current, normalized])
      resetSourceDraft()
      setSourceFlowStep('closed')
      setSourceAddedNotice(normalized.name)
    } finally {
      setSavingSource(false)
    }
  }
  const [browsingLocation, setBrowsingLocation] = useState(false)
  const browseProjectLocation = async () => {
    setBrowsingLocation(true)
    clearSetupError()
    try {
      const result = await post<{ path: string | null }>('/api/projects/browse', {}, NO_TIMEOUT)
      if (result.path) update('parentDirectory', result.path)
    } catch (cause) {
      failStep(1, message(cause))
    } finally {
      setBrowsingLocation(false)
    }
  }
  const browseSourceDirectory = async () => {
    setBrowsing(true)
    clearSetupError()
    try {
      const result = await post<{ path: string | null }>('/api/setup/browse-directory', {}, NO_TIMEOUT)
      if (result.path) update('sourcePath', result.path)
    } catch (cause) {
      setPathErrors((current) => ({ ...current, sourcePath: message(cause) }))
    } finally {
      setBrowsing(false)
    }
  }
  const testGitConnection = async () => {
    setGitTesting(true)
    clearSetupError()
    setPathErrors((current) => ({ ...current, sourcePath: '' }))
    try {
      const result = await post<{ repository: string; branch: string; head: string; branches: string[] }>('/api/setup/git/test', {
        repository: form.repository,
        branch: form.branch,
        authMethod: form.authMethod,
        gitUsername: form.gitUsername,
        gitSecret: form.gitSecret,
      })
      setForm((current) => ({ ...current, repository: result.repository, branch: result.branch }))
      setGitBranches(result.branches)
      await loadGitDirectories(result.repository, result.branch)
      setGitHead(result.head)
    } catch (cause) {
      setGitHead('')
      setGitDirectories([])
      setPathErrors((current) => ({ ...current, sourcePath: message(cause) }))
    } finally {
      setGitTesting(false)
    }
  }
  const loadGitDirectories = async (repository: string, branch: string) => {
    setGitFoldersLoading(true)
    try {
      const result = await post<{ directories: string[] }>('/api/setup/git/folders', { ...form, repository, branch, subdirectory: '' })
      setGitDirectories(result.directories)
    } finally {
      setGitFoldersLoading(false)
    }
  }
  const selectGitBranch = async (branch: string) => {
    setForm((current) => ({ ...current, branch, subdirectory: '' }))
    clearSetupError()
    setPathErrors((current) => ({ ...current, sourcePath: '' }))
    try {
      await loadGitDirectories(form.repository, branch)
    } catch (cause) {
      setPathErrors((current) => ({ ...current, sourcePath: message(cause) }))
    }
  }
  const editGitConnection = () => {
    setGitHead('')
    setGitBranches([])
    setGitDirectories([])
    setPathErrors((current) => ({ ...current, sourcePath: '' }))
  }
  const createDocumentation = async () => {
    setSubmitting(true)
    clearSetupError()
    try {
      // The sidebar lets the user revisit and change any earlier step, so
      // every step is re-validated here and the first problem is shown on
      // the step it belongs to.
      for (const at of [1, 2, 3]) {
        const issue = stepIssue(at)
        if (issue) {
          setStep(at)
          failStep(at, issue)
          return
        }
      }
      if (captureProfileRequired) {
        const readiness = await ensureApplicationReady()
        if (readiness.status !== 'ready') {
          setStep(3)
          failStep(3, readinessIssue(readiness))
          return
        }
      }
      if (!projectCreated) {
        const directoryValidation = await validatePaths(false)
        if (!directoryValidation) return
        if (directoryValidation.directoryError) {
          setStep(1)
          return
        }
        for (const source of sources) {
          if (source.sourceKind === 'openapi' && source.specInput === 'file' && source.specContent.trim()) continue
          const validation = await validatePaths(true, source)
          if (!validation) return
          if (validation.sourcePathError) {
            setStep(2)
            failStep(2, `${source.name}: ${validation.sourcePathError}`)
            return
          }
        }
      }
      if (!projectCreated) {
        const created = await act(() => post<UiState>('/api/project', {
          ...form,
          // The location shown on step 1: an empty field means the default
          // shown there, never the folder the control center was started in.
          parentDirectory: form.parentDirectory || defaultParentDirectory,
          sources,
          ...(form.screenshots !== 'disabled' && form.applicationBaseUrl.trim() ? {
            application: {
              baseUrl: form.applicationBaseUrl.trim(),
              readyPath: form.applicationStartPath.trim(),
              screenshots: {
                policy: 'auto',
                highlight: true,
                viewport: { width: 1440, height: 900 },
                startPath: form.applicationStartPath.trim(),
              },
              ...(form.applicationSignIn === 'yes' && form.applicationLoginPath.trim() ? { authentication: { loginPath: form.applicationLoginPath.trim() } } : {}),
            },
            // Credentials travel once, over the local socket, and are stored
            // outside the project; they are never part of project.json.
            ...(typedSetupCredentials ? { applicationCredentials: { username: form.applicationUsername.trim(), password: form.applicationPassword } } : {}),
            ...(reusedSignIn ? { applicationSignInFrom: reusedSignIn.path } : {}),
          } : {}),
          documentation: {
            audiences: form.audiences,
            primaryAudience: form.audiences.join(', '),
            priorityOutcomes: [form.readerOutcome.trim() || DEFAULT_READER_OUTCOME],
            experienceLevel: form.experienceLevel,
            preferredExamples: splitSetupList(form.preferredExamples),
            locale: form.locale.trim() || 'en-US',
            accessibilityTarget: form.accessibilityTarget.trim() || 'WCAG 2.2 AA',
            exclusions: splitSetupList(form.exclusions),
            terminology: parseSetupTerminology(form.terminology),
            designDirection: form.designDirection.trim(),
            customInstructions: form.customInstructions,
          },
        }), undefined, false)
        if (!created) {
          failStep(5, 'The documentation workspace could not be created. Review the configuration and try again.')
          return
        }
        setProjectCreated(true)
        try { localStorage.removeItem(draftKey) } catch { /* Nothing stored. */ }
      }
      const result = await act(() => post<{ job: UiJob }>('/api/plans', setupDocumentationPlanRequest({ ...form, applicationSignInSkipped: skipSignIn && form.applicationSignIn === 'yes' && !setupAuth?.session && !hasSetupCredentials })), undefined, false)
      if (!result) {
        failStep(5, 'The documentation plan could not be started. Review the configuration and try again.')
        return
      }
      await onContinue('authoring')
    } finally {
      setSubmitting(false)
    }
  }
  const sourceAccess: 'public' | 'private' | 'local' = form.sourceLocation === 'local' ? 'local' : form.authMethod === 'credentials' ? 'private' : 'public'
  const chooseSourceAccess = (value: 'public' | 'private' | 'local') => {
    if (value === 'local') { updateSourceType('local'); return }
    updateSourceType('git')
    update('authMethod', value === 'private' ? 'credentials' : 'automatic')
    editGitConnection()
  }
  const chooseSourceKind = (kind: SetupSource['sourceKind']) => {
    resetSourceDraft()
    setForm((current) => ({ ...current, sourceKind: kind, sourceLocation: 'git' }))
    clearSetupError()
  }
  const openSourceDialog = () => {
    resetSourceDraft()
    setForm((current) => ({ ...current, sourceKind: 'directory', sourceLocation: 'git' }))
    setSourceFlowStep('type')
  }
  // Sign-in details are always offered with screenshots; giving any of them
  // (or reaching a sign-in page) is what turns the sign-in step on.
  const updateSignInField = (key: 'applicationLoginPath' | 'applicationUsername' | 'applicationPassword', value: string) => {
    setForm((current) => {
      const next = { ...current, [key]: value }
      const provided = Boolean(next.applicationLoginPath.trim() || next.applicationUsername.trim() || next.applicationPassword)
      return { ...next, applicationSignIn: provided || setupAuth?.session ? 'yes' : 'no' }
    })
    clearSetupError()
    setApplicationReadiness(undefined)
    setSkipSignIn(false)
  }
  const startBrowserSignIn = () => {
    setForm((current) => ({ ...current, applicationSignIn: 'yes' }))
    void runSignIn('start', () => post<SetupCaptureAuth>('/api/setup/application/sign-in', { ...setupApplication(), ...(form.applicationLoginPath.trim() ? { authentication: { loginPath: form.applicationLoginPath.trim() } } : {}) }))
  }
  const readinessLabel = applicationReadiness?.status === 'ready' ? 'Reachable' : applicationReadiness?.status === 'authentication-required' ? 'Sign-in required' : 'Unreachable'
  const readinessTone = applicationReadiness?.status === 'ready' ? 'good' : applicationReadiness?.status === 'authentication-required' ? 'warn' : 'bad'
  const sourceKindTitle = form.sourceKind === 'openapi' ? 'Add OpenAPI spec' : form.sourceKind === 'docs-site' ? 'Add existing documentation' : 'Add source code'
  const stepCopy: Record<number, readonly [string, string]> = {
    1: mode === 'new'
      ? ['Name your documentation', 'Where the workspace lives and what readers will call it.']
      : ['Use an existing documentation folder', 'Point Doxloop at a documentation site you already have. Nothing in it is changed.'],
    2: ['Connect your content', 'Doxloop reads code, specs and live docs sites. Add at least one.'],
    3: ['Choose your coding agent', 'Doxloop drives the assistant you already pay for. No extra API key.'],
    4: ['Guide the writing', 'Tell the planner who reads this and how deep to go.'],
    5: ['Review and create your plan', ''],
  }
  const [stepTitle, stepDetail] = stepCopy[step] ?? stepCopy[1]!
  const reasoningValue = form.agent === 'claude' ? form.effort : form.reasoning
  const screenshotsOn = form.screenshots !== 'disabled'
  const sourceSummary = (source: SetupSource) => source.sourceKind === 'openapi'
    ? ['OpenAPI', source.openapiSummary ? `${source.openapiSummary.title} ${source.openapiSummary.version} · ${source.openapiSummary.operationCount} operations` : source.sourcePath || 'Uploaded specification']
    : source.sourceKind === 'docs-site'
      ? ['Docs site', source.docsSite ? `${source.docsSite.pages} pages · ${source.docsSite.words.toLocaleString()} words${source.docsSite.generator ? ` · ${source.docsSite.generator}` : ''}` : source.sourcePath]
      : source.sourceLocation === 'git'
        ? [repositoryProvider(source.repository) === 'github' ? 'GitHub' : repositoryProvider(source.repository) === 'gitlab' ? 'GitLab' : 'Git', `${source.branch}${source.subdirectory ? ` / ${source.subdirectory}` : ''}`]
        : ['Local folder', source.sourcePath]
  const sourceIcon = (source: SetupSource) => source.sourceKind === 'openapi' ? 'braces' : source.sourceKind === 'docs-site' ? 'globe' : source.sourceLocation === 'git' ? repositoryProviderIcon(source.repository) : 'folder'
  return <div class="setup setup-wizard">
    <header class="wizard-bar">
      <div class="wizard-brand">
        <span class="wizard-mark" aria-hidden="true">D</span><span class="wizard-wordmark">Doxloop</span>
        <i class="wizard-bar-divider" aria-hidden="true" />
        <span class="wizard-context">Set up documentation</span>
      </div>
      <nav class="wizard-stepper" aria-label="Setup navigation">
        {SETUP_STEPS.map((label, index) => {
          const number = index + 1
          const status = number < step ? 'done' : number === step ? 'current' : 'upcoming'
          return <Fragment key={label}>
            {index > 0 && <i class={`wizard-connector ${number <= step ? 'done' : ''}`} aria-hidden="true" />}
            <button type="button" class={`wizard-step ${status}`} aria-label={`Step ${number}: ${label}`} aria-current={number === step ? 'step' : undefined} disabled={submitting || number > step} onClick={() => setStep(number)}>
              <span class="wizard-step-mark">{number < step ? <Icon name="check" size={12} /> : number}</span>
              <span class="wizard-step-label">{label}</span>
            </button>
          </Fragment>
        })}
      </nav>
      <div class="wizard-bar-actions">{onCancel && <Button tone="ghost" class="setup-cancel-button" title="Your answers are kept as a draft" onClick={onCancel}>Save and exit</Button>}</div>
    </header>
    <div class="wizard-body">
      <div class="wizard-column">
        {draftRestored && <div class="setup-draft-note" role="status"><span>Restored your unfinished setup. Re-enter any passwords.</span><span><Button size="sm" tone="ghost" onClick={() => setDraftRestored(false)}>Dismiss</Button><Button size="sm" onClick={discardDraft}>Start over</Button></span></div>}
        <div class="wizard-heading"><span class="kicker">Step {step} of 5</span><h1>{stepTitle}</h1>{stepDetail && <p>{stepDetail}</p>}</div>

        {step === 1 && <>
          <div class="wizard-group"><span class="field-label">How do you want to start?</span>
            <div class="radio-rows" role="radiogroup" aria-label="How to start">
              <button type="button" role="radio" aria-checked={mode === 'new'} class={mode === 'new' ? 'selected' : ''} onClick={() => { setMode('new'); clearSetupError() }}><span><strong>Start new</strong><small>Create a fresh documentation site from your sources.</small></span></button>
              <button type="button" role="radio" aria-checked={mode === 'existing'} class={mode === 'existing' ? 'selected' : ''} onClick={() => { setMode('existing'); clearSetupError() }}><span><strong>Use an existing documentation folder</strong><small>Keep your generator, or convert Mintlify.</small></span></button>
            </div>
          </div>
          {mode === 'existing' && <div class="wizard-panel setup-import-existing"><ImportExistingPanel onImported={() => onContinue('pages')} /></div>}
          {mode === 'new' && <>
            <Field label="Location" hint="The folder the new workspace is created in. Keep it outside your product source, usually the parent folder of the checkout."><div class="wizard-addon-row"><Input class="mono-input" value={form.parentDirectory || defaultParentDirectory} onInput={(value) => update('parentDirectory', value.currentTarget.value)} /><Button icon="folder" busy={browsingLocation} onClick={() => void browseProjectLocation()}>Browse</Button></div></Field>
            <Field label="Workspace name" hint="The folder your docs will live in."><ValidatedSetupInput value={form.directory} valid={Boolean(form.directory.trim()) && !pathErrors.directory} invalid={Boolean(pathErrors.directory)} onInput={(value) => update('directory', value)} />{pathErrors.directory && <small class="field-error">{pathErrors.directory}</small>}</Field>
            <Field label="Documentation title" hint="The title readers will see."><ValidatedSetupInput value={form.title} valid={Boolean(form.title.trim())} onInput={(value) => update('title', value)} /></Field>
          </>}
        </>}

        {step === 2 && <>
          <div class="wizard-source-list" aria-label="Connected sources">
            {sources.map((source, index) => {
              const [kind, detail] = sourceSummary(source)
              return <div class="wizard-source-row" key={`${source.name}-${index}`}>
                <span class="wizard-source-icon"><Icon name={sourceIcon(source)} size={16} /></span>
                <div class="wizard-source-copy"><strong>{source.name}</strong><span class="wizard-source-meta"><span>{kind}</span><span>{detail}</span></span></div><Badge tone="good">Connected</Badge>
                <button type="button" class="wizard-icon-button" aria-label={`Delete ${source.name}`} title="Delete source" onClick={() => setSources((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Icon name="trash" size={16} /></button>
              </div>
            })}
            <button type="button" class="wizard-source-add" onClick={openSourceDialog}><Icon name="plus" size={16} /><span>{sources.length ? 'Add another source' : 'Add source'}</span></button>
          </div>
          <Note>Private repositories need a personal access token. It is stored in your keychain, never in the project.</Note>
          {sourceAddedNotice && <div class="source-added-success" role="status"><span><Icon name="check" size={16} /></span><div><strong>Source added</strong><small>{sourceAddedNotice} is connected and ready.</small></div><button type="button" aria-label="Dismiss" onClick={() => setSourceAddedNotice('')}><Icon name="close" size={13} /></button></div>}
          {sourceFlowStep !== 'closed' && <div class="sources-modal-scrim" onClick={() => setSourceFlowStep('closed')}><section class={`sources-reference-dialog ${form.sourceKind === 'openapi' ? 'openapi' : form.sourceKind === 'docs-site' ? 'docs-site' : 'source'}`} role="dialog" aria-modal="true" aria-labelledby="setup-source-dialog-title" onClick={(event) => event.stopPropagation()}>
            <header><h2 id="setup-source-dialog-title">{sourceKindTitle}</h2><button type="button" aria-label="Close" onClick={() => setSourceFlowStep('closed')}><Icon name="close" size={16} /></button></header>
            <div class="sources-dialog-body">
              <div class="wizard-group"><span class="field-label">What are you adding?</span>
                <div class="radio-rows" role="group" aria-label="Source type">
                  <button type="button" aria-pressed={form.sourceKind === 'directory'} aria-label="Source code" onClick={() => chooseSourceKind('directory')}><span><strong>Source code</strong><small>A Git repository or local folder</small></span></button>
                  <button type="button" aria-pressed={form.sourceKind === 'openapi'} aria-label="OpenAPI spec" onClick={() => chooseSourceKind('openapi')}><span><strong>OpenAPI spec</strong><small>From a URL or an uploaded file</small></span></button>
                  <button type="button" aria-pressed={form.sourceKind === 'docs-site'} aria-label="Existing documentation: rewrite a live docs site" onClick={() => chooseSourceKind('docs-site')}><span><strong>Existing documentation</strong><small>Crawl a live docs site to audit and rewrite it</small></span></button>
                </div>
              </div>
              {form.sourceKind === 'docs-site' ? <DocsSiteSourceFields url={form.sourcePath} onUrl={(value) => { update('sourcePath', value); setPathErrors((current) => ({ ...current, sourcePath: '' })) }} inspection={docsSiteInspection} onInspection={setDocsSiteInspection} error={pathErrors.sourcePath} onError={(message) => setPathErrors((current) => ({ ...current, sourcePath: message }))} />
                : form.sourceKind === 'directory' ? <>
                  <div class="wizard-group"><span class="field-label">Where is it?</span>
                    <div class="radio-rows" role="group" aria-label="Source location">
                      <button type="button" aria-pressed={sourceAccess === 'public'} aria-label="Public repository" onClick={() => chooseSourceAccess('public')}><span><strong>Public repository</strong><small>GitHub, GitLab or another Git service</small></span></button>
                      <button type="button" aria-pressed={sourceAccess === 'private'} aria-label="Private repository" onClick={() => chooseSourceAccess('private')}><span><strong>Private repository</strong><small>Needs a personal access token</small></span></button>
                      <button type="button" aria-pressed={sourceAccess === 'local'} aria-label="Local folder" onClick={() => chooseSourceAccess('local')}><span><strong>Local folder</strong><small>A folder on this computer or network</small></span></button>
                    </div>
                  </div>
                  {sourceType === 'git' ? <>
                    <Field label="Repository URL" hint="Paste the clone or browser URL of the repository."><div class="wizard-addon-row"><Input class="mono-input" value={form.repository} placeholder="https://github.com/your-team/product" onInput={(event) => { update('repository', event.currentTarget.value); editGitConnection() }} onBlur={autoConnectRepository} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); autoConnectRepository() } }} /><RepositoryConnectButton connected={Boolean(gitHead)} busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && (!form.gitUsername.trim() || !form.gitSecret.trim()))} onClick={() => void testGitConnection()} /></div></Field>
                    {form.authMethod === 'credentials' && <>
                      <Field label="Username"><Input value={form.gitUsername} autocomplete="username" onInput={(event) => { update('gitUsername', event.currentTarget.value); editGitConnection() }} /></Field>
                      <Field label="Personal access token" hint="Held in your keychain for this computer only."><Input type="password" value={form.gitSecret} autocomplete="off" onInput={(event) => { update('gitSecret', event.currentTarget.value); editGitConnection() }} /></Field>
                    </>}
                    <Field label="Branch"><Select value={form.branch} disabled={!gitHead || gitTesting} onChange={(event) => void selectGitBranch(event.currentTarget.value)}>{gitBranches.length ? gitBranches.map((branch) => <option key={branch}>{branch}</option>) : <option>{gitTesting ? 'Connecting...' : 'Connect repository first'}</option>}</Select></Field>
                    <Field label="Folder (optional)" hint="Document one folder of the repository instead of all of it."><Select value={form.subdirectory} disabled={!gitHead || gitFoldersLoading} onChange={(event) => update('subdirectory', event.currentTarget.value)}><option value="">/</option>{gitDirectories.map((directory) => <option key={directory}>{directory}</option>)}</Select></Field>
                  </> : <Field label="Local folder"><div class="wizard-addon-row"><Input class="mono-input" value={form.sourcePath} aria-invalid={Boolean(pathErrors.sourcePath)} onInput={(event) => { update('sourcePath', event.currentTarget.value); setPathErrors((current) => ({ ...current, sourcePath: '' })) }} /><Button icon="folder" busy={browsing} onClick={() => void browseSourceDirectory()}>Browse</Button></div></Field>}
                  {pathErrors.sourcePath && <p class="field-error" role="alert">{pathErrors.sourcePath}</p>}
                </> : <>
                  <div class="wizard-group"><span class="field-label">Format</span>
                    <div class="radio-rows" role="group" aria-label="Specification input">
                      <button type="button" aria-pressed={form.specInput === 'file'} onClick={() => update('specInput', 'file')}><span><strong>Upload file</strong><small>.yaml, .yml or .json</small></span></button>
                      <button type="button" aria-pressed={form.specInput === 'url'} onClick={() => update('specInput', 'url')}><span><strong>From URL</strong><small>A public OpenAPI document</small></span></button>
                    </div>
                  </div>
                  {form.specInput === 'file'
                    ? <div class={`openapi-dropzone ${setupSpecFileName ? 'has-file' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void readSetupSpecification(event.dataTransfer?.files[0]) }}><input ref={setupSpecInput} type="file" accept=".yaml,.yml,.json,application/json,text/yaml" onChange={(event) => void readSetupSpecification(event.currentTarget.files?.[0])} /><span><Icon name={setupSpecFileName ? 'check' : 'publish'} size={20} /></span><strong>{setupSpecFileName || 'Drop your OpenAPI file here'}</strong><Button size="sm" onClick={() => setupSpecInput.current?.click()}>{setupSpecFileName ? 'Choose another file' : 'Browse file'}</Button></div>
                    : <Field label="OpenAPI spec URL" hint="Public URLs and standard OpenAPI formats are supported."><Input class="mono-input" value={form.sourcePath} placeholder="https://api.example.com/openapi.json" onInput={(event) => { update('sourcePath', event.currentTarget.value); update('specContent', ''); setSetupSpecFileName('') }} /></Field>}
                </>}
            </div>
            <footer><Button tone="ghost" onClick={() => setSourceFlowStep('closed')}>Cancel</Button><Button tone="primary" icon="plus" busy={savingSource} disabled={form.sourceKind === 'docs-site' ? docsSiteInspection?.status !== 'completed' || docsSiteInspection.url !== form.sourcePath.trim().replace(/#.*$/, '') && !form.sourcePath.trim() : form.sourceKind === 'directory' ? sourceType === 'git' ? !gitHead || gitFoldersLoading : !form.sourcePath.trim() : form.specInput === 'file' ? !form.specContent.trim() : !form.sourcePath.trim()} onClick={() => void addSetupSource()}>Add source</Button></footer>
          </section></div>}
        </>}

        {step === 3 && <>
          <div class="wizard-group"><span class="field-label">Coding agent</span>
            <div class="radio-rows wizard-agent-rows" role="radiogroup" aria-label="Coding agent">
              {(['claude', 'codex', 'gemini'] as const).map((name) => {
                const entry = state.agents?.find((agent) => agent.name === name)
                const model = agentModels(name)[0]?.label ?? 'default model'
                const status = !entry ? 'not installed' : entry.authentication?.status === 'authenticated' ? 'signed in' : entry.authentication?.status === 'unauthenticated' ? 'signed out' : 'installed'
                const installJob = state.jobs.find((job) => job.type === 'agent:install' && job.agent === name && (job.status === 'running' || job.agent === requestedAgentInstall))
                const installing = installJob?.status === 'running' || (requestedAgentInstall === name && !installJob)
                return <label key={name} class={form.agent === name ? 'selected' : ''}>
                  <input type="radio" name="setup-agent" class="wizard-radio-input" value={name} checked={form.agent === name} disabled={selectedAgentInstallJob?.status === 'running'} onChange={() => chooseAgent(name)} />
                  <span><strong>{agentLabel(name)}</strong><small>{model} · {status}</small></span>
                  {!entry
                    ? <Button size="sm" busy={installing} onClick={(event) => { event.preventDefault(); chooseAgent(name); setRequestedAgentInstall(name); void act(() => post<UiJob | { name: string; executable: string; alreadyInstalled: true }>('/api/agent/install', { agent: name })).then((result) => { if (!result || !('status' in result)) setRequestedAgentInstall('') }) }}>Install</Button>
                    : entry.authentication?.status === 'authenticated' ? <Badge tone="good">Ready</Badge>
                      : entry.authentication?.status === 'unauthenticated' ? <Badge tone="warn">Signed out</Badge>
                        : <Badge tone="neutral">Installed</Badge>}
                </label>
              })}
            </div>
          </div>
          {form.agent && !selectedAgent && selectedAgentInstallJob && <AgentInstallProgress job={selectedAgentInstallJob} onRetry={() => void installSelectedAgent()} />}
          {selectedAgent?.authentication?.status === 'unauthenticated' && <div class="wizard-inline-alert" role="alert">
            <Note tone="warn">{agentLabel(form.agent)} is signed out on this computer. {signInInstruction(form.agent)}.{signedInAlternative ? ` Or use ${agentLabel(signedInAlternative)}, which is signed in.` : ''}</Note>
            <div class="wizard-inline-actions">
              {signedInAlternative && <Button size="sm" tone="primary" onClick={() => chooseAgent(signedInAlternative)}>Use {agentLabel(signedInAlternative)}</Button>}
              <Button size="sm" busy={checkingAgents} onClick={() => void recheckAgents()}>Check again</Button>
            </div>
          </div>}
          <Field label="Model" hint={form.agent ? `Search suggested ${agentLabel(form.agent)} models or enter another model ID.` : 'Select a coding agent first.'}><Combo value={form.model} options={availableModels.map((model) => [model.id, model.label] as const)} disabled={!form.agent} placeholder="Search or enter a model ID" onValueChange={(value) => update('model', value)} /></Field>
          <Field label={form.agent === 'claude' ? 'Effort' : 'Reasoning'} hint={supportedReasoning.length ? 'Higher levels plan more carefully and take longer. Search suggested levels or enter a custom value.' : 'Enter a supported value, or leave blank for the default.'}><Combo value={reasoningValue} options={supportedReasoning.map((value) => [value, value] as const)} disabled={!form.agent} placeholder="Search or enter a value" onValueChange={(value) => update(form.agent === 'claude' ? 'effort' : 'reasoning', value)} /></Field>
          <details class="wizard-advanced">
            <summary><span><strong>Advanced</strong><small>Documentation generator and what each tool supports</small></span><Icon name="chevronDown" size={16} /></summary>
            <div class="wizard-advanced-fields">
              <Field label="Documentation generator" hint="Creates and organizes your documentation site."><Select value={form.generator} onChange={(event) => update('generator', event.currentTarget.value)}>{generators.map((item) => <option value={item.id}>{item.displayName}</option>)}</Select><span class="wizard-field-badges">{form.generator === 'doxbrix' && <span class="badge teal no-dot">Recommended</span>}<GeneratorTierBadge entry={selectedGenerator} /></span></Field>
              <GeneratorPreflightPanel entry={selectedGenerator} result={generatorPreflight} busy={checkingGenerator} onRetry={() => void checkGenerator(form.generator)} />
              <details class="agent-capabilities-details setup-generator-tiers" open={Boolean(selectedGenerator?.tier) && selectedGenerator?.tier !== 'full'}>
                <summary>What each generator supports{selectedGenerator?.tier && selectedGenerator.tier !== 'full' ? ` · ${selectedGenerator.displayName} is ${selectedGenerator.tierLabel ?? selectedGenerator.tier}` : ''}</summary>
                <GeneratorTierMatrix generators={generators} selected={form.generator} />
              </details>
              <details class="agent-capabilities-details setup-agent-capabilities" open={form.agent === 'gemini'}>
                <summary>What each assistant supports{form.agent === 'gemini' ? ' · Gemini is limited in some areas' : ''}</summary>
                <AgentCapabilityMatrix selected={form.agent || undefined} />
              </details>
            </div>
          </details>
          <section class="wizard-box setup-capture-profile" aria-label="Screenshots">
            <div class="wizard-box-row"><span class="wizard-box-title">Add product screenshots</span><Toggle checked={screenshotsOn} label="Add product screenshots" onChange={(checked) => { update('screenshots', screenshotIntentFromChoice(checked ? 'yes' : 'no')); setApplicationReadiness(undefined) }} /></div>
            {screenshotsOn && <div class="wizard-box-body">
              <Field label="Application URL" hint="The address of your running local, demo, or test application. Doxloop captures the screens your guides describe; anything it cannot reach stays text-only."><div class="wizard-addon-row"><Input class="mono-input" value={form.applicationBaseUrl} placeholder="http://localhost:3000" onInput={(event) => update('applicationBaseUrl', event.currentTarget.value)} /><Button aria-label="Check page" disabled={!captureProfileComplete} busy={testingApplication} onClick={() => void testApplication()}>Check</Button></div></Field>
              {applicationReadiness && <div class={`wizard-readiness ${readinessTone}`}><Badge tone={readinessTone}>{readinessLabel}</Badge><span>{applicationReadiness.message}</span></div>}
              <Field label="Starting page" hint="The first application page Doxloop may open. Use / for the home page."><Input class="mono-input" value={form.applicationStartPath} placeholder="/ or /settings/team" onInput={(event) => update('applicationStartPath', event.currentTarget.value)} /></Field>
              {showSignIn ? <>
              <Field label="Sign-in route" hint="Optional. Where the sign-in window opens; leave empty when the app redirects to its sign-in page. Sign in once so screenshots show the signed-in product; the session and test account stay on this computer."><div class="wizard-addon-row"><Input class="mono-input" value={form.applicationLoginPath} placeholder="/login" onInput={(event) => updateSignInField('applicationLoginPath', event.currentTarget.value)} /><Button icon="globe" disabled={!captureProfileComplete || setupAuth?.signIn.active} busy={signInBusy === 'start'} onClick={startBrowserSignIn}>{setupAuth?.session ? 'Sign in again with browser' : 'Sign in with browser'}</Button></div></Field>
              {setupAuth?.session && !setupAuth.signIn.active && <div class="wizard-readiness good"><Badge tone="good">Signed in</Badge><span>A browser session is saved for screenshots.</span></div>}
              {!setupAuth?.session && !typedSetupCredentials && savedSignIns.length > 0 && <div class="radio-rows wizard-saved-sign-ins" role="radiogroup" aria-label="Saved sign-in">
                {savedSignIns.map((match) => <button key={match.path} type="button" role="radio" aria-checked={reuseSignInFrom === match.path} class={reuseSignInFrom === match.path ? 'selected' : ''} onClick={() => { setReuseSignInFrom(reuseSignInFrom === match.path ? '' : match.path); setForm((current) => ({ ...current, applicationSignIn: 'yes', applicationUsername: current.applicationUsername || match.username || '', applicationLoginPath: current.applicationLoginPath || match.loginPath || '' })); setApplicationReadiness(undefined); clearSetupError() }}>
                  <span><strong>Use the saved sign-in from {match.title}</strong><small>{[match.username, match.session ? 'browser session' : '', match.path.split(/[\\/]/).filter(Boolean).at(-1)].filter(Boolean).join(' · ')}</small></span>
                </button>)}
              </div>}
              <Field label="Test account username or email" hint="Optional. For a plain username and password form."><Input value={form.applicationUsername} autocomplete="off" placeholder="docs-demo@example.com" onInput={(event) => updateSignInField('applicationUsername', event.currentTarget.value)} /></Field>
              <Field label="Test account password" hint="Typed by the capture browser, never shown to the agent or saved in the project."><Input type="password" value={form.applicationPassword} autocomplete="new-password" placeholder={reusedSignIn ? 'Using the saved sign-in' : 'Enter a password'} onInput={(event) => updateSignInField('applicationPassword', event.currentTarget.value)} /></Field>
              </> : <Button tone="link" class="wizard-signin-open" onClick={() => setSignInOpen(true)}>My app needs a sign-in</Button>}
              {setupAuth?.signIn.active && <div class="setup-capture-signin-actions"><Note tone={setupAuth.signIn.open ? 'info' : 'warn'}><span>{setupAuth.signIn.open ? <>Sign in in the Chrome window, then choose <strong>Save session</strong>.</> : <>The Chrome window was closed. Choose <strong>Save session</strong> to keep the last signed-in state, or start again.</>}</span></Note><div class="wizard-inline-actions"><Button busy={signInBusy === 'cancel'} onClick={() => void runSignIn('cancel', () => post<SetupCaptureAuth>('/api/setup/application/sign-in/cancel'))}>Cancel</Button><Button tone="primary" busy={signInBusy === 'finish'} onClick={() => void runSignIn('finish', () => post<SetupCaptureAuth>('/api/setup/application/sign-in/finish'))}>Save session</Button></div></div>}
              {applicationReadiness?.status === 'authentication-required' && !skipSignIn && <div><Button size="sm" tone="ghost" onClick={() => { setSkipSignIn(true); clearSetupError() }}>Continue without signing in</Button></div>}
              {skipSignIn && <small class="setup-signin-skipped">Continuing without sign-in: screenshots show only pages visible before sign-in.</small>}
              {captureProfileIssue ? <Note>{captureProfileIssue}</Note> : null}
            </div>}
          </section>
        </>}

        {step === 4 && <DocumentationGuidance
          audiences={form.audiences}
          scope={form.scope}
          readerOutcome={form.readerOutcome}
          preferences={{ experienceLevel: form.experienceLevel, preferredExamples: form.preferredExamples, locale: form.locale, accessibilityTarget: form.accessibilityTarget, exclusions: form.exclusions, terminology: form.terminology, designDirection: form.designDirection, clarificationMode: form.clarificationMode }}
          customInstructions={form.customInstructions}
          onAudiencesChange={(audiences) => setForm((current) => ({ ...current, audiences }))}
          onScopeChange={(scope) => setForm((current) => ({ ...current, scope }))}
          onReaderOutcomeChange={(readerOutcome) => setForm((current) => ({ ...current, readerOutcome }))}
          onPreferencesChange={(preferences) => setForm((current) => ({ ...current, ...preferences }))}
          onInstructionsChange={(customInstructions) => setForm((current) => ({ ...current, customInstructions }))}
        />}

        {step === 5 && <>
          <section class="wizard-panel wizard-summary" aria-label="Documentation configuration">
            <div class="vrows">
              <SummaryRow label="Title" value={`${form.title || 'Untitled documentation'} · ${(form.parentDirectory || defaultParentDirectory).replace(/[\\/]+$/, '')}/${form.directory}`} onEdit={() => setStep(1)} />
              <SummaryRow label="Sources" value={sources.length ? sources.map((source) => source.name).join(' · ') : 'No sources yet'} onEdit={() => setStep(2)} />
              <SummaryRow label="Agent" value={`${agentLabel(form.agent)} · ${form.model || 'default model'}${reasoningValue ? ` · ${reasoningValue}` : ''}${selectedAgent?.authentication?.status === 'unauthenticated' ? ' · signed out' : ''}`} onEdit={() => setStep(3)} />
              <SummaryRow label="Depth" value={`${scopeLabel(form.scope)} · ${describeBatchLimits(batchLimitsForScope(form.scope, form.screenshots))}`} onEdit={() => setStep(4)} />
              <SummaryRow label="Screenshots" value={form.screenshots === 'disabled' ? 'Off' : `On · ${setupApplicationCaptureTarget(form.applicationBaseUrl, form.applicationStartPath)}${form.applicationSignIn === 'yes' ? ` · ${setupAuth?.session ? 'sign-in saved' : reusedSignIn ? `sign-in from ${reusedSignIn.title}` : hasSetupCredentials ? 'test account' : 'without sign-in'}` : ''}`} onEdit={() => setStep(3)} />
              <SummaryRow label="Audience" value={`${form.audiences.length ? form.audiences.join(', ') : 'Agent decides the audience'}${styleLabels(form.customInstructions).length ? ` · ${styleLabels(form.customInstructions).join(', ')}` : ''}`} onEdit={() => setStep(4)} />
              <SummaryRow label="Reader goal" value={form.readerOutcome.trim() || DEFAULT_READER_OUTCOME} onEdit={() => setStep(4)} />
            </div>
          </section>
          <div class="wizard-callout setup-review-ready"><span class="wizard-callout-icon"><Icon name="lock" size={18} /></span><div><strong>Nothing is written until you approve the plan.</strong><small>Planning takes several minutes and produces a plan you can edit before any page is generated.</small></div></div>
          {submitting && sources.some((source) => source.sourceLocation === 'git') && <Note>Downloading read-only repository snapshots and starting documentation planning…</Note>}
        </>}

        {setupError?.step === step && <Note tone="bad">{setupError.message}</Note>}
        {error && <Note tone="bad">{error}</Note>}
        <footer class="wizard-footer setup-actions">
          <span>{step > 1 && <Button tone="ghost" class="setup-back-button wizard-back" icon="arrowRight" disabled={submitting} onClick={() => setStep((value) => value - 1)}>Back</Button>}</span>
          {step === 1 && mode === 'existing'
            ? <span class="setup-existing-hint">Import above to open the folder's pages.</span>
            : step < 5
              ? <Button tone="primary" busy={validatingPaths} disabled={submitting} onClick={() => void continueSetup()}>Continue <Icon name="arrowRight" size={16} /></Button>
              : <Button tone="primary" class="wizard-create" icon="sparkles" busy={submitting} onClick={() => void createDocumentation()}>Create documentation plan</Button>}
        </footer>
      </div>
    </div>
  </div>
}

interface SavedSignIn { path: string; title: string; username?: string; session: boolean; loginPath?: string }

const SETUP_STEPS = ['Workspace', 'Sources', 'Agent', 'Guidance', 'Review'] as const

function SummaryRow({ label, value, onEdit }: { label: string; value: string; onEdit: () => void }) {
  return <div class="vrow"><span class="vrow-label">{label}<small>{value}</small></span><span class="vrow-value"><Button tone="link" aria-label={`Edit ${label.toLowerCase()}`} onClick={onEdit}>Edit</Button></span></div>
}

const AUDIENCE_SUGGESTIONS = [
  'Developers',
  'API consumers',
  'Administrators',
  'End users',
  'Technical decision-makers',
] as const

const INSTRUCTION_SUGGESTIONS = [
  ['Beginner-friendly', 'Explain unfamiliar concepts for readers who are new to the product.'],
  ['Concise', 'Keep explanations concise and action-oriented.'],
  ['Code-heavy', 'Prioritize practical code examples where the sources support them.'],
  ['Include examples', 'Include realistic examples for important workflows.'],
] as const

function styleLabels(customInstructions: string): string[] {
  const lines = customInstructions.split('\n').map((line) => line.trim())
  return INSTRUCTION_SUGGESTIONS.filter(([, instruction]) => lines.includes(instruction)).map(([label]) => label.toLowerCase())
}

function DocumentationGuidance({ audiences, scope, readerOutcome, preferences, customInstructions, onAudiencesChange, onScopeChange, onReaderOutcomeChange, onPreferencesChange, onInstructionsChange }: {
  audiences: string[]
  scope: 'starter' | 'standard' | 'comprehensive'
  readerOutcome: string
  preferences: SetupGuidancePreferences
  customInstructions: string
  onAudiencesChange: (audiences: string[]) => void
  onScopeChange: (scope: 'starter' | 'standard' | 'comprehensive') => void
  onReaderOutcomeChange: (outcome: string) => void
  onPreferencesChange: (preferences: Partial<SetupGuidancePreferences>) => void
  onInstructionsChange: (instructions: string) => void
}) {
  const [audienceInput, setAudienceInput] = useState('')
  // Picked audiences show as tokens in the field, so the suggestions only
  // offer what is not chosen yet and the row never reflows under the pointer.
  const matchingSuggestions = AUDIENCE_SUGGESTIONS.filter((suggestion) =>
    suggestion.toLowerCase().includes(audienceInput.trim().toLowerCase()) &&
    !audiences.some((item) => item.toLowerCase() === suggestion.toLowerCase()),
  )
  const addAudience = (value: string) => {
    const audience = value.trim().replace(/,$/, '').trim()
    if (!audience || audiences.some((item) => item.toLowerCase() === audience.toLowerCase())) {
      setAudienceInput('')
      return
    }
    onAudiencesChange([...audiences, audience])
    setAudienceInput('')
  }
  const toggleAudience = (audience: string) => {
    const selected = audiences.some((item) => item.toLowerCase() === audience.toLowerCase())
    onAudiencesChange(selected
      ? audiences.filter((item) => item.toLowerCase() !== audience.toLowerCase())
      : [...audiences, audience])
  }
  const instructionLines = customInstructions.split('\n').map((line) => line.trim())
  const toggleInstruction = (instruction: string) => {
    const lines = instructionLines.filter(Boolean)
    onInstructionsChange(lines.includes(instruction)
      ? lines.filter((line) => line !== instruction).join('\n')
      : [...lines, instruction].join('\n'))
  }
  return <>
    <div class="wizard-group"><span class="field-label">Documentation depth</span>
      <div class="radio-rows" role="radiogroup" aria-label="Documentation depth">
        {([
          ['starter', 'Starter', 'A quickstart and the essentials'],
          ['standard', 'Standard', 'Guides for every main workflow, concepts and troubleshooting'],
          ['comprehensive', 'Comprehensive', 'Every surface, reference included', 'Recommended'],
        ] as const).map(([value, label, detail, badge]) => <button type="button" role="radio" aria-checked={scope === value} class={scope === value ? 'selected' : ''} onClick={() => onScopeChange(value)} key={value}><span><strong>{label}</strong><small>{detail}</small></span>{badge && <span class="badge teal no-dot">{badge}</span>}</button>)}
      </div>
    </div>
    <div class="wizard-group">
      <span class="field-label">Who is this documentation for?<span class="field-hint" tabIndex={0} role="img" aria-label="Optional. Name the readers so the planner can choose the right depth and examples. Press Enter after each audience." data-hint="Optional. Name the readers so the planner can choose the right depth and examples. Press Enter after each audience."><Icon name="info" size={12} /></span></span>
      <div class="audience-picker input" onClick={(event) => (event.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
        {audiences.map((audience) => <span class="audience-token" key={audience}>{audience}<button type="button" aria-label={`Remove ${audience}`} onClick={(event) => { event.stopPropagation(); toggleAudience(audience) }}><Icon name="close" size={11} /></button></span>)}
        <input value={audienceInput} aria-label="Add an audience" placeholder={audiences.length ? 'Add another audience…' : 'Backend developers evaluating the product for a new app'} onInput={(event) => setAudienceInput(event.currentTarget.value)} onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ',') {
            event.preventDefault()
            addAudience(event.currentTarget.value)
          } else if (event.key === 'Backspace' && !event.currentTarget.value && audiences.length) {
            onAudiencesChange(audiences.slice(0, -1))
          }
        }} onBlur={() => addAudience(audienceInput)} />
      </div>
      {matchingSuggestions.length > 0 && <div class="wizard-chips" aria-label="Suggested audiences">
        {matchingSuggestions.map((audience) => <button type="button" class={`chip ${audiences.includes(audience) ? 'on' : ''}`} aria-pressed={audiences.includes(audience)} onMouseDown={(event) => event.preventDefault()} onClick={() => toggleAudience(audience)} key={audience}>{audiences.includes(audience) && <Icon name="check" size={14} />}{audience}</button>)}
      </div>}
    </div>
    <div class="wizard-group"><span class="field-label">Style</span>
      <div class="wizard-chips" aria-label="Suggested writing instructions">
        {INSTRUCTION_SUGGESTIONS.map(([label, instruction]) => <button type="button" class={`chip ${instructionLines.includes(instruction) ? 'on' : ''}`} aria-pressed={instructionLines.includes(instruction)} onClick={() => toggleInstruction(instruction)} key={label}>{instructionLines.includes(instruction) && <Icon name="check" size={14} />}{label}</button>)}
      </div>
    </div>
    <details class="wizard-advanced setup-guidance-advanced">
      <summary><span><strong>Advanced planning preferences</strong><small>Reader experience, locale, terminology, exclusions, open-question policy</small></span><Icon name="chevronDown" size={16} /></summary>
      <div class="wizard-advanced-fields">
        <Field label="What should readers be able to do?" hint="The outcomes the documentation must make possible. Leave it empty to use the default shown."><Input value={readerOutcome} placeholder={DEFAULT_READER_OUTCOME} onInput={(event) => onReaderOutcomeChange(event.currentTarget.value)} /></Field>
        <Field label="Reader experience"><Select value={preferences.experienceLevel} onChange={(event) => onPreferencesChange({ experienceLevel: event.currentTarget.value as SetupGuidancePreferences['experienceLevel'] })}><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option><option value="mixed">Mixed experience</option></Select></Field>
        <Field label="Preferred examples" hint="Comma-separated languages or tools"><Input value={preferences.preferredExamples} placeholder="TypeScript, curl" onInput={(event) => onPreferencesChange({ preferredExamples: event.currentTarget.value })} /></Field>
        <Field label="Locale"><Input value={preferences.locale} placeholder="en-US" onInput={(event) => onPreferencesChange({ locale: event.currentTarget.value })} /></Field>
        <Field label="Accessibility target"><Input value={preferences.accessibilityTarget} placeholder="WCAG 2.2 AA" onInput={(event) => onPreferencesChange({ accessibilityTarget: event.currentTarget.value })} /></Field>
        <Field label="Terminology" hint="One term = guidance per line"><Textarea rows={3} value={preferences.terminology} placeholder="access key = API access token" onInput={(event) => onPreferencesChange({ terminology: event.currentTarget.value })} /></Field>
        <Field label="Exclusions" hint="Comma-separated"><Textarea rows={3} value={preferences.exclusions} placeholder="Internal APIs, unreleased features" onInput={(event) => onPreferencesChange({ exclusions: event.currentTarget.value })} /></Field>
        <Field label="Design direction"><Textarea rows={3} value={preferences.designDirection} placeholder="Use the product brand and prioritize a compact developer-focused layout." onInput={(event) => onPreferencesChange({ designDirection: event.currentTarget.value })} /></Field>
        <Field label="If the planner has questions"><Select value={preferences.clarificationMode} onChange={(event) => onPreferencesChange({ clarificationMode: event.currentTarget.value as SetupGuidancePreferences['clarificationMode'] })}><option value="review">Ask me in the review screen</option><option value="defaults">Use recommended defaults when possible</option><option value="stop">Stop and wait for explicit answers</option></Select></Field>
        <Field label="Custom instructions" hint="Free-form guidance for the writer. Style choices above are kept here as lines."><Textarea rows={5} value={customInstructions} placeholder="For example: Use concise explanations, include TypeScript examples, and add troubleshooting sections." onInput={(event) => onInstructionsChange(event.currentTarget.value)} /></Field>
      </div>
    </details>
  </>
}

function scopeLabel(scope: 'starter' | 'standard' | 'comprehensive'): string {
  return scope[0]!.toUpperCase() + scope.slice(1)
}

function splitSetupList(value: string): string[] {
  return [...new Set(value.split(/[,\n]/).map((item) => item.trim()).filter(Boolean))]
}

function parseSetupTerminology(value: string): Record<string, string> {
  return Object.fromEntries(value.split('\n').flatMap((line) => {
    const separator = line.indexOf('=')
    if (separator <= 0) return []
    const term = line.slice(0, separator).trim()
    const guidance = line.slice(separator + 1).trim()
    return term && guidance ? [[term, guidance]] : []
  }))
}

function ValidatedSetupInput({ value, valid, invalid, onInput }: { value: string; valid: boolean; invalid?: boolean; onInput: (value: string) => void }) {
  return <div class="validated-setup-input"><Input value={value} aria-invalid={Boolean(invalid)} onInput={(event) => onInput(event.currentTarget.value)} />{valid && <Icon name="check" size={14} />}</div>
}

function RepositoryConnectButton({ connected, busy, disabled, onClick }: { connected: boolean; busy: boolean; disabled: boolean; onClick: () => void }) {
  const label = connected ? 'Repository connected' : busy ? 'Connecting repository' : 'Connect repository'
  return <button type="button" class={`repository-connect-button ${connected ? 'connected' : ''}`} aria-label={label} title={label} disabled={disabled || busy || connected} onClick={onClick}>
    {busy ? <span class="repository-connect-spinner" /> : <Icon name={connected ? 'check' : 'link'} size={19} />}
  </button>
}

function RepositoryFolderSelect({ value, directories, loading, connected, onChange }: {
  value: string
  directories: string[]
  loading: boolean
  connected: boolean
  onChange: (value: string) => void
}) {
  const hint = loading
    ? 'Loading folders…'
    : connected
      ? directories.length ? `${directories.length} folders available. Choose one or use the entire repository.` : 'This repository has no folders, so the entire repository will be used.'
      : 'Connect the repository to browse its folders.'
  return <Field label="Folder within repository" hint={hint}>
    <Select value={value} disabled={!connected || loading} onChange={(event) => onChange(event.currentTarget.value)}>
      <option value="">Entire repository</option>
      {value && !directories.includes(value) && <option value={value}>{value}</option>}
      {directories.map((directory) => <option key={directory} value={directory}>{directory}</option>)}
    </Select>
  </Field>
}


type Action = <T>(run: () => Promise<T>, success?: string, refresh?: boolean) => Promise<T | undefined>

function readSetupDraft(key: string): { form: Record<string, unknown>; sources: unknown[]; step: number } | undefined {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) ?? 'null') as { form?: unknown; sources?: unknown; step?: unknown } | null
    if (!parsed || typeof parsed.form !== 'object' || !parsed.form || !Array.isArray(parsed.sources)) return undefined
    const step = typeof parsed.step === 'number' && parsed.step >= 1 && parsed.step <= 5 ? Math.floor(parsed.step) : 1
    // Only a draft that got past the first screen is worth restoring.
    return step > 1 || parsed.sources.length ? { form: parsed.form as Record<string, unknown>, sources: parsed.sources, step } : undefined
  } catch {
    return undefined
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function agentLabel(value: string): string {
  return value === 'claude' ? 'Claude Code' : value === 'codex' ? 'Codex' : 'Gemini'
}

function AgentInstallProgress({ job, onRetry }: { job: UiJob; onRetry: () => void }) {
  const label = job.agent ? agentLabel(job.agent) : 'Agent'
  if (job.status === 'running') return <div class="agent-install-progress"><span class="spinner" /><span>Installing {label}…</span></div>
  if (job.status === 'succeeded') return <div class="agent-install-progress good"><Icon name="check" size={14} /><span>{label} installed</span></div>
  return <div class="agent-install-progress bad"><Icon name="alert" size={14} /><span>Installation failed</span><Button size="sm" onClick={onRetry}>Try again</Button></div>
}
