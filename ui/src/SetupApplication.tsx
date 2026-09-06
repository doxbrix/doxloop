import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import './SetupApplication.css'
import { api, post, NO_TIMEOUT } from './api'
import { Button, Combo, Field, Input, Note, Segmented, Select, Textarea, Toggle } from './components'
import { Icon } from './icons'
import { agentModels, defaultModelForAgent, modelReasoningLevels, preferredReasoningLevel } from './model-options'
import { ImportExistingPanel } from './ProjectSwitcher'
import { AgentCapabilityMatrix } from './agent-capabilities'
import { GeneratorPreflightPanel, GeneratorTierBadge, GeneratorTierMatrix } from './generator-tiers'
import { DEFAULT_READER_OUTCOME, screenshotIntentFromChoice, setupApplicationCaptureTarget, setupCaptureProfileStatus, setupDocumentationPlanRequest } from './setup-plan'
import type { GeneratorPreflight, UiJob, UiState } from './types'

const DOXLOOP_LOGO = new URL('../../assets/brand/doxloop-logo-light.png', import.meta.url).href

type OpenApiSummary = { title: string; version: string; specificationVersion: string; servers: string[]; securitySchemes: string[]; schemas: string[]; operationCount: number }
type SetupValidation = { directoryPath?: string; directoryError?: string; sourcePath?: string; sourcePathError?: string; openapiSummary?: OpenApiSummary }
type ApplicationReadiness = { configured: boolean; reachable: boolean; status: 'not-configured' | 'ready' | 'authentication-required' | 'unreachable'; url?: string; message: string; authentication?: 'none' | 'session' | 'credentials' | 'expired' }
type SetupCaptureAuth = { session?: { savedAt: string; origin: string; cookies: number; origins: number }; signIn: { active: boolean; open?: boolean; url?: string; currentUrl?: string } }

type SetupSource = {
  name: string
  sourceKind: 'directory' | 'openapi'
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
}

type SourceFlowStep = 'closed' | 'type' | 'source-location' | 'git-access' | 'git-connect' | 'git-select' | 'local' | 'openapi-format' | 'openapi-input'

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
  const [form, setForm] = useState(() => {
    const agent = state.agents?.find((item) => item.executable)?.name ?? 'codex'
    const model = defaultModelForAgent(agent)
    const reasoning = preferredReasoningLevel(agent, model)
    return {
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
      screenshots: 'disabled' as 'auto' | 'enabled' | 'disabled',
      applicationBaseUrl: '',
      applicationStartPath: '/',
      applicationSignIn: 'no' as 'no' | 'yes',
      applicationLoginPath: '',
      applicationUsername: '',
      applicationPassword: '',
      audiences: [] as string[],
      scope: 'comprehensive' as 'starter' | 'standard' | 'comprehensive',
      readerOutcome: DEFAULT_READER_OUTCOME,
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
  })
  const [step, setStep] = useState(1)
  const [sources, setSources] = useState<SetupSource[]>([])
  const [sourceFlowStep, setSourceFlowStep] = useState<SourceFlowStep>('closed')
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const [sourceAddedNotice, setSourceAddedNotice] = useState(false)
  // The confirmation is a toast, not a gate: it leaves on its own so it never
  // sits on top of the wizard footer on a short viewport.
  useEffect(() => {
    if (!sourceAddedNotice) return
    const timer = setTimeout(() => setSourceAddedNotice(false), 4000)
    return () => clearTimeout(timer)
  }, [sourceAddedNotice])
  useEffect(() => { setSourceAddedNotice(false) }, [step])
  const [setupSpecFileName, setSetupSpecFileName] = useState('')
  const setupSpecInput = useRef<HTMLInputElement>(null)
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
  const [setupAuth, setSetupAuth] = useState<SetupCaptureAuth>()
  const [signInBusy, setSignInBusy] = useState<'' | 'start' | 'finish' | 'cancel' | 'forget'>('')
  const [projectCreated, setProjectCreated] = useState(false)
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
  const update = (key: string, value: string) => {
    setForm((current) => ({ ...current, [key]: value }))
    clearSetupError()
    if (key === 'directory') setPathErrors((current) => ({ ...current, directory: '' }))
    if (key === 'generator') setGeneratorPreflight(undefined)
    if (key === 'sourcePath' || key === 'sourceKind') setPathErrors((current) => ({ ...current, sourcePath: '' }))
    if (key.startsWith('application')) setApplicationReadiness(undefined)
    if (['repository', 'authMethod', 'gitUsername', 'gitSecret', 'sourceLocation'].includes(key)) {
      setPathErrors((current) => ({ ...current, sourcePath: '' }))
      setGitHead('')
      setGitDirectories([])
    }
  }
  const captureProfile = setupCaptureProfileStatus(form)
  const captureProfileRequired = captureProfile.required
  const captureProfileComplete = captureProfile.complete
  const setupApplication = () => ({
    baseUrl: form.applicationBaseUrl,
    readyPath: form.applicationStartPath,
    screenshots: { policy: 'auto', startPath: form.applicationStartPath },
    ...(form.applicationSignIn === 'yes' && form.applicationLoginPath.trim() ? { authentication: { loginPath: form.applicationLoginPath.trim() } } : {}),
  })
  const hasSetupCredentials = form.applicationSignIn === 'yes' && Boolean(form.applicationUsername.trim() && form.applicationPassword)
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
  const testApplication = async () => {
    setTestingApplication(true)
    clearSetupError()
    try {
      const application = { ...setupApplication(), hasCredentials: hasSetupCredentials }
      setApplicationReadiness(await post<ApplicationReadiness>('/api/setup/application/readiness', application))
    } catch (cause) {
      setApplicationReadiness({ configured: true, reachable: false, status: 'unreachable', message: message(cause) })
    } finally {
      setTestingApplication(false)
    }
  }
  const sourceType = form.sourceKind === 'openapi' ? 'openapi' : form.sourceLocation === 'git' ? 'git' : 'local'
  const filteredSetupSources = sources.map((source, index) => ({ source, index }))
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
    sourceKind: form.sourceKind as 'directory' | 'openapi',
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
  })
  const validatePaths = async (includeSource: boolean, source = currentSource()): Promise<SetupValidation | undefined> => {
    try {
      const result = await post<SetupValidation>('/api/setup/validate', {
        directory: form.directory,
        ...(form.parentDirectory ? { parentDirectory: form.parentDirectory } : {}),
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
      if (step === 1) {
        const result = await validatePaths(false)
        if (!result || result.directoryError) return
      }
      if (step === 2) {
        for (const source of sources) {
          if (source.sourceKind === 'openapi' && source.specInput === 'file' && source.specContent.trim()) continue
          const result = await validatePaths(true, source)
          if (!result || result.directoryError || result.sourcePathError) return
        }
      }
      if (step === 3 && captureProfileRequired) {
        // A plan with screenshots is long; do not start one that will fail
        // at capture time because the application was never reached.
        if (!captureProfileComplete) { failStep(3, 'Enter the application URL and starting page, or choose No for screenshots.'); return }
        if (applicationReadiness?.status !== 'ready') { failStep(3, 'Check the application page successfully before continuing, or choose No for screenshots.'); return }
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
    const fallback = draft.sourceKind === 'openapi' ? 'OpenAPI Specification' : draft.sourceLocation === 'git' ? 'Git Repository' : 'Local Repository'
    const segment = location.replace(/[?#].*$/, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/\.git$/i, '').replace(/\.(json|ya?ml)$/i, '')
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
      setSourceMenuOpen(false)
      setSourceAddedNotice(true)
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
      if (captureProfileRequired && !captureProfileComplete) {
        setStep(3)
        failStep(3, 'Enter the application URL and starting page, or choose No for screenshots.')
        return
      }
      if (captureProfileRequired && applicationReadiness?.status !== 'ready') {
        setStep(3)
        failStep(3, 'Check the application page successfully before creating a plan with screenshots.')
        return
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
          if (!validation || validation.sourcePathError) {
            setStep(2)
            return
          }
        }
      }
      if (!projectCreated) {
        const created = await act(() => post<UiState>('/api/project', {
          ...form,
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
            ...(hasSetupCredentials ? { applicationCredentials: { username: form.applicationUsername.trim(), password: form.applicationPassword } } : {}),
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
      }
      const result = await act(() => post<{ job: UiJob }>('/api/plans', setupDocumentationPlanRequest(form)), undefined, false)
      if (!result) {
        failStep(5, 'The documentation plan could not be started. Review the configuration and try again.')
        return
      }
      await onContinue('authoring')
    } finally {
      setSubmitting(false)
    }
  }
  return <div class="setup reference-setup">
    <section class="setup-panel">
      <aside class="setup-rail">
        <div class="doxloop-sidebar-brand"><span><img src={DOXLOOP_LOGO} alt="Doxloop" /></span></div>
        <div class="setup-sidebar-heading"><strong>Create documentation</strong><small>Configure your documentation workspace</small></div>
        {onCancel && <button type="button" class="setup-cancel-button" onClick={onCancel}><Icon name="chevronRight" size={14} /><span>Back to {state.project?.title ?? 'workspace'}</span></button>}
        <nav class="reference-sidebar-nav setup-reference-nav" aria-label="Setup navigation">{([['folder', 'Workspace', 'Name your workspace'], ['sources', 'Sources', 'Connect your content'], ['settings', 'Tools', 'Configure generation'], ['users', 'Guidance', 'Audience and instructions'], ['check', 'Review', 'Review and plan']] as const).map(([icon, label, detail], index) => <button type="button" key={label} disabled={submitting || index + 1 > step} class={step === index + 1 ? 'active' : ''} onClick={() => setStep(index + 1)}><Icon name={icon} size={18} /><span><strong>{label}</strong><small>{detail}</small></span></button>)}</nav>
      </aside>
      <div class={`setup-body ${step === 1 ? 'setup-home-body' : step === 5 ? 'setup-review-body' : ''}`}>
        {step === 1 && <div class="setup-home-card">
          <header class="setup-home-heading"><span><Icon name="folder" size={34} /></span><div><h1>{mode === 'new' ? "Let's name your workspace" : 'Use existing documentation'}</h1><p>{mode === 'new' ? "This will be your docs' home in Doxloop." : 'Point Doxloop at a documentation site you already have. Nothing in it is changed.'}</p></div></header>
          <div class="setup-mode-choice" role="radiogroup" aria-label="How to start">
            <button type="button" role="radio" aria-checked={mode === 'new'} class={mode === 'new' ? 'selected' : ''} onClick={() => { setMode('new'); clearSetupError() }}><span><Icon name="sparkle" size={20} /></span><strong>Start new</strong><small>Create a fresh documentation site from your sources.</small></button>
            <button type="button" role="radio" aria-checked={mode === 'existing'} class={mode === 'existing' ? 'selected' : ''} onClick={() => { setMode('existing'); clearSetupError() }}><span><Icon name="folder" size={20} /></span><strong>Use existing documentation folder</strong><small>Adopt a Docusaurus, MkDocs, Hugo, Sphinx, or other site as it is.</small></button>
          </div>
          {mode === 'existing' && <div class="setup-import-existing"><ImportExistingPanel onImported={() => onContinue('pages')} /></div>}
          {mode === 'new' && <section class="setup-home-location-field"><Field label="Location" hint="The folder the new workspace is created in. Keep it outside your product source, usually the parent folder of the checkout."><div class="source-folder-input"><Input value={form.parentDirectory || state.cwd} onInput={(value) => update('parentDirectory', value.currentTarget.value)} /><Button icon="folder" busy={browsingLocation} onClick={() => void browseProjectLocation()}>Browse</Button></div></Field></section>}
          {mode === 'new' && <div class="setup-home-fields"><section class="setup-home-field"><span class="setup-home-field-icon workspace"><Icon name="folder" size={25} /></span><Field label="Workspace name" hint="This is the folder where your docs will live."><ValidatedSetupInput value={form.directory} valid={Boolean(form.directory.trim()) && !pathErrors.directory} invalid={Boolean(pathErrors.directory)} onInput={(value) => update('directory', value)} />{pathErrors.directory && <small class="field-error">{pathErrors.directory}</small>}</Field></section><section class="setup-home-field"><span class="setup-home-field-icon title">T<small>T</small></span><Field label="What should we call your docs?" hint="This is the title people will see."><ValidatedSetupInput value={form.title} valid={Boolean(form.title.trim())} onInput={(value) => update('title', value)} /></Field></section></div>}
        </div>}
        {step === 2 && <><header class="sources-page-header setup-sources-header"><div><h1>Sources</h1><p>Manage all the sources you've connected to create documentation.</p></div><div class="sources-page-tools"><div class="sources-add-wrap"><button type="button" class="sources-add-dropdown-button" aria-expanded={sourceMenuOpen} onClick={() => setSourceMenuOpen((open) => !open)}><Icon name="plus" size={16} />Add source<Icon name="chevronDown" size={14} /></button>{sourceMenuOpen && <div class="sources-add-menu"><button type="button" onClick={() => { resetSourceDraft(); setForm((current) => ({ ...current, sourceKind: 'directory', sourceLocation: 'git' })); setSourceFlowStep('source-location') }}><span><Icon name="api" size={20} /></span><span><strong>Source code</strong></span></button><button type="button" onClick={() => { resetSourceDraft(); setForm((current) => ({ ...current, sourceKind: 'openapi' })); setSourceFlowStep('openapi-format') }}><span><Icon name="braces" size={20} /></span><span><strong>OpenAPI spec</strong></span></button></div>}</div></div></header>
          <section class="sources-data-panel setup-sources-table"><header>All sources ({sources.length})</header><div class="sources-table-head"><span>Name</span><span>Type</span><span>Details</span><span>Status</span><span /></div>{filteredSetupSources.length ? <div class="sources-table-body">{filteredSetupSources.map(({ source, index }) => <div class="sources-data-row" key={`${source.name}-${index}`}><span class="sources-name-cell"><span class={`source-service-icon ${source.sourceKind === 'openapi' ? 'openapi' : source.sourceLocation === 'git' ? `git ${repositoryProvider(source.repository)}` : 'local'}`}><Icon name={source.sourceKind === 'openapi' ? 'braces' : source.sourceLocation === 'git' ? repositoryProviderIcon(source.repository) : 'folder'} size={20} /></span><span><strong>{source.name}</strong><small>{source.sourceKind === 'openapi' ? source.sourcePath || 'Uploaded OpenAPI specification' : source.sourceLocation === 'git' ? source.repository : source.sourcePath}</small></span></span><span><em class={`source-type-pill ${source.sourceKind === 'openapi' ? 'openapi' : source.sourceLocation}`}>{source.sourceKind === 'openapi' ? 'OpenAPI' : source.sourceLocation === 'git' ? 'Git' : 'Local'}</em></span><span class="source-updated">{source.sourceKind === 'openapi' ? source.openapiSummary ? `${source.openapiSummary.title} ${source.openapiSummary.version} · ${source.openapiSummary.operationCount} operations` : 'Specification' : source.sourceLocation === 'git' ? `${source.branch}${source.subdirectory ? ` / ${source.subdirectory}` : ''}` : 'Local folder'}</span><span><em class="source-sync-status"><Icon name="check" size={12} />Validated</em></span><span class="source-row-menu"><button type="button" aria-label={`Delete ${source.name}`} title="Delete source" onClick={() => setSources((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Icon name="trash" size={22} /></button></span></div>)}</div> : <div class="sources-table-empty"><Icon name={sources.length ? 'search' : 'sources'} size={28} /><strong>{sources.length ? 'No matching sources' : 'No sources added yet'}</strong><small>{sources.length ? 'Try a different name, URL, path, or source type.' : 'Use “Add source” to connect your first source.'}</small></div>}<footer><span>Showing {filteredSetupSources.length ? `1 to ${filteredSetupSources.length}` : '0'} of {sources.length} results</span><span><button disabled><Icon name="chevronRight" size={14} /></button><button disabled><Icon name="chevronRight" size={14} /></button></span></footer></section>
          {sourceAddedNotice && <div class="source-added-success"><span><Icon name="check" size={20} /></span><div><strong>Source added successfully!</strong><small>The source will appear in the list.</small></div><button type="button" aria-label="Dismiss" onClick={() => setSourceAddedNotice(false)}><Icon name="close" size={13} /></button></div>}
          {sourceFlowStep !== 'closed' && <div class="sources-modal-scrim" onClick={() => setSourceFlowStep('closed')}><section class={`sources-reference-dialog ${form.sourceKind === 'openapi' ? 'openapi' : 'source'}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <header>{form.sourceKind === 'openapi' && <span class="sources-dialog-icon"><Icon name="file" size={24} /></span>}<div><h2>{form.sourceKind === 'openapi' ? 'Add OpenAPI spec' : 'Add source code'}</h2><p>{form.sourceKind === 'openapi' ? 'Import your OpenAPI specification from a local file or a public URL.' : 'Choose how you want to connect your source code.'}</p></div><button type="button" aria-label="Close" onClick={() => setSourceFlowStep('closed')}><Icon name="close" size={17} /></button></header>
            {form.sourceKind === 'directory' ? <div class="sources-dialog-body"><span class="dialog-section-label">Source type</span><div class="source-mode-grid"><button type="button" class={sourceType === 'git' ? 'selected' : ''} onClick={() => updateSourceType('git')}><span><Icon name="api" size={22} /></span><i /><strong>Git repository</strong><small>Connect a GitHub, GitLab, Azure DevOps or other Git service.</small></button><button type="button" class={sourceType === 'local' ? 'selected' : ''} onClick={() => updateSourceType('local')}><span><Icon name="folder" size={22} /></span><i /><strong>Local folder</strong><small>Use a folder on your computer or network.</small></button></div>{sourceType === 'git' ? <div class="source-code-fields"><Field label="Repository access"><Select value={form.authMethod} onChange={(event) => { update('authMethod', event.currentTarget.value); editGitConnection() }}><option value="automatic">Public repository</option><option value="credentials">Private repository</option></Select></Field><Field label="Repository URL"><div class="repository-connect-input"><Input value={form.repository} onInput={(event) => { update('repository', event.currentTarget.value); editGitConnection() }} /><RepositoryConnectButton connected={Boolean(gitHead)} busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && (!form.gitUsername.trim() || !form.gitSecret.trim()))} onClick={() => void testGitConnection()} /></div></Field>{form.authMethod === 'credentials' && <div class="private-git-fields"><Field label="Username"><Input value={form.gitUsername} autocomplete="username" onInput={(event) => { update('gitUsername', event.currentTarget.value); editGitConnection() }} /></Field><Field label="Personal Access Token (PAT)"><Input type="password" value={form.gitSecret} autocomplete="off" onInput={(event) => { update('gitSecret', event.currentTarget.value); editGitConnection() }} /></Field></div>}<div class="source-branch-grid"><Field label="Branch"><Select value={form.branch} disabled={!gitHead || gitTesting} onChange={(event) => void selectGitBranch(event.currentTarget.value)}>{gitBranches.length ? gitBranches.map((branch) => <option key={branch}>{branch}</option>) : <option>{gitTesting ? 'Connecting...' : 'Connect repository first'}</option>}</Select></Field><Field label="Folder (optional)"><Select value={form.subdirectory} disabled={!gitHead || gitFoldersLoading} onChange={(event) => update('subdirectory', event.currentTarget.value)}><option value="">/</option>{gitDirectories.map((directory) => <option key={directory}>{directory}</option>)}</Select></Field></div></div> : <Field label="Local folder"><div class="source-folder-input"><Input value={form.sourcePath} aria-invalid={Boolean(pathErrors.sourcePath)} onInput={(event) => { update('sourcePath', event.currentTarget.value); setPathErrors((current) => ({ ...current, sourcePath: '' })) }} /><Button icon="folder" busy={browsing} onClick={() => void browseSourceDirectory()}>Browse</Button></div></Field>}{pathErrors.sourcePath && <p class="field-error" role="alert">{pathErrors.sourcePath}</p>}</div> : <div class="sources-dialog-body openapi-body"><div class="openapi-tabs"><button type="button" class={form.specInput === 'file' ? 'active' : ''} onClick={() => update('specInput', 'file')}><Icon name="publish" size={18} />Upload file</button><button type="button" class={form.specInput === 'url' ? 'active' : ''} onClick={() => update('specInput', 'url')}><Icon name="external" size={18} />From URL</button></div>{form.specInput === 'file' ? <div class={`openapi-dropzone ${setupSpecFileName ? 'has-file' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void readSetupSpecification(event.dataTransfer?.files[0]) }}><input ref={setupSpecInput} type="file" accept=".yaml,.yml,.json,application/json,text/yaml" onChange={(event) => void readSetupSpecification(event.currentTarget.files?.[0])} /><span><Icon name={setupSpecFileName ? 'check' : 'publish'} size={28} /></span><strong>{setupSpecFileName || 'Drag and drop your OpenAPI file here'}</strong>{!setupSpecFileName && <small>or</small>}<Button onClick={() => setupSpecInput.current?.click()}>{setupSpecFileName ? 'Choose another file' : 'Browse file'}</Button><em>Accepted formats: .yaml, .yml, .json</em></div> : <Field label="OpenAPI spec URL"><div class="openapi-url-input"><Icon name="external" size={18} /><Input value={form.sourcePath} onInput={(event) => { update('sourcePath', event.currentTarget.value); update('specContent', ''); setSetupSpecFileName('') }} /></div><small>We support public URLs and standard OpenAPI formats.</small></Field>}</div>}
            <footer><Button onClick={() => setSourceFlowStep('closed')}>Cancel</Button><Button tone="primary" busy={savingSource} disabled={form.sourceKind === 'directory' ? sourceType === 'git' ? !gitHead || gitFoldersLoading : !form.sourcePath.trim() : form.specInput === 'file' ? !form.specContent.trim() : !form.sourcePath.trim()} onClick={() => void addSetupSource()}>Add source</Button></footer>
          </section></div>}
        </>}
        {step === 3 && <div class="setup-tools-stage"><SetupStepHeading visual="🪄" title="Configure your tools" detail="Choose how Doxloop should generate your documentation." />
          <div class="setup-tools"><Field label="Documentation generator" hint="Creates and organizes your documentation."><Select value={form.generator} onChange={(event) => update('generator', event.currentTarget.value)}>{generators.map((item) => <option value={item.id}>{item.displayName}</option>)}</Select>{form.generator === 'doxbrix' && <small class="recommended-label"><Icon name="sparkle" size={12} />Recommended</small>}<GeneratorTierBadge entry={selectedGenerator} /></Field><Field label="Coding assistant" hint="Helps understand and explain your product."><Select value={form.agent} disabled={selectedAgentInstallJob?.status === 'running'} onChange={(event) => {
            const agent = event.currentTarget.value
            const model = defaultModelForAgent(agent)
            const level = preferredReasoningLevel(agent, model)
            setRequestedAgentInstall('')
            setForm((current) => ({ ...current, agent, model, reasoning: agent === 'codex' ? level : '', effort: agent === 'claude' ? level : '' }))
          }}><option value="">Select coding assistant</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select>{form.agent === 'codex' && <small class="recommended-label"><Icon name="sparkle" size={12} />Recommended</small>}</Field>
            {form.agent && !selectedAgent && <div class="setup-agent-readiness missing">
              <span class="setup-agent-readiness-icon"><Icon name="alert" size={17} /></span>
              <div class="setup-agent-readiness-copy"><strong>{agentLabel(form.agent)} is not installed</strong><small>Install this coding agent to continue creating your documentation.</small></div>
              {selectedAgentInstallJob
                ? <AgentInstallProgress job={selectedAgentInstallJob} onRetry={() => void installSelectedAgent()} />
                : <Button size="sm" tone="primary" busy={agentInstallPending} onClick={() => void installSelectedAgent()}>Install {agentLabel(form.agent)}</Button>}
            </div>}
            <Field label="Select Model" hint={form.agent ? `Search suggested ${agentLabel(form.agent)} models or enter another model ID.` : 'Select a coding assistant first.'}><Combo value={form.model} options={availableModels.map((model) => [model.id, model.label] as const)} disabled={!form.agent} placeholder="Search or enter a model ID" onValueChange={(value) => update('model', value)} /></Field><Field label={form.agent === 'claude' ? 'Effort' : 'Reasoning'} hint={supportedReasoning.length ? 'Search suggested levels or enter a custom value.' : 'Enter a supported value, or leave blank for the default.'}><Combo value={form.agent === 'claude' ? form.effort : form.reasoning} options={supportedReasoning.map((value) => [value, value] as const)} disabled={!form.agent} placeholder="Search or enter a value" onValueChange={(value) => update(form.agent === 'claude' ? 'effort' : 'reasoning', value)} /></Field><Field label="Add product screenshots?" hint="Optional. If you choose Yes, Doxloop must capture and verify the planned images before it can finish."><Segmented value={form.screenshots === 'disabled' ? 'no' : 'yes'} onChange={(value) => { update('screenshots', screenshotIntentFromChoice(value)); setApplicationReadiness(undefined) }} items={[['no', 'No'], ['yes', 'Yes']] as const} /></Field></div>
          <GeneratorPreflightPanel entry={selectedGenerator} result={generatorPreflight} busy={checkingGenerator} onRetry={() => void checkGenerator(form.generator)} />
          <details class="agent-capabilities-details setup-generator-tiers" open={Boolean(selectedGenerator?.tier) && selectedGenerator?.tier !== 'full'}>
            <summary>What each generator supports{selectedGenerator?.tier && selectedGenerator.tier !== 'full' ? ` · ${selectedGenerator.displayName} is ${selectedGenerator.tierLabel ?? selectedGenerator.tier}` : ''}</summary>
            <GeneratorTierMatrix generators={generators} selected={form.generator} />
          </details>
          <details class="agent-capabilities-details setup-agent-capabilities" open={form.agent === 'gemini'}>
            <summary>What each assistant supports{form.agent === 'gemini' ? ' · Gemini is limited in some areas' : ''}</summary>
            <AgentCapabilityMatrix selected={form.agent || undefined} />
          </details>
          {form.screenshots !== 'disabled' && <section class="setup-capture-profile"><header><span><Icon name="camera" size={18} /></span><div><strong>Screenshot details</strong><small>Give Doxloop one safe page to start from. The planner will inspect it and propose meaningful screenshots—you do not need to describe every image.</small></div></header><div class="setup-capture-grid"><Field label="Application URL" hint="The address of your running local, demo, or test application."><Input value={form.applicationBaseUrl} placeholder="http://localhost:3000" onInput={(event) => update('applicationBaseUrl', event.currentTarget.value)} /></Field><Field label="Starting page" hint="The first application page Doxloop may open. Use / for the home page."><Input value={form.applicationStartPath} placeholder="/ or /settings/team" onInput={(event) => update('applicationStartPath', event.currentTarget.value)} /></Field><div class="setup-capture-test"><Button disabled={!captureProfileComplete} busy={testingApplication} onClick={() => void testApplication()}>Check page</Button>{applicationReadiness && <small class={applicationReadiness.status === 'ready' ? 'ready' : 'missing'}><Icon name={applicationReadiness.status === 'ready' ? 'check' : 'alert'} size={13} />{applicationReadiness.message}</small>}</div></div>
            <Field label="Does this page require sign-in?" hint="Doxloop can record a signed-in browser session, use a test account's credentials, or both. Neither is stored in the project."><Segmented value={form.applicationSignIn} onChange={(value) => { update('applicationSignIn', value); setApplicationReadiness(undefined) }} items={[['no', 'No'], ['yes', 'Yes']] as const} /></Field>
            {form.applicationSignIn === 'yes' && <div class="setup-capture-signin">
              <div class="setup-capture-grid">
                <Field label="Sign-in route" hint="Optional. Where the sign-in window opens; leave empty when the app redirects to its login page."><Input value={form.applicationLoginPath} placeholder="/login" onInput={(event) => update('applicationLoginPath', event.currentTarget.value)} /></Field>
                <div class="setup-capture-test"><Button disabled={!captureProfileComplete || setupAuth?.signIn.active} busy={signInBusy === 'start'} onClick={() => void runSignIn('start', () => post<SetupCaptureAuth>('/api/setup/application/sign-in', setupApplication()))}>{setupAuth?.session ? 'Sign in again with browser' : 'Sign in with browser'}</Button>{setupAuth?.session && !setupAuth.signIn.active && <small class="ready"><Icon name="check" size={13} />Session recorded with {setupAuth.session.cookies} cookie{setupAuth.session.cookies === 1 ? '' : 's'}. It is saved with the project.</small>}</div>
                <Field label="Test account username or email" hint="Optional. For a plain username and password form."><Input value={form.applicationUsername} autocomplete="off" placeholder="docs-demo@example.com" onInput={(event) => update('applicationUsername', event.currentTarget.value)} /></Field>
                <Field label="Test account password" hint="Typed by the capture server, never shown to the agent."><Input type="password" value={form.applicationPassword} autocomplete="new-password" placeholder="••••••••" onInput={(event) => update('applicationPassword', event.currentTarget.value)} /></Field>
              </div>
              {setupAuth?.signIn.active && <div class="setup-capture-signin-actions"><Note tone={setupAuth.signIn.open ? 'info' : 'warn'}><span>{setupAuth.signIn.open ? <>A Chrome window is open at {setupAuth.signIn.url}. Complete the sign-in there, wait for the signed-in screen, then choose <strong>Save session</strong>.</> : <>The Chrome window was closed. Choose <strong>Save session</strong> to keep the last signed-in state, or start again.</>}</span></Note><div class="setup-capture-signin-buttons"><Button busy={signInBusy === 'cancel'} onClick={() => void runSignIn('cancel', () => post<SetupCaptureAuth>('/api/setup/application/sign-in/cancel'))}>Cancel</Button><Button tone="primary" busy={signInBusy === 'finish'} onClick={() => void runSignIn('finish', () => post<SetupCaptureAuth>('/api/setup/application/sign-in/finish'))}>Save session</Button></div></div>}
            </div>}
            {!captureProfileComplete ? <Note>Enter the application URL and starting page, or choose No above.</Note> : applicationReadiness?.status !== 'ready' && <Note>Check the page before continuing. This prevents a long plan from starting when screenshots cannot be captured.</Note>}</section>}
          {selectedAgent && <div class="setup-success-note"><span><Icon name="check" size={13} /></span><p><strong>Great choice!</strong>This setup works well for most projects and is easy to change later.</p></div>}</div>}
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
        {step === 5 && <><div class="setup-review-heading"><span aria-hidden="true">🗺️</span><div><h1>Review and plan</h1><p>Everything looks good. Next, the agent will propose the documentation structure for your approval.</p></div></div>
          <div class="setup-review-grid">
            <section class="setup-review-summary concise" aria-label="Documentation configuration">
              <ReviewSummaryRow icon="file" label="Title"><strong>{form.title}</strong></ReviewSummaryRow>
              <ReviewSummaryRow icon="link" label="Sources" trailing={<span class="review-source-count"><Icon name="check" size={12} />{sources.length} {sources.length === 1 ? 'source' : 'sources'}</span>}><span class="review-source-list">{sources.map((source) => <span class="review-source" key={source.name}><strong>{source.name} · {source.sourceKind === 'openapi' ? 'OpenAPI Specification' : source.sourceLocation === 'git' ? 'Git Repository' : 'Local Folder'}</strong><small>{source.sourceKind === 'openapi' || source.sourceLocation === 'local' ? source.sourcePath || 'Uploaded specification' : `${source.repository} · ${source.branch}${source.subdirectory ? ` / ${source.subdirectory}` : ''}`}</small></span>)}</span></ReviewSummaryRow>
              <ReviewSummaryRow icon="bot" label="Model"><strong>{form.model || 'Default'}</strong></ReviewSummaryRow>
              <ReviewSummaryRow icon="map" label="Plan"><span class="review-guidance"><strong>{scopeLabel(form.scope)} depth</strong><small>{form.readerOutcome.trim() || DEFAULT_READER_OUTCOME}</small></span></ReviewSummaryRow>
              <ReviewSummaryRow icon="camera" label="Screenshots"><span class="review-guidance"><strong>{form.screenshots === 'disabled' ? 'No' : 'Yes — required for this run'}</strong><small>{form.screenshots === 'disabled' ? 'Documentation will be created without product screenshots.' : `${setupApplicationCaptureTarget(form.applicationBaseUrl, form.applicationStartPath)}${form.applicationSignIn === 'yes' ? ` · sign-in: ${[setupAuth?.session ? 'recorded browser session' : '', hasSetupCredentials ? 'test account credentials' : ''].filter(Boolean).join(' and ') || 'none provided yet'}` : ''}`}</small></span></ReviewSummaryRow>
              <ReviewSummaryRow icon="users" label="Guidance"><span class="review-guidance"><strong>{form.audiences.length ? form.audiences.join(', ') : 'Agent will determine the audience'}</strong><small>{form.customInstructions.trim() || 'No custom instructions'}</small></span></ReviewSummaryRow>
            </section>
          </div>
          <div class="setup-review-ready"><span><Icon name="check" size={20} /></span><div><strong>Ready to prepare your plan</strong><small>The agent will research your sources and propose the pages to create. Nothing will be written until you approve the plan.</small></div></div>
          {submitting && sources.some((source) => source.sourceLocation === 'git') && <Note>Downloading read-only repository snapshots and starting documentation planning…</Note>}
          </>}
        {setupError?.step === step && <Note tone="bad">{setupError.message}</Note>}
        {error && <Note tone="bad">{error}</Note>}
        <footer class="setup-actions setup-review-actions">
          <div class="setup-review-progress"><strong>Step {step} of 5</strong><span>{[1, 2, 3, 4, 5].map((item) => <span class={item === step ? 'current' : item < step ? 'complete' : 'pending'} key={item}><i>{item <= step && <Icon name="check" size={10} />}</i>{item < 5 && <b />}</span>)}</span></div>
          <div>{step > 1 && <Button class="setup-back-button" disabled={submitting} onClick={() => setStep((value) => value - 1)}>Back</Button>}
            {step === 1 && mode === 'existing'
              ? <span class="setup-existing-hint">Import above to open the folder's pages.</span>
              : step < 5
              ? <Button tone="primary" busy={validatingPaths} disabled={(step === 1 && (!form.directory.trim() || !form.title.trim() || Boolean(pathErrors.directory))) || (step === 2 && (sources.length === 0 || sourceFlowStep !== 'closed')) || (step === 3 && ((Boolean(form.agent) && !selectedAgent) || (captureProfileRequired && (!captureProfileComplete || applicationReadiness?.status !== 'ready'))))} onClick={() => void continueSetup()}>Continue <Icon name="arrowRight" size={14} /></Button>
              : <Button tone="primary" icon="sparkle" busy={submitting} onClick={() => void createDocumentation()}>Create documentation plan</Button>}
          </div>
        </footer>
      </div>
    </section>
  </div>
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
  const matchingSuggestions = AUDIENCE_SUGGESTIONS.filter((suggestion) =>
    suggestion.toLowerCase().includes(audienceInput.trim().toLowerCase()),
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
  const toggleInstruction = (instruction: string) => {
    const lines = customInstructions.split('\n').map((line) => line.trim()).filter(Boolean)
    onInstructionsChange(lines.includes(instruction)
      ? lines.filter((line) => line !== instruction).join('\n')
      : [...lines, instruction].join('\n'))
  }
  return <div class="setup-guidance-stage">
    <SetupStepHeading visual="✍️" title="Guide your documentation" detail="Help the agent tailor the documentation to your readers and preferences." />
    <div class="setup-guidance-card">
      <section class="setup-guidance-section setup-coverage-guidance">
        <div class="setup-guidance-label"><span><strong>What should readers be able to do?</strong><small>This outcome guides the page structure and depth.</small></span></div>
        <Input value={readerOutcome} placeholder="For example: Install the SDK, authenticate, and complete the primary workflows." onInput={(event) => onReaderOutcomeChange(event.currentTarget.value)} />
        <div class="setup-guidance-label"><span><strong>Documentation depth</strong><small>Depth chooses which surface to cover. The number of pages comes from the evidence in your sources, not from a fixed range.</small></span></div>
        <div class="setup-scope-options" role="radiogroup" aria-label="Documentation depth">
          {([
            ['starter', 'Starter', 'First success path and essential reference'],
            ['standard', 'Standard', 'Primary journeys, concepts, troubleshooting, and reference'],
            ['comprehensive', 'Comprehensive', 'Every evidence-supported workflow, screen, and interface', 'Recommended'],
          ] as const).map(([value, label, detail, badge]) => <button type="button" role="radio" aria-checked={scope === value} class={scope === value ? 'selected' : ''} onClick={() => onScopeChange(value)} key={value}><span><strong>{label}</strong><small>{detail}</small></span>{badge && <em>{badge}</em>}</button>)}
        </div>
      </section>
      <section class="setup-guidance-section">
        <div class="setup-guidance-label"><span><strong>Who is this documentation for?</strong><small>Select suggestions or enter your own audience.</small></span><em>Optional</em></div>
        <div class="audience-picker" onClick={(event) => (event.currentTarget.querySelector('input') as HTMLInputElement | null)?.focus()}>
          {audiences.map((audience) => <span class="audience-token" key={audience}>{audience}<button type="button" aria-label={`Remove ${audience}`} onClick={(event) => { event.stopPropagation(); toggleAudience(audience) }}><Icon name="close" size={11} /></button></span>)}
          <input value={audienceInput} aria-label="Add an audience" placeholder={audiences.length ? 'Add another audience…' : 'Type an audience and press Enter…'} onInput={(event) => setAudienceInput(event.currentTarget.value)} onKeyDown={(event) => {
            if (event.key === 'Enter' || event.key === ',') {
              event.preventDefault()
              addAudience(event.currentTarget.value)
            } else if (event.key === 'Backspace' && !event.currentTarget.value && audiences.length) {
              onAudiencesChange(audiences.slice(0, -1))
            }
          }} onBlur={() => addAudience(audienceInput)} />
        </div>
        <div class="guidance-suggestions" aria-label="Suggested audiences">
          {matchingSuggestions.map((audience) => <button type="button" class={audiences.includes(audience) ? 'selected' : ''} aria-pressed={audiences.includes(audience)} onMouseDown={(event) => event.preventDefault()} onClick={() => toggleAudience(audience)} key={audience}>{audiences.includes(audience) && <Icon name="check" size={11} />}{audience}</button>)}
        </div>
      </section>
      <details class="setup-guidance-advanced">
        <summary><span><strong>Advanced planning preferences</strong><small>Examples, language, terminology, accessibility, and clarification behavior</small></span><Icon name="chevronDown" size={14} /></summary>
        <div class="setup-guidance-advanced-fields">
          <Field label="Reader experience"><Select value={preferences.experienceLevel} onChange={(event) => onPreferencesChange({ experienceLevel: event.currentTarget.value as SetupGuidancePreferences['experienceLevel'] })}><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option><option value="mixed">Mixed experience</option></Select></Field>
          <Field label="Preferred examples" hint="Comma-separated languages or tools"><Input value={preferences.preferredExamples} placeholder="TypeScript, curl" onInput={(event) => onPreferencesChange({ preferredExamples: event.currentTarget.value })} /></Field>
          <Field label="Locale"><Input value={preferences.locale} placeholder="en-US" onInput={(event) => onPreferencesChange({ locale: event.currentTarget.value })} /></Field>
          <Field label="Accessibility target"><Input value={preferences.accessibilityTarget} placeholder="WCAG 2.2 AA" onInput={(event) => onPreferencesChange({ accessibilityTarget: event.currentTarget.value })} /></Field>
          <Field label="Terminology" hint="One term = guidance per line"><Textarea rows={3} value={preferences.terminology} placeholder="access key = API access token" onInput={(event) => onPreferencesChange({ terminology: event.currentTarget.value })} /></Field>
          <Field label="Exclusions" hint="Comma-separated"><Textarea rows={3} value={preferences.exclusions} placeholder="Internal APIs, unreleased features" onInput={(event) => onPreferencesChange({ exclusions: event.currentTarget.value })} /></Field>
          <Field label="Design direction"><Textarea rows={3} value={preferences.designDirection} placeholder="Use the product brand and prioritize a compact developer-focused layout." onInput={(event) => onPreferencesChange({ designDirection: event.currentTarget.value })} /></Field>
          <Field label="If the planner has questions"><Select value={preferences.clarificationMode} onChange={(event) => onPreferencesChange({ clarificationMode: event.currentTarget.value as SetupGuidancePreferences['clarificationMode'] })}><option value="review">Ask me in the review screen</option><option value="defaults">Use recommended defaults when possible</option><option value="stop">Stop and wait for explicit answers</option></Select></Field>
        </div>
      </details>
      <section class="setup-guidance-section">
        <div class="setup-guidance-label"><span><strong>Instructions</strong><small>Describe how you want the agent to prepare the documentation.</small></span><em>Optional</em></div>
        <Textarea rows={6} value={customInstructions} placeholder="For example: Use concise explanations, include TypeScript examples, and add troubleshooting sections." onInput={(event) => onInstructionsChange(event.currentTarget.value)} />
        <div class="guidance-suggestions instruction-suggestions" aria-label="Suggested writing instructions">
          {INSTRUCTION_SUGGESTIONS.map(([label, instruction]) => <button type="button" class={customInstructions.split('\n').map((line) => line.trim()).includes(instruction) ? 'selected' : ''} aria-pressed={customInstructions.split('\n').map((line) => line.trim()).includes(instruction)} onClick={() => toggleInstruction(instruction)} key={label}>{customInstructions.split('\n').map((line) => line.trim()).includes(instruction) && <Icon name="check" size={11} />}{label}</button>)}
        </div>
      </section>
    </div>
    <div class="setup-guidance-note"><Icon name="sparkles" size={15} /><span>These preferences are saved with the workspace and reused for future documentation updates.</span></div>
  </div>
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

function ReviewSummaryRow({ icon, label, trailing, children }: { icon: string; label: string; trailing?: ComponentChildren; children: ComponentChildren }) {
  return <div class="review-summary-row"><span class="review-summary-icon"><Icon name={icon} size={20} /></span><span class="review-summary-label">{label}</span><span class="review-summary-value">{children}</span>{trailing && <span class="review-summary-trailing">{trailing}</span>}</div>
}

function SetupStepHeading({ visual, title, detail }: { visual: string; title: string; detail: string }) {
  return <div class="setup-step-heading"><span class="setup-heading-visual" aria-hidden="true">{visual}</span><div><h3>{title}</h3><p>{detail}</p></div></div>
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
