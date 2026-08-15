import type { ComponentChildren } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { api, patch, post, remove } from './api'
import {
  Badge, Button, Combo, Empty, Field, Input, JobTable, KeyValues, Lines, Note, Options, PageHeader,
  Panel, Segmented, Select, Stat, Table, Tabs, Textarea, Toggle, parseTerms, splitComma, termText, timeText,
} from './components'
import { Icon } from './icons'
import { agentModels, defaultModelForAgent, modelReasoningLevels, preferredReasoningLevel } from './model-options'
import type { AgentState, DiffRow, GeneratorEntry, Proposal, ProposalChange, Source, SourceDiff, SyncConfig, UiJob, UiState, Validation } from './types'

const NAV = [
  ['home', 'Overview', ''],
  ['sources', 'Sources', ''],
  ['authoring', 'Documentation', 'Automation'],
  ['sync', 'Monitoring', 'Automation'],
  ['proposals', 'Proposals', 'Automation'],
  ['quality', 'Quality', 'Delivery'],
  ['preview', 'Preview', 'Delivery'],
  ['publish', 'Publish', 'Delivery'],
  ['settings', 'Settings', ''],
] as const

const DOXLOOP_LOGO = new URL('../../assets/brand/doxloop-logo-light.png', import.meta.url).href

type Page = typeof NAV[number][0]

function currentPage(): Page {
  const segment = location.pathname.split('/').filter(Boolean)[0]
  return NAV.some(([id]) => id === segment) ? segment as Page : 'home'
}

export function App() {
  const [state, setState] = useState<UiState | null>(null)
  const [page, setPage] = useState<Page>(currentPage())
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [navOpen, setNavOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')
  const [jobStreamConnected, setJobStreamConnected] = useState(false)

  const reload = async () => {
    setLoading(true)
    try {
      setState(await api<UiState>('/api/state'))
      setError('')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [])
  useEffect(() => {
    if (!state?.projectFound) return
    const stream = new EventSource('/api/jobs/stream')
    stream.onopen = () => setJobStreamConnected(true)
    stream.onmessage = (event) => {
      try {
        const jobs = JSON.parse(event.data) as unknown
        if (Array.isArray(jobs)) setState((current) => current ? { ...current, jobs: jobs as UiJob[] } : current)
      } catch {
        // EventSource reconnects and the next complete snapshot replaces this one.
      }
    }
    stream.onerror = () => setJobStreamConnected(false)
    return () => {
      stream.close()
      setJobStreamConnected(false)
    }
  }, [state?.projectFound])
  useEffect(() => {
    const listener = () => setPage(currentPage())
    addEventListener('popstate', listener)
    return () => removeEventListener('popstate', listener)
  }, [])
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        setSearchOpen(true)
      }
      if (event.key === 'Escape') setSearchOpen(false)
    }
    addEventListener('keydown', listener)
    return () => removeEventListener('keydown', listener)
  }, [])

  const jobsRunning = state?.jobs.some((job) => job.status === 'running') ?? false
  useEffect(() => {
    if (!jobsRunning) return
    const timer = window.setInterval(async () => {
      try {
        const jobs = await api<UiJob[]>('/api/jobs')
        setState((current) => current ? { ...current, jobs } : current)
        if (!jobs.some((job) => job.status === 'running')) void reload()
      } catch (cause) {
        setError(message(cause))
      }
    }, 1800)
    return () => clearInterval(timer)
  }, [jobsRunning])

  const navigate = (next: Page) => {
    history.pushState({}, '', next === 'home' ? '/' : `/${next}`)
    setPage(next)
    setNavOpen(false)
  }

  const act = async <T,>(run: () => Promise<T>, success?: string, refresh = true): Promise<T | undefined> => {
    setError('')
    setNotice('')
    try {
      const result = await run()
      if (success) setNotice(success)
      if (refresh) await reload()
      return result
    } catch (cause) {
      setError(message(cause))
      return undefined
    }
  }

  if (!state && loading) return <Splash />
  if (!state) return <Splash error={error} />
  if (!state.projectFound) return <ProjectSetup state={state} act={act} error={error} onOpenPreview={async () => {
    await act(() => post('/api/preview/start', { open: true }), undefined, false)
  }} onContinue={async (next) => {
    await reload()
    navigate(next)
  }} />

  const project = state.project!
  const currentLabel = NAV.find(([id]) => id === page)?.[1] ?? 'Overview'
  const searchResults = NAV.filter(([, label, group]) => `${label} ${group}`.toLowerCase().includes(searchQuery.toLowerCase()))
  return <div class={`shell ${page === 'proposals' ? 'proposal-shell' : ''} ${page === 'sources' ? 'sources-shell' : ''}`}>
    {searchOpen && <div class="scrim" onClick={() => setSearchOpen(false)}>
      <section class="palette" role="dialog" aria-modal="true" aria-label="Search" onClick={(event) => event.stopPropagation()}>
        <div class="palette-input"><Icon name="search" size={16} /><input autoFocus value={searchQuery} placeholder="Search pages and actions…" onInput={(event) => setSearchQuery(event.currentTarget.value)} /><kbd>esc</kbd></div>
        <div class="palette-list">
          {searchResults.map(([id, label, group]) => <button key={id} onClick={() => { navigate(id); setSearchOpen(false); setSearchQuery('') }}>
            <Icon name={id} size={16} /><span>{label}</span><small>{group || 'Workspace'}</small>
          </button>)}
          {searchResults.length === 0 && <p class="palette-empty">No matching pages.</p>}
        </div>
      </section>
    </div>}
    {navOpen && <button class="nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}

    <aside class={`sidebar ${navOpen ? 'open' : ''}`}>
      <div class="doxloop-sidebar-brand"><span><img src={DOXLOOP_LOGO} alt="Doxloop" /></span><button type="button" aria-label="Collapse navigation"><Icon name="chevronRight" size={14} /><Icon name="chevronRight" size={14} /></button></div>
      <Button class="sidebar-create-docs" icon="plus" onClick={() => navigate('authoring')}>Create documentation</Button>
      <nav class="reference-sidebar-nav" aria-label="Main navigation">
        {([['home', 'columns', 'Workspaces'], ['sources', 'sources', 'Sources'], ['authoring', 'file', 'Documentation'], ['quality', 'book', 'Library'], ['settings', 'settings', 'Settings']] as const).map(([id, icon, label]) => <button key={id} class={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={icon} size={17} /><span>{label}</span></button>)}
      </nav>
      <footer class="sidebar-trust-card"><Icon name="shield" size={18} /><p>Your content is read-only and never copied to our servers.</p><a href="https://github.com/doxbrix/doxloop" target="_blank" rel="noreferrer">Learn more <Icon name="external" size={12} /></a></footer>
    </aside>

    <div class="main">
      <header class="topbar">
        <button class="topbar-search" onClick={() => setSearchOpen(true)}><Icon name="search" size={15} /><span>{page === 'proposals' ? 'Search documentation, files, proposals…' : 'Search'}</span><kbd>⌘K</kbd></button>
        <div class="topbar-tools">
          <span class="mode-flag"><i />Local mode</span>
          <button class="icon-btn" title="Documentation" aria-label="Documentation" onClick={() => navigate('quality')}><Icon name="help" size={17} /></button>
          <button class="icon-btn" title="Settings" aria-label="Settings" onClick={() => navigate('settings')}><Icon name="settings" size={17} /></button>
          <button class="create-btn" aria-label="Open documentation" title="Open documentation" onClick={() => navigate('authoring')}><Icon name="plus" size={16} /></button>
        </div>
      </header>
      <div class="mobile-topbar">
        <button aria-label="Open navigation" onClick={() => setNavOpen(true)}><Icon name="columns" size={18} /></button>
        <strong>{currentLabel}</strong>
        <button class="icon-btn" aria-label="Search" onClick={() => setSearchOpen(true)}><Icon name="search" size={17} /></button>
      </div>

      <div class="page">
        {loading && <div class="loading-bar" />}
        {error && <Banner tone="bad" title="Action failed" detail={error} onClose={() => setError('')} />}
        {notice && <Banner tone="good" title="Done" detail={notice} onClose={() => setNotice('')} />}
        {page === 'home' && <Home state={state} navigate={navigate} reload={reload} act={act} />}
        {page === 'sources' && <SourcesReference state={state} act={act} />}
        {page === 'authoring' && <Authoring state={state} act={act} streamConnected={jobStreamConnected} />}
        {page === 'sync' && <SyncPage state={state} act={act} />}
        {page === 'proposals' && <Proposals state={state} act={act} />}
        {page === 'quality' && <Quality state={state} act={act} />}
        {page === 'preview' && <Preview state={state} act={act} />}
        {page === 'publish' && <Publish state={state} act={act} />}
        {page === 'settings' && <Settings state={state} act={act} />}
      </div>
    </div>
  </div>
}

function Banner({ tone, title, detail, onClose }: { tone: 'good' | 'bad'; title: string; detail: string; onClose: () => void }) {
  return <div class={`banner ${tone}`}>
    <Icon name={tone === 'bad' ? 'alert' : 'check'} size={16} />
    <div><strong>{title}</strong><span>{detail}</span></div>
    <button aria-label="Dismiss" onClick={onClose}><Icon name="close" size={14} /></button>
  </div>
}

function Splash({ error }: { error?: string }) {
  return <div class="splash"><span class="splash-mark">D</span><strong>Doxloop</strong><p>{error ?? 'Opening the local control center…'}</p></div>
}

type SetupValidation = { directoryPath?: string; directoryError?: string; sourcePath?: string; sourcePathError?: string }

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
}

type SourceFlowStep = 'closed' | 'type' | 'source-location' | 'git-access' | 'git-connect' | 'git-select' | 'local' | 'openapi-format' | 'openapi-input'

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

function ProjectSetup({ state, act, error, onOpenPreview, onContinue }: { state: UiState; act: Action; error: string; onOpenPreview: () => Promise<void>; onContinue: (page: 'authoring' | 'sync' | 'publish') => Promise<void> }) {
  const [form, setForm] = useState(() => {
    const agent = state.agents?.find((item) => item.executable)?.name ?? 'codex'
    const model = defaultModelForAgent(agent)
    const reasoning = preferredReasoningLevel(agent, model)
    return {
      directory: 'my-product-docs',
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
      screenshots: false,
      audiences: [] as string[],
      customInstructions: '',
    }
  })
  const [step, setStep] = useState(1)
  const [sources, setSources] = useState<SetupSource[]>([])
  const [sourceFlowStep, setSourceFlowStep] = useState<SourceFlowStep>('closed')
  const [sourceMenuOpen, setSourceMenuOpen] = useState(false)
  const [sourceAddedNotice, setSourceAddedNotice] = useState(false)
  const [setupSpecFileName, setSetupSpecFileName] = useState('')
  const setupSpecInput = useRef<HTMLInputElement>(null)
  const [savingSource, setSavingSource] = useState(false)
  const [pathErrors, setPathErrors] = useState({ directory: '', sourcePath: '' })
  const [setupError, setSetupError] = useState('')
  const [validatingPaths, setValidatingPaths] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [gitTesting, setGitTesting] = useState(false)
  const [gitBranches, setGitBranches] = useState<string[]>([])
  const [gitDirectories, setGitDirectories] = useState<string[]>([])
  const [gitHead, setGitHead] = useState('')
  const [gitFoldersLoading, setGitFoldersLoading] = useState(false)
  const [gitDialog, setGitDialog] = useState<'access' | 'branch' | 'folder' | null>(null)
  const [gitAccessDraft, setGitAccessDraft] = useState<'automatic' | 'credentials'>('automatic')
  const [gitUsernameDraft, setGitUsernameDraft] = useState('')
  const [gitSecretDraft, setGitSecretDraft] = useState('')
  const [gitBranchDraft, setGitBranchDraft] = useState('main')
  const [gitFolderDraft, setGitFolderDraft] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [projectCreated, setProjectCreated] = useState(false)
  const [creationJob, setCreationJob] = useState<UiJob | null>(null)
  const [creationStreamConnected, setCreationStreamConnected] = useState(false)
  const [openingPreview, setOpeningPreview] = useState(false)
  const [cancellingCreation, setCancellingCreation] = useState(false)
  const [requestedAgentInstall, setRequestedAgentInstall] = useState('')
  const generators = state.generators
  const availableModels = agentModels(form.agent)
  const supportedReasoning = modelReasoningLevels(form.agent, form.model)
  const selectedAgent = state.agents?.find((agent) => agent.name === form.agent)
  const selectedAgentInstallJob = form.agent
    ? state.jobs.find((job) => job.type === 'agent:install' && job.agent === form.agent && (job.status === 'running' || job.agent === requestedAgentInstall))
    : undefined
  const agentInstallPending = requestedAgentInstall === form.agent && !selectedAgentInstallJob
  const openDocumentationPreview = async () => {
    if (openingPreview) return
    setOpeningPreview(true)
    try {
      await onOpenPreview()
    } finally {
      setOpeningPreview(false)
    }
  }
  useEffect(() => {
    if (!creationJob || creationJob.status !== 'running') return
    const stream = new EventSource('/api/jobs/stream')
    stream.onopen = () => setCreationStreamConnected(true)
    stream.onmessage = (event) => {
      try {
        const jobs = JSON.parse(event.data) as UiJob[]
        const current = jobs.find((job) => job.id === creationJob.id)
        if (current) setCreationJob(current)
      } catch {
        // The next complete job snapshot replaces malformed or partial output.
      }
    }
    stream.onerror = () => setCreationStreamConnected(false)
    return () => {
      stream.close()
      setCreationStreamConnected(false)
    }
  }, [creationJob?.id, creationJob?.status])
  const update = (key: string, value: string) => {
    setForm((current) => ({ ...current, [key]: value }))
    setSetupError('')
    if (key === 'directory') setPathErrors((current) => ({ ...current, directory: '' }))
    if (key === 'sourcePath' || key === 'sourceKind') setPathErrors((current) => ({ ...current, sourcePath: '' }))
    if (['repository', 'authMethod', 'gitUsername', 'gitSecret', 'sourceLocation'].includes(key)) {
      setPathErrors((current) => ({ ...current, sourcePath: '' }))
      setGitHead('')
      setGitDirectories([])
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
    setSetupError('')
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
        ...(includeSource ? {
          ...source,
        } : {}),
      })
      setPathErrors({ directory: result.directoryError ?? '', sourcePath: result.sourcePathError ?? '' })
      return result
    } catch (cause) {
      setSetupError(message(cause))
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
  const startSourceFlow = () => {
    resetSourceDraft()
    setSourceFlowStep('type')
  }
  const nextSourceFlowStep = () => {
    if (sourceFlowStep === 'type') {
      setSourceFlowStep(form.sourceKind === 'openapi' ? 'openapi-format' : 'source-location')
    } else if (sourceFlowStep === 'source-location') {
      setSourceFlowStep(form.sourceLocation === 'git' ? 'git-access' : 'local')
    } else if (sourceFlowStep === 'git-access') {
      setSourceFlowStep('git-connect')
    } else if (sourceFlowStep === 'openapi-format') {
      setSourceFlowStep('openapi-input')
    }
  }
  const previousSourceFlowStep = () => {
    if (sourceFlowStep === 'source-location' || sourceFlowStep === 'openapi-format') setSourceFlowStep('type')
    else if (sourceFlowStep === 'git-access' || sourceFlowStep === 'local') setSourceFlowStep('source-location')
    else if (sourceFlowStep === 'git-connect') setSourceFlowStep('git-access')
    else if (sourceFlowStep === 'git-select') setSourceFlowStep('git-connect')
    else if (sourceFlowStep === 'openapi-input') setSourceFlowStep('openapi-format')
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
      const inlineSpecification = source.sourceKind === 'openapi' && source.specInput === 'file' && source.specContent.trim()
      const result = inlineSpecification ? {} : await validatePaths(true, source)
      if (!result || result.directoryError || result.sourcePathError) return
      const normalized = result.sourcePath && source.sourceLocation === 'local' ? { ...source, sourcePath: result.sourcePath } : source
      setSources((current) => [...current, normalized])
      resetSourceDraft()
      setSourceFlowStep('closed')
      setSourceMenuOpen(false)
      setSourceAddedNotice(true)
    } finally {
      setSavingSource(false)
    }
  }
  const browseSourceDirectory = async () => {
    setBrowsing(true)
    setSetupError('')
    try {
      const result = await post<{ path: string | null }>('/api/setup/browse-directory')
      if (result.path) update('sourcePath', result.path)
    } catch (cause) {
      setPathErrors((current) => ({ ...current, sourcePath: message(cause) }))
    } finally {
      setBrowsing(false)
    }
  }
  const testGitConnection = async () => {
    setGitTesting(true)
    setSetupError('')
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
    setSetupError('')
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
  const openGitDialog = (dialog: 'access' | 'branch' | 'folder') => {
    setGitDialog(dialog)
    setGitAccessDraft(form.authMethod as 'automatic' | 'credentials')
    setGitUsernameDraft(form.gitUsername)
    setGitSecretDraft(form.gitSecret)
    setGitBranchDraft(form.branch)
    setGitFolderDraft(form.subdirectory)
  }
  const saveGitAccess = () => {
    const changed = gitAccessDraft !== form.authMethod || gitUsernameDraft !== form.gitUsername || gitSecretDraft !== form.gitSecret
    setForm((current) => ({
      ...current,
      authMethod: gitAccessDraft,
      gitUsername: gitAccessDraft === 'credentials' ? gitUsernameDraft : '',
      gitSecret: gitAccessDraft === 'credentials' ? gitSecretDraft : '',
    }))
    if (changed) editGitConnection()
    setGitDialog(null)
  }
  const saveGitBranch = async () => {
    setGitDialog(null)
    await selectGitBranch(gitBranchDraft)
  }
  useEffect(() => {
    if (!gitDialog) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setGitDialog(null)
    }
    addEventListener('keydown', close)
    return () => removeEventListener('keydown', close)
  }, [gitDialog])
  const documentationRunRequest = () => ({
    mode: 'create',
    request: '',
    ...(form.agent ? { agent: form.agent } : {}),
    ...(form.model ? { model: form.model } : {}),
    ...(form.agent === 'codex' && form.reasoning ? { reasoning: form.reasoning } : {}),
    ...(form.agent === 'claude' && form.effort ? { effort: form.effort } : {}),
    screenshots: form.screenshots,
  })
  const retryDocumentationCreation = async () => {
    setSubmitting(true)
    setSetupError('')
    try {
      const result = await act(() => post<UiJob>('/api/author', documentationRunRequest()), undefined, false)
      if (result) setCreationJob(result)
      else setSetupError('Documentation creation could not be restarted. Review the log and try again.')
    } finally {
      setSubmitting(false)
    }
  }
  const cancelDocumentationCreation = async () => {
    if (!creationJob || creationJob.status !== 'running') return
    setCancellingCreation(true)
    try {
      const result = await act(() => post<UiJob>(`/api/jobs/${creationJob.id}/cancel`), undefined, false)
      if (result) setCreationJob(result)
    } finally {
      setCancellingCreation(false)
    }
  }
  const createDocumentation = async () => {
    setSubmitting(true)
    setSetupError('')
    try {
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
          documentation: {
            audiences: form.audiences,
            primaryAudience: form.audiences.join(', '),
            customInstructions: form.customInstructions,
          },
        }), undefined, false)
        if (!created) {
          setSetupError('The documentation workspace could not be created. Review the configuration and try again.')
          return
        }
        setProjectCreated(true)
      }
      const result = await act(() => post<UiJob>('/api/author', documentationRunRequest()), undefined, false)
      if (result) setCreationJob(result)
      else setSetupError('Documentation creation could not be started. Review the configuration and try again.')
    } finally {
      setSubmitting(false)
    }
  }
  return <div class="setup reference-setup">
    <section class="setup-panel">
      <aside class="setup-rail">
        <div class="doxloop-sidebar-brand"><span><img src={DOXLOOP_LOGO} alt="Doxloop" /></span></div>
        <div class="setup-sidebar-heading"><strong>Create documentation</strong><small>Configure your documentation workspace</small></div>
        <nav class="reference-sidebar-nav setup-reference-nav" aria-label="Setup navigation">{([['folder', 'Workspace', 'Name your workspace'], ['sources', 'Sources', 'Connect your content'], ['settings', 'Tools', 'Configure generation'], ['users', 'Guidance', 'Audience and instructions'], ['quality', 'Review', 'Review and create']] as const).map(([icon, label, detail], index) => <button type="button" key={label} disabled={Boolean(creationJob) || index + 1 > step} class={step === index + 1 ? 'active' : ''} onClick={() => setStep(index + 1)}><Icon name={icon} size={18} /><span><strong>{label}</strong><small>{detail}</small></span></button>)}</nav>
      </aside>
      <div class={`setup-body ${step === 1 ? 'setup-home-body' : step === 5 ? 'setup-review-body' : ''}`}>
        {step === 1 && <div class="setup-home-card">
          <header class="setup-home-heading"><span><Icon name="folder" size={34} /></span><div><h1>Let's name your workspace</h1><p>This will be your docs' home in Doxloop.</p></div></header>
          <div class="setup-home-fields"><section class="setup-home-field"><span class="setup-home-field-icon workspace"><Icon name="folder" size={25} /></span><Field label="Workspace name" hint="This is the folder where your docs will live."><ValidatedSetupInput value={form.directory} valid={Boolean(form.directory.trim()) && !pathErrors.directory} invalid={Boolean(pathErrors.directory)} onInput={(value) => update('directory', value)} />{pathErrors.directory && <small class="field-error">{pathErrors.directory}</small>}</Field></section><section class="setup-home-field"><span class="setup-home-field-icon title">T<small>T</small></span><Field label="What should we call your docs?" hint="This is the title people will see."><ValidatedSetupInput value={form.title} valid={Boolean(form.title.trim())} onInput={(value) => update('title', value)} /></Field></section></div>
        </div>}
        {false && step === 2 && sourceType === 'git' && <><div class="git-connect-heading"><SetupStepHeading visual="📁" title="Connect a source" detail="Paste your Git repository URL. We'll handle the rest." /><Button size="sm" tone="ghost" onClick={() => updateSourceType('local')}>Change source type</Button></div>
          <div class="git-connect-page">
            <div class={`git-repository-box ${gitHead ? 'connected' : ''}`}><Icon name="sources" size={19} /><Input value={form.repository} aria-invalid={Boolean(pathErrors.sourcePath)} placeholder="https://github.com/company/product" onInput={(event) => update('repository', event.currentTarget.value)} />{gitHead ? <span class="git-repository-check"><Icon name="check" size={19} /></span> : <Button type="button" tone="primary" busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && !form.gitSecret)} onClick={() => void testGitConnection()}>Connect</Button>}</div>
            {pathErrors.sourcePath && <small class="field-error">{pathErrors.sourcePath}</small>}
            <div class="git-summary-list">
              <GitSettingRow icon="cloud" label="Access" value={form.authMethod === 'credentials' ? 'Private repository' : 'Public or already connected'} onChange={() => openGitDialog('access')} />
              <GitSettingRow icon="sources" label="Branch" value={gitHead ? form.branch : 'Available after connecting'} disabled={!gitHead} onChange={() => openGitDialog('branch')} />
              <GitSettingRow icon="folder" label="Folder" value={gitHead ? form.subdirectory || 'Entire repository' : 'Available after connecting'} disabled={!gitHead || gitFoldersLoading} onChange={() => openGitDialog('folder')} />
            </div>
            {gitHead && <div class="git-connected-banner"><span><Icon name="check" size={16} /></span><div><strong>All set! We can access this repository.</strong><small>{gitBranches.length} {gitBranches.length === 1 ? 'branch' : 'branches'} available</small></div></div>}
          </div></>}
        {false && step === 2 && sourceType !== 'git' && <><SetupStepHeading visual="📁" title="Where is your content?" detail="Tell us where your product content is stored." />
          <div class="setup-form-stack"><span class="field-label">Source type</span><div class="source-type-grid">
            <SourceTypeChoice selected={false} visual="code" title="Git repository" detail="Connect a GitHub, GitLab, Azure DevOps or other Git service." onClick={() => updateSourceType('git')} />
            <SourceTypeChoice selected={sourceType === 'local'} visual="folder" title="Local folder" detail="Use a folder on your computer or network." onClick={() => updateSourceType('local')} />
            <SourceTypeChoice selected={sourceType === 'openapi'} visual="api" title="API / OpenAPI" detail="Import from an OpenAPI spec file or URL." onClick={() => updateSourceType('openapi')} />
          </div>
            {false && <div class="setup-source-details"><Field label="Repository URL"><div class="path-input git-url-input"><Input value={form.repository} aria-invalid={Boolean(pathErrors.sourcePath)} placeholder="https://github.com/company/product" onInput={(event) => update('repository', event.currentTarget.value)} />{gitHead ? <span class="setup-input-check"><Icon name="check" size={14} /></span> : <Button type="button" tone="primary" busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && !form.gitSecret)} onClick={() => void testGitConnection()}>Connect</Button>}</div>{pathErrors.sourcePath && <small class="field-error">{pathErrors.sourcePath}</small>}</Field>
              <section class="setup-git-options"><div class="setup-section-title"><span><Icon name="settings" size={15} /></span><div><strong>Repository settings</strong><small>Access, branch and folder are always visible.</small></div>{gitHead && <Button size="sm" tone="ghost" onClick={editGitConnection}>Reconnect</Button>}</div>
                <div class="git-option-grid">
                  <Field label="Access"><Segmented value={form.authMethod as 'automatic' | 'credentials'} onChange={(value) => update('authMethod', value)} items={[['automatic', 'Public'], ['credentials', 'Private']] as const} /></Field>
                  <Field label="Branch" hint={gitHead ? `${gitBranches.length} available` : 'Available after connecting.'}><Select value={form.branch} disabled={!gitHead || gitFoldersLoading} onChange={(event) => void selectGitBranch(event.currentTarget.value)}>{gitHead ? gitBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>) : <option value="main">Connect repository first</option>}</Select></Field>
                  <RepositoryFolderSelect value={form.subdirectory} directories={gitDirectories} loading={gitFoldersLoading} connected={Boolean(gitHead)} onChange={(value) => update('subdirectory', value)} />
                </div>
                {form.authMethod === 'credentials' && <div class="git-private-section"><div class="git-private-heading"><Icon name="lock" size={15} /><span><strong>Private repository access</strong><small>Read-only permission is enough. Credentials are never saved in the project.</small></span></div><div class="git-private-fields"><Field label="Account username"><Input value={form.gitUsername} autocomplete="username" onInput={(event) => update('gitUsername', event.currentTarget.value)} /></Field><Field label="Personal access token"><Input type="password" value={form.gitSecret} autocomplete="off" onInput={(event) => update('gitSecret', event.currentTarget.value)} /></Field></div></div>}
                {gitHead && <div class="git-ready-inline"><Icon name="check" size={13} /><span>Repository connected successfully</span></div>}
              </section></div>}
            {sourceType === 'local' && <div class="setup-source-details"><Field label="Local folder"><div class="path-input"><Input value={form.sourcePath} aria-invalid={Boolean(pathErrors.sourcePath)} placeholder="/path/to/my-product" onInput={(event) => update('sourcePath', event.currentTarget.value)} /><Button type="button" icon="folder" busy={browsing} onClick={() => void browseSourceDirectory()}>Browse</Button></div>{pathErrors.sourcePath && <small class="field-error">{pathErrors.sourcePath}</small>}</Field></div>}
            {sourceType === 'openapi' && <div class="setup-source-details"><Field label="OpenAPI file or URL"><Input value={form.sourcePath} aria-invalid={Boolean(pathErrors.sourcePath)} placeholder="openapi.yaml or https://…" onInput={(event) => update('sourcePath', event.currentTarget.value)} />{pathErrors.sourcePath && <small class="field-error">{pathErrors.sourcePath}</small>}</Field></div>}
          </div></>}
        {false && step === 2 && <><SetupStepHeading visual="📚" title="Connect your sources" detail="Bring repositories, local folders, and API specifications together in one documentation." />
          <div class="multi-source-step">
            {sources.length > 0 && <div class="connected-source-list">
              <div class="connected-source-heading"><span><strong>Sources</strong><small>{sources.length} configured source{sources.length === 1 ? '' : 's'} for this documentation.</small></span>{sourceFlowStep === 'closed' && <Button size="sm" tone="primary" icon="plus" onClick={startSourceFlow}>Add Sources</Button>}</div>
              {sources.map((source, index) => <div class="connected-source-card" key={`${source.name}-${index}`}>
                <span class={`connected-source-icon ${source.sourceKind === 'openapi' ? 'api' : source.sourceLocation}`}><Icon name={source.sourceKind === 'openapi' ? 'api' : source.sourceLocation === 'git' ? 'sources' : 'folder'} size={17} /></span>
                <div><strong>{source.name}</strong><small>{source.sourceKind === 'openapi' ? 'OpenAPI Specification' : source.sourceLocation === 'git' ? 'Git Repository' : 'Local Folder'}</small><code>{source.sourceKind === 'openapi' ? source.sourcePath : source.sourceLocation === 'git' ? `${source.repository} · ${source.branch}${source.subdirectory ? ` / ${source.subdirectory}` : ''}` : source.sourcePath}</code></div>
                <button type="button" aria-label={`Remove ${source.name}`} onClick={() => setSources((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Icon name="trash" size={14} /></button>
              </div>)}
            </div>}
            {sources.length === 0 && sourceFlowStep === 'closed' && <div class="add-sources-empty"><span><Icon name="sources" size={19} /></span><div><strong>No sources added yet</strong><small>Add a repository or OpenAPI specification to begin.</small></div><Button tone="primary" icon="plus" onClick={startSourceFlow}>Add Sources</Button></div>}
            {sourceFlowStep !== 'closed' && <section class="source-composer source-wizard">
              <header><div><span class="source-number">{sources.length + 1}</span><span><strong>{sourceFlowTitle(sourceFlowStep)}</strong><small>{sourceFlowDetail(sourceFlowStep)}</small></span></div><Button size="sm" tone="ghost" onClick={() => { resetSourceDraft(); setSourceFlowStep('closed') }}>Cancel</Button></header>
              <div class="source-wizard-body">
                {sourceFlowStep === 'type' && <Field label="Add Sources"><Select value={form.sourceKind === 'openapi' ? 'openapi' : 'directory'} onChange={(event) => updateSourceType(event.currentTarget.value === 'openapi' ? 'openapi' : 'git')}><option value="directory">Source</option><option value="openapi">OpenAPI Specification</option></Select></Field>}
                {sourceFlowStep === 'source-location' && <Field label="Choose source"><Select value={form.sourceLocation} onChange={(event) => updateSourceType(event.currentTarget.value)}><option value="local">Local Repository</option><option value="git">Git Repository</option></Select></Field>}
                {sourceFlowStep === 'git-access' && <Field label="Repository access"><Select value={form.authMethod} onChange={(event) => update('authMethod', event.currentTarget.value)}><option value="automatic">Public Repository</option><option value="credentials">Private Repository</option></Select></Field>}
                {sourceFlowStep === 'git-connect' && <div class="source-wizard-fields"><Field label="Repository URL"><Input value={form.repository} aria-invalid={Boolean(pathErrors.sourcePath)} placeholder="https://github.com/company/product" onInput={(event) => update('repository', event.currentTarget.value)} /></Field>{form.authMethod === 'credentials' && <><Field label="Username"><Input value={form.gitUsername} autocomplete="username" placeholder="Git account username" onInput={(event) => update('gitUsername', event.currentTarget.value)} /></Field><Field label="Personal Access Token (PAT)"><Input type="password" value={form.gitSecret} autocomplete="off" placeholder="Token with repository read access" onInput={(event) => update('gitSecret', event.currentTarget.value)} /></Field></>}<div class="credential-note"><Icon name="shield" size={14} />{form.authMethod === 'credentials' ? 'Credentials are used only to authenticate and are not saved in the project.' : 'Doxloop will connect with read-only access.'}</div></div>}
                {sourceFlowStep === 'git-select' && <div class="source-wizard-fields"><div class="source-authenticated"><Icon name="check" size={13} /><span>Repository connected. Choose the content to use.</span></div><div class="source-option-grid"><Field label="Branch" hint={`${gitBranches.length} available`}><Select value={form.branch} disabled={gitFoldersLoading} onChange={(event) => void selectGitBranch(event.currentTarget.value)}>{gitBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</Select></Field><RepositoryFolderSelect value={form.subdirectory} directories={gitDirectories} loading={gitFoldersLoading} connected={Boolean(gitHead)} onChange={(value) => update('subdirectory', value)} /></div></div>}
                {sourceFlowStep === 'local' && <Field label="Local Repository"><div class="path-input"><Input value={form.sourcePath} aria-invalid={Boolean(pathErrors.sourcePath)} placeholder="/path/to/local-repository" onInput={(event) => update('sourcePath', event.currentTarget.value)} /><Button type="button" icon="folder" busy={browsing} onClick={() => void browseSourceDirectory()}>Select folder</Button></div>{form.sourcePath && <small class="selected-path"><Icon name="folder" size={13} />Selected repository · {form.sourcePath}</small>}</Field>}
                {sourceFlowStep === 'openapi-format' && <Field label="Provide specification as"><Select value={form.specInput} onChange={(event) => { update('specInput', event.currentTarget.value); update('sourcePath', '') }}><option value="url">OpenAPI specification URL</option><option value="file">OpenAPI YAML/JSON</option></Select></Field>}
                {sourceFlowStep === 'openapi-input' && <Field label={form.specInput === 'url' ? 'OpenAPI specification URL' : 'OpenAPI YAML/JSON'}><Input value={form.sourcePath} aria-invalid={Boolean(pathErrors.sourcePath)} placeholder={form.specInput === 'url' ? 'https://api.example.com/openapi.yaml' : '/path/to/openapi.yaml'} onInput={(event) => update('sourcePath', event.currentTarget.value)} /></Field>}
                {pathErrors.sourcePath && <small class="field-error">{pathErrors.sourcePath}</small>}
              </div>
              <footer><Button disabled={sourceFlowStep === 'type'} onClick={previousSourceFlowStep}>Back</Button>{['type', 'source-location', 'git-access', 'openapi-format'].includes(sourceFlowStep) && <Button tone="primary" onClick={nextSourceFlowStep}>Next <Icon name="arrowRight" size={14} /></Button>}{sourceFlowStep === 'git-connect' && <Button tone="primary" busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && (!form.gitUsername.trim() || !form.gitSecret.trim()))} onClick={() => void testGitConnection()}>Next <Icon name="arrowRight" size={14} /></Button>}{sourceFlowStep === 'git-select' && <Button tone="primary" icon="plus" busy={savingSource} disabled={!gitHead || gitFoldersLoading} onClick={() => void addSetupSource()}>Add Source</Button>}{(sourceFlowStep === 'local' || sourceFlowStep === 'openapi-input') && <Button tone="primary" icon="plus" busy={savingSource} disabled={!form.sourcePath.trim()} onClick={() => void addSetupSource()}>Add Source</Button>}</footer>
            </section>}
            {sourceFlowStep === 'closed' && sources.length > 0 && <div class="multi-source-note"><Icon name="info" size={15} /><span>Use “+ Add Sources” to combine another repository or OpenAPI specification with this documentation.</span></div>}
          </div></>}
        {step === 2 && <><header class="sources-page-header setup-sources-header"><div><h1>Sources</h1><p>Manage all the sources you've connected to create documentation.</p></div><div class="sources-page-tools"><div class="sources-add-wrap"><button type="button" class="sources-add-dropdown-button" aria-expanded={sourceMenuOpen} onClick={() => setSourceMenuOpen((open) => !open)}><Icon name="plus" size={16} />Add source<Icon name="chevronDown" size={14} /></button>{sourceMenuOpen && <div class="sources-add-menu"><button type="button" onClick={() => { resetSourceDraft(); setForm((current) => ({ ...current, sourceKind: 'directory', sourceLocation: 'git' })); setSourceFlowStep('source-location') }}><span><Icon name="api" size={20} /></span><span><strong>Source code</strong></span></button><button type="button" onClick={() => { resetSourceDraft(); setForm((current) => ({ ...current, sourceKind: 'openapi' })); setSourceFlowStep('openapi-format') }}><span><Icon name="braces" size={20} /></span><span><strong>OpenAPI spec</strong></span></button></div>}</div></div></header>
          <section class="sources-data-panel setup-sources-table"><header>All sources ({sources.length})</header><div class="sources-table-head"><span>Name</span><span>Type</span><span>Last updated</span><span>Status</span><span /></div>{filteredSetupSources.length ? <div class="sources-table-body">{filteredSetupSources.map(({ source, index }) => <div class="sources-data-row" key={`${source.name}-${index}`}><span class="sources-name-cell"><span class={`source-service-icon ${source.sourceKind === 'openapi' ? 'openapi' : source.sourceLocation === 'git' ? `git ${repositoryProvider(source.repository)}` : 'local'}`}><Icon name={source.sourceKind === 'openapi' ? 'braces' : source.sourceLocation === 'git' ? repositoryProviderIcon(source.repository) : 'folder'} size={20} /></span><span><strong>{source.name}</strong><small>{source.sourceKind === 'openapi' ? source.sourcePath || 'Uploaded OpenAPI specification' : source.sourceLocation === 'git' ? source.repository : source.sourcePath}</small></span></span><span><em class={`source-type-pill ${source.sourceKind === 'openapi' ? 'openapi' : source.sourceLocation}`}>{source.sourceKind === 'openapi' ? 'OpenAPI' : source.sourceLocation === 'git' ? 'Git' : 'Local'}</em></span><span class="source-updated">Just now</span><span><em class="source-sync-status"><Icon name="check" size={12} />Synced</em></span><span class="source-row-menu"><button type="button" aria-label={`Delete ${source.name}`} title="Delete source" onClick={() => setSources((current) => current.filter((_, itemIndex) => itemIndex !== index))}><Icon name="trash" size={22} /></button></span></div>)}</div> : <div class="sources-table-empty"><Icon name={sources.length ? 'search' : 'sources'} size={28} /><strong>{sources.length ? 'No matching sources' : 'No sources added yet'}</strong><small>{sources.length ? 'Try a different name, URL, path, or source type.' : 'Use “Add source” to connect your first source.'}</small></div>}<footer><span>Showing {filteredSetupSources.length ? `1 to ${filteredSetupSources.length}` : '0'} of {sources.length} results</span><span><button disabled><Icon name="chevronRight" size={14} /></button><button disabled><Icon name="chevronRight" size={14} /></button></span></footer></section>
          {sourceAddedNotice && <div class="source-added-success"><span><Icon name="check" size={20} /></span><div><strong>Source added successfully!</strong><small>The source will appear in the list.</small></div><button type="button" aria-label="Dismiss" onClick={() => setSourceAddedNotice(false)}><Icon name="close" size={13} /></button></div>}
          {false && sourceFlowStep !== 'closed' && sourceFlowStep !== 'type' && <div class="source-modal-scrim" onClick={() => setSourceFlowStep('closed')}><section class="source-reference-modal" role="dialog" aria-modal="true" aria-labelledby="add-source-title" onClick={(event) => event.stopPropagation()}>
            <header><strong id="add-source-title">Add Source</strong><button type="button" aria-label="Close" onClick={() => setSourceFlowStep('closed')}><Icon name="close" size={15} /></button></header>
            <div class="source-reference-modal-body">
              {sourceFlowStep === 'source-location' && <><p>How would you like to add the source?</p><div class="reference-choice-list"><ReferenceChoice icon="github" title="Git Source" detail="Add from a Git repository" onClick={() => setSourceFlowStep('git-access')} /><ReferenceChoice icon="folder" tone="folder" title="Local Repository" detail="Add from your local folder" onClick={() => { updateSourceType('local'); setSourceFlowStep('local') }} /></div></>}
              {sourceFlowStep === 'git-access' && <><p>Is this a public or private repository?</p><div class="reference-choice-list"><ReferenceChoice icon="cloud" title="Public Git" detail="Anyone can access" onClick={() => { update('authMethod', 'automatic'); setSourceFlowStep('git-connect') }} /><ReferenceChoice icon="lock" title="Private Git" detail="Requires authentication" onClick={() => { update('authMethod', 'credentials'); setSourceFlowStep('git-connect') }} /></div></>}
              {sourceFlowStep === 'git-connect' && <div class="reference-modal-fields">{form.authMethod === 'automatic' && <p>Enter the public repository URL</p>}<Field label={form.authMethod === 'credentials' ? 'Repository URL' : ''}><Input value={form.repository} placeholder="https://github.com/owner/repo.git" onInput={(event) => update('repository', event.currentTarget.value)} /></Field>{form.authMethod === 'credentials' && <><Field label="Username"><Input value={form.gitUsername} autocomplete="username" placeholder="Enter username" onInput={(event) => update('gitUsername', event.currentTarget.value)} /></Field><Field label="Personal Access Token (PAT)"><Input type="password" value={form.gitSecret} autocomplete="off" placeholder="Enter personal access token" onInput={(event) => update('gitSecret', event.currentTarget.value)} /></Field></>}</div>}
              {sourceFlowStep === 'git-select' && <div class="reference-modal-fields"><Field label="Select branch"><Select value={form.branch} disabled={gitFoldersLoading} onChange={(event) => void selectGitBranch(event.currentTarget.value)}>{gitBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}</Select></Field><Field label="Select folder"><RepositoryFolderTree value={form.subdirectory} directories={gitDirectories} loading={gitFoldersLoading} onChange={(value) => update('subdirectory', value)} /></Field></div>}
              {sourceFlowStep === 'local' && <div class="reference-modal-fields"><p>Select your local repository or folder</p><Field label="Local repository"><div class="path-input"><Input value={form.sourcePath} placeholder="/path/to/local-repository" onInput={(event) => update('sourcePath', event.currentTarget.value)} /><Button icon="folder" busy={browsing} onClick={() => void browseSourceDirectory()}>Browse</Button></div></Field></div>}
              {sourceFlowStep === 'openapi-format' && <><p>How would you like to add the OpenAPI specification?</p><div class="reference-choice-list compact"><ReferenceChoice icon="external" title="From URL" detail="Provide a URL to your OpenAPI spec" onClick={() => { update('specInput', 'url'); setSourceFlowStep('openapi-input') }} /><ReferenceChoice icon="api" tone="api" title="From YAML / JSON" detail="Paste your YAML or JSON content" onClick={() => { update('specInput', 'file'); setSourceFlowStep('openapi-input') }} /></div></>}
              {sourceFlowStep === 'openapi-input' && <div class="reference-modal-fields">{form.specInput === 'url' ? <><p>Enter OpenAPI specification URL</p><Input value={form.sourcePath} placeholder="https://example.com/openapi.yaml" onInput={(event) => update('sourcePath', event.currentTarget.value)} /></> : <><p>Paste your OpenAPI specification</p><Textarea value={form.specContent} placeholder="Paste YAML or JSON content here..." onInput={(event) => update('specContent', event.currentTarget.value)} /></>}</div>}
              {pathErrors.sourcePath && <small class="reference-modal-error">{pathErrors.sourcePath}</small>}
            </div>
            {['git-connect', 'git-select', 'local', 'openapi-input'].includes(sourceFlowStep) && <footer>{sourceFlowStep === 'git-connect' ? <Button tone="primary" busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && (!form.gitUsername.trim() || !form.gitSecret.trim()))} onClick={() => void testGitConnection()}>Next</Button> : <Button tone="primary" busy={savingSource} disabled={sourceFlowStep === 'git-select' ? !gitHead || gitFoldersLoading : sourceFlowStep === 'local' ? !form.sourcePath.trim() : form.specInput === 'url' ? !form.sourcePath.trim() : !form.specContent.trim()} onClick={() => void addSetupSource()}>Add Source</Button>}</footer>}
          </section></div>}
          {sourceFlowStep !== 'closed' && <div class="sources-modal-scrim" onClick={() => setSourceFlowStep('closed')}><section class={`sources-reference-dialog ${form.sourceKind === 'openapi' ? 'openapi' : 'source'}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
            <header>{form.sourceKind === 'openapi' && <span class="sources-dialog-icon"><Icon name="file" size={24} /></span>}<div><h2>{form.sourceKind === 'openapi' ? 'Add OpenAPI spec' : 'Add source code'}</h2><p>{form.sourceKind === 'openapi' ? 'Import your OpenAPI specification from a local file or a public URL.' : 'Choose how you want to connect your source code.'}</p></div><button type="button" aria-label="Close" onClick={() => setSourceFlowStep('closed')}><Icon name="close" size={17} /></button></header>
            {form.sourceKind === 'directory' ? <div class="sources-dialog-body"><span class="dialog-section-label">Source type</span><div class="source-mode-grid"><button type="button" class={sourceType === 'git' ? 'selected' : ''} onClick={() => updateSourceType('git')}><span><Icon name="api" size={22} /></span><i /><strong>Git repository</strong><small>Connect a GitHub, GitLab, Azure DevOps or other Git service.</small></button><button type="button" class={sourceType === 'local' ? 'selected' : ''} onClick={() => updateSourceType('local')}><span><Icon name="folder" size={22} /></span><i /><strong>Local folder</strong><small>Use a folder on your computer or network.</small></button></div>{sourceType === 'git' ? <div class="source-code-fields"><Field label="Repository access"><Select value={form.authMethod} onChange={(event) => { update('authMethod', event.currentTarget.value); editGitConnection() }}><option value="automatic">Public repository</option><option value="credentials">Private repository</option></Select></Field><Field label="Repository URL"><div class="repository-connect-input"><Input value={form.repository} placeholder="https://github.com/company/product" onInput={(event) => { update('repository', event.currentTarget.value); editGitConnection() }} /><RepositoryConnectButton connected={Boolean(gitHead)} busy={gitTesting} disabled={!form.repository.trim() || (form.authMethod === 'credentials' && (!form.gitUsername.trim() || !form.gitSecret.trim()))} onClick={() => void testGitConnection()} /></div></Field>{form.authMethod === 'credentials' && <div class="private-git-fields"><Field label="Username"><Input value={form.gitUsername} autocomplete="username" placeholder="Enter username" onInput={(event) => { update('gitUsername', event.currentTarget.value); editGitConnection() }} /></Field><Field label="Personal Access Token (PAT)"><Input type="password" value={form.gitSecret} autocomplete="off" placeholder="Enter personal access token" onInput={(event) => { update('gitSecret', event.currentTarget.value); editGitConnection() }} /></Field></div>}<div class="source-branch-grid"><Field label="Branch"><Select value={form.branch} disabled={!gitHead || gitTesting} onChange={(event) => void selectGitBranch(event.currentTarget.value)}>{gitBranches.length ? gitBranches.map((branch) => <option key={branch}>{branch}</option>) : <option>{gitTesting ? 'Connecting...' : 'Connect repository first'}</option>}</Select></Field><Field label="Folder (optional)"><Select value={form.subdirectory} disabled={!gitHead || gitFoldersLoading} onChange={(event) => update('subdirectory', event.currentTarget.value)}><option value="">/</option>{gitDirectories.map((directory) => <option key={directory}>{directory}</option>)}</Select></Field></div></div> : <Field label="Local folder"><div class="source-folder-input"><Input value={form.sourcePath} placeholder="/Users/you/projects/product" onInput={(event) => update('sourcePath', event.currentTarget.value)} /><Button icon="folder" busy={browsing} onClick={() => void browseSourceDirectory()}>Browse</Button></div></Field>}</div> : <div class="sources-dialog-body openapi-body"><div class="openapi-tabs"><button type="button" class={form.specInput === 'file' ? 'active' : ''} onClick={() => update('specInput', 'file')}><Icon name="publish" size={18} />Upload file</button><button type="button" class={form.specInput === 'url' ? 'active' : ''} onClick={() => update('specInput', 'url')}><Icon name="external" size={18} />From URL</button></div>{form.specInput === 'file' ? <div class={`openapi-dropzone ${setupSpecFileName ? 'has-file' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void readSetupSpecification(event.dataTransfer?.files[0]) }}><input ref={setupSpecInput} type="file" accept=".yaml,.yml,.json,application/json,text/yaml" onChange={(event) => void readSetupSpecification(event.currentTarget.files?.[0])} /><span><Icon name={setupSpecFileName ? 'check' : 'publish'} size={28} /></span><strong>{setupSpecFileName || 'Drag and drop your OpenAPI file here'}</strong>{!setupSpecFileName && <small>or</small>}<Button onClick={() => setupSpecInput.current?.click()}>{setupSpecFileName ? 'Choose another file' : 'Browse file'}</Button><em>Accepted formats: .yaml, .yml, .json</em></div> : <Field label="OpenAPI spec URL"><div class="openapi-url-input"><Icon name="external" size={18} /><Input value={form.sourcePath} placeholder="https://example.com/openapi.json" onInput={(event) => { update('sourcePath', event.currentTarget.value); update('specContent', ''); setSetupSpecFileName('') }} /></div><small>We support public URLs and standard OpenAPI formats.</small></Field>}</div>}
            <footer><Button onClick={() => setSourceFlowStep('closed')}>Cancel</Button><Button tone="primary" busy={savingSource} disabled={form.sourceKind === 'directory' ? sourceType === 'git' ? !gitHead || gitFoldersLoading : !form.sourcePath.trim() : form.specInput === 'file' ? !form.specContent.trim() : !form.sourcePath.trim()} onClick={() => void addSetupSource()}>Add source</Button></footer>
          </section></div>}
        </>}
        {step === 3 && <div class="setup-tools-stage"><SetupStepHeading visual="🪄" title="Configure your tools" detail="Choose how Doxloop should generate your documentation." />
          <div class="setup-tools"><Field label="Documentation generator" hint="Creates and organizes your documentation."><Select value={form.generator} onChange={(event) => update('generator', event.currentTarget.value)}>{generators.map((item) => <option value={item.id}>{item.displayName}</option>)}</Select>{form.generator === 'doxbrix' && <small class="recommended-label"><Icon name="sparkle" size={12} />Recommended</small>}</Field><Field label="Coding assistant" hint="Helps understand and explain your product."><Select value={form.agent} disabled={selectedAgentInstallJob?.status === 'running'} onChange={(event) => {
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
            <Field label="Select Model" hint={form.agent ? `Search suggested ${agentLabel(form.agent)} models or enter another model ID.` : 'Select a coding assistant first.'}><Combo value={form.model} options={availableModels.map((model) => [model.id, model.label] as const)} disabled={!form.agent} placeholder="Search or enter a model ID" onValueChange={(value) => update('model', value)} /></Field><Field label={form.agent === 'claude' ? 'Effort' : 'Reasoning'} hint={supportedReasoning.length ? 'Search suggested levels or enter a custom value.' : 'Enter a supported value, or leave blank for the default.'}><Combo value={form.agent === 'claude' ? form.effort : form.reasoning} options={supportedReasoning.map((value) => [value, value] as const)} disabled={!form.agent} placeholder="Search or enter a value" onValueChange={(value) => update(form.agent === 'claude' ? 'effort' : 'reasoning', value)} /></Field><div class="screenshot-option setup-screenshot-option"><span>Capture application screenshots</span><Toggle checked={form.screenshots} onChange={(screenshots) => setForm((current) => ({ ...current, screenshots }))} label="Capture screenshots during documentation creation" /></div></div>
          {selectedAgent && <div class="setup-success-note"><span><Icon name="check" size={13} /></span><p><strong>Great choice!</strong>This setup works well for most projects and is easy to change later.</p></div>}</div>}
        {step === 4 && <DocumentationGuidance
          audiences={form.audiences}
          customInstructions={form.customInstructions}
          onAudiencesChange={(audiences) => setForm((current) => ({ ...current, audiences }))}
          onInstructionsChange={(customInstructions) => setForm((current) => ({ ...current, customInstructions }))}
        />}
        {step === 5 && !creationJob && <><div class="setup-review-heading"><span aria-hidden="true">🚀</span><div><h1>Review and create</h1><p>Everything looks good! Let's create your documentation.</p></div></div>
          <div class="setup-review-grid">
            <section class="setup-review-summary concise" aria-label="Documentation configuration">
              <ReviewSummaryRow icon="file" label="Title"><strong>{form.title}</strong></ReviewSummaryRow>
              <ReviewSummaryRow icon="link" label="Sources" trailing={<span class="review-source-count"><Icon name="check" size={12} />{sources.length} {sources.length === 1 ? 'source' : 'sources'}</span>}><span class="review-source-list">{sources.map((source) => <span class="review-source" key={source.name}><strong>{source.name} · {source.sourceKind === 'openapi' ? 'OpenAPI Specification' : source.sourceLocation === 'git' ? 'Git Repository' : 'Local Folder'}</strong><small>{source.sourceKind === 'openapi' || source.sourceLocation === 'local' ? source.sourcePath || 'Uploaded specification' : `${source.repository} · ${source.branch}${source.subdirectory ? ` / ${source.subdirectory}` : ''}`}</small></span>)}</span></ReviewSummaryRow>
              <ReviewSummaryRow icon="bot" label="Model"><strong>{form.model || 'Default'}</strong></ReviewSummaryRow>
              <ReviewSummaryRow icon="users" label="Guidance"><span class="review-guidance"><strong>{form.audiences.length ? form.audiences.join(', ') : 'Agent will determine the audience'}</strong><small>{form.customInstructions.trim() || 'No custom instructions'}</small></span></ReviewSummaryRow>
            </section>
          </div>
          <div class="setup-review-ready"><span><Icon name="check" size={20} /></span><div><strong>All set to create!</strong><small>We'll create your documentation workspace with the configuration above.</small></div></div>
          {submitting && sources.some((source) => source.sourceLocation === 'git') && <Note>Downloading read-only repository snapshots and starting documentation creation…</Note>}
          {(setupError || error) && <Note tone="bad">{error || setupError}</Note>}</>}
        {step === 5 && creationJob && <SetupCreationProgress job={creationJob} model={form.model} streamConnected={creationStreamConnected} />}
        {step === 5 && creationJob?.status === 'succeeded' && <SetupNextSteps
          openingPreview={openingPreview}
          onPreview={() => void openDocumentationPreview()}
          onContinue={(next) => void onContinue(next)}
        />}
        {step === 5 && creationJob && (setupError || error) && <Note tone="bad">{error || setupError}</Note>}
        {step !== 5 && setupError && <Note tone="bad">{setupError}</Note>}
        <footer class="setup-actions setup-review-actions">
          {creationJob
            ? <><div class="setup-creation-footer-status"><span class={creationJob.status} /><strong>{creationJob.status === 'running' ? 'Documentation creation in progress' : creationJob.status === 'succeeded' ? 'Documentation is ready — choose a next step above' : 'Documentation creation stopped'}</strong></div><div>{creationJob.status === 'running' && <Button tone="danger" icon="stop" busy={cancellingCreation} onClick={() => void cancelDocumentationCreation()}>Stop creation</Button>}{creationJob.status === 'succeeded' && <Button icon="columns" onClick={() => void onContinue('authoring')}>Open Workspace</Button>}{(creationJob.status === 'failed' || creationJob.status === 'cancelled') && <Button tone="primary" icon="refresh" busy={submitting} onClick={() => void retryDocumentationCreation()}>Try Again</Button>}</div></>
            : <><div class="setup-review-progress"><strong>Step {step} of 5</strong><span>{[1, 2, 3, 4, 5].map((item) => <span class={item === step ? 'current' : item < step ? 'complete' : 'pending'} key={item}><i>{item <= step && <Icon name="check" size={10} />}</i>{item < 5 && <b />}</span>)}</span></div>
              <div>{step > 1 && <Button class="setup-back-button" onClick={() => setStep((value) => value - 1)}>Back</Button>}
                {step < 5
                  ? <Button tone="primary" busy={validatingPaths} disabled={(step === 1 && (!form.directory.trim() || !form.title.trim() || Boolean(pathErrors.directory))) || (step === 2 && (sources.length === 0 || sourceFlowStep !== 'closed')) || (step === 3 && Boolean(form.agent) && !selectedAgent)} onClick={() => void continueSetup()}>Continue <Icon name="arrowRight" size={14} /></Button>
                  : <Button tone="primary" icon="sparkle" busy={submitting} onClick={() => void createDocumentation()}>Create Documentation</Button>}
              </div></>}
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

function DocumentationGuidance({ audiences, customInstructions, onAudiencesChange, onInstructionsChange }: {
  audiences: string[]
  customInstructions: string
  onAudiencesChange: (audiences: string[]) => void
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

function SetupNextSteps({ openingPreview, onPreview, onContinue }: {
  openingPreview: boolean
  onPreview: () => void
  onContinue: (page: 'authoring' | 'sync' | 'publish') => void
}) {
  return <section class="setup-next-steps" aria-labelledby="setup-next-steps-title">
    <header>
      <div><span><Icon name="sparkles" size={17} /></span><div><h2 id="setup-next-steps-title">What would you like to do next?</h2><p>Your documentation stays local until you choose to publish it.</p></div></div>
    </header>
    <div class="setup-next-step-grid">
      <button type="button" class="setup-next-step featured" disabled={openingPreview} onClick={onPreview}>
        <span class="setup-next-step-icon"><Icon name="preview" size={18} /></span><strong>{openingPreview ? 'Opening preview…' : 'Preview documentation'}</strong><Icon name="external" size={13} />
      </button>
      <button type="button" class="setup-next-step" onClick={() => onContinue('publish')}>
        <span class="setup-next-step-icon publish"><Icon name="publish" size={18} /></span><strong>Publish to Doxbrix</strong><Icon name="arrowRight" size={13} />
      </button>
      <button type="button" class="setup-next-step" onClick={() => onContinue('sync')}>
        <span class="setup-next-step-icon monitor"><Icon name="sync" size={18} /></span><strong>Set up monitoring</strong><Icon name="arrowRight" size={13} />
      </button>
      <button type="button" class="setup-next-step" onClick={() => onContinue('authoring')}><span class="setup-next-step-icon update"><Icon name="wand" size={18} /></span><strong>Update documentation</strong><Icon name="arrowRight" size={13} /></button>
    </div>
  </section>
}

const DOCUMENTATION_PROGRESS_MESSAGES = [
  'Working on your documentation…',
  'This can take a few minutes. You can follow the activity below.',
  'Getting there — Doxloop is organizing and validating your content…',
  'Finishing the documentation and preparing your preview…',
]

function SetupCreationProgress({ job, model, streamConnected }: { job: UiJob; model: string; streamConnected: boolean }) {
  const [messageIndex, setMessageIndex] = useState(0)
  const [clock, setClock] = useState(() => Date.now())
  const log = useRef<HTMLPreElement>(null)
  const running = job.status === 'running'
  const succeeded = job.status === 'succeeded'
  useEffect(() => {
    if (!running) return
    const timer = window.setInterval(() => setMessageIndex((current) => (current + 1) % DOCUMENTATION_PROGRESS_MESSAGES.length), 4200)
    return () => clearInterval(timer)
  }, [running])
  useEffect(() => {
    if (!running) return
    setClock(Date.now())
    const timer = window.setInterval(() => setClock(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running, job.startedAt])
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [job.lines.length])
  const title = succeeded ? 'Your documentation is ready!' : running ? 'Creating your documentation' : 'Documentation creation stopped'
  const detail = succeeded
    ? 'Everything has been generated and validated. Open the preview when you are ready.'
    : running
      ? DOCUMENTATION_PROGRESS_MESSAGES[messageIndex]
      : 'The run did not complete. Review the latest activity below, then try again.'
  const elapsed = durationText(new Date(job.startedAt).getTime(), job.finishedAt ? new Date(job.finishedAt).getTime() : clock)
  return <div class={`setup-creation-progress ${job.status}`}>
    <header class="setup-creation-heading">
      <span class="setup-creation-spinner">{succeeded ? <Icon name="check" size={28} /> : running ? <i /> : <Icon name="alert" size={26} />}</span>
      <div><h1>{title}</h1><p aria-live="polite">{detail}</p></div>
    </header>
    <section class="setup-creation-status-card">
      <div class="setup-creation-status-top"><span><i class={job.status} />{running ? 'Generation in progress' : succeeded ? 'Generation complete' : 'Generation failed'}</span>{running && <Badge tone={streamConnected ? 'good' : 'warn'} icon="broadcast">{streamConnected ? 'Live' : 'Reconnecting…'}</Badge>}</div>
      <div class="setup-creation-track"><i /></div>
      <div class="setup-creation-meta"><span><Icon name="bot" size={14} />{job.agent ? agentLabel(job.agent) : 'Coding agent'}</span><span class="setup-creation-model"><Icon name="sparkles" size={14} />Model <strong>{model || 'Default'}</strong></span><span class="setup-creation-elapsed"><Icon name="clock" size={14} />{running ? 'Working for' : 'Worked for'} <strong>{elapsed}</strong></span><span><Icon name="file" size={14} />{job.lines.length} log {job.lines.length === 1 ? 'entry' : 'entries'}</span></div>
    </section>
    <section class="setup-creation-log" aria-label="Documentation creation activity">
      <header><div><span><Icon name="record" size={14} /></span><strong>Live activity</strong></div><a href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer">Open full log <Icon name="external" size={12} /></a></header>
      <pre ref={log} aria-live="polite">{job.lines.length ? job.lines.join('\n') : 'Starting the documentation agent…'}</pre>
    </section>
  </div>
}

function durationText(startedAt: number, endedAt: number): string {
  const totalSeconds = Math.max(0, Math.floor((endedAt - startedAt) / 1000))
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}

function ReviewSummaryRow({ icon, label, trailing, children }: { icon: string; label: string; trailing?: ComponentChildren; children: ComponentChildren }) {
  return <div class="review-summary-row"><span class="review-summary-icon"><Icon name={icon} size={20} /></span><span class="review-summary-label">{label}</span><span class="review-summary-value">{children}</span>{trailing && <span class="review-summary-trailing">{trailing}</span>}</div>
}

function SetupStepHeading({ visual, title, detail }: { visual: string; title: string; detail: string }) {
  return <div class="setup-step-heading"><span class="setup-heading-visual" aria-hidden="true">{visual}</span><div><h3>{title}</h3><p>{detail}</p></div></div>
}

function sourceFlowTitle(step: SourceFlowStep): string {
  if (step === 'type') return 'What would you like to add?'
  if (step === 'source-location') return 'Choose a repository type'
  if (step === 'git-access') return 'Is the repository public or private?'
  if (step === 'git-connect') return 'Connect the Git repository'
  if (step === 'git-select') return 'Choose a branch and folder'
  if (step === 'local') return 'Select a local repository'
  if (step === 'openapi-format') return 'Choose an OpenAPI format'
  return 'Provide the OpenAPI specification'
}

function sourceFlowDetail(step: SourceFlowStep): string {
  if (step === 'type') return 'Select one option to continue.'
  if (step === 'source-location') return 'Choose where the source repository is located.'
  if (step === 'git-access') return 'This determines which connection details are required.'
  if (step === 'git-connect') return 'Enter only the details required to connect.'
  if (step === 'git-select') return 'Select the exact repository content to include.'
  if (step === 'local') return 'Choose or provide the local repository folder.'
  if (step === 'openapi-format') return 'Provide a hosted URL or a YAML/JSON file.'
  return 'Enter the specification location, then add it as a source.'
}

function ReferenceChoice({ icon, tone = '', title, detail, onClick }: { icon: string; tone?: string; title: string; detail: string; onClick: () => void }) {
  return <button type="button" class="reference-choice" onClick={onClick}><span class={tone}><Icon name={icon} size={22} /></span><span><strong>{title}</strong><small>{detail}</small></span></button>
}

function RepositoryFolderTree({ value, directories, loading, onChange }: { value: string; directories: string[]; loading: boolean; onChange: (value: string) => void }) {
  if (loading) return <div class="repository-folder-tree loading"><span class="spinner" />Loading folders…</div>
  return <div class="repository-folder-tree" role="listbox" aria-label="Repository folders">
    <button type="button" class={!value ? 'selected' : ''} onClick={() => onChange('')}><Icon name="folder" size={14} /><span>/</span></button>
    {directories.map((directory) => {
      const depth = Math.min(directory.split('/').length - 1, 4)
      const label = directory.split('/').pop() ?? directory
      return <button type="button" class={value === directory ? 'selected' : ''} style={{ paddingLeft: `${14 + depth * 16}px` }} onClick={() => onChange(directory)} key={directory}><Icon name="folder" size={14} /><span>{label}</span></button>
    })}
  </div>
}

function SourceTypeChoice({ selected, visual, title, detail, onClick }: { selected: boolean; visual: 'code' | 'folder' | 'api'; title: string; detail: string; onClick: () => void }) {
  const icon = visual === 'folder' ? 'folder' : visual === 'api' ? 'file' : 'api'
  return <button type="button" class={`source-type-choice ${selected ? 'selected' : ''}`} aria-pressed={selected} onClick={onClick}><span class={`source-type-visual ${visual}`}><Icon name={icon} size={20} /></span><strong>{title}</strong><small>{detail}</small></button>
}

function GitSettingRow({ icon, label, value, disabled, onChange }: { icon: string; label: string; value: string; disabled?: boolean; onChange: () => void }) {
  return <div class={`git-setting-row ${disabled ? 'disabled' : ''}`}><span class="git-setting-icon"><Icon name={icon} size={19} /></span><div><strong>{label}</strong><small>{value}</small></div><Button type="button" disabled={disabled} onClick={onChange}>Change</Button></div>
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

function Home({ state, navigate, reload, act }: { state: UiState; navigate: (page: Page) => void; reload: () => Promise<void>; act: Action }) {
  const project = state.project!
  const validation = validValidation(state.validation)
  const documentationGenerated = Boolean(state.receipt)
  const runs = validRuns(state.runs)
  const drift = state.drift
  const stale = drift && 'pages' in drift ? drift.pages.length : 0
  const configuredAgent = project.defaultAgent && ['codex', 'claude', 'gemini'].includes(project.defaultAgent)
    ? project.defaultAgent
    : state.agents?.[0]?.name ?? 'codex'
  const [installTarget, setInstallTarget] = useState(configuredAgent)
  const [switchingAgent, setSwitchingAgent] = useState(false)
  const [requestedInstall, setRequestedInstall] = useState('')
  const [loginRequested, setLoginRequested] = useState(false)
  const [loginStarting, setLoginStarting] = useState(false)
  const preferred = state.agents?.find((agent) => agent.name === installTarget)
  const runningInstall = state.jobs.find((job) => job.type === 'agent:install' && job.status === 'running')
  const requestedInstallJob = requestedInstall
    ? state.jobs.find((job) => job.type === 'agent:install' && job.agent === requestedInstall)
    : undefined
  const installJob = runningInstall ?? requestedInstallJob
  const installPending = requestedInstall === installTarget && !installJob
  const runningLogin = state.jobs.find((job) => job.type === 'login' && job.status === 'running')
  const requestedLoginJob = loginRequested ? state.jobs.find((job) => job.type === 'login') : undefined
  const loginJob = runningLogin ?? requestedLoginJob
  const requestAgentInstall = async () => {
    setRequestedInstall(installTarget)
    const result = await act(() => post<UiJob | { name: string; executable: string; alreadyInstalled: true }>('/api/agent/install', { agent: installTarget }))
    if (!result || !('status' in result)) setRequestedInstall('')
  }
  const switchAgent = async (agent: string) => {
    if (agent === installTarget) return
    const previous = installTarget
    setInstallTarget(agent)
    setSwitchingAgent(true)
    const result = await act(() => patch('/api/project', { defaultAgent: agent }), `Default agent changed to ${agentLabel(agent)}`)
    if (result === undefined) setInstallTarget(previous)
    setSwitchingAgent(false)
  }
  const requestLogin = async () => {
    setLoginRequested(true)
    setLoginStarting(true)
    const result = await act(() => post<UiJob>('/api/auth/login', { apiUrl: state.account?.apiUrl }))
    if (!result) setLoginRequested(false)
    setLoginStarting(false)
  }
  const cancelLogin = async () => {
    if (!loginJob || loginJob.status !== 'running') return
    await act(() => post(`/api/jobs/${loginJob.id}/cancel`), 'Sign-in cancelled')
  }
  useEffect(() => setInstallTarget(configuredAgent), [configuredAgent])
  useEffect(() => {
    if (runningLogin) setLoginRequested(true)
  }, [runningLogin?.id])
  useEffect(() => {
    if (!state.account?.signedIn && loginJob?.status === 'succeeded') void reload()
  }, [loginJob?.status, state.account?.signedIn])
  const pending = runs.filter((run) => OPEN_STATUSES.includes(run.status)).length
  const healthy = documentationGenerated && (validation?.errors ?? 0) === 0 && stale === 0
  return <>
    <PageHeader
      title="Overview"
      description={project.title}
      meta={<>
        <Badge tone={healthy ? 'good' : 'warn'} icon={healthy ? 'check' : 'alert'}>{healthy ? 'Healthy' : 'Needs attention'}</Badge>
        <span>{generatorLabel(state.generators, project.generator)}</span>
        <span>{project.sources.length} source{project.sources.length === 1 ? '' : 's'}</span>
        <span>{agentLabel(installTarget)}{preferred ? '' : ' · not installed'}</span>
      </>}
      actions={<><Button icon="refresh" onClick={() => void reload()}>Refresh</Button><Button tone="primary" icon="sparkle" onClick={() => navigate('authoring')}>{state.receipt ? 'Maintain documentation' : 'Create documentation'}</Button></>}
    />
    <div class="stat-row">
      <Stat label="Documentation pages" value={documentationGenerated ? validation?.pages.length ?? '—' : '—'} detail={documentationGenerated ? `${validation?.errors ?? 0} errors · ${validation?.warnings ?? 0} warnings` : 'Generate documentation to begin'} />
      <Stat label="Source drift" value={stale} detail={stale === 1 ? 'stale page' : 'stale pages'} {...(stale ? { tone: 'warn' as const } : {})} />
      <Stat label="Pending proposals" value={pending} detail={`${runs.length} total run${runs.length === 1 ? '' : 's'}`} />
      <Stat label="Monitoring" value={project.sync.on.length ? 'On' : 'Off'} detail={project.sync.on.join(', ') || 'Manual checks only'} />
    </div>
    <div class="split">
      <Panel title="Next steps" description="The most useful actions for this workspace" flush>
        <div class="link-rows">
          {([['authoring', 'Update documentation', 'Create docs from your connected sources'], ['sync', 'Check source drift', 'Compare sources with your documentation'], ['proposals', 'Review proposals', 'Accept or reject isolated changes'], ['preview', 'Open preview', 'Inspect the generated site locally']] as const).map(([target, title, detail]) =>
            <button key={target} onClick={() => navigate(target)}>
              <span class="row-icon"><Icon name={target} size={16} /></span>
              <span class="row-copy"><strong>{title}</strong><small>{detail}</small></span>
              <Icon name="chevronRight" size={14} class="row-chevron" />
            </button>)}
        </div>
      </Panel>
      <Panel title="Workspace readiness" description="Live checks across the setup" flush>
        <div class="check-rows">
          <Check
            ok={Boolean(preferred)}
            label="Coding agent"
            detail={preferred
              ? `${agentLabel(preferred.name)} · ${preferred.authentication.status}`
              : `${agentLabel(installTarget)} is not installed`}
            action={<>
              <Select aria-label="Default coding agent" value={installTarget} disabled={switchingAgent || installJob?.status === 'running'} onChange={(event) => void switchAgent(event.currentTarget.value)}>
                {['codex', 'claude', 'gemini'].map((agent) => <option key={agent} value={agent}>{agentLabel(agent)} — {state.agents?.some((item) => item.name === agent) ? 'Installed' : 'Not installed'}</option>)}
              </Select>
              {installJob
                ? <AgentInstallProgress job={installJob} onRetry={() => void requestAgentInstall()} />
                : preferred
                  ? <Badge tone="good" icon="check">Installed</Badge>
                  : <Button size="sm" busy={installPending} onClick={() => void requestAgentInstall()}>Install {agentLabel(installTarget)}</Button>}
            </>}
          />
          <Check
            ok={documentationGenerated && (validation?.errors ?? 1) === 0}
            warning={!documentationGenerated}
            label="Documentation validation"
            detail={documentationGenerated ? `${validation?.errors ?? 0} errors and ${validation?.warnings ?? 0} warnings` : 'Documentation not generated yet'}
            action={!documentationGenerated && <Button size="sm" tone="primary" icon="sparkle" onClick={() => navigate('authoring')}>Create documentation</Button>}
          />
          <Check ok={project.sources.length > 0} label="Product sources" detail={`${project.sources.length} connected source${project.sources.length === 1 ? '' : 's'}`} />
          <Check
            ok={Boolean(state.account?.signedIn)}
            warning={!state.account?.signedIn && loginJob?.status === 'running'}
            label="Doxbrix account"
            detail={state.account?.signedIn
              ? state.account.user?.email ?? 'Signed in'
              : loginJob?.status === 'running' ? 'Waiting for browser authentication…' : 'Not signed in'}
            action={state.account?.signedIn
              ? <Button size="sm" onClick={() => navigate('publish')}>Manage</Button>
              : loginJob
                ? <AccountLoginProgress job={loginJob} busy={loginStarting} onCancel={() => void cancelLogin()} onRetry={() => void requestLogin()} />
                : <Button size="sm" tone="primary" icon="key" busy={loginStarting} onClick={() => void requestLogin()}>Sign in</Button>}
          />
        </div>
      </Panel>
    </div>
    <Panel title="Recent activity" actions={<Button size="sm" onClick={() => void act(() => api('/api/jobs'), undefined, false)}>Refresh</Button>} flush>
      <JobTable jobs={state.jobs.slice(0, 5)} onCancel={(id) => void act(() => post(`/api/jobs/${id}/cancel`), 'Job cancelled')} />
    </Panel>
  </>
}

function SourcesReference({ state, act }: { state: UiState; act: Action }) {
  const project = state.project!
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<'source' | 'openapi' | null>(null)
  const [sourceMode, setSourceMode] = useState<'git' | 'local'>('git')
  const [openapiMode, setOpenapiMode] = useState<'file' | 'url'>('file')
  const [add, setAdd] = useState({ repository: '', branch: 'main', subdirectory: '', path: '', authMethod: 'automatic', gitUsername: '', gitSecret: '', specContent: '', fileName: '' })
  const [branches, setBranches] = useState<string[]>([])
  const [directories, setDirectories] = useState<string[]>([])
  const [head, setHead] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [foldersLoading, setFoldersLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const fileInput = useRef<HTMLInputElement>(null)
  const filtered = project.sources
  const resetAdd = () => {
    setAdd({ repository: '', branch: 'main', subdirectory: '', path: '', authMethod: 'automatic', gitUsername: '', gitSecret: '', specContent: '', fileName: '' })
    setBranches([])
    setDirectories([])
    setHead('')
    setSourceMode('git')
    setOpenapiMode('file')
  }
  const openDialog = (next: 'source' | 'openapi') => {
    resetAdd()
    setMenuOpen(false)
    setDialog(next)
  }
  const closeDialog = () => setDialog(null)
  const connectRepository = async () => {
    if (!add.repository.trim() || connecting) return
    setConnecting(true)
    try {
      const result = await act(() => post<{ repository: string; branch: string; head: string; branches: string[] }>('/api/setup/git/test', add), undefined, false)
      if (!result) return
      setAdd((current) => ({ ...current, repository: result.repository, branch: result.branch, subdirectory: '' }))
      setBranches(result.branches)
      setFoldersLoading(true)
      const folders = await act(() => post<{ directories: string[] }>('/api/setup/git/folders', { ...add, repository: result.repository, branch: result.branch, subdirectory: '' }), undefined, false)
      if (!folders) return
      setDirectories(folders.directories)
      setHead(result.head)
    } finally {
      setFoldersLoading(false)
      setConnecting(false)
    }
  }
  const selectBranch = async (branch: string) => {
    setAdd((current) => ({ ...current, branch, subdirectory: '' }))
    setFoldersLoading(true)
    try {
      const folders = await act(() => post<{ directories: string[] }>('/api/setup/git/folders', { ...add, branch, subdirectory: '' }), undefined, false)
      setDirectories(folders?.directories ?? [])
    } finally {
      setFoldersLoading(false)
    }
  }
  const readSpecification = async (file: File | undefined) => {
    if (!file) return
    const content = await file.text()
    setOpenapiMode('file')
    setAdd((current) => ({ ...current, fileName: file.name, specContent: content, path: '' }))
  }
  const addSource = async () => {
    const location = dialog === 'openapi' ? add.path || add.fileName || 'openapi' : sourceMode === 'git' ? add.repository : add.path
    const rawName = location.replace(/[?#].*$/, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/\.git$/i, '').replace(/\.(json|ya?ml)$/i, '') || 'source'
    const name = rawName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    setSaving(true)
    try {
      const body = dialog === 'openapi'
        ? { kind: 'openapi', name, path: openapiMode === 'url' ? add.path : undefined, specContent: openapiMode === 'file' ? add.specContent : undefined }
        : sourceMode === 'git'
          ? { kind: 'git', name, ...add }
          : { kind: 'directory', name, path: add.path }
      const result = await act(() => post('/api/sources', body), 'Source added')
      if (result !== undefined) closeDialog()
    } finally {
      setSaving(false)
    }
  }
  return <div class="sources-reference-page">
    <header class="sources-page-header"><div><h1>Sources</h1><p>Manage all the sources you've connected to create documentation.</p></div><div class="sources-page-tools"><div class="sources-add-wrap"><button type="button" class="sources-add-dropdown-button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><Icon name="plus" size={16} />Add source<Icon name="chevronDown" size={14} /></button>{menuOpen && <div class="sources-add-menu"><button type="button" onClick={() => openDialog('source')}><span><Icon name="api" size={20} /></span><span><strong>Source code</strong></span></button><button type="button" onClick={() => openDialog('openapi')}><span><Icon name="braces" size={20} /></span><span><strong>OpenAPI spec</strong></span></button></div>}</div></div></header>
    <section class="sources-data-panel"><header>All sources ({filtered.length})</header><div class="sources-table-head"><span>Name</span><span>Type</span><span>Last updated</span><span>Status</span><span /></div>{filtered.length ? <div class="sources-table-body">{filtered.map((source) => <div class="sources-data-row" key={source.name}><span class="sources-name-cell"><span class={`source-service-icon ${source.kind === 'openapi' ? 'openapi' : source.remote ? `git ${repositoryProvider(source.remote.repository)}` : 'local'}`}><Icon name={source.kind === 'openapi' ? 'braces' : source.remote ? repositoryProviderIcon(source.remote.repository) : 'folder'} size={20} /></span><span><strong>{source.name}</strong><small>{source.remote ? source.remote.repository : source.path}</small></span></span><span><em class={`source-type-pill ${source.kind === 'openapi' ? 'openapi' : source.remote ? 'git' : 'local'}`}>{source.kind === 'openapi' ? 'OpenAPI' : source.remote ? 'Git' : 'Local'}</em></span><span class="source-updated">Recently</span><span><em class="source-sync-status"><Icon name="check" size={12} />Synced</em></span><span class="source-row-menu"><button type="button" aria-label={`Delete ${source.name}`} title="Delete source" onClick={() => { if (confirm(`Remove ${source.name}?`)) void act(() => remove(`/api/sources/${encodeURIComponent(source.name)}`), 'Source removed') }}><Icon name="trash" size={22} /></button></span></div>)}</div> : <div class="sources-table-empty"><Icon name="sources" size={28} /><strong>No sources found</strong><small>Add a source or adjust your search.</small></div>}<footer><span>Showing {filtered.length ? `1 to ${filtered.length}` : '0'} of {filtered.length} results</span><span><button disabled><Icon name="chevronRight" size={14} /></button><button disabled><Icon name="chevronRight" size={14} /></button></span></footer></section>
    {dialog && <div class="sources-modal-scrim" onClick={closeDialog}><section class={`sources-reference-dialog ${dialog}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
      <header>{dialog === 'openapi' && <span class="sources-dialog-icon"><Icon name="file" size={24} /></span>}<div><h2>{dialog === 'source' ? 'Add source code' : 'Add OpenAPI spec'}</h2><p>{dialog === 'source' ? 'Choose how you want to connect your source code.' : 'Import your OpenAPI specification from a local file or a public URL.'}</p></div><button type="button" aria-label="Close" onClick={closeDialog}><Icon name="close" size={17} /></button></header>
      {dialog === 'source' ? <div class="sources-dialog-body"><span class="dialog-section-label">Source type</span><div class="source-mode-grid"><button type="button" class={sourceMode === 'git' ? 'selected' : ''} onClick={() => setSourceMode('git')}><span><Icon name="api" size={22} /></span><i /><strong>Git repository</strong><small>Connect a GitHub, GitLab, Azure DevOps or other Git service.</small></button><button type="button" class={sourceMode === 'local' ? 'selected' : ''} onClick={() => setSourceMode('local')}><span><Icon name="folder" size={22} /></span><i /><strong>Local folder</strong><small>Use a folder on your computer or network.</small></button></div>{sourceMode === 'git' ? <div class="source-code-fields"><Field label="Repository access"><Select value={add.authMethod} onChange={(event) => { setAdd({ ...add, authMethod: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }}><option value="automatic">Public repository</option><option value="credentials">Private repository</option></Select></Field><Field label="Repository URL"><div class="repository-connect-input"><Input value={add.repository} placeholder="https://github.com/company/product" onInput={(event) => { setAdd({ ...add, repository: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /><RepositoryConnectButton connected={Boolean(head)} busy={connecting} disabled={!add.repository.trim() || (add.authMethod === 'credentials' && (!add.gitUsername.trim() || !add.gitSecret.trim()))} onClick={() => void connectRepository()} /></div></Field>{add.authMethod === 'credentials' && <div class="private-git-fields"><Field label="Username"><Input value={add.gitUsername} autocomplete="username" placeholder="Enter username" onInput={(event) => { setAdd({ ...add, gitUsername: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /></Field><Field label="Personal Access Token (PAT)"><Input type="password" value={add.gitSecret} autocomplete="off" placeholder="Enter personal access token" onInput={(event) => { setAdd({ ...add, gitSecret: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /></Field></div>}<div class="source-branch-grid"><Field label="Branch"><Select value={add.branch} disabled={!head || connecting} onChange={(event) => void selectBranch(event.currentTarget.value)}>{branches.length ? branches.map((branch) => <option key={branch}>{branch}</option>) : <option>{connecting ? 'Connecting...' : 'Connect repository first'}</option>}</Select></Field><Field label="Folder (optional)"><Select value={add.subdirectory} disabled={!head || foldersLoading} onChange={(event) => setAdd({ ...add, subdirectory: event.currentTarget.value })}><option value="">/</option>{directories.map((directory) => <option key={directory}>{directory}</option>)}</Select></Field></div></div> : <Field label="Local folder"><div class="source-folder-input"><Input value={add.path} placeholder="/Users/you/projects/product" onInput={(event) => setAdd({ ...add, path: event.currentTarget.value })} /><Button icon="folder" onClick={() => void post<{ path: string | null }>('/api/setup/browse-directory').then((result) => result.path && setAdd({ ...add, path: result.path }))}>Browse</Button></div></Field>}</div> : <div class="sources-dialog-body openapi-body"><div class="openapi-tabs"><button type="button" class={openapiMode === 'file' ? 'active' : ''} onClick={() => setOpenapiMode('file')}><Icon name="publish" size={18} />Upload file</button><button type="button" class={openapiMode === 'url' ? 'active' : ''} onClick={() => setOpenapiMode('url')}><Icon name="external" size={18} />From URL</button></div>{openapiMode === 'file' ? <div class={`openapi-dropzone ${add.fileName ? 'has-file' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void readSpecification(event.dataTransfer?.files[0]) }}><input ref={fileInput} type="file" accept=".yaml,.yml,.json,application/json,text/yaml" onChange={(event) => void readSpecification(event.currentTarget.files?.[0])} /><span><Icon name={add.fileName ? 'check' : 'publish'} size={28} /></span><strong>{add.fileName || 'Drag and drop your OpenAPI file here'}</strong>{!add.fileName && <small>or</small>}<Button onClick={() => fileInput.current?.click()}>{add.fileName ? 'Choose another file' : 'Browse file'}</Button><em>Accepted formats: .yaml, .yml, .json</em></div> : <Field label="OpenAPI spec URL"><div class="openapi-url-input"><Icon name="external" size={18} /><Input value={add.path} placeholder="https://example.com/openapi.json" onInput={(event) => setAdd({ ...add, path: event.currentTarget.value, specContent: '', fileName: '' })} /></div><small>We support public URLs and standard OpenAPI formats.</small></Field>}</div>}
      <footer><Button onClick={closeDialog}>Cancel</Button><Button tone="primary" busy={saving} disabled={dialog === 'source' ? sourceMode === 'git' ? !head || foldersLoading : !add.path.trim() : openapiMode === 'file' ? !add.specContent.trim() : !add.path.trim()} onClick={() => void addSource()}>Add source</Button></footer>
    </section></div>}
  </div>
}

function Sources({ state, act }: { state: UiState; act: Action }) {
  const project = state.project!
  const [selected, setSelected] = useState(project.sources[0]?.name ?? '')
  const [adding, setAdding] = useState(project.sources.length === 0)
  const [add, setAdd] = useState({ kind: 'directory', name: 'product', path: '', repository: '', branch: 'main', subdirectory: '', authMethod: 'automatic', gitUsername: '', gitSecret: '' })
  const [addBranches, setAddBranches] = useState<string[]>([])
  const [addDirectories, setAddDirectories] = useState<string[]>([])
  const [addHead, setAddHead] = useState('')
  const [testingAdd, setTestingAdd] = useState(false)
  const [loadingAddFolders, setLoadingAddFolders] = useState(false)
  const source = project.sources.find((item) => item.name === selected) ?? project.sources[0]
  const connectAddRepository = async () => {
    setTestingAdd(true)
    try {
      const result = await act(() => post<{ repository: string; branch: string; head: string; branches: string[] }>('/api/setup/git/test', add), 'Repository connected', false)
      if (result) {
        setAdd((current) => ({ ...current, repository: result.repository, branch: result.branch }))
        setAddBranches(result.branches)
        setAddHead(result.head)
        setLoadingAddFolders(true)
        const folders = await act(() => post<{ directories: string[] }>('/api/setup/git/folders', { ...add, repository: result.repository, branch: result.branch, subdirectory: '' }), undefined, false)
        setAddDirectories(folders?.directories ?? [])
      }
    } finally {
      setLoadingAddFolders(false)
      setTestingAdd(false)
    }
  }
  const selectAddBranch = async (branch: string) => {
    setAdd((current) => ({ ...current, branch, subdirectory: '' }))
    setLoadingAddFolders(true)
    try {
      const folders = await act(() => post<{ directories: string[] }>('/api/setup/git/folders', { ...add, branch, subdirectory: '' }), undefined, false)
      setAddDirectories(folders?.directories ?? [])
    } finally {
      setLoadingAddFolders(false)
    }
  }
  return <>
    <PageHeader
      title="Sources"
      description="Connect the read-only sources Doxloop uses to create and maintain documentation."
      actions={<Button tone="primary" icon="plus" onClick={() => setAdding(true)}>Add source</Button>}
    />
    <div class="stat-row three">
      <Stat label="Connected sources" value={project.sources.length} detail="Read-only access" />
      <Stat label="Remote monitored" value={project.sources.filter((item) => item.remote).length} detail="Git connections" />
      <Stat label="API specifications" value={project.sources.filter((item) => item.kind === 'openapi').length} detail="OpenAPI documents" />
    </div>

    {adding && <Panel title="Add a source" description="Source paths are validated to stay outside the documentation content directory." actions={<Button size="sm" onClick={() => setAdding(false)}>Cancel</Button>}>
      <div class="form-grid">
        <Field label="Type"><Select value={add.kind} onChange={(event) => setAdd({ ...add, kind: event.currentTarget.value })}><option value="directory">Source directory</option><option value="git">Git repository</option><option value="openapi">OpenAPI specification</option></Select></Field>
        <Field label="Source"><Input value={add.name} onInput={(event) => setAdd({ ...add, name: event.currentTarget.value })} /></Field>
        {add.kind !== 'git' && <Field label={add.kind === 'openapi' ? 'File path or URL' : 'Directory path'} wide><Input value={add.path} placeholder={add.kind === 'openapi' ? 'openapi.yaml or https://…' : '../product'} onInput={(event) => setAdd({ ...add, path: event.currentTarget.value })} /></Field>}
        {add.kind === 'git' && <>
          <Field label="Repository address"><div class="path-input"><Input value={add.repository} placeholder="https://git.example.com/team/product.git" onInput={(event) => { setAdd({ ...add, repository: event.currentTarget.value }); setAddHead(''); setAddBranches([]); setAddDirectories([]) }} /><Button icon="key" busy={testingAdd} disabled={!add.repository.trim() || (add.authMethod === 'credentials' && !add.gitSecret)} onClick={() => void connectAddRepository()}>Connect</Button></div></Field>
          <Field label="Repository access"><Select value={add.authMethod} onChange={(event) => { setAdd({ ...add, authMethod: event.currentTarget.value }); setAddHead('') }}><option value="automatic">Public or already connected</option><option value="credentials">Private repository</option></Select></Field>
          {add.authMethod === 'credentials' && <><Field label="Account username"><Input value={add.gitUsername} autocomplete="username" onInput={(event) => setAdd({ ...add, gitUsername: event.currentTarget.value })} /></Field><Field label="Password or access key"><Input type="password" value={add.gitSecret} autocomplete="off" onInput={(event) => { setAdd({ ...add, gitSecret: event.currentTarget.value }); setAddHead('') }} /></Field></>}
          <Field label="Branch" hint={addBranches.length ? `${addBranches.length} available` : 'Connect the repository first.'}><Select value={add.branch} disabled={!addBranches.length || loadingAddFolders} onChange={(event) => void selectAddBranch(event.currentTarget.value)}>{addBranches.length ? addBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>) : <option>Connect repository first</option>}</Select></Field>
          <RepositoryFolderSelect value={add.subdirectory} directories={addDirectories} loading={loadingAddFolders} connected={Boolean(addHead)} onChange={(subdirectory) => setAdd({ ...add, subdirectory })} />
        </>}
      </div>
      <div class="form-actions"><Button tone="primary" disabled={add.kind === 'git' ? !add.repository.trim() || !add.branch.trim() || !addHead || loadingAddFolders : !add.path.trim()} onClick={() => void act(() => post('/api/sources', add), 'Source added').then(() => setAdding(false))}>Add source</Button></div>
    </Panel>}

    {project.sources.length === 0
      ? <Panel flush><Empty icon="sources" title="No sources connected" detail="Add a directory, Git repository, or OpenAPI specification." action={<Button tone="primary" icon="plus" onClick={() => setAdding(true)}>Add source</Button>} /></Panel>
      : <>
        <Panel title="Connected sources" flush>
          <Table head={<><th>Name</th><th>Type</th><th>Location</th><th>Monitoring</th><th class="right" /></>}>
            {project.sources.map((item) => <tr key={item.name} class={`selectable ${item.name === source?.name ? 'selected' : ''}`} onClick={() => setSelected(item.name)}>
              <td><div class="cell-lead"><Icon name={item.kind === 'openapi' ? 'api' : 'folder'} size={15} /><strong>{item.name}</strong></div></td>
              <td class="muted-cell">{item.kind === 'openapi' ? 'OpenAPI' : item.remote ? 'Git repository' : 'Directory'}</td>
              <td><code class="mono">{item.remote ? `${item.remote.repository}@${item.remote.branch}${item.remote.subdirectory ? `/${item.remote.subdirectory}` : ''}` : item.path}</code></td>
              <td>{item.remote ? <Badge tone="info" icon="cloud">{gitServiceLabel(item.remote.repository, item.remote.provider)}</Badge> : <span class="muted-cell">Local only</span>}</td>
              <td class="right"><Button size="sm" tone="ghost" onClick={(event) => { event.stopPropagation(); if (confirm(`Remove ${item.name}?`)) void act(() => remove(`/api/sources/${encodeURIComponent(item.name)}`), 'Source removed') }}><Icon name="trash" size={14} /></Button></td>
            </tr>)}
          </Table>
        </Panel>
        {source && <SourceDetail key={source.name} source={source} act={act} />}
      </>}
  </>
}

function SourceDetail({ source, act }: { source: Source; act: Action }) {
  const [remote, setRemote] = useState(() => ({
    provider: 'git' as const,
    repository: source.remote?.provider === 'github' ? `https://github.com/${source.remote.repository}.git` : source.remote?.repository ?? '',
    branch: source.remote?.branch ?? 'main',
    subdirectory: source.remote?.subdirectory ?? '',
    authMethod: 'automatic',
    gitUsername: '',
    gitSecret: '',
  }))
  const [remoteBranches, setRemoteBranches] = useState<string[]>([])
  const [remoteDirectories, setRemoteDirectories] = useState<string[]>([])
  const [remoteHead, setRemoteHead] = useState('')
  const [remoteTesting, setRemoteTesting] = useState(false)
  const [remoteFoldersLoading, setRemoteFoldersLoading] = useState(false)
  const [location, setLocation] = useState({ kind: source.kind ?? 'directory', path: source.path })
  const [tab, setTab] = useState<'location' | 'remote'>(source.remote ? 'remote' : 'location')
  const connectRemote = async () => {
    setRemoteTesting(true)
    try {
      const result = await act(() => post<{ repository: string; branch: string; head: string; branches: string[] }>('/api/setup/git/test', remote), 'Repository connected', false)
      if (result) {
        setRemote((current) => ({ ...current, repository: result.repository, branch: result.branch }))
        setRemoteBranches(result.branches)
        setRemoteHead(result.head)
        setRemoteFoldersLoading(true)
        const folders = await act(() => post<{ directories: string[] }>('/api/setup/git/folders', { ...remote, repository: result.repository, branch: result.branch, subdirectory: '' }), undefined, false)
        setRemoteDirectories(folders?.directories ?? [])
      }
    } finally {
      setRemoteFoldersLoading(false)
      setRemoteTesting(false)
    }
  }
  const selectRemoteBranch = async (branch: string) => {
    setRemote((current) => ({ ...current, branch, subdirectory: '' }))
    setRemoteFoldersLoading(true)
    try {
      const folders = await act(() => post<{ directories: string[] }>('/api/setup/git/folders', { ...remote, branch, subdirectory: '' }), undefined, false)
      setRemoteDirectories(folders?.directories ?? [])
    } finally {
      setRemoteFoldersLoading(false)
    }
  }
  return <Panel title={source.name} description={source.remote ? `${gitServiceLabel(source.remote.repository, source.remote.provider)} repository · ${source.remote.repository}@${source.remote.branch}` : `${source.kind === 'openapi' ? 'OpenAPI specification' : 'Source directory'} · ${source.path}`}>
    {(source.kind ?? 'directory') === 'directory' && <Tabs value={tab} onChange={setTab} items={[['location', 'Location'], ['remote', 'Remote monitoring']] as const} />}
    {tab === 'location' || (source.kind ?? 'directory') !== 'directory'
      ? <>
        <div class="form-grid">
          <Field label="Source type"><Select disabled={Boolean(source.remote)} value={location.kind} onChange={(event) => setLocation({ ...location, kind: event.currentTarget.value as 'directory' | 'openapi' })}><option value="directory">Source directory</option><option value="openapi">OpenAPI specification</option></Select></Field>
          <Field label={source.remote ? 'Managed snapshot' : 'Path or URL'}><Input disabled={Boolean(source.remote)} value={location.path} onInput={(event) => setLocation({ ...location, path: event.currentTarget.value })} /></Field>
        </div>
        {source.remote && <Note>The snapshot is managed by Doxloop and refreshed from the configured branch.</Note>}
        <div class="form-actions"><Button tone="primary" disabled={Boolean(source.remote) || !location.path.trim()} onClick={() => void act(() => patch(`/api/sources/${encodeURIComponent(source.name)}`, location), 'Source location saved')}>Save source</Button></div>
      </>
      : <>
        <div class="form-grid">
          <Field label="Repository address"><div class="path-input"><Input value={remote.repository} placeholder="https://git.example.com/team/product.git" onInput={(event) => { setRemote({ ...remote, repository: event.currentTarget.value }); setRemoteHead(''); setRemoteBranches([]); setRemoteDirectories([]) }} /><Button icon="key" busy={remoteTesting} disabled={!remote.repository.trim() || (remote.authMethod === 'credentials' && !remote.gitSecret)} onClick={() => void connectRemote()}>Connect</Button></div></Field>
          <Field label="Repository access"><Select value={remote.authMethod} onChange={(event) => { setRemote({ ...remote, authMethod: event.currentTarget.value }); setRemoteHead('') }}><option value="automatic">Public or already connected</option><option value="credentials">Private repository</option></Select></Field>
          {remote.authMethod === 'credentials' && <><Field label="Account username"><Input value={remote.gitUsername} autocomplete="username" onInput={(event) => setRemote({ ...remote, gitUsername: event.currentTarget.value })} /></Field><Field label="Password or access key"><Input type="password" value={remote.gitSecret} autocomplete="off" onInput={(event) => { setRemote({ ...remote, gitSecret: event.currentTarget.value }); setRemoteHead('') }} /></Field></>}
          <Field label="Branch" hint={remoteBranches.length ? `${remoteBranches.length} available` : 'Connect to load available branches.'}><Select value={remote.branch} disabled={!remoteBranches.length || remoteFoldersLoading} onChange={(event) => void selectRemoteBranch(event.currentTarget.value)}>{remoteBranches.length ? remoteBranches.map((branch) => <option key={branch} value={branch}>{branch}</option>) : <option value={remote.branch}>{remote.branch}</option>}</Select></Field>
          <RepositoryFolderSelect value={remote.subdirectory} directories={remoteDirectories} loading={remoteFoldersLoading} connected={Boolean(remoteHead)} onChange={(subdirectory) => setRemote({ ...remote, subdirectory })} />
        </div>
        <Note>Access details are used for this Doxloop session and are never written to the project.</Note>
        <div class="form-actions">
          <Button tone="danger" onClick={() => void act(() => patch(`/api/sources/${encodeURIComponent(source.name)}`, { remote: null }), 'Remote monitoring removed')}>Disconnect</Button>
          <Button tone="primary" disabled={!remote.repository || !remote.branch || !remoteHead || remoteFoldersLoading} onClick={() => void act(() => patch(`/api/sources/${encodeURIComponent(source.name)}`, { remote }), 'Remote source saved')}>Save connection</Button>
        </div>
      </>}
  </Panel>
}

function Authoring({ state, act, streamConnected }: { state: UiState; act: Action; streamConnected: boolean }) {
  const hasCompletedRun = Boolean(state.receipt)
  const mode = hasCompletedRun ? 'update' : 'create'
  const pendingSources = state.receipt?.pendingSources ?? []
  const defaultAgent = state.project?.defaultAgent ?? ''
  const defaultModel = defaultModelForAgent(defaultAgent)
  const defaultReasoning = preferredReasoningLevel(defaultAgent, defaultModel)
  const [form, setForm] = useState({ request: '', agent: defaultAgent, model: defaultModel, reasoning: defaultAgent === 'codex' ? defaultReasoning : '', effort: defaultAgent === 'claude' ? defaultReasoning : '', screenshots: false })
  const availableAuthorModels = agentModels(form.agent)
  const supportedAuthorReasoning = modelReasoningLevels(form.agent, form.model)
  const [confirmRegeneration, setConfirmRegeneration] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const runs = state.jobs.filter((job) => job.type.startsWith('author:') || job.type === 'capture')
  const activeRun = runs.find((job) => job.status === 'running')
  const runBusy = Boolean(activeRun || submitting)
  const startRun = async (runMode: 'create' | 'update' | 'review') => {
    if (runBusy) return
    const label = runMode === 'review' ? 'Review started' : 'Documentation run started'
    const { reasoning, effort, ...runForm } = form
    const request = {
      ...runForm,
      mode: runMode,
      ...(form.agent === 'codex' && reasoning ? { reasoning } : {}),
      ...(form.agent === 'claude' && effort ? { effort } : {}),
    }
    setSubmitting(true)
    try {
      await act(() => post('/api/author', request), label)
    } finally {
      setSubmitting(false)
    }
  }
  useEffect(() => {
    if (!confirmRegeneration) return
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setConfirmRegeneration(false)
    }
    addEventListener('keydown', close)
    return () => removeEventListener('keydown', close)
  }, [confirmRegeneration])
  return <div class="authoring-page">
    {confirmRegeneration && <div class="scrim" onClick={() => setConfirmRegeneration(false)}>
      <section class="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="regenerate-title" onClick={(event) => event.stopPropagation()}>
        <span class="confirm-icon"><Icon name="alert" size={20} /></span>
        <div class="confirm-copy">
          <h2 id="regenerate-title">Regenerate the complete documentation?</h2>
          <p>This starts broad product discovery again and may rewrite navigation, theme, page structure, and existing content.</p>
          <Note tone="bad">Use Update unless you intentionally want a complete documentation redesign.</Note>
        </div>
        <div class="confirm-actions">
          <Button onClick={() => setConfirmRegeneration(false)}>Cancel</Button>
          <Button tone="danger" onClick={() => { setConfirmRegeneration(false); void startRun('create') }}>Regenerate all docs</Button>
        </div>
      </section>
    </div>}
    <PageHeader
      icon="authoring"
      title={hasCompletedRun ? 'Maintain documentation' : 'Create documentation'}
      description="Describe the outcome you want. Doxloop uses your connected sources and keeps them read-only."
    />
    {hasCompletedRun && pendingSources.length > 0 && <div class="source-sync-banner">
      <span class="source-sync-icon"><Icon name="sources" size={18} /></span>
      <div>
        <strong>{pendingSources.length === 1 ? `New source “${pendingSources[0]}” was added` : `${pendingSources.length} new sources were added`}</strong>
        <p>Run Update to synchronize {pendingSources.length === 1 ? 'this source' : 'these sources'} with the existing documentation. Unrelated pages, navigation, and styling will be preserved.</p>
      </div>
    </div>}
    {activeRun && <LiveJobLog job={activeRun} connected={streamConnected} />}
    <Panel class="authoring-request" icon="wand" title={hasCompletedRun ? 'Update documentation' : 'Create documentation'} description={hasCompletedRun ? 'Maintain the existing documentation after product or source changes.' : 'Generate the first documentation set from your connected sources.'}>
      <fieldset class="authoring-fields" disabled={runBusy}>
        <legend>Run options</legend>
        <div class="authoring-options">
          <Field label="Agent"><Select icon="bot" value={form.agent} onChange={(event) => {
            const agent = event.currentTarget.value
            const model = defaultModelForAgent(agent)
            const level = preferredReasoningLevel(agent, model)
            setForm({
              ...form,
              agent,
              model,
              reasoning: agent === 'codex' ? level : '',
              effort: agent === 'claude' ? level : '',
            })
          }}><option value="">Select coding assistant</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select></Field>
          <Field label="Select Model"><Combo value={form.model} options={availableAuthorModels.map((model) => [model.id, model.label] as const)} disabled={!form.agent} placeholder="Search or enter a model ID" onValueChange={(value) => setForm({ ...form, model: value })} /></Field>
          <Field label={form.agent === 'claude' ? 'Effort' : 'Reasoning'}><Combo value={form.agent === 'claude' ? form.effort : form.reasoning} options={supportedAuthorReasoning.map((value) => [value, value] as const)} disabled={!form.agent} placeholder="Search or enter a value" onValueChange={(value) => setForm({ ...form, [form.agent === 'claude' ? 'effort' : 'reasoning']: value })} /></Field>
          <div class="screenshot-option"><span>Capture application screenshots</span><Toggle checked={form.screenshots} disabled={runBusy} onChange={(checked) => setForm({ ...form, screenshots: checked })} label="Capture screenshots during the run" /></div>
        </div>
        <Field label="What should the agent do?" wide hint={hasCompletedRun ? 'Be specific about the user outcome, or leave empty to synchronize detected source changes.' : 'Be specific about the user outcome. Leave empty to receive a complete recommendation.'}>
          <Textarea rows={4} value={form.request} placeholder="For example: Document webhook retries and the new authentication flow for developers integrating our API…" onInput={(event) => setForm({ ...form, request: event.currentTarget.value })} />
        </Field>
      </fieldset>
      <div class="panel-inline-foot">
        <span><Icon name="lock" size={14} />Product sources stay read-only</span>
        <div class="row-actions">
          <Button disabled={runBusy} onClick={() => void startRun('review')}>Start review</Button>
          <Button disabled={runBusy} busy={submitting} tone="primary" icon="sparkle" onClick={() => void startRun(mode)}>{hasCompletedRun ? 'Update documentation' : 'Create documentation'}</Button>
        </div>
      </div>
    </Panel>
    {runs.length > 0 && <Panel class="authoring-history" icon="list" title="Run activity" flush><JobTable jobs={runs} onCancel={(id) => void act(() => post(`/api/jobs/${id}/cancel`), 'Job cancelled')} /></Panel>}
    {hasCompletedRun && <Panel title="Full regeneration" description="Start over only when you want to reconsider the complete documentation structure.">
      <div class="regeneration-row">
        <div><strong>Regenerate all documentation</strong><p>This may restructure or replace existing pages, navigation, styling, and documentation decisions.</p></div>
        <Button tone="danger" disabled={runBusy} onClick={() => setConfirmRegeneration(true)}>Regenerate all docs…</Button>
      </div>
    </Panel>}
  </div>
}

function LiveJobLog({ job, connected }: { job: UiJob; connected: boolean }) {
  const log = useRef<HTMLPreElement>(null)
  const agent = job.agent ? agentLabel(job.agent) : 'Agent'
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [job.lines.length])
  return <Panel
    class="live-authoring"
    icon="record"
    title="Live run activity"
    description={`Output appears here until ${agent} exits and Doxloop finishes validation.`}
    actions={<><Badge tone="info">Running</Badge><Badge tone={connected ? 'good' : 'warn'} icon="broadcast">{connected ? 'Live' : 'Reconnecting…'}</Badge></>}
  >
    <p class="live-job-help"><Icon name="info" size={15} />A completed tool action is one step. The documentation run finishes only after validation succeeds.</p>
    <div class="live-job-meta" aria-live="polite">
      <span><Icon name="user" size={14} />{job.type.replaceAll(':', ' · ')}</span>
      <b class="meta-divider" />
      <span><Icon name="clock" size={14} />Last output {timeText(job.lastOutputAt ?? job.startedAt)}</span>
      <span><Icon name="file" size={14} />{job.lines.length} recent line{job.lines.length === 1 ? '' : 's'}</span>
      <a href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer">Open full log<Icon name="external" size={13} /></a>
    </div>
    <pre ref={log} class="terminal live-terminal">{job.lines.length > 0 ? job.lines.join('\n') : `Starting ${agent}…`}</pre>
  </Panel>
}

function AgentList({ agents, act }: { agents: AgentState[]; act: Action }) {
  return <div class="check-rows">{['codex', 'claude', 'gemini'].map((name) => {
    const agent = agents.find((item) => item.name === name)
    return <div class="agent-row" key={name}>
      <div><strong>{agentLabel(name)}</strong><small>{agent ? agent.authentication.detail : 'Not installed'}</small></div>
      <div class="row-actions">
        {agent?.preferred && <Badge tone="good">Default</Badge>}
        {agent
          ? <Button size="sm" onClick={() => void act(() => post('/api/agent/skills', { agent: name }), 'Project skills installed')}>Repair skills</Button>
          : <Button size="sm" onClick={() => void act(() => post('/api/agent/install', { agent: name }), `${agentLabel(name)} installed`)}>Install</Button>}
      </div>
    </div>
  })}</div>
}

function SyncPage({ state, act }: { state: UiState; act: Action }) {
  const project = state.project!
  const [sync, setSync] = useState<SyncConfig>(() => {
    const current = structuredClone(project.sync)
    return current.on.length ? current : { ...current, on: [scheduleTrigger(scheduleForm([]))] }
  })
  const [schedule, setSchedule] = useState<ScheduleForm>(() => scheduleForm(project.sync.on))
  const [advanced, setAdvanced] = useState(false)
  const drift = state.drift
  const stale = drift && 'pages' in drift ? drift.pages.length : 0
  const set = <K extends keyof SyncConfig>(key: K, value: SyncConfig[K]) => setSync((current) => ({ ...current, [key]: value }))
  const updateSchedule = (next: Partial<ScheduleForm>) => {
    setSchedule((current) => {
      const updated = { ...current, ...next }
      setSync((value) => ({ ...value, on: [scheduleTrigger(updated)] }))
      return updated
    })
  }
  const modeLabel = { check: 'Notify only', propose: 'Prepare proposal', auto: 'Automatic proposals' }[project.sync.mode]
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  return <div class="sync-page">
    <PageHeader
      icon="sparkles"
      title="Monitoring"
      description="Detect when source changes make documentation stale, then prepare safe proposals."
      actions={<><Button tone="danger" onClick={() => confirm('Disable the installed monitoring schedule?') && void act(() => post('/api/sync/off'), 'Monitoring disabled')}>Disable</Button><Button tone="primary" icon="refresh" onClick={() => void act(() => post('/api/sync/now'), 'Source check started')}>Check now</Button></>}
    />
    <div class="stat-row three">
      <Stat icon="calendar" label="Schedule" value={project.sync.on.length ? 'Active' : 'Not configured'} detail={project.sync.on.length ? scheduleSummary(scheduleForm(project.sync.on)) : 'Choose a schedule below'} />
      <Stat icon="file" label="Stale pages" value={stale} detail="Since the last check" {...(stale ? { tone: 'warn' as const } : {})} />
      <Stat icon="bell" label="Response" value={modeLabel} detail="When documentation is stale" />
    </div>
    <div class="split wide-left">
      <div class="stack">
        <Panel icon="shield" title="Monitoring policy" description="The schedule runs locally through the operating system.">
          <div class="form-grid">
            <Field label="Product branch"><Input value={sync.branch ?? ''} placeholder="main" onInput={(event) => set('branch', event.currentTarget.value)} /></Field>
            <Field label="Schedule"><Select value={schedule.kind} onChange={(event) => updateSchedule({ kind: event.currentTarget.value as ScheduleKind })}><option value="daily">Daily</option><option value="weekdays">Weekdays</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="custom">Custom schedule</option></Select></Field>
          </div>
          <div class="form-grid gap-top schedule-fields">
            {schedule.kind === 'weekly' && <Field label="Day of week"><Select value={schedule.weekday} onChange={(event) => updateSchedule({ weekday: event.currentTarget.value })}>{WEEKDAY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>}
            {schedule.kind === 'monthly' && <Field label="Day of month" hint="The 1st through 28th runs reliably every month."><Input type="number" min="1" max="28" value={schedule.day} onInput={(event) => updateSchedule({ day: clampNumber(event.currentTarget.value, 1, 28) })} /></Field>}
            {schedule.kind !== 'custom' && <Field label="Time" hint={`Uses your device timezone (${timezone}).`}><Input type="time" value={schedule.time} onInput={(event) => updateSchedule({ time: event.currentTarget.value || '09:00' })} /></Field>}
            {schedule.kind === 'custom' && <><Field label="Repeat every"><Input type="number" min="1" max={schedule.unit === 'm' ? '59' : '24'} value={schedule.interval} onInput={(event) => updateSchedule({ interval: clampNumber(event.currentTarget.value, 1, schedule.unit === 'm' ? 59 : 24) })} /></Field><Field label="Interval"><Select value={schedule.unit} onChange={(event) => { const unit = event.currentTarget.value as ScheduleUnit; updateSchedule({ unit, interval: Math.min(schedule.interval, unit === 'm' ? 59 : 24) }) }}><option value="m">Minutes</option><option value="h">Hours</option></Select></Field></>}
          </div>
          <p class="schedule-summary"><Icon name="calendar" size={15} />{scheduleSummary(schedule)}</p>
          <h3 class="form-heading">When documentation is stale</h3>
          <Options value={sync.mode} columns={3} onChange={(value) => set('mode', value)} items={[['check', 'Notify only', 'Report stale pages; never start an agent', 'bell'], ['propose', 'Prepare proposal', 'Generate an isolated review proposal', 'file'], ['auto', 'Automatic proposals', 'Generate proposals from configured triggers', 'zap']] as const} />
          <button type="button" class="disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={14} />Advanced watch scope and budgets</button>
          {advanced && <div class="form-grid gap-top">
            <Field label="Watched paths"><Lines value={sync.watch} onInput={(value) => set('watch', value)} placeholder={'src/**\nopenapi.yaml'} /></Field>
            <Field label="Ignored paths"><Lines value={sync.ignore} onInput={(value) => set('ignore', value)} placeholder={'**/*.test.ts\npnpm-lock.yaml'} /></Field>
            <Field label="Maximum runs per day"><Input type="number" min="1" value={sync.budget?.maxRunsPerDay ?? ''} onInput={(event) => setSync({ ...sync, budget: numberBudget(sync.budget, 'maxRunsPerDay', event.currentTarget.value) })} /></Field>
            <Field label="Maximum agent minutes"><Input type="number" min="1" value={sync.budget?.maxMinutes ?? ''} onInput={(event) => setSync({ ...sync, budget: numberBudget(sync.budget, 'maxMinutes', event.currentTarget.value) })} /></Field>
          </div>}
          <Note>Monitoring never writes to product source or publishes documentation. Proposals change real documentation only after acceptance.</Note>
          <div class="form-actions"><Button tone="primary" onClick={() => void act(() => post('/api/sync/configure', sync), 'Monitoring configuration installed')}>Save and install</Button></div>
        </Panel>
      </div>
      <Panel icon="broadcast" title="Live status" description="Remote, scheduler, agent and source checks">
        <SyncStatus text={typeof state.syncStatus === 'string' ? state.syncStatus : state.syncStatus?.error ?? 'Status unavailable'} />
      </Panel>
    </div>
    <Panel icon="list" title="Monitoring activity" flush><JobTable jobs={state.jobs.filter((job) => job.type === 'sync')} onCancel={(id) => void act(() => post(`/api/jobs/${id}/cancel`), 'Job cancelled')} /></Panel>
  </div>
}

const STATUS_ICONS: Record<string, string> = {
  'Remote source': 'cloud',
  Schedule: 'calendar',
  Agent: 'bot',
  'Evidence map': 'map',
  'Last run': 'clock',
  Reviews: 'users',
  'Drift now': 'activity',
}
const STATUS_TONES: Record<string, string> = { '✓': 'good', '✗': 'bad', '!': 'warn' }

/**
 * `formatSyncStatus` is written for a terminal, so the padded columns and the
 * ✓/✗ marks carry meaning that a raw <pre> throws away. This reads the same
 * lines back into labelled rows so the panel can align values and tone the
 * marks, while any line it does not recognise still renders verbatim.
 */
function SyncStatus({ text }: { text: string }) {
  const rows = text.split('\n').map((line) => {
    const check = /^ {2}([✓✗!-]) (\S.*?) {2,}(.*)$/.exec(line)
    if (check) return { label: check[2]!, value: check[3]!, tone: STATUS_TONES[check[1]!] ?? 'muted' }
    const meta = /^ {2}(\S.*?) {2,}(.*)$/.exec(line)
    if (meta) return { label: meta[1]!, value: meta[2]! }
    return { text: line }
  })
  const heading = rows.findIndex((row) => 'text' in row && row.text.startsWith('Automatic sync:'))
  return <div class="sync-status">
    {rows.map((row, index) => {
      if ('text' in row) {
        if (!row.text.trim()) return <hr key={index} class="sync-status-rule" />
        if (index === heading) {
          const on = row.text.endsWith('ON')
          return <p key={index} class="sync-status-head"><i class={on ? 'on' : 'off'} />{row.text}</p>
        }
        return <p key={index} class="sync-status-foot">{commandText(row.text)}</p>
      }
      return <div key={index} class={`sync-status-row ${row.tone ?? ''}`}>
        <Icon name={STATUS_ICONS[row.label] ?? 'info'} size={15} />
        <span class="sync-status-label">{row.label}</span>
        <span class="sync-status-value">{row.value}</span>
      </div>
    })}
  </div>
}

/** Renders the `doxloop …` fragment of a hint line as a highlighted command. */
function commandText(line: string) {
  const match = /^(.*?)(doxloop [\w\s-]+)(.*)$/.exec(line)
  if (!match) return line
  return <>{match[1]}<code>{match[2]}</code>{match[3]}</>
}

function Proposals({ state, act }: { state: UiState; act: Action }) {
  const runs = validRuns(state.runs)
  const [selectedId, setSelectedId] = useState(runs[0]?.id ?? '')
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0]
  const [changeId, setChangeId] = useState(selected?.changes[0]?.id ?? '')
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [layout, setLayout] = useState<'split' | 'unified'>('split')
  const [onlyChanges, setOnlyChanges] = useState(true)
  const change = selected?.changes.find((item) => item.id === changeId) ?? selected?.changes[0]
  useEffect(() => setChangeId(selected?.changes[0]?.id ?? ''), [selected?.id])
  const open = selected ? OPEN_STATUSES.includes(selected.status) : false
  const counts = selected ? proposalChangeCounts(selected.changes) : { added: 0, modified: 0, deleted: 0 }
  return <>
    <PageHeader title="Proposals" description="Compare isolated documentation changes and decide exactly what reaches the real project." />
    {runs.length === 0
      ? <Panel flush><Empty icon="proposals" title="No proposals yet" detail="Run source monitoring, or start an update when documentation becomes stale." /></Panel>
      : <div class="review">
        <aside class="review-rail">
          <div class="rail-head"><span>{runs.length} proposal{runs.length === 1 ? '' : 's'}</span><span class="rail-sort">Newest first <Icon name="filter" size={14} /></span></div>
          {runs.map((run) => <button key={run.id} class={selected?.id === run.id ? 'active' : ''} onClick={() => setSelectedId(run.id)}>
            <strong>{proposalSummaryText(run.changes)}</strong>
            <div class="rail-row"><small>{timeText(run.createdAt)} · {run.changes.length} file{run.changes.length === 1 ? '' : 's'}</small><Badge tone={statusTone(run.status)}>{statusLabel(run.status)}</Badge></div>
          </button>)}
        </aside>
        {selected && <section class="review-main">
          <div class="proposal-card">
            <header class="proposal-summary">
              <span class="proposal-summary-icon"><Icon name="proposals" size={25} /></span>
              <div class="proposal-summary-copy">
                <div class="proposal-summary-line">
                  <h2>{selected.changes.length} file change{selected.changes.length === 1 ? '' : 's'}</h2>
                  <div class="change-counts" aria-label={`${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted`}>
                    <span class="added"><i />{counts.added} added</span><b />
                    <span class="modified"><i />{counts.modified} modified</span><b />
                    <span class="deleted"><i />{counts.deleted} deleted</span>
                  </div>
                </div>
                <strong class="source-count">{selected.sourceSummary}<Icon name="info" size={14} /></strong>
                <p class="source-detail">{selected.stalePages.length > 0 ? selected.stalePages.join(', ') : selected.summary}</p>
              </div>
              <div class="proposal-summary-side">
                <div class="proposal-actions">
                  <Button tone="danger" disabled={!open} onClick={() => confirm('Reject this complete proposal?') && void act(() => post(`/api/proposals/${selected.id}/reject`), 'Proposal rejected')}>Reject</Button>
                  <Button tone="primary" icon="check" disabled={!open} onClick={() => confirm('Apply every change in this proposal?') && void act(() => post(`/api/proposals/${selected.id}/accept`, { scope: 'all' }), 'Proposal accepted')}>Accept all</Button>
                </div>
                <div class="proposal-meta"><span><Icon name="clock" size={15} />{timeText(selected.createdAt)}</span><b /><span><Icon name="file" size={15} />{selected.changes.length} file{selected.changes.length === 1 ? '' : 's'}</span></div>
              </div>
            </header>

            <div class="file-picker-bar">
              <label class="file-picker">
                <span class="file-picker-icon"><Icon name="file" size={16} /></span>
                <span class="file-picker-copy"><small>Reviewing file</small><strong>{change?.path ?? 'Choose a file'}</strong></span>
                <Select class="file-picker-select" aria-label="Choose a proposal file" value={change?.id ?? ''} onChange={(event) => setChangeId(event.currentTarget.value)}>
                  {selected.changes.map((item) => <option key={item.id} value={item.id}>{item.path} · {item.kind}</option>)}
                </Select>
                <Badge tone={statusTone(change?.kind ?? '')}>{change?.kind ?? ''}</Badge>
                <span class="file-position">{Math.max(0, selected.changes.findIndex((item) => item.id === change?.id)) + 1} of {selected.changes.length}</span>
                <Icon name="chevronDown" size={16} />
              </label>
            </div>
            {change ? <>
              <div class="review-toolbar">
                <div class="chips"><Badge>{change.category}</Badge><Badge>{change.kind}</Badge></div>
                <div class="row-actions">
                  <span class="toolbar-label">View</span>
                  <Segmented value={view} onChange={setView} items={[['rendered', 'Rendered'], ['source', 'Source']] as const} />
                  {view === 'rendered' && <>
                    <Segmented value={layout} onChange={setLayout} items={[['split', 'Side by side'], ['unified', 'Stacked']] as const} />
                    <Button size="sm" onClick={() => setOnlyChanges(!onlyChanges)}>{onlyChanges ? 'Show context' : 'Only changes'}</Button>
                  </>}
                  <Button size="sm" tone="primary" disabled={!open} onClick={() => void act(() => post(`/api/proposals/${selected.id}/accept`, { scope: 'page', changeId: change.id }), 'Page accepted')}>Accept file</Button>
                </div>
              </div>
              {view === 'source'
                ? <ProposalSourceDiff runId={selected.id} change={change} act={act} />
                : <iframe class="review-frame" title={`Review ${change.title}`} src={`/review-preview/${selected.id}/${change.id}?layout=${layout}${onlyChanges ? '&only=1' : ''}`} />}
            </> : <Empty title="This proposal contains no file changes" />}
          </div>
        </section>}
      </div>}
  </>
}

function proposalChangeCounts(changes: ProposalChange[]): { added: number; modified: number; deleted: number } {
  return changes.reduce((counts, change) => {
    if (change.kind === 'added') counts.added += 1
    else if (change.kind === 'deleted') counts.deleted += 1
    else counts.modified += 1
    return counts
  }, { added: 0, modified: 0, deleted: 0 })
}

function proposalSummaryText(changes: ProposalChange[]): string {
  const counts = proposalChangeCounts(changes)
  return `${changes.length} file change${changes.length === 1 ? '' : 's'} · ${counts.added} added · ${counts.modified} modified · ${counts.deleted} deleted`
}

function ProposalSourceDiff({ runId, change, act }: { runId: string; change: ProposalChange; act: Action }) {
  const [diff, setDiff] = useState<SourceDiff | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setDiff(null)
    setError('')
    void api<SourceDiff>(`/api/proposals/${runId}/changes/${change.id}/diff`).then(setDiff).catch((cause) => setError(message(cause)))
  }, [runId, change.id])
  if (error) return <div class="diff-message error">{error}</div>
  if (!diff) return <div class="diff-message">Loading source diff…</div>
  if (diff.binary) return <Empty title="Binary asset" detail="This file has no line-by-line source diff. Accept the page to apply it." />
  const groups = diffGroups(diff.rows)
  return <div class="source-diff">
    <div class="diff-summary"><span class="added">+{diff.added}</span><span class="removed">−{diff.removed}</span><small>Accept one change at a time, or accept the complete page.</small></div>
    {groups.map((group, index) => <section class={`hunk ${group.state ?? ''}`} key={group.hunkId ?? index}>
      <header>
        <strong>{group.hunkId ? `Change ${index + 1}` : 'Context'}</strong>
        {group.hunkId && group.state === 'pending' && <Button size="sm" tone="primary" onClick={() => void act(() => post(`/api/proposals/${runId}/accept`, { scope: 'hunk', changeId: change.id, hunkId: group.hunkId }), 'Change accepted')}>Accept change</Button>}
        {group.hunkId && group.state !== 'pending' && <Badge tone={statusTone(group.state ?? '')}>{group.state ?? 'resolved'}</Badge>}
      </header>
      <div class="diff-lines">{group.rows.map((row, rowIndex) => <DiffLine key={rowIndex} row={row} />)}</div>
    </section>)}
  </div>
}

function DiffLine({ row }: { row: DiffRow }) {
  if (row.type === 'gap') return <div class="diff-line gap"><span /><span /><b /><code>{row.hidden} unchanged lines</code></div>
  const sign = row.type === 'insert' ? '+' : row.type === 'delete' ? '−' : ' '
  return <div class={`diff-line ${row.type}`}><span>{row.oldNumber ?? ''}</span><span>{row.newNumber ?? ''}</span><b>{sign}</b><code dangerouslySetInnerHTML={{ __html: row.html || ' ' }} /></div>
}

function diffGroups(rows: DiffRow[]): Array<{ hunkId?: string; state?: string; rows: DiffRow[] }> {
  const groups: Array<{ hunkId?: string; state?: string; rows: DiffRow[] }> = []
  for (const row of rows) {
    const last = groups.at(-1)
    if (last && last.hunkId === row.hunkId) last.rows.push(row)
    else groups.push({ ...(row.hunkId ? { hunkId: row.hunkId } : {}), ...(row.hunkState ? { state: row.hunkState } : {}), rows: [row] })
  }
  return groups
}

function Quality({ state, act }: { state: UiState; act: Action }) {
  const validation = validValidation(state.validation)
  const doctor = state.doctor && !('error' in state.doctor) ? state.doctor : undefined
  const [filter, setFilter] = useState<'all' | 'error' | 'warning'>('all')
  const issues = (validation?.issues ?? []).filter((issue) => filter === 'all' || issue.severity === filter)
  return <>
    <PageHeader
      title="Quality"
      description="Validate pages, navigation, links, source boundaries, generators and local readiness."
      actions={<Button tone="primary" icon="check" onClick={() => void act(() => post('/api/validate'), 'Validation complete')}>Run validation</Button>}
    />
    <div class="stat-row">
      <Stat label="Pages checked" value={validation?.pages.length ?? '—'} detail="In the content directory" active={filter === 'all'} onClick={() => setFilter('all')} />
      <Stat label="Errors" value={validation?.errors ?? '—'} detail="Must be fixed" {...(validation?.errors ? { tone: 'bad' as const } : {})} active={filter === 'error'} onClick={() => setFilter('error')} />
      <Stat label="Warnings" value={validation?.warnings ?? '—'} detail="Worth reviewing" {...(validation?.warnings ? { tone: 'warn' as const } : {})} active={filter === 'warning'} onClick={() => setFilter('warning')} />
      <Stat label="Environment" value={doctor?.ready ? 'Ready' : 'Attention'} detail={`${doctor?.checks.length ?? 0} diagnostics`} {...(doctor?.ready ? {} : { tone: 'warn' as const })} />
    </div>
    <div class="split wide-left">
      <Panel title="Validation issues" description={filter === 'all' ? 'Every reported issue' : `Filtered to ${filter}s`} flush>
        {issues.length === 0
          ? <Empty icon="quality" title="No issues to show" detail="Pages, navigation, links and sources passed validation." />
          : <Table head={<><th>Severity</th><th>Issue</th><th>Location</th></>}>
            {issues.map((issue, index) => <tr key={index}>
              <td><Badge tone={issue.severity === 'error' ? 'bad' : 'warn'}>{issue.severity}</Badge></td>
              <td>{issue.message}</td>
              <td><code class="mono">{issue.file ?? issue.code}</code></td>
            </tr>)}
          </Table>}
      </Panel>
      <Panel title="Environment" description="Local diagnostics" flush>
        <div class="check-rows">
          {doctor?.checks.map((check, index) => <Check key={index} ok={check.status === 'pass'} warning={check.status === 'warning'} label={check.label} {...(check.detail ? { detail: check.detail } : {})} />)
            ?? <Empty title="Diagnostics unavailable" />}
        </div>
      </Panel>
    </div>
  </>
}

function Preview({ state, act }: { state: UiState; act: Action }) {
  const running = state.preview?.running ?? false
  return <>
    <PageHeader
      title="Preview"
      description="Run the selected generator locally with live reload."
      meta={<><Badge tone={running ? 'good' : 'neutral'} icon={running ? 'check' : 'clock'}>{running ? 'Running' : 'Stopped'}</Badge><code class="mono">127.0.0.1:4321</code></>}
      actions={<>
        <a class="btn secondary md" href="http://127.0.0.1:4321" target="_blank" rel="noreferrer"><Icon name="external" size={16} />Open in new tab</a>
        {running
          ? <Button tone="danger" icon="stop" onClick={() => void act(() => post('/api/preview/stop'), 'Preview stopped')}>Stop preview</Button>
          : <Button tone="primary" icon="play" onClick={() => void act(() => post('/api/preview/start'), 'Preview started')}>Start preview</Button>}
      </>}
    />
    <Panel flush class="frame-panel">
      {running
        ? <iframe class="site-frame" title="Documentation preview" src="http://127.0.0.1:4321" />
        : <Empty icon="preview" title="Preview is not running" detail="Start it to inspect the generated documentation at 127.0.0.1:4321." action={<Button tone="primary" icon="play" onClick={() => void act(() => post('/api/preview/start'), 'Preview started')}>Start preview</Button>} />}
    </Panel>
    <Panel title="Preview process" flush><JobTable jobs={state.jobs.filter((job) => job.type === 'preview')} onCancel={(id) => void act(() => post(`/api/jobs/${id}/cancel`), 'Preview stopped')} /></Panel>
  </>
}

function Publish({ state, act }: { state: UiState; act: Action }) {
  const effective = state.effectiveDeployment!
  const [deployment, setDeployment] = useState(effective)
  const account = state.account
  const save = () => act(() => patch('/api/project', { deployment }), 'Deployment settings saved')
  const deploy = async (dryRun: boolean) => {
    if (!dryRun && !confirm(`Deploy ${deployment.visibility === 'public' ? 'PUBLICLY' : 'privately'} to ${deployment.apiUrl}?`)) return
    await act(() => post('/api/deploy', { ...deployment, public: deployment.visibility === 'public', dryRun }), dryRun ? 'Deployment validation started' : 'Deployment started')
  }
  return <>
    <PageHeader
      title="Publish"
      description="Validate and deploy documentation without including configured product sources."
      meta={<><Badge tone={account?.signedIn ? 'good' : 'warn'} icon={account?.signedIn ? 'check' : 'alert'}>{account?.signedIn ? 'Signed in' : 'Not signed in'}</Badge><span>{deployment.visibility === 'public' ? 'Public site' : 'Private site'}</span></>}
      actions={<><Button onClick={() => void deploy(true)}>Dry run</Button><Button tone="primary" icon="publish" disabled={!account?.signedIn} onClick={() => void deploy(false)}>Deploy</Button></>}
    />
    <div class="split wide-left">
      <Panel title="Deployment" description="Where this documentation is published.">
        <div class="form-grid">
          <Field label="Hosted project name"><Input value={deployment.name} onInput={(event) => setDeployment({ ...deployment, name: event.currentTarget.value })} /></Field>
          <Field label="Project address"><Input value={deployment.slug} onInput={(event) => setDeployment({ ...deployment, slug: event.currentTarget.value })} /></Field>
          <Field label="Visibility"><Select value={deployment.visibility} onChange={(event) => setDeployment({ ...deployment, visibility: event.currentTarget.value })}><option value="private">Private</option><option value="public">Public</option></Select></Field>
          <Field label="Doxbrix API destination"><Input value={deployment.apiUrl} onInput={(event) => setDeployment({ ...deployment, apiUrl: event.currentTarget.value })} /></Field>
        </div>
        <Note>Deployment packages documentation pages and media only. Product source directories are excluded.</Note>
        <div class="form-actions"><Button tone="primary" onClick={() => void save()}>Save settings</Button></div>
      </Panel>
      <Panel title="Doxbrix account">
        {account?.signedIn
          ? <div class="account-card">
            <span class="avatar">{account.user?.email.slice(0, 1).toUpperCase()}</span>
            <strong>{account.user?.name ?? account.user?.email}</strong>
            <small>{account.user?.email}</small>
            <code class="mono">{account.apiUrl}</code>
            <Button icon="logout" onClick={() => void act(() => post('/api/auth/logout'), 'Signed out')}>Sign out</Button>
          </div>
          : <div class="account-card">
            <span class="avatar muted"><Icon name="user" size={18} /></span>
            <strong>Not signed in</strong>
            <small>{account?.detail ?? 'Sign in to deploy this documentation.'}</small>
            <Button tone="primary" icon="key" onClick={() => void act(() => post('/api/auth/login', { apiUrl: deployment.apiUrl }), 'Browser sign-in started')}>Sign in with browser</Button>
          </div>}
      </Panel>
    </div>
    <Panel title="Publishing activity" flush><JobTable jobs={state.jobs.filter((job) => job.type.startsWith('deploy') || job.type === 'login')} onCancel={(id) => void act(() => post(`/api/jobs/${id}/cancel`), 'Job cancelled')} /></Panel>
  </>
}

const SETTINGS_SECTIONS = [
  ['general', 'General', 'Project identity and defaults', 'settings'],
  ['experience', 'Audience and voice', 'Writing style and accessibility', 'book'],
  ['capture', 'Visual evidence', 'Design references and screenshots', 'preview'],
  ['tools', 'Generators', 'Site output support packages', 'publish'],
] as const

function Settings({ state, act }: { state: UiState; act: Action }) {
  const project = state.project!
  const [section, setSection] = useState<typeof SETTINGS_SECTIONS[number][0]>('general')
  const [identity, setIdentity] = useState({ title: project.title, defaultAgent: project.defaultAgent ?? '' })
  const [docs, setDocs] = useState({ ...project.documentation, audiencesText: project.documentation.audiences?.join(', ') ?? '', customInstructions: project.documentation.customInstructions ?? '', outcomesText: project.documentation.priorityOutcomes?.join(', ') ?? '', toneText: project.documentation.tone.join(', '), exclusionsText: project.documentation.exclusions.join('\n'), termsText: termText(project.documentation.terminology) })
  const [references, setReferences] = useState(project.designReferences.map((item) => item.url).join('\n'))
  const [application, setApplication] = useState({
    baseUrl: project.application?.baseUrl ?? '',
    source: project.application?.source ?? '',
    startCommand: project.application?.startCommand ?? '',
    readyPath: project.application?.readyPath ?? '',
    policy: project.application?.screenshots?.policy ?? 'requested',
    highlight: project.application?.screenshots?.highlight ?? true,
    viewportWidth: String(project.application?.screenshots?.viewport?.width ?? 1440),
    viewportHeight: String(project.application?.screenshots?.viewport?.height ?? 900),
  })
  const saveDocs = () => act(() => patch('/api/project', { documentation: { ...docs, audiences: splitComma(docs.audiencesText), priorityOutcomes: splitComma(docs.outcomesText), tone: splitComma(docs.toneText), exclusions: docs.exclusionsText.split('\n').map((item) => item.trim()).filter(Boolean), terminology: parseTerms(docs.termsText) } }), 'Documentation preferences saved')
  return <>
    <PageHeader title="Settings" description="Shape the documentation experience for this workspace." />
    <div class="settings">
      <nav class="settings-nav" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map(([id, label, detail, icon]) => <button key={id} class={section === id ? 'active' : ''} aria-pressed={section === id} onClick={() => setSection(id)}>
          <Icon name={icon} size={16} /><span><strong>{label}</strong><small>{detail}</small></span>
        </button>)}
      </nav>
      <div class="stack">
        {section === 'general' && <Panel title="Project identity" description="The name and default documentation tool used across this workspace.">
          <div class="form-grid">
            <Field label="Site title"><Input value={identity.title} onInput={(event) => setIdentity({ ...identity, title: event.currentTarget.value })} /></Field>
            <Field label="Default documentation agent"><Select value={identity.defaultAgent} onChange={(event) => setIdentity({ ...identity, defaultAgent: event.currentTarget.value })}><option value="">Choose per run</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select></Field>
          </div>
          <KeyValues items={[['Content directory', <code class="mono">{project.contentDir}</code>], ['Generator', generatorLabel(state.generators, project.generator)], ['Workspace', <code class="mono">{state.root ?? state.cwd}</code>]]} />
          <div class="form-actions"><Button tone="primary" onClick={() => void act(() => patch('/api/project', identity), 'Identity settings saved')}>Save changes</Button></div>
        </Panel>}

        {section === 'experience' && <Panel title="Audience and voice" description="These preferences guide every documentation run, so results stay consistent.">
          <div class="form-grid">
            <Field label="Primary audience"><Input value={docs.primaryAudience ?? ''} placeholder="Developers integrating our API" onInput={(event) => setDocs({ ...docs, primaryAudience: event.currentTarget.value })} /></Field>
            <Field label="Audiences" hint="Separate multiple audiences with commas"><Input value={docs.audiencesText} placeholder="Developers, API consumers, administrators" onInput={(event) => setDocs({ ...docs, audiencesText: event.currentTarget.value })} /></Field>
            <Field label="Experience level"><Select value={docs.experienceLevel ?? 'intermediate'} onChange={(event) => setDocs({ ...docs, experienceLevel: event.currentTarget.value })}><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option><option value="mixed">Mixed</option></Select></Field>
            <Field label="Locale"><Input value={docs.locale} onInput={(event) => setDocs({ ...docs, locale: event.currentTarget.value })} /></Field>
            <Field label="Accessibility target"><Input value={docs.accessibilityTarget} onInput={(event) => setDocs({ ...docs, accessibilityTarget: event.currentTarget.value })} /></Field>
            <Field label="Tone"><Input value={docs.toneText} placeholder="clear, direct, helpful" onInput={(event) => setDocs({ ...docs, toneText: event.currentTarget.value })} /></Field>
            <Field label="Priority outcomes"><Input value={docs.outcomesText} placeholder="quick start, successful integration" onInput={(event) => setDocs({ ...docs, outcomesText: event.currentTarget.value })} /></Field>
            <Field label="Standards profile"><Input value={docs.standardsProfile} onInput={(event) => setDocs({ ...docs, standardsProfile: event.currentTarget.value })} /></Field>
            <Field label="Style guide"><Input value={docs.styleGuide} onInput={(event) => setDocs({ ...docs, styleGuide: event.currentTarget.value })} /></Field>
            <Field label="Preferred terminology" hint="One “term = replacement” per line"><Textarea rows={5} value={docs.termsText} onInput={(event) => setDocs({ ...docs, termsText: event.currentTarget.value })} /></Field>
            <Field label="Content exclusions" hint="One item per line"><Textarea rows={5} value={docs.exclusionsText} onInput={(event) => setDocs({ ...docs, exclusionsText: event.currentTarget.value })} /></Field>
            <Field label="Instructions" hint="Additional guidance reused for future documentation runs" wide><Textarea rows={5} value={docs.customInstructions} placeholder="Use concise explanations and include TypeScript examples." onInput={(event) => setDocs({ ...docs, customInstructions: event.currentTarget.value })} /></Field>
          </div>
          <div class="form-actions"><Button tone="primary" onClick={() => void saveDocs()}>Save changes</Button></div>
        </Panel>}

        {section === 'capture' && <>
          <Panel title="Design references" description="Public documentation sites used as visual evidence.">
            <Field label="Reference URLs" hint="One public URL per line" wide><Textarea rows={5} value={references} placeholder={'https://docs.example.com\nhttps://developer.example.com'} onInput={(event) => setReferences(event.currentTarget.value)} /></Field>
            <div class="form-actions">
              <Button onClick={() => void act(() => post('/api/capture', { urls: references.split('\n').map((item) => item.trim()).filter(Boolean) }), 'Design capture started')}>Capture references</Button>
              <Button tone="primary" onClick={() => void act(() => patch('/api/project', { designReferences: references.split('\n').map((item) => item.trim()).filter(Boolean) }), 'Design references saved')}>Save references</Button>
            </div>
          </Panel>
          <Panel title="Application screenshots" description="Configure a safe local or test application for guide screenshots.">
            <div class="form-grid">
              <Field label="Application base URL"><Input value={application.baseUrl} placeholder="http://localhost:3000" onInput={(event) => setApplication({ ...application, baseUrl: event.currentTarget.value })} /></Field>
              <Field label="Product source"><Select value={application.source} onChange={(event) => setApplication({ ...application, source: event.currentTarget.value })}><option value="">None</option>{project.sources.map((source) => <option value={source.name}>{source.name}</option>)}</Select></Field>
              <Field label="Start command"><Input value={application.startCommand} placeholder="npm run dev" onInput={(event) => setApplication({ ...application, startCommand: event.currentTarget.value })} /></Field>
              <Field label="Ready path"><Input value={application.readyPath} placeholder="/health" onInput={(event) => setApplication({ ...application, readyPath: event.currentTarget.value })} /></Field>
              <Field label="Screenshot policy"><Select value={application.policy} onChange={(event) => setApplication({ ...application, policy: event.currentTarget.value })}><option value="requested">Only when requested</option><option value="auto">Automatically for UI workflows</option><option value="off">Never</option></Select></Field>
              <Field label="Viewport width"><Input type="number" min="320" max="3840" value={application.viewportWidth} onInput={(event) => setApplication({ ...application, viewportWidth: event.currentTarget.value })} /></Field>
              <Field label="Viewport height"><Input type="number" min="320" max="2160" value={application.viewportHeight} onInput={(event) => setApplication({ ...application, viewportHeight: event.currentTarget.value })} /></Field>
            </div>
            <Toggle checked={application.highlight} onChange={(checked) => setApplication({ ...application, highlight: checked })} label="Highlight captured controls" />
            <div class="form-actions">
              <Button tone="danger" onClick={() => void act(() => patch('/api/project', { application: null }), 'Application configuration removed')}>Remove</Button>
              <Button tone="primary" disabled={!application.baseUrl} onClick={() => void act(() => patch('/api/project', { application: { baseUrl: application.baseUrl, source: application.source, startCommand: application.startCommand, readyPath: application.readyPath, screenshots: { policy: application.policy, highlight: application.highlight, viewport: { width: application.viewportWidth, height: application.viewportHeight } } } }), 'Application settings saved')}>Save application</Button>
            </div>
          </Panel>
        </>}

        {section === 'tools' && <Panel title="Documentation generators" description="Install or remove support packages without changing the active generator." flush>
          <Table head={<><th>Generator</th><th>Status</th><th class="right" /></>}>
            {state.generators.map((generator) => <tr key={generator.id}>
              <td><div class="cell-lead"><span class="generator-mark">{generator.displayName.slice(0, 1)}</span><div class="row-copy"><strong>{generator.displayName}</strong><small>{generator.id === 'doxbrix' ? 'Built in' : generator.packageName ?? generator.id}</small></div></div></td>
              <td>{generator.id === project.generator ? <Badge tone="good" icon="check">Active</Badge> : generator.installed ? <Badge tone="info">Installed</Badge> : <Badge>Available</Badge>}</td>
              <td class="right">{generator.id === 'doxbrix' || generator.id === project.generator
                ? <span class="muted-cell">—</span>
                : <Button size="sm" {...(generator.installed ? { tone: 'danger' as const } : {})} onClick={() => void act(() => post('/api/generator', { action: generator.installed ? 'remove' : 'add', generator: generator.id }), generator.installed ? 'Generator removal started' : 'Generator installation started')}>{generator.installed ? 'Remove' : 'Install'}</Button>}</td>
            </tr>)}
          </Table>
        </Panel>}
      </div>
    </div>
  </>
}

function Check({ ok, warning, label, detail, action }: { ok: boolean; warning?: boolean; label: string; detail?: string; action?: ComponentChildren }) {
  return <div class="check">
    <span class={`check-mark ${ok ? 'pass' : warning ? 'warn' : 'fail'}`}><Icon name={ok ? 'check' : warning ? 'alert' : 'close'} size={12} /></span>
    <div class="check-copy"><strong>{label}</strong>{detail && <small>{detail}</small>}</div>
    {action && <div class="check-action">{action}</div>}
  </div>
}

function AgentInstallProgress({ job, onRetry }: { job: UiJob; onRetry: () => void }) {
  const label = job.agent ? agentLabel(job.agent) : 'Agent'
  const complete = job.status === 'succeeded'
  const failed = job.status === 'failed' || job.status === 'cancelled'
  const latestLine = job.lines[job.lines.length - 1]
  return <div class={`agent-install-progress ${complete ? 'complete' : failed ? 'failed' : 'running'}`} aria-live="polite">
    <div class="agent-install-progress-copy"><strong>{complete ? `${label} installed` : failed ? 'Installation failed' : `Installing ${label}…`}</strong><small title={latestLine}>{latestLine ?? 'Starting installation…'}</small></div>
    <span class="agent-install-track"><i /></span>
    {failed && <Button size="sm" onClick={onRetry}>Retry</Button>}
  </div>
}

function AccountLoginProgress({ job, busy, onCancel, onRetry }: { job: UiJob; busy: boolean; onCancel: () => void; onRetry: () => void }) {
  const running = job.status === 'running'
  const complete = job.status === 'succeeded'
  const latestLine = job.lines[job.lines.length - 1]
  return <div class={`account-login-progress ${running ? 'running' : complete ? 'complete' : 'failed'}`} aria-live="polite">
    <div class="account-login-progress-copy">
      <strong>{running ? 'Waiting for sign-in…' : complete ? 'Sign-in complete' : 'Sign-in failed'}</strong>
      <small title={latestLine}>{running ? latestLine ?? 'Complete authentication in the opened browser.' : complete ? 'Refreshing your Doxbrix account…' : 'Try again or run `doxloop login`.'}</small>
    </div>
    <span class="account-login-track"><i /></span>
    {running
      ? <Button size="sm" onClick={onCancel}>Cancel</Button>
      : !complete && <Button size="sm" busy={busy} onClick={onRetry}>Try again</Button>}
  </div>
}

type Action = <T>(run: () => Promise<T>, success?: string, refresh?: boolean) => Promise<T | undefined>

/** Proposal states a reviewer can still act on. */
const OPEN_STATUSES = ['awaiting-review', 'partially-applied']

function statusTone(status: string): string {
  if (['applied', 'accepted', 'succeeded', 'pass', 'added'].includes(status)) return 'good'
  if (['awaiting-review', 'generating', 'pending', 'running', 'modified'].includes(status)) return 'info'
  if (['partially-applied', 'conflicted'].includes(status)) return 'warn'
  if (['rejected', 'failed', 'error', 'deleted'].includes(status)) return 'bad'
  return 'neutral'
}

function statusLabel(status: string): string {
  if (status === 'awaiting-review') return 'pending'
  return status.replaceAll('-', ' ').replaceAll('_', ' ')
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function gitServiceLabel(repository: string, provider?: 'git' | 'github'): string {
  if (provider === 'github') return 'GitHub'
  const value = repository.toLowerCase()
  if (value.includes('github.com')) return 'GitHub'
  if (value.includes('gitlab.com')) return 'GitLab'
  if (value.includes('dev.azure.com') || value.includes('visualstudio.com')) return 'Azure DevOps'
  if (value.includes('bitbucket.org')) return 'Bitbucket'
  return 'Git'
}

function validRuns(value: UiState['runs']): Proposal[] {
  return Array.isArray(value) ? value : []
}

function validValidation(value: UiState['validation']): Validation | undefined {
  return value && !value.error ? value : undefined
}

function pendingRuns(state: UiState): number {
  return validRuns(state.runs).filter((run) => OPEN_STATUSES.includes(run.status)).length
}

type ScheduleKind = 'daily' | 'weekdays' | 'weekly' | 'monthly' | 'custom'
type ScheduleUnit = 'm' | 'h'
type ScheduleForm = {
  kind: ScheduleKind
  time: string
  weekday: string
  day: number
  interval: number
  unit: ScheduleUnit
}

const WEEKDAY_OPTIONS = [
  ['mon', 'Monday'], ['tue', 'Tuesday'], ['wed', 'Wednesday'], ['thu', 'Thursday'],
  ['fri', 'Friday'], ['sat', 'Saturday'], ['sun', 'Sunday'],
] as const

function scheduleForm(on: readonly string[]): ScheduleForm {
  const trigger = on[0] ?? ''
  const base: ScheduleForm = { kind: 'daily', time: '09:00', weekday: 'mon', day: 1, interval: 1, unit: 'h' }
  let match = /^daily@(\d{2}:\d{2})$/.exec(trigger)
  if (match) return { ...base, time: match[1]! }
  match = /^weekdays@(\d{2}:\d{2})$/.exec(trigger)
  if (match) return { ...base, kind: 'weekdays', time: match[1]! }
  match = /^weekly@(sun|mon|tue|wed|thu|fri|sat)@(\d{2}:\d{2})$/.exec(trigger)
  if (match) return { ...base, kind: 'weekly', weekday: match[1]!, time: match[2]! }
  match = /^monthly@(\d{1,2})@(\d{2}:\d{2})$/.exec(trigger)
  if (match) return { ...base, kind: 'monthly', day: Number(match[1]), time: match[2]! }
  match = /^every@(\d+)([mh])$/.exec(trigger)
  if (match) return { ...base, kind: 'custom', interval: Number(match[1]), unit: match[2] as ScheduleUnit }
  return base
}

function scheduleTrigger(schedule: ScheduleForm): string {
  if (schedule.kind === 'weekdays') return `weekdays@${schedule.time}`
  if (schedule.kind === 'weekly') return `weekly@${schedule.weekday}@${schedule.time}`
  if (schedule.kind === 'monthly') return `monthly@${schedule.day}@${schedule.time}`
  if (schedule.kind === 'custom') return `every@${schedule.interval}${schedule.unit}`
  return `daily@${schedule.time}`
}

function scheduleSummary(schedule: ScheduleForm): string {
  const time = readableTime(schedule.time)
  if (schedule.kind === 'weekdays') return `Every weekday at ${time}`
  if (schedule.kind === 'weekly') return `Every ${WEEKDAY_OPTIONS.find(([day]) => day === schedule.weekday)?.[1] ?? 'Monday'} at ${time}`
  if (schedule.kind === 'monthly') return `Day ${schedule.day} of every month at ${time}`
  if (schedule.kind === 'custom') return `Every ${schedule.interval} ${schedule.unit === 'm' ? 'minute' : 'hour'}${schedule.interval === 1 ? '' : 's'}`
  return `Every day at ${time}`
}

function readableTime(value: string): string {
  const [hour = 0, minute = 0] = value.split(':').map(Number)
  const suffix = hour >= 12 ? 'PM' : 'AM'
  return `${hour % 12 || 12}:${String(minute).padStart(2, '0')} ${suffix}`
}

function clampNumber(raw: string, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number(raw) || min))
}

function numberBudget(
  budget: SyncConfig['budget'],
  key: 'maxRunsPerDay' | 'maxMinutes',
  raw: string,
): NonNullable<SyncConfig['budget']> {
  const next = { ...budget }
  const value = Number(raw)
  if (value > 0) next[key] = value
  else delete next[key]
  return next
}

function shortPath(value: string): string {
  const parts = value.split('/').filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : value
}

function generatorLabel(generators: GeneratorEntry[], value: string): string {
  return generators.find((item) => item.id === value)?.displayName ?? value
}

function agentLabel(value: string): string {
  return value === 'claude' ? 'Claude Code' : value === 'codex' ? 'Codex' : 'Gemini'
}
