import { useEffect, useRef, useState } from 'preact/hooks'
import './WorkspaceApplication.css'
import { api, patch, post, remove } from './api'
import {
  Badge, Button, Combo, Empty, Field, Input, KeyValues, Lines, Note, PageHeader,
  Panel, Segmented, Select, Stat, Table, Tabs, Textarea, Toggle, parseTerms, splitComma, termText, timeText,
} from './components'
import { Icon } from './icons'
import { settledPlanJobs } from './job-transitions'
import { agentModels, defaultModelForAgent, modelReasoningLevels, preferredReasoningLevel } from './model-options'
import { countPlanPages, groupPlanPages, planActionLabel, planApprovalControls, type PlanPageFilter } from './plan-review'
import { workspacePath, workspaceRoute, type ResolvedWorkspaceRoute, type WorkspaceRoute } from './routes'
import { screenshotIntentFromChoice } from './setup-plan'
import type { CoverageItem, DeploymentRecord, DiffRow, DocumentationPlan, DocumentationPlanPage, GeneratorEntry, HistoryChangedPage, HistoryRequest, Proposal, ProposalChange, Source, SourceDiff, SourceIntelligence, SyncConfig, UiJob, UiState } from './types'

type PlanDiscoverySummary = {
  suggestedPages: { starter: number; standard: number; comprehensive: number }
  publicSignals: number
  generatedAt: string
  cacheHit: boolean
}

type ApplicationReadiness = {
  configured: boolean
  reachable: boolean
  status: 'not-configured' | 'ready' | 'authentication-required' | 'unreachable'
  url?: string
  message: string
}

const NAV = [
  ['overview', 'Overview', 'overview'],
  ['sources', 'Sources', 'sources'],
  ['authoring', 'Update', 'update'],
  ['proposals', 'Review', 'review'],
  ['publish', 'Deploy', 'deploy'],
  ['settings', 'Settings', 'settings'],
] as const

const PAGE_TITLES: Record<Page, string> = {
  overview: 'Overview',
  sources: 'Sources',
  authoring: 'Update documentation',
  proposals: 'Review changes',
  publish: 'Deploy',
  settings: 'Settings',
  'not-found': 'Not found',
}

const DOXLOOP_LOGO = new URL('../../assets/brand/doxloop-logo-light.png', import.meta.url).href

type Page = ResolvedWorkspaceRoute

type WorkspaceApplicationProps = {
  state: UiState
  loading: boolean
  error: string
  reload: () => Promise<void>
  act: Action
  onJobsUpdate: (jobs: UiJob[]) => void
  onError: (error: string) => void
  onErrorDismiss: () => void
}

export function WorkspaceApplication({
  state,
  loading,
  error,
  reload,
  act,
  onJobsUpdate,
  onError,
  onErrorDismiss,
}: WorkspaceApplicationProps) {
  const project = state.project!
  const [page, setPage] = useState<Page>(() => workspaceRoute(location.pathname))
  const [navOpen, setNavOpen] = useState(false)
  const [jobStreamConnected, setJobStreamConnected] = useState(false)
  const [readyProposal, setReadyProposal] = useState<Proposal | null>(null)
  const runningJobIds = useRef(new Set(state.jobs.filter((job) => job.status === 'running').map((job) => job.id)))
  const announcedJobIds = useRef(new Set<string>())
  const pendingProposalCount = validRuns(state.runs).filter((run) => OPEN_STATUSES.includes(run.status)).length
  const authoringNavigationLabel = documentationExists(state) || state.documentationPlan?.status === 'generated' ? 'Update' : 'Create'

  const receiveJobs = (jobs: UiJob[]) => {
    const previouslyRunning = runningJobIds.current
    const completedUpdates = jobs.filter((job) =>
      job.type === 'author:update' &&
      job.status === 'succeeded' &&
      previouslyRunning.has(job.id) &&
      !announcedJobIds.current.has(job.id),
    )
    const settledPlans = settledPlanJobs(jobs, previouslyRunning, announcedJobIds.current)
    const settledRevisions = jobs.filter((job) =>
      (job.type.startsWith('proposal:revise:') || job.type.startsWith('proposal:resume:')) &&
      job.status !== 'running' &&
      previouslyRunning.has(job.id) &&
      !announcedJobIds.current.has(job.id),
    )
    // Any plan job that stopped running must refresh the persisted plan, even
    // if this client already handled it once. The announce guard exists to stop
    // duplicate navigation, and letting it also suppress the refresh is what
    // leaves the screen stuck on "researching" after the plan is ready.
    const stoppedPlan = jobs.some((job) =>
      job.type.startsWith('plan:') && job.status !== 'running' && previouslyRunning.has(job.id),
    )
    runningJobIds.current = new Set(jobs.filter((job) => job.status === 'running').map((job) => job.id))
    onJobsUpdate(jobs)
    if (stoppedPlan && settledPlans.length === 0) void reload()
    for (const job of settledPlans) {
      announcedJobIds.current.add(job.id)
      if ((job.type !== 'plan:generate' && job.type !== 'plan:continue') || job.status !== 'succeeded') {
        void reload()
        continue
      }
      void (async () => {
        await reload()
        try {
          const proposals = await api<Proposal[]>('/api/proposals')
          const proposal = proposals.find((run) => OPEN_STATUSES.includes(run.status))
          if (!proposal) return
          setReadyProposal(proposal)
          history.pushState({}, '', '/proposals')
          setPage('proposals')
        } catch (cause) {
          onError(message(cause))
        }
      })()
    }
    for (const job of completedUpdates) {
      announcedJobIds.current.add(job.id)
      void (async () => {
        await reload()
        try {
          const proposals = await api<Proposal[]>('/api/proposals')
          const proposal = proposals.find((run) => OPEN_STATUSES.includes(run.status))
          if (!proposal) return
          setReadyProposal(proposal)
          history.pushState({}, '', '/proposals')
          setPage('proposals')
        } catch (cause) {
          onError(message(cause))
        }
      })()
    }
    for (const job of settledRevisions) {
      announcedJobIds.current.add(job.id)
      void (async () => {
        await reload()
        if (job.status !== 'succeeded') return
        try {
          const resumed = job.type.startsWith('proposal:resume:')
          const previousId = job.type.slice((resumed ? 'proposal:resume:' : 'proposal:revise:').length)
          const proposals = await api<Proposal[]>('/api/proposals')
          // A resumed run keeps its id; a revision replaces the run it revises.
          const proposal = proposals.find((run) => (resumed ? run.id === previousId : run.revisionOf === previousId) && run.status === 'awaiting-review')
          if (!proposal) return
          setReadyProposal(proposal)
          history.pushState({}, '', '/proposals')
          setPage('proposals')
        } catch (cause) {
          onError(message(cause))
        }
      })()
    }
  }

  useEffect(() => {
    const stream = new EventSource('/api/jobs/stream')
    stream.onopen = () => setJobStreamConnected(true)
    stream.onmessage = (event) => {
      try {
        const jobs = JSON.parse(event.data) as unknown
        if (Array.isArray(jobs)) receiveJobs(jobs as UiJob[])
      } catch {
        // EventSource reconnects and the next complete snapshot replaces this one.
      }
    }
    stream.onerror = () => setJobStreamConnected(false)
    return () => {
      stream.close()
      setJobStreamConnected(false)
    }
  }, [])

  useEffect(() => {
    const listener = () => setPage(workspaceRoute(location.pathname))
    addEventListener('popstate', listener)
    return () => removeEventListener('popstate', listener)
  }, [])

  const jobsRunning = state.jobs.some((job) => job.status === 'running')
  useEffect(() => {
    if (!jobsRunning) return
    const timer = window.setInterval(async () => {
      try {
        const jobs = await api<UiJob[]>('/api/jobs')
        receiveJobs(jobs)
        if (!jobs.some((job) => job.status === 'running')) void reload()
      } catch (cause) {
        onError(message(cause))
      }
    }, 1800)
    return () => clearInterval(timer)
  }, [jobsRunning])

  const navigate = (next: WorkspaceRoute) => {
    history.pushState({}, '', workspacePath(next))
    setPage(next)
    setNavOpen(false)
  }

  const openPreview = async () => {
    const previewTab = window.open('about:blank', '_blank')
    if (previewTab) previewTab.opener = null
    try {
      await post('/api/preview/start', { open: !previewTab })
      previewTab?.location.replace(state.preview?.url ?? 'http://127.0.0.1:4321')
      void reload()
    } catch (cause) {
      previewTab?.close()
      onError(message(cause))
    }
  }

  return <div class={`shell ${page === 'proposals' ? 'proposal-shell' : ''} ${page === 'sources' ? 'sources-shell' : ''}`}>
    {navOpen && <button class="nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}

    {readyProposal && <div class="proposal-ready-scrim" role="presentation">
      <section class="proposal-ready-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-ready-title">
        <button class="proposal-ready-close" type="button" aria-label="Close" onClick={() => setReadyProposal(null)}><Icon name="close" size={16} /></button>
        <span class="proposal-ready-icon"><Icon name="proposals" size={24} /></span>
        <div><h2 id="proposal-ready-title">Documentation changes are ready</h2><p>Your update finished successfully. Review the proposed changes before they replace the current documentation.</p></div>
        <div class="proposal-ready-summary"><strong>{proposalSummaryText(readyProposal.changes)}</strong><span>The current documentation remains unchanged until you accept the proposal.</span></div>
        <footer><Button icon="external" onClick={() => void openProposalPreview(readyProposal.id, onError)}>Preview changes</Button><Button tone="primary" icon="proposals" onClick={() => setReadyProposal(null)}>Review changes</Button></footer>
      </section>
    </div>}

    <aside class={`sidebar ${navOpen ? 'open' : ''}`}>
      <button class="workspace-brand" type="button" aria-label="Open navigation" onClick={() => setNavOpen(true)}><img src={DOXLOOP_LOGO} alt="Doxloop" /></button>
      <div class="workspace-identity" aria-label={`Current workspace: ${project.title}`}>
        <span class="workspace-identity-mark">{project.title.slice(0, 1).toUpperCase()}</span>
        <span class="workspace-identity-copy"><strong>{project.title}</strong><small>Local workspace</small></span>
      </div>
      <nav class="reference-sidebar-nav" aria-label="Main navigation">
        {NAV.map(([id, label, icon]) => <button key={id} class={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={icon} size={17} /><span>{id === 'authoring' ? authoringNavigationLabel : label}</span>{id === 'proposals' && pendingProposalCount > 0 && <b class="nav-count" aria-label={`${pendingProposalCount} pending proposal${pendingProposalCount === 1 ? '' : 's'}`}>{pendingProposalCount}</b>}</button>)}
      </nav>
      <button type="button" class="new-project-button" onClick={() => alert('Open Doxloop from the product folder you want to document to start a new project.')}>
        <Icon name="plus" size={16} />
        <span><strong>New documentation project</strong><small>Open the setup wizard</small></span>
      </button>
    </aside>

    <main class="workspace-main">
      <header class="workspace-navbar">
        <button class="workspace-mobile-menu" type="button" aria-label="Open navigation" onClick={() => setNavOpen(true)}><Icon name="menu" size={18} /></button>
        <strong class="workspace-screen-title">{PAGE_TITLES[page]}</strong>
        <span class="workspace-navbar-spacer" />
        <a class="workspace-support-link" href="https://github.com/doxbrix/doxloop" target="_blank" rel="noreferrer"><Icon name="help" size={15} />Support</a>
        <button type="button" class="workspace-preview-primary" onClick={() => void openPreview()}><Icon name="preview" size={15} /><strong>Preview docs</strong><Icon name="external" size={12} /></button>
      </header>
      <div class="main">
        <div class="page">
        {loading && <div class="loading-bar" />}
        {error && <Banner title="Action failed" detail={error} onClose={onErrorDismiss} />}
        {page === 'overview' && <Overview state={state} navigate={navigate} openPreview={openPreview} />}
        {page === 'sources' && <SourcesReference state={state} act={act} navigate={navigate} />}
        {page === 'authoring' && <Authoring state={state} act={act} streamConnected={jobStreamConnected} onError={onError} />}
        {page === 'proposals' && <Proposals state={state} act={act} onError={onError} />}
        {page === 'publish' && <Publish state={state} act={act} streamConnected={jobStreamConnected} onError={onError} />}
        {page === 'settings' && <Settings state={state} act={act} />}
        {page === 'not-found' && <NotFound navigate={navigate} />}
        </div>
      </div>
    </main>
  </div>
}

function Overview({ state, navigate, openPreview }: { state: UiState; navigate: (page: WorkspaceRoute) => void; openPreview: () => Promise<void> }) {
  const project = state.project!
  const [intelligence, setIntelligence] = useState<SourceIntelligence>()
  useEffect(() => {
    let active = true
    void api<SourceIntelligence>('/api/source-intelligence')
      .then((report) => { if (active) setIntelligence(report) })
      .catch(() => undefined)
    return () => { active = false }
  }, [project.sources.map((source) => `${source.name}:${source.path}`).join('|')])

  const proposals = validRuns(state.runs)
  const openProposal = proposals.find((run) => OPEN_STATUSES.includes(run.status))
  const measuredCoverage = intelligence?.coverage.metrics.filter((metric) => metric.status !== 'unknown') ?? []
  const documentedItems = measuredCoverage.reduce((total, metric) => total + metric.documented, 0)
  const discoveredItems = measuredCoverage.reduce((total, metric) => total + metric.total, 0)
  const coverage = discoveredItems > 0 ? Math.round((documentedItems / discoveredItems) * 100) : 0
  const hasDocs = documentationExists(state)
  const plan = state.documentationPlan
  const deployedSlug = state.effectiveDeployment?.slug ?? project.deployment?.slug
  const deployedAddress = deployedSlug ? (deployedSlug.includes('.') ? deployedSlug : `${deployedSlug}.doxbrix.site`) : 'Not deployed yet'
  const latestTimestamp = state.jobs[0]?.finishedAt ?? state.jobs[0]?.startedAt ?? plan?.updatedAt
  const changed = openProposal?.changes ?? []
  const added = changed.filter((change) => change.kind === 'added').length
  const modified = changed.filter((change) => change.kind !== 'added' && change.kind !== 'deleted').length
  const recentJobs = state.jobs.slice(0, 3)
  const planPages = plan?.pages.filter((page) => page.priority !== 'later').length ?? 0
  const pipeline = [
    { label: 'Sources', sub: `${project.sources.length} connected`, icon: 'sources', route: 'sources' as const, state: project.sources.length ? 'done' : 'idle' },
    { label: 'Plan', sub: plan ? `Version ${plan.version}` : 'Not started', icon: 'list', route: 'authoring' as const, state: plan ? 'done' : 'idle' },
    { label: 'Write', sub: hasDocs ? `${state.validation?.pages.length ?? planPages} pages ready` : plan?.status === 'generating' ? 'In progress' : 'Waiting', icon: 'update', route: 'authoring' as const, state: hasDocs ? 'done' : plan?.status === 'generating' ? 'active' : 'idle' },
    { label: 'Review', sub: openProposal ? 'Awaiting you' : 'No pending changes', icon: 'review', route: 'proposals' as const, state: openProposal ? 'active' : hasDocs ? 'done' : 'idle' },
    { label: 'Deploy', sub: deployedSlug ? 'Destination ready' : 'Not configured', icon: 'deploy', route: 'publish' as const, state: deployedSlug ? 'done' : 'idle' },
  ]

  return <section class="overview-page">
    <div class="overview-heading">
      <div><h2>Your documentation loop</h2><p>Everything between your source code and the published docs, in one pass.</p></div>
      <span>{latestTimestamp ? `Last checked ${timeText(latestTimestamp)}` : 'Ready to begin'}</span>
    </div>

    <section class="pipeline-card" aria-label="Documentation workflow">
      <div class="pipeline-track"><i /></div>
      {pipeline.map((step) => <button type="button" key={step.label} class={step.state} onClick={() => navigate(step.route)}>
        <span><Icon name={step.icon} size={17} /></span>
        <strong>{step.label}</strong>
        <small>{step.sub}</small>
      </button>)}
    </section>

    <div class="overview-card-grid">
      <section class={`overview-review-card ${openProposal ? 'attention' : ''}`}>
        <header><i />{openProposal ? 'Needs your review' : 'Documentation is current'}</header>
        <div><h3>{openProposal?.summary || (hasDocs ? 'No changes are waiting' : 'Create your first documentation plan')}</h3><p>{openProposal ? `${changed.length} file change${changed.length === 1 ? '' : 's'} · ${added} added · ${modified} modified` : hasDocs ? 'The latest accepted documentation is ready to preview.' : 'Connect sources and let the planning agent propose the right pages.'}</p></div>
        <footer>
          <button type="button" class="primary" onClick={() => navigate(openProposal ? 'proposals' : 'authoring')}>{openProposal ? 'Review changes' : hasDocs ? 'Plan an update' : 'Create documentation'}</button>
          {hasDocs && <button type="button" onClick={() => void openPreview()}>Preview</button>}
        </footer>
      </section>

      <section class="overview-metric-card">
        <header>Coverage</header>
        <div class="overview-coverage"><span style={{ '--overview-coverage': `${coverage}%` }}><b>{intelligence ? `${coverage}%` : '—'}</b></span><div><h3>{!intelligence ? 'Checking evidence' : coverage >= 90 ? 'Strong coverage' : coverage >= 70 ? 'Good foundation' : coverage >= 40 ? 'Coverage gaps remain' : 'Needs attention'}</h3><p>{intelligence ? `${documentedItems} of ${discoveredItems} discovered items documented` : 'Coverage appears after source discovery completes'}</p></div></div>
        <button type="button" class="overview-link" onClick={() => navigate('sources')}>See coverage by surface →</button>
      </section>

      <section class="overview-metric-card">
        <header>Published site</header>
        <div class="overview-published"><span><Icon name={deployedSlug ? 'check' : 'publish'} size={16} /></span><div><h3>{deployedSlug ? 'Deployment destination ready' : 'No deployment yet'}</h3><code>{deployedAddress}</code></div></div>
        <button type="button" class="overview-link" onClick={() => navigate('publish')}>Deployment history →</button>
      </section>
    </div>

    <section class="overview-activity-card">
      <header><strong>Recent activity</strong><span>Agents run quietly in the background</span></header>
      {recentJobs.length ? recentJobs.map((job) => <div class="overview-activity-row" key={job.id}>
        <span class={job.status}><Icon name={job.type.startsWith('deploy') ? 'deploy' : job.type.startsWith('plan') ? 'list' : job.type.includes('proposal') ? 'review' : 'update'} size={14} /></span>
        <p><strong>{workflowActivityLabel(job.type)}</strong>{job.status === 'running' ? ' is running' : job.status === 'succeeded' ? ' completed successfully' : job.status === 'failed' ? ' needs attention' : ` was ${job.status}`}</p>
        <time>{timeText(job.finishedAt ?? job.startedAt)}</time>
      </div>) : <div class="overview-activity-row empty"><span><Icon name="check" size={14} /></span><p>Your workspace is ready. Activity will appear here after the first run.</p><time>Now</time></div>}
    </section>
  </section>
}

function Banner({ title, detail, onClose }: { title: string; detail: string; onClose: () => void }) {
  return <div class="banner bad">
    <Icon name="alert" size={16} />
    <div><strong>{title}</strong><span>{detail}</span></div>
    <button aria-label="Dismiss" onClick={onClose}><Icon name="close" size={14} /></button>
  </div>
}

function NotFound({ navigate }: { navigate: (page: WorkspaceRoute) => void }) {
  return <div class="workspace-not-found"><span><Icon name="alert" size={24} /></span><h1>Workspace page not found</h1><p>This URL does not match an available Doxloop workspace.</p><Button tone="primary" onClick={() => navigate('authoring')}>Open documentation update</Button></div>
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

async function openProposalPreview(runId: string, onError: (error: string) => void): Promise<void> {
  const previewTab = window.open('about:blank', '_blank')
  if (previewTab) previewTab.opener = null
  try {
    const result = await post<{ url: string }>(`/api/proposals/${runId}/preview/start`, { open: !previewTab })
    previewTab?.location.replace(result.url)
  } catch (cause) {
    previewTab?.close()
    onError(message(cause))
  }
}

function RepositoryConnectButton({ connected, busy, disabled, onClick }: { connected: boolean; busy: boolean; disabled: boolean; onClick: () => void }) {
  if (connected) return <button type="button" class="repository-connected-button" onClick={onClick}><Icon name="check" size={14} />Connected</button>
  return <Button tone="primary" busy={busy} disabled={disabled} onClick={onClick}>Connect</Button>
}

function RepositoryFolderSelect({ value, directories, loading, connected, onChange }: {
  value: string
  directories: string[]
  loading: boolean
  connected: boolean
  onChange: (value: string) => void
}) {
  return <Field label="Folder" hint={connected ? 'Choose a repository folder or use the root.' : 'Connect the repository first.'}>
    <Select value={value} disabled={!connected || loading} onChange={(event) => onChange(event.currentTarget.value)}>
      <option value="">{loading ? 'Loading folders…' : 'Entire repository'}</option>
      {value && !directories.includes(value) && <option value={value}>{value}</option>}
      {directories.map((directory) => <option key={directory} value={directory}>{directory}</option>)}
    </Select>
  </Field>
}


function SourcesReference({ state, act, navigate }: { state: UiState; act: Action; navigate: (page: WorkspaceRoute) => void }) {
  const project = state.project!
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<'source' | 'openapi' | null>(null)
  const [monitoringOpen, setMonitoringOpen] = useState(false)
  const [scopeSource, setScopeSource] = useState<Source | null>(null)
  const [sourceMode, setSourceMode] = useState<'git' | 'local'>('git')
  const [openapiMode, setOpenapiMode] = useState<'file' | 'url'>('file')
  const [add, setAdd] = useState({ repository: '', branch: 'main', subdirectory: '', path: '', authMethod: 'automatic', gitUsername: '', gitSecret: '', specContent: '', fileName: '', space: '', routePrefix: '', navigationGroup: '', sharedPages: '' })
  const [intelligence, setIntelligence] = useState<SourceIntelligence>()
  const [branches, setBranches] = useState<string[]>([])
  const [directories, setDirectories] = useState<string[]>([])
  const [head, setHead] = useState('')
  const [connecting, setConnecting] = useState(false)
  const [foldersLoading, setFoldersLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [checkingSource, setCheckingSource] = useState('')
  const [coverageMetricId, setCoverageMetricId] = useState<string>()
  const fileInput = useRef<HTMLInputElement>(null)
  const filtered = project.sources
  const resetAdd = () => {
    setAdd({ repository: '', branch: 'main', subdirectory: '', path: '', authMethod: 'automatic', gitUsername: '', gitSecret: '', specContent: '', fileName: '', space: '', routePrefix: '', navigationGroup: '', sharedPages: '' })
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
  const loadIntelligence = async () => setIntelligence(await api<SourceIntelligence>('/api/source-intelligence'))
  useEffect(() => {
    let active = true
    void api<SourceIntelligence>('/api/source-intelligence').then((report) => { if (active) setIntelligence(report) }).catch(() => undefined)
    return () => { active = false }
  }, [project.sources.map((source) => `${source.name}:${source.path}`).join('|')])
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
      const scope = add.space.trim() || add.routePrefix.trim() || add.navigationGroup.trim() || add.sharedPages.trim() ? { space: add.space.trim() || undefined, routePrefix: add.routePrefix.trim() || undefined, navigationGroup: add.navigationGroup.trim() || undefined, sharedPages: splitComma(add.sharedPages) } : undefined
      const body = dialog === 'openapi'
        ? { kind: 'openapi', name, path: openapiMode === 'url' ? add.path : undefined, specContent: openapiMode === 'file' ? add.specContent : undefined, scope }
        : sourceMode === 'git'
          ? { kind: 'git', name, ...add, scope }
          : { kind: 'directory', name, path: add.path, scope }
      const result = await act(() => post('/api/sources', body), 'Source added')
      if (result !== undefined) closeDialog()
    } finally {
      setSaving(false)
    }
  }
  const remoteSourceCount = filtered.filter((source) => Boolean(source.remote)).length
  const openapiSourceCount = filtered.filter((source) => source.kind === 'openapi').length
  const measuredCoverage = intelligence?.coverage.metrics.filter((metric) => metric.status !== 'unknown') ?? []
  const documentedItems = measuredCoverage.reduce((total, metric) => total + metric.documented, 0)
  const discoveredItems = measuredCoverage.reduce((total, metric) => total + metric.total, 0)
  const overallCoverage = discoveredItems > 0 ? Math.round((documentedItems / discoveredItems) * 100) : null
  const unknownCoverageCount = intelligence?.coverage.metrics.filter((metric) => metric.status === 'unknown').length ?? 0
  const coverageAssessment = overallCoverage === null ? 'Awaiting discovery' : overallCoverage >= 90 ? 'Strong coverage' : overallCoverage >= 70 ? 'Good foundation' : overallCoverage >= 40 ? 'Coverage gaps remain' : 'Needs attention'
  const selectedCoverageMetric = intelligence?.coverage.metrics.find((metric) => metric.id === coverageMetricId)
  return <div class="sources-reference-page">
    <PageHeader title="Sources" description="Manage the read-only sources Doxloop uses to create and maintain your documentation." actions={<><Button icon="bell" onClick={() => setMonitoringOpen(true)}>Monitoring</Button><div class="sources-add-wrap"><button type="button" class="sources-add-dropdown-button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><Icon name="plus" size={16} />Add source<Icon name="chevronDown" size={14} /></button>{menuOpen && <div class="sources-add-menu"><button type="button" onClick={() => openDialog('source')}><span><Icon name="api" size={20} /></span><span><strong>Source code</strong></span></button><button type="button" onClick={() => openDialog('openapi')}><span><Icon name="braces" size={20} /></span><span><strong>OpenAPI spec</strong></span></button></div>}</div></>} />
    <section class="sources-library">
      <header class="sources-library-header">
        <div><h2>Connected sources</h2><p>Evidence Doxloop can read when it creates and updates your documentation.</p></div>
        <div class="sources-library-summary"><span><strong>{filtered.length}</strong> connected</span><i /><span><strong>{remoteSourceCount}</strong> remote</span><i /><span><strong>{openapiSourceCount}</strong> API</span></div>
      </header>
      {filtered.length ? <div class="sources-library-table" role="table" aria-label="Connected sources">
        <div class="sources-library-table-head" role="row">
          <span role="columnheader">Source</span><span role="columnheader">Type</span><span role="columnheader">Details</span><span role="columnheader">Status</span><span role="columnheader"><span class="sr-only">Actions</span></span>
        </div>
        <div class="sources-library-table-body" role="rowgroup">{filtered.map((source) => {
          const health = intelligence?.health.find((item) => item.name === source.name)
          const type = source.kind === 'openapi' ? 'OpenAPI' : source.remote ? 'Git' : 'Local'
          const detail = health?.openapi
            ? `v${health.openapi.version} · ${health.openapi.operationCount} operations · ${health.openapi.schemas.length} schemas`
            : health?.branch
              ? `${health.branch}${health.subdirectory ? ` / ${health.subdirectory}` : ''}${health.revision ? ` · ${health.revision.slice(0, 10)}` : ''}`
              : source.scope?.routePrefix
                ? `Owns /${source.scope.routePrefix.replace(/^\//, '')}`
                : 'Project-wide evidence'
          const status = health ? health.status === 'healthy' ? 'Available' : health.status === 'warning' ? 'Needs attention' : 'Unavailable' : 'Checking…'
          return <div class="sources-library-row" role="row" key={source.name}>
            <div class="sources-library-name" role="cell"><span class={`source-service-icon ${source.kind === 'openapi' ? 'openapi' : source.remote ? `git ${repositoryProvider(source.remote.repository)}` : 'local'}`}><Icon name={source.kind === 'openapi' ? 'braces' : source.remote ? repositoryProviderIcon(source.remote.repository) : 'folder'} size={20} /></span><span><strong>{source.name}</strong><small title={source.remote ? source.remote.repository : source.path}>{source.remote ? source.remote.repository : source.path}</small></span></div>
            <div role="cell"><em class={`source-type-pill ${source.kind === 'openapi' ? 'openapi' : source.remote ? 'git' : 'local'}`}>{type}</em></div>
            <div class="sources-library-detail" role="cell"><strong>{detail}</strong>{source.scope?.routePrefix && health?.openapi && <small>Owns /{source.scope.routePrefix.replace(/^\//, '')}</small>}{health?.status === 'error' && <small class="source-health-error">{health.summary}</small>}</div>
            <div class="sources-library-status" role="cell"><span class={`source-connection-status ${health?.status ?? ''}`} title={health ? `Checked ${new Date(health.checkedAt).toLocaleString()}${health.lastMonitoringAt ? ` · Last monitoring check ${new Date(health.lastMonitoringAt).toLocaleString()}` : ''}` : ''}><i />{status}</span>{health && <small>Checked {new Date(health.checkedAt).toLocaleDateString()}</small>}</div>
            <span class="source-row-menu" role="cell"><button type="button" aria-label={`Test ${source.name}`} title="Test connection" disabled={checkingSource === source.name} onClick={() => { setCheckingSource(source.name); void act(() => post(`/api/sources/${encodeURIComponent(source.name)}/test`), 'Source connection checked').then(() => loadIntelligence()).finally(() => setCheckingSource('')) }}><Icon name="refresh" size={18} /></button><button type="button" aria-label={`Configure documentation ownership for ${source.name}`} title="Documentation ownership" onClick={() => setScopeSource(source)}><Icon name="map" size={18} /></button><button type="button" aria-label={`Delete ${source.name}`} title="Delete source" onClick={() => { if (confirm(`Remove ${source.name}?`)) void act(() => remove(`/api/sources/${encodeURIComponent(source.name)}`), 'Source removed') }}><Icon name="trash" size={18} /></button></span>
          </div>
        })}</div>
      </div> : <div class="sources-table-empty"><Icon name="sources" size={28} /><strong>No sources yet</strong><small>Add a source to start creating documentation.</small><Button tone="primary" icon="plus" onClick={() => openDialog('source')}>Add source</Button></div>}
    </section>
    {intelligence && <section class="source-intelligence-panel">
      <header><div><h2>Documentation coverage</h2><p>See which discovered product surfaces are supported by documentation evidence.</p></div><span class={intelligence.evidenceDiagnostics.length ? 'attention' : 'precise'}>{intelligence.evidenceDiagnostics.length ? `${intelligence.evidenceDiagnostics.length} evidence notes` : 'Evidence looks precise'}</span></header>
      <div class="coverage-overview">
        <aside class="coverage-summary-card">
          <div class="coverage-score" style={{ '--coverage': `${overallCoverage ?? 0}%` }} aria-label={overallCoverage === null ? 'Coverage unavailable' : `${overallCoverage}% overall documentation coverage`}><span><strong>{overallCoverage === null ? '—' : `${overallCoverage}%`}</strong><small>overall</small></span></div>
          <div class="coverage-summary-copy"><span class={`coverage-assessment ${overallCoverage !== null && overallCoverage < 70 ? 'attention' : ''}`}>{coverageAssessment}</span><h3>{documentedItems} of {discoveredItems} discovered items are documented</h3><p>Coverage measures traceable evidence across all connected sources.</p></div>
          <dl class="coverage-summary-stats"><div><dt>Documented</dt><dd>{documentedItems}</dd></div><div><dt>Not covered</dt><dd>{Math.max(discoveredItems - documentedItems, 0)}</dd></div><div><dt>No items found</dt><dd>{unknownCoverageCount}</dd></div></dl>
          <p class="source-coverage-disclaimer">{intelligence.coverage.disclaimer}</p>
        </aside>
        <div class="coverage-breakdown">
          <div class="coverage-breakdown-heading"><div><h3>Coverage by surface</h3><p>Each percentage is based on items found during source discovery.</p></div><span>{measuredCoverage.length} measured</span></div>
          <div class="source-coverage-list">{intelligence.coverage.metrics.map((metric) => {
            const measured = metric.status !== 'unknown'
            const discoveryTitle = 'Discovery completed, but no items in this category were found in the connected sources.'
            const gaps = metric.items.filter((item) => item.state === 'uncovered' || item.state === 'needs-human').length
            return <div class={`source-coverage-row ${measured ? '' : 'unknown'}`} key={metric.id} title={measured ? metric.denominator : `${discoveryTitle} ${metric.denominator}`}>
              <div class="source-coverage-row-heading"><span>{metric.label}</span>{measured ? <span><strong>{metric.percent}%</strong><small>{metric.documented} of {metric.total}</small></span> : <em>No items discovered</em>}</div>
              <div class="source-coverage-track" role="progressbar" aria-label={`${metric.label} coverage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={measured ? metric.percent : undefined}><i style={{ width: measured ? `${metric.percent}%` : '0%' }} /></div>
              {(gaps > 0 || metric.excluded > 0) && <button type="button" class="coverage-review-action" onClick={() => setCoverageMetricId(metric.id)}>{gaps > 0 ? `Review ${gaps} ${gaps === 1 ? 'gap' : 'gaps'}` : `Review ${metric.excluded} excluded`}</button>}
            </div>
          })}</div>
        </div>
      </div>
      {intelligence.evidenceDiagnostics.length > 0 && <details class="source-evidence-notes"><summary>Review evidence precision</summary>{intelligence.evidenceDiagnostics.slice(0, 8).map((item) => <div key={`${item.code}:${item.page}:${item.identifier}`}><strong>{item.page}</strong><p>{item.message}</p><small>{item.suggestion}</small></div>)}</details>}
    </section>}
    {monitoringOpen && <MonitoringDialog state={state} act={act} onClose={() => setMonitoringOpen(false)} />}
    {selectedCoverageMetric && <CoverageResolutionDialog
      metric={selectedCoverageMetric}
      pages={intelligence?.coverage.pages ?? []}
      act={act}
      onClose={() => setCoverageMetricId(undefined)}
      onReport={setIntelligence}
      onCreateUpdate={async (items) => {
        const selectedGaps = items.map((item) => `- ${item.label}${item.source ? ` — source: ${item.source}` : ''}${item.path ? `, path: ${item.path}` : ''}`).join('\n')
        const result = await act(() => post('/api/plans', {
          mode: 'update',
          scope: 'custom',
          clarificationMode: 'review',
          request: `Create one focused documentation update plan that resolves these ${items.length} selected coverage ${items.length === 1 ? 'gap' : 'gaps'}:\n${selectedGaps}\nMap each public surface or reader outcome to the most appropriate reader-facing page and preserve unrelated documentation.`,
        }), 'Coverage update planning started')
        if (result !== undefined) navigate('authoring')
        return result !== undefined
      }}
    />}
    {scopeSource && <SourceScopeDialog source={scopeSource} act={act} onClose={() => setScopeSource(null)} />}
    {dialog && <div class="sources-modal-scrim" onClick={closeDialog}><section class={`sources-reference-dialog ${dialog}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
      <header>{dialog === 'openapi' && <span class="sources-dialog-icon"><Icon name="file" size={24} /></span>}<div><h2>{dialog === 'source' ? 'Add source code' : 'Add OpenAPI spec'}</h2><p>{dialog === 'source' ? 'Choose how you want to connect your source code.' : 'Import your OpenAPI specification from a local file or a public URL.'}</p></div><button type="button" aria-label="Close" onClick={closeDialog}><Icon name="close" size={17} /></button></header>
      {dialog === 'source' ? <div class="sources-dialog-body"><span class="dialog-section-label">Source type</span><div class="source-mode-grid"><button type="button" class={sourceMode === 'git' ? 'selected' : ''} onClick={() => setSourceMode('git')}><span><Icon name="api" size={22} /></span><i /><strong>Git repository</strong><small>Connect a GitHub, GitLab, Azure DevOps or other Git service.</small></button><button type="button" class={sourceMode === 'local' ? 'selected' : ''} onClick={() => setSourceMode('local')}><span><Icon name="folder" size={22} /></span><i /><strong>Local folder</strong><small>Use a folder on your computer or network.</small></button></div>{sourceMode === 'git' ? <div class="source-code-fields"><Field label="Repository access"><Select value={add.authMethod} onChange={(event) => { setAdd({ ...add, authMethod: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }}><option value="automatic">Public repository</option><option value="credentials">Private repository</option></Select></Field><Field label="Repository URL"><div class="repository-connect-input"><Input value={add.repository} onInput={(event) => { setAdd({ ...add, repository: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /><RepositoryConnectButton connected={Boolean(head)} busy={connecting} disabled={!add.repository.trim() || (add.authMethod === 'credentials' && (!add.gitUsername.trim() || !add.gitSecret.trim()))} onClick={() => void connectRepository()} /></div></Field>{add.authMethod === 'credentials' && <div class="private-git-fields"><Field label="Username"><Input value={add.gitUsername} autocomplete="username" onInput={(event) => { setAdd({ ...add, gitUsername: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /></Field><Field label="Personal Access Token (PAT)"><Input type="password" value={add.gitSecret} autocomplete="off" onInput={(event) => { setAdd({ ...add, gitSecret: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /></Field></div>}<div class="source-branch-grid"><Field label="Branch"><Select value={add.branch} disabled={!head || connecting} onChange={(event) => void selectBranch(event.currentTarget.value)}>{branches.length ? branches.map((branch) => <option key={branch}>{branch}</option>) : <option>{connecting ? 'Connecting...' : 'Connect repository first'}</option>}</Select></Field><Field label="Folder (optional)"><Select value={add.subdirectory} disabled={!head || foldersLoading} onChange={(event) => setAdd({ ...add, subdirectory: event.currentTarget.value })}><option value="">/</option>{directories.map((directory) => <option key={directory}>{directory}</option>)}</Select></Field></div></div> : <Field label="Local folder"><div class="source-folder-input"><Input value={add.path} onInput={(event) => setAdd({ ...add, path: event.currentTarget.value })} /><Button icon="folder" onClick={() => void post<{ path: string | null }>('/api/setup/browse-directory').then((result) => result.path && setAdd({ ...add, path: result.path }))}>Browse</Button></div></Field>}</div> : <div class="sources-dialog-body openapi-body"><div class="openapi-tabs"><button type="button" class={openapiMode === 'file' ? 'active' : ''} onClick={() => setOpenapiMode('file')}><Icon name="publish" size={18} />Upload file</button><button type="button" class={openapiMode === 'url' ? 'active' : ''} onClick={() => setOpenapiMode('url')}><Icon name="external" size={18} />From URL</button></div>{openapiMode === 'file' ? <div class={`openapi-dropzone ${add.fileName ? 'has-file' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void readSpecification(event.dataTransfer?.files[0]) }}><input ref={fileInput} type="file" accept=".yaml,.yml,.json,application/json,text/yaml" onChange={(event) => void readSpecification(event.currentTarget.files?.[0])} /><span><Icon name={add.fileName ? 'check' : 'publish'} size={28} /></span><strong>{add.fileName || 'Drag and drop your OpenAPI file here'}</strong>{!add.fileName && <small>or</small>}<Button onClick={() => fileInput.current?.click()}>{add.fileName ? 'Choose another file' : 'Browse file'}</Button><em>Accepted formats: .yaml, .yml, .json</em></div> : <Field label="OpenAPI spec URL"><Input value={add.path} placeholder="https://example.com/openapi.yaml" onInput={(event) => setAdd({ ...add, path: event.currentTarget.value, specContent: '', fileName: '' })} /><small>We support public URLs and standard OpenAPI formats.</small></Field>}</div>}
      <details class="source-scope-fields"><summary>Documentation ownership (optional)</summary><div><Field label="Route prefix"><Input value={add.routePrefix} placeholder="api or integrations/payments" onInput={(event) => setAdd({ ...add, routePrefix: event.currentTarget.value })} /></Field><Field label="Navigation group"><Input value={add.navigationGroup} placeholder="API reference" onInput={(event) => setAdd({ ...add, navigationGroup: event.currentTarget.value })} /></Field><Field label="Space"><Input value={add.space} placeholder="Developers" onInput={(event) => setAdd({ ...add, space: event.currentTarget.value })} /></Field><Field label="Shared pages" hint="Comma-separated page paths or globs"><Input value={add.sharedPages} placeholder="docs/overview.mdx" onInput={(event) => setAdd({ ...add, sharedPages: event.currentTarget.value })} /></Field></div></details>
      <footer><Button onClick={closeDialog}>Cancel</Button><Button tone="primary" busy={saving} disabled={dialog === 'source' ? sourceMode === 'git' ? !head || foldersLoading : !add.path.trim() : openapiMode === 'file' ? !add.specContent.trim() : !add.path.trim()} onClick={() => void addSource()}>Add source</Button></footer>
    </section></div>}
  </div>
}

function CoverageResolutionDialog({ metric, pages, act, onClose, onReport, onCreateUpdate }: {
  metric: SourceIntelligence['coverage']['metrics'][number]
  pages: string[]
  act: Action
  onClose: () => void
  onReport: (report: SourceIntelligence) => void
  onCreateUpdate: (items: CoverageItem[]) => Promise<boolean>
}) {
  const attentionItems = metric.items.filter((item) => item.state === 'uncovered' || item.state === 'needs-human')
  const resolvedItems = metric.items.filter((item) => item.state !== 'uncovered' && item.state !== 'needs-human')
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [planning, setPlanning] = useState(false)
  const selectedItems = attentionItems.filter((item) => selectedIds.includes(item.id))
  const allSelected = attentionItems.length > 0 && selectedItems.length === attentionItems.length

  useEffect(() => {
    const availableIds = new Set(attentionItems.map((item) => item.id))
    setSelectedIds((current) => current.filter((id) => availableIds.has(id)))
  }, [metric])

  const resolve = async (item: CoverageItem, action: string, page?: string, reason?: string) => {
    const report = await act(() => post<SourceIntelligence>('/api/coverage/resolve', { id: item.id, action, page, reason }), 'Coverage updated')
    if (report) onReport(report)
  }
  const toggleSelected = (item: CoverageItem, selected: boolean) => {
    setSelectedIds((current) => selected ? [...new Set([...current, item.id])] : current.filter((id) => id !== item.id))
  }
  const createPlan = async () => {
    if (!selectedItems.length) return
    setPlanning(true)
    try { await onCreateUpdate(selectedItems) } finally { setPlanning(false) }
  }
  return <div class="sources-modal-scrim coverage-resolution-scrim" onClick={onClose}>
    <section class="coverage-resolution-dialog" role="dialog" aria-modal="true" aria-labelledby="coverage-resolution-title" onClick={(event) => event.stopPropagation()}>
      <header><div><span class="coverage-dialog-eyebrow">Review documentation gaps</span><h2 id="coverage-resolution-title">{metric.label}</h2><p>Choose everything you want to document, then create one update plan.</p></div><button type="button" aria-label="Close" onClick={onClose}><Icon name="close" size={17} /></button></header>
      {attentionItems.length > 0 && <div class="coverage-selection-toolbar">
        <label><input type="checkbox" checked={allSelected} onChange={(event) => setSelectedIds(event.currentTarget.checked ? attentionItems.map((item) => item.id) : [])} /><span>Select all {attentionItems.length} {attentionItems.length === 1 ? 'gap' : 'gaps'}</span></label>
        <strong>{selectedItems.length} selected</strong>
      </div>}
      <div class="coverage-resolution-list">
        {attentionItems.length > 0 ? <section class="coverage-gap-section" aria-label="Gaps needing attention"><div class="coverage-list-heading"><strong>Needs attention</strong><small>Select gaps to add to this update</small></div>{attentionItems.map((item) => <CoverageResolutionItem key={item.id} item={item} pages={pages} selected={selectedIds.includes(item.id)} onSelectedChange={(selected) => toggleSelected(item, selected)} onResolve={resolve} />)}</section> : <div class="coverage-gaps-empty"><Icon name="check" size={22} /><strong>Everything is resolved</strong><small>There are no documentation gaps in this category.</small></div>}
        {resolvedItems.length > 0 && <details class="coverage-resolved-items"><summary>{resolvedItems.length} already resolved</summary><div>{resolvedItems.map((item) => <CoverageResolutionItem key={item.id} item={item} pages={pages} selected={false} onSelectedChange={() => undefined} onResolve={resolve} />)}</div></details>}
      </div>
      <footer><div class="coverage-plan-summary"><strong>{selectedItems.length ? `${selectedItems.length} ${selectedItems.length === 1 ? 'gap' : 'gaps'} ready to plan` : 'No gaps selected'}</strong><small>{selectedItems.length ? 'One plan will cover your full selection.' : 'Select one or more gaps to continue.'}</small></div><div><Button onClick={onClose}>Close</Button><Button tone="primary" busy={planning} disabled={!selectedItems.length} onClick={() => void createPlan()}>Create update plan{selectedItems.length ? ` (${selectedItems.length})` : ''}</Button></div></footer>
    </section>
  </div>
}

function CoverageResolutionItem({ item, pages, selected, onSelectedChange, onResolve }: {
  item: CoverageItem
  pages: string[]
  selected: boolean
  onSelectedChange: (selected: boolean) => void
  onResolve: (item: CoverageItem, action: string, page?: string, reason?: string) => Promise<void>
}) {
  const [page, setPage] = useState(item.page ?? item.suggestedPage ?? pages[0] ?? '')
  const [reason, setReason] = useState(item.reason ?? '')
  const [busy, setBusy] = useState(false)
  const [resolutionMode, setResolutionMode] = useState<'link' | 'exclude' | null>(null)
  const run = async (action: string) => {
    setBusy(true)
    try {
      await onResolve(item, action, page, reason)
      setResolutionMode(null)
    } finally { setBusy(false) }
  }
  const needsAttention = item.state === 'uncovered' || item.state === 'needs-human'
  return <article class={`coverage-resolution-item ${item.state} ${selected ? 'selected' : ''}`}>
    <div class="coverage-resolution-item-heading"><span><strong>{item.label}</strong><small>{[item.source, item.path].filter(Boolean).join(' · ') || item.page || 'Priority reader outcome'}</small></span>{needsAttention ? <label class="coverage-update-choice"><input type="checkbox" checked={selected} onChange={(event) => onSelectedChange(event.currentTarget.checked)} /><span>{selected ? 'Added' : 'Add to update'}</span></label> : <Badge tone={item.state === 'documented' ? 'good' : 'neutral'}>{item.state}</Badge>}</div>
    {needsAttention && <div class="coverage-resolution-controls">
      <div class="coverage-alternative-actions"><small>Or resolve without an update</small><span>{pages.length > 0 && <button type="button" aria-expanded={resolutionMode === 'link'} onClick={() => setResolutionMode(resolutionMode === 'link' ? null : 'link')}>Link existing page</button>}{item.surface === 'reader-journeys' ? <button type="button" disabled={busy} onClick={() => void run('remove-priority')}>No longer a priority</button> : <button type="button" aria-expanded={resolutionMode === 'exclude'} onClick={() => setResolutionMode(resolutionMode === 'exclude' ? null : 'exclude')}>Mark as internal</button>}<button type="button" disabled={busy} onClick={() => void run('needs-human')}>Decide later</button></span></div>
      {resolutionMode === 'link' && <div class="coverage-inline-resolution"><Select aria-label={`Page for ${item.label}`} value={page} onChange={(event) => setPage(event.currentTarget.value)}>{pages.map((candidate) => <option key={candidate} value={candidate}>{candidate}{candidate === item.suggestedPage ? ' — suggested' : ''}</option>)}</Select><Button size="sm" disabled={!page || busy} onClick={() => void run('link')}>Link page</Button><button type="button" aria-label="Cancel linking page" onClick={() => setResolutionMode(null)}><Icon name="close" size={14} /></button></div>}
      {resolutionMode === 'exclude' && <div class="coverage-inline-resolution"><Input value={reason} aria-label={`Reason ${item.label} is internal`} placeholder="Why is this not part of the public documentation?" onInput={(event) => setReason(event.currentTarget.value)} /><Button size="sm" disabled={!reason.trim() || busy} onClick={() => void run('exclude')}>Mark internal</Button><button type="button" aria-label="Cancel marking internal" onClick={() => setResolutionMode(null)}><Icon name="close" size={14} /></button></div>}
    </div>}
    {item.state === 'excluded' && <div class="coverage-resolution-actions"><small>{item.reason}</small><Button size="sm" disabled={busy} onClick={() => void run('reset')}>Restore</Button></div>}
  </article>
}

function SourceScopeDialog({ source, act, onClose }: { source: Source; act: Action; onClose: () => void }) {
  const [scope, setScope] = useState({ space: source.scope?.space ?? '', routePrefix: source.scope?.routePrefix ?? '', navigationGroup: source.scope?.navigationGroup ?? '', sharedPages: (source.scope?.sharedPages ?? []).join(', ') })
  const [saving, setSaving] = useState(false)
  const save = async () => {
    setSaving(true)
    try {
      const result = await act(() => patch(`/api/sources/${encodeURIComponent(source.name)}`, { scope: scope.space.trim() || scope.routePrefix.trim() || scope.navigationGroup.trim() || scope.sharedPages.trim() ? { space: scope.space.trim() || undefined, routePrefix: scope.routePrefix.trim() || undefined, navigationGroup: scope.navigationGroup.trim() || undefined, sharedPages: splitComma(scope.sharedPages) } : null }), 'Documentation ownership saved')
      if (result !== undefined) onClose()
    } finally { setSaving(false) }
  }
  return <div class="sources-modal-scrim" onClick={onClose}><section class="sources-reference-dialog source-scope-dialog" role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}><header><span class="sources-dialog-icon"><Icon name="map" size={23} /></span><div><h2>Documentation ownership</h2><p>Keep changes from <strong>{source.name}</strong> inside a clear documentation boundary.</p></div><button type="button" aria-label="Close" onClick={onClose}><Icon name="close" size={17} /></button></header><div class="sources-dialog-body"><div class="form-grid"><Field label="Route prefix" hint="Pages grounded in this source stay below this route."><Input value={scope.routePrefix} placeholder="api or integrations/payments" onInput={(event) => setScope({ ...scope, routePrefix: event.currentTarget.value })} /></Field><Field label="Navigation group"><Input value={scope.navigationGroup} placeholder="API reference" onInput={(event) => setScope({ ...scope, navigationGroup: event.currentTarget.value })} /></Field><Field label="Space"><Input value={scope.space} placeholder="Developers" onInput={(event) => setScope({ ...scope, space: event.currentTarget.value })} /></Field><Field label="Shared pages" hint="Comma-separated paths or globs allowed outside the route."><Input value={scope.sharedPages} placeholder="docs/overview.mdx" onInput={(event) => setScope({ ...scope, sharedPages: event.currentTarget.value })} /></Field></div><Note>Overlapping route prefixes are rejected. Shared pages must be listed explicitly so one source cannot silently rewrite another source’s section.</Note></div><footer><Button onClick={onClose}>Cancel</Button><Button tone="primary" busy={saving} onClick={() => void save()}>Save ownership</Button></footer></section></div>
}

function Authoring({ state, act, streamConnected, onError }: { state: UiState; act: Action; streamConnected: boolean; onError: (error: string) => void }) {
  const hasCompletedRun = documentationExists(state)
  const mode = hasCompletedRun ? 'update' : 'create'
  const pendingSources = state.receipt?.pendingSources ?? []
  const defaultAgent = state.project?.defaultAgent ?? ''
  const defaultModel = defaultModelForAgent(defaultAgent)
  const defaultReasoning = preferredReasoningLevel(defaultAgent, defaultModel)
  // A configured application means the reviewer set it up to be captured;
  // default to screenshots rather than making them opt in on every plan.
  const [form, setForm] = useState({ request: '', scope: 'comprehensive', targetPages: '', clarificationMode: 'review', agent: defaultAgent, model: defaultModel, reasoning: defaultAgent === 'codex' ? defaultReasoning : '', effort: defaultAgent === 'claude' ? defaultReasoning : '', screenshots: (state.project?.application?.baseUrl ? 'enabled' : 'disabled') as 'auto' | 'enabled' | 'disabled' })
  const [showNewPlan, setShowNewPlan] = useState(() => shouldShowAuthoringForm(state))
  const [agentConfigOpen, setAgentConfigOpen] = useState(false)
  const availableAuthorModels = agentModels(form.agent)
  const supportedAuthorReasoning = modelReasoningLevels(form.agent, form.model)
  const [activityOpen, setActivityOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [discovery, setDiscovery] = useState<PlanDiscoverySummary>()
  const [captureReadiness, setCaptureReadiness] = useState<ApplicationReadiness>()
  const runs = state.jobs.filter((job) => job.type.startsWith('plan:') || job.type.startsWith('author:') || job.type === 'capture')
  const activeRun = runs.find((job) => job.status === 'running')
  const currentRun = activeRun ?? runs[0]
  const runBusy = Boolean(activeRun || submitting)
  const visiblePlan = showNewPlan ? undefined : state.documentationPlan

  useEffect(() => {
    if (activeRun) setActivityOpen(true)
  }, [activeRun?.id, activeRun?.status])

  useEffect(() => {
    if (mode !== 'create') {
      setDiscovery(undefined)
      return
    }
    let active = true
    void api<PlanDiscoverySummary>('/api/plans/discovery')
      .then((result) => { if (active && result?.suggestedPages && typeof result.publicSignals === 'number') setDiscovery(result) })
      .catch(() => { /* Planning still performs discovery and will show the exact estimate. */ })
    return () => { active = false }
  }, [mode, state.project?.sources.length])

  useEffect(() => {
    if (form.screenshots === 'disabled') { setCaptureReadiness(undefined); return }
    let active = true
    void api<ApplicationReadiness>('/api/application/readiness')
      .then((result) => { if (active) setCaptureReadiness(result) })
      .catch(() => { if (active) setCaptureReadiness(undefined) })
    return () => { active = false }
  }, [form.screenshots, state.project?.application?.baseUrl])

  useEffect(() => {
    setShowNewPlan(shouldShowAuthoringForm(state))
  }, [state.documentationPlan?.id, state.documentationPlan?.status, state.documentationPlan?.proposalId, validRuns(state.runs).map((run) => `${run.id}:${run.status}`).join('|')])

  const startPlan = async () => {
    if (runBusy) return
    if (form.screenshots === 'enabled' && captureReadiness?.status !== 'ready') {
      onError('Screenshots are selected. Configure and start the application, then wait for the page check to succeed before planning.')
      return
    }
    const { reasoning, effort, targetPages, ...planForm } = form
    const parsedTarget = targetPages.trim() ? Number(targetPages) : undefined
    if (parsedTarget !== undefined && (!Number.isInteger(parsedTarget) || parsedTarget < 1)) {
      onError('Target page count must be a whole number of at least 1.')
      return
    }
    const request = {
      ...planForm,
      scope: mode === 'create' ? form.scope : 'custom',
      ...(parsedTarget !== undefined ? { targetPages: parsedTarget } : {}),
      mode,
      ...(form.agent === 'codex' && reasoning ? { reasoning } : {}),
      ...(form.agent === 'claude' && effort ? { effort } : {}),
    }
    setSubmitting(true)
    setActivityOpen(true)
    try {
      const started = await act(() => post<{ plan: DocumentationPlan; job: UiJob }>('/api/plans', request), 'Planning started')
      if (started) setShowNewPlan(false)
      else setActivityOpen(false)
    } finally {
      setSubmitting(false)
    }
  }

  return <div class="authoring-page">
    <PageHeader
      title={visiblePlan?.status === 'generated' ? 'Documentation proposal' : mode === 'create' ? 'Create documentation' : 'Update documentation'}
      description={visiblePlan?.status === 'generated' ? 'Shape and approve the documentation plan before the agent writes any pages.' : 'Describe the outcome. The agent researches evidence, proposes a plan, and writes nothing until you approve.'}
    />
    {hasCompletedRun && pendingSources.length > 0 && <div class="source-sync-banner">
      <span class="source-sync-icon"><Icon name="sources" size={18} /></span>
      <div>
        <strong>{pendingSources.length === 1 ? `New source “${pendingSources[0]}” was added` : `${pendingSources.length} new sources were added`}</strong>
        <p>The planning agent will inspect {pendingSources.length === 1 ? 'this source' : 'these sources'} and show where the documentation should change.</p>
      </div>
    </div>}

    {visiblePlan
      ? <DocumentationPlanReview plan={visiblePlan} act={act} busy={runBusy} onStartAnother={() => setShowNewPlan(true)} />
      : <div class="authoring-workbench">
        <Panel class="authoring-request">
          <fieldset class="authoring-fields" disabled={runBusy}>
            <div class="authoring-prompt-block">
              <div class="authoring-prompt-title"><span><Icon name="chat" size={18} /></span><div><h2>What should readers be able to do?</h2><p>Describe the outcome or product change. The agent will research the evidence and propose the documentation shape first.</p></div></div>
              <span class="authoring-textarea-wrap"><Textarea rows={6} maxlength={2000} value={form.request} placeholder={mode === 'create' ? 'For example: Help developers install the SDK, authenticate, and complete their first successful API request.' : 'For example: Document API key rotation and update the authentication journey with a TypeScript example.'} onInput={(event) => setForm({ ...form, request: event.currentTarget.value })} /></span>
            </div>
          </fieldset>
          {mode === 'create' && <section class="plan-scope-section" aria-label="Documentation scope">
            <header><span><Icon name="map" size={17} /></span><div><h2>Choose a starting scope</h2><p>You can add, remove, reorder, or defer individual pages after research.</p></div></header>
            <div class="plan-scope-options">
              {([
                ['starter', 'Starter', 'First success path and essential reference'],
                ['standard', 'Standard', 'Primary journeys, concepts, troubleshooting, and reference'],
                ['comprehensive', 'Comprehensive', 'Complete evidence-supported public surface'],
              ] as const).map(([value, label, detail]) => {
                const estimate = discovery?.suggestedPages[value]
                return <button type="button" key={value} class={form.scope === value ? 'active' : ''} aria-pressed={form.scope === value} onClick={() => setForm({ ...form, scope: value })}><span><strong>{label}</strong><small>{detail}</small></span><b>{estimate ? `About ${estimate} pages` : 'Estimating…'}</b></button>
              })}
            </div>
            {discovery && <small class="plan-scope-evidence">Based on {discovery.publicSignals} public source signal{discovery.publicSignals === 1 ? '' : 's'}. Small products stay small; unsupported topics are never added as filler.</small>}
            <div class="plan-target-pages">
              <Field label="Minimum pages to write (optional)" hint="Leave empty to let the evidence decide. There is no upper limit — the planner splits the public surface into as many focused pages as the target needs."><Input type="number" min="1" max="500" value={form.targetPages} placeholder={discovery ? String(discovery.suggestedPages[form.scope as 'starter' | 'standard' | 'comprehensive']) : 'For example: 40'} onInput={(event) => setForm({ ...form, targetPages: event.currentTarget.value })} /></Field>
            </div>
          </section>}
          {mode === 'update' && <section class="plan-scope-section" aria-label="Documentation size">
            <div class="plan-target-pages">
              <Field label="Minimum pages to write (optional)" hint="Ask for a larger update when the existing documentation is thin; the planner adds distinct evidence-backed pages rather than filler."><Input type="number" min="1" max="500" value={form.targetPages} placeholder="For example: 25" onInput={(event) => setForm({ ...form, targetPages: event.currentTarget.value })} /></Field>
            </div>
          </section>}
          <section class="authoring-run-config">
            <button type="button" class="agent-config-summary" aria-expanded={agentConfigOpen} onClick={() => setAgentConfigOpen(!agentConfigOpen)}>
              <Icon name="bot" size={16} />
              <span>Planning agent: <b>{form.agent ? agentLabel(form.agent) : 'Automatically detect'}{form.model ? ` · ${form.model}` : ''}{form.agent === 'codex' && form.reasoning ? ` · ${form.reasoning} reasoning` : form.agent === 'claude' && form.effort ? ` · ${form.effort} effort` : ''}</b></span>
              <strong>{agentConfigOpen ? 'Hide options' : 'Change'}</strong>
            </button>
            {agentConfigOpen && <fieldset class="authoring-options" disabled={runBusy}>
              <Field label="Planning agent"><span class="authoring-control-icon agent"><Icon name="bot" size={16} /><Select value={form.agent} onChange={(event) => {
                const agent = event.currentTarget.value
                const model = defaultModelForAgent(agent)
                const level = preferredReasoningLevel(agent, model)
                setForm({ ...form, agent, model, reasoning: agent === 'codex' ? level : '', effort: agent === 'claude' ? level : '' })
              }}><option value="">Automatically detect</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select></span></Field>
              <Field label="Model"><span class="authoring-control-icon model"><Icon name="sparkle" size={17} /><Combo value={form.model} options={availableAuthorModels.map((model) => [model.id, model.label] as const)} disabled={!form.agent} placeholder="Default model" onValueChange={(value) => setForm({ ...form, model: value })} /></span></Field>
              <Field label={form.agent === 'claude' ? 'Effort' : 'Reasoning'}><span class="authoring-control-icon reasoning"><Icon name="brain" size={17} /><Combo value={form.agent === 'claude' ? form.effort : form.reasoning} options={supportedAuthorReasoning.map((value) => [value, value] as const)} disabled={!form.agent} placeholder="Default" onValueChange={(value) => setForm({ ...form, [form.agent === 'claude' ? 'effort' : 'reasoning']: value })} /></span></Field>
              <Field label="Planner questions"><Select value={form.clarificationMode} onChange={(event) => setForm({ ...form, clarificationMode: event.currentTarget.value })}><option value="review">Ask in review</option><option value="defaults">Use recommendations</option><option value="stop">Always wait for answers</option></Select></Field>
            </fieldset>}
            <section class="screenshot-run-choice" aria-label="Application screenshot behavior">
              <span class="screenshot-camera"><Icon name="camera" size={18} /></span>
              <div><strong>Add product screenshots?</strong><small>Optional. If you choose Yes, Doxloop must capture and verify the planned images before it can finish.</small></div>
              <Segmented value={form.screenshots === 'disabled' ? 'no' : 'yes'} onChange={(value) => setForm({ ...form, screenshots: screenshotIntentFromChoice(value) })} items={[['no', 'No'], ['yes', 'Yes']] as const} />
              {form.screenshots !== 'disabled' && captureReadiness && <small class={`capture-readiness ${captureReadiness.status === 'ready' ? 'ready' : 'missing'}`}><Icon name={captureReadiness.status === 'ready' ? 'check' : 'info'} size={13} />{captureReadiness.message}{!captureReadiness.configured && <> Configure it in <button type="button" onClick={() => { history.pushState({}, '', '/settings'); dispatchEvent(new PopStateEvent('popstate')) }}>Settings</button>.</>}</small>}
            </section>
            <footer><Button disabled={runBusy || (form.screenshots === 'enabled' && captureReadiness?.status !== 'ready')} busy={submitting} tone="primary" icon="sparkle" onClick={() => void startPlan()}>{mode === 'create' ? 'Create documentation plan' : 'Plan documentation update'}</Button><small>{form.screenshots === 'enabled' && captureReadiness?.status !== 'ready' ? 'Start or configure the application before planning with screenshots.' : 'This first run is read-only. It researches sources and existing docs, but cannot write documentation.'}</small></footer>
          </section>
        </Panel>
      </div>}

    {(currentRun || submitting) && <section class={`authoring-action-card activity-card live-activity-card ${activityOpen ? 'open' : ''}`}>
      <button type="button" class="authoring-action-card-head" aria-expanded={activityOpen} onClick={() => setActivityOpen(!activityOpen)}>
        <span class="action-card-icon activity"><Icon name="record" size={19} /></span>
        <span class="action-card-copy"><strong>Live activity</strong><small>{activeRun ? `${streamConnected ? 'Live · ' : ''}${workflowActivityLabel(activeRun.type)}` : submitting ? 'Starting planning agent…' : 'Show the latest workflow log'}</small></span>
        {activeRun && <Badge tone={streamConnected ? 'good' : 'warn'} icon="broadcast">{streamConnected ? 'Live' : 'Reconnecting…'}</Badge>}
        <Icon name="chevronDown" size={17} />
      </button>
      {activityOpen && currentRun && <AuthoringLiveLog job={currentRun} act={act} />}
      {activityOpen && !currentRun && <div class="authoring-live-empty">Starting the planning agent…</div>}
    </section>}
    <Panel class="history-panel" title="Update history" description="A clear record of each documentation action and the instruction behind it.">
      <RequestHistory jobs={state.jobs} onError={onError} />
    </Panel>
  </div>
}

function DocumentationPlanReview({ plan, act, busy, onStartAnother }: { plan: DocumentationPlan; act: Action; busy: boolean; onStartAnother: () => void }) {
  const [draft, setDraft] = useState(plan)
  const [revision, setRevision] = useState('')
  const [clarificationAnswers, setClarificationAnswers] = useState<Record<string, string>>({})
  const [pageFilter, setPageFilter] = useState<PlanPageFilter>('all')
  const [selectedPageId, setSelectedPageId] = useState<string>()
  const [briefOpen, setBriefOpen] = useState(false)
  const [versions, setVersions] = useState<DocumentationPlan[]>([])
  const revisionInput = useRef<HTMLTextAreaElement>(null)
  const [saving, setSaving] = useState(false)
  const [revising, setRevising] = useState(false)
  const [approving, setApproving] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [continuing, setContinuing] = useState<'resume' | 'ignore-errors'>()
  const [captureReadiness, setCaptureReadiness] = useState<ApplicationReadiness>()
  const [captureCheck, setCaptureCheck] = useState<'idle' | 'checking' | 'done' | 'failed'>('idle')
  const [captureCheckNonce, setCaptureCheckNonce] = useState(0)
  useEffect(() => { setDraft(plan); setClarificationAnswers(plan.clarification.answers) }, [plan.id, plan.version, plan.status, plan.updatedAt])
  useEffect(() => {
    let active = true
    if (plan.version <= 1) { setVersions([]); return () => { active = false } }
    void api<DocumentationPlan[]>(`/api/plans/${plan.id}/versions`)
      .then((result) => { if (active) setVersions(result) })
      .catch(() => { if (active) setVersions([]) })
    return () => { active = false }
  }, [plan.id, plan.version, plan.updatedAt])
  const locked = busy || ['planning', 'revising', 'generating'].includes(plan.status)
  const editable = !locked && !['generated', 'cancelled'].includes(plan.status)
  const stale = plan.status === 'stale'
  const changed = editable && planEditableJson(draft) !== planEditableJson(plan)
  const pages = draft.pages.filter((page) => page.priority !== 'later')
  const counts = countPlanPages(pages)
  const screenshotIntent = normalizeUiScreenshotIntent(draft.execution.screenshots)
  const visualPages = pages.filter((page) => page.visuals && page.visuals.mode !== 'none')
  const plannedCaptures = visualPages.reduce((total, page) => total + Math.max(1, page.visuals?.estimatedCaptures ?? 0), 0)
  const captureRequired = screenshotIntent === 'enabled'
  const capturePlanned = screenshotIntent !== 'disabled' && visualPages.length > 0
  const incompleteCapturePages = visualPages.filter((page) =>
    !page.visuals?.startPath?.trim() ||
    !page.visuals?.workflow?.trim() ||
    page.visuals?.captureSequence?.length !== page.visuals?.estimatedCaptures ||
    (page.visuals?.captureSequence ?? []).some((item) => item.trim().length < 20),
  )
  const captureReady = !captureRequired || (captureReadiness?.reachable === true && incompleteCapturePages.length === 0)
  // Name the single thing standing between the reviewer and approval, so a
  // disabled button is never a dead end.
  const approvalBlocker = draft.questions.length > 0
    ? 'Resolve the required questions before approval.'
    : changed
      ? 'Save your direct edits, then approve the updated plan.'
      : captureRequired && visualPages.length === 0
        ? 'Screenshots are required, but no page plans one. Add a guide, or change this run to Automatic.'
        : captureRequired && incompleteCapturePages.length > 0
          ? `Complete the capture details for ${incompleteCapturePages.map((page) => page.title).join(', ')} before approval.`
          : captureRequired && captureCheck === 'checking'
            ? 'Checking that the application is reachable…'
            : captureRequired && !captureReadiness
              ? 'Screenshots are required, but Doxloop could not check the application. Start it, then choose Check again.'
              : captureRequired && captureReadiness?.reachable !== true
                ? `Screenshots are required, but the application is not reachable. ${captureReadiness?.message ?? ''}`.trim()
                : undefined
  const approvalControls = planApprovalControls({
    changed,
    busy,
    hasPages: draft.pages.length > 0,
    hasQuestions: draft.questions.length > 0,
    captureRequired,
    hasVisualPages: visualPages.length > 0,
    captureReady,
  })
  const groupedPages = groupPlanPages(pages, pageFilter)
  const selectedIndex = selectedPageId ? pages.findIndex((page) => page.id === selectedPageId) : -1
  const selectedPage = selectedIndex >= 0 ? pages[selectedIndex] : undefined
  const generationTarget = counts.pagesToWrite > 0
    ? `${counts.pagesToWrite} page${counts.pagesToWrite === 1 ? '' : 's'}`
    : 'documentation changes'
  const previousVersion = versions.find((version) => version.version < plan.version)
  const versionChanges = previousVersion ? comparePlanVersions(previousVersion, plan) : undefined
  const unresolvedCapabilities = draft.capabilities.filter((capability) => capability.disposition === 'needs-human').length
  useEffect(() => {
    if (screenshotIntent === 'disabled') { setCaptureReadiness(undefined); setCaptureCheck('idle'); return }
    let active = true
    setCaptureCheck('checking')
    void api<ApplicationReadiness>('/api/application/readiness')
      .then((result) => { if (active) { setCaptureReadiness(result); setCaptureCheck('done') } })
      .catch(() => { if (active) { setCaptureReadiness(undefined); setCaptureCheck('failed') } })
    return () => { active = false }
  }, [screenshotIntent, captureCheckNonce])
  // The application is often started after the plan is already on screen, so
  // re-check when the reviewer returns to the tab rather than stranding them
  // behind a disabled button until a full reload.
  useEffect(() => {
    if (screenshotIntent === 'disabled') return
    const recheck = () => { if (document.visibilityState === 'visible') setCaptureCheckNonce((value) => value + 1) }
    addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    return () => { removeEventListener('focus', recheck); document.removeEventListener('visibilitychange', recheck) }
  }, [screenshotIntent])
  const setPage = (index: number, value: DocumentationPlanPage) => setDraft({ ...draft, scope: 'custom', pages: pages.map((page, item) => item === index ? value : page) })
  const movePage = (index: number, offset: -1 | 1) => {
    const target = index + offset
    if (target < 0 || target >= pages.length) return
    const next = [...pages]
    const [page] = next.splice(index, 1)
    next.splice(target, 0, page!)
    setDraft({ ...draft, scope: 'custom', pages: next })
  }
  const addPage = () => {
    const page = newPlanPage(pages.length)
    setDraft({ ...draft, scope: 'custom', pages: [...pages, page] })
    setSelectedPageId(page.id)
  }
  const removePage = (index: number) => {
    const removed = pages[index]
    const capabilities = removed ? draft.capabilities.map((capability) => {
      const pageIds = capability.pageIds.filter((id) => id !== removed.id)
      return { ...capability, pageIds, disposition: pageIds.length === 0 && (capability.disposition === 'planned' || capability.disposition === 'existing') ? 'excluded' as const : capability.disposition }
    }) : draft.capabilities
    setDraft({ ...draft, scope: 'custom', pages: pages.filter((_, item) => item !== index), capabilities })
    setSelectedPageId(undefined)
  }
  const continueWithClarifications = async (useRecommendations = false) => {
    setRevising(true)
    try {
      await act(() => post<UiJob>(`/api/plans/${plan.id}/clarify`, { answers: clarificationAnswers, useRecommendations }), 'Continuing documentation plan')
    } finally { setRevising(false) }
  }
  // Keep the proposed structure and refresh the evidence snapshot, so an
  // unrelated code edit does not force the reviewer through planning again.
  const resume = async () => {
    setResuming(true)
    try {
      await act(() => post<DocumentationPlan>(`/api/plans/${plan.id}/resume`), 'Continuing with the current plan')
    } finally { setResuming(false) }
  }
  const save = async () => {
    setSaving(true)
    try {
      const updated = await act(() => patch<DocumentationPlan>(`/api/plans/${plan.id}`, planEditablePayload(draft)), 'Plan changes saved')
      if (updated) setDraft(updated)
    } finally { setSaving(false) }
  }
  const revise = async () => {
    if (!revision.trim()) return
    setRevising(true)
    try {
      const result = await act(() => post<UiJob>(`/api/plans/${plan.id}/revise`, { feedback: revision }), 'Plan revision started')
      if (result) setRevision('')
    } finally { setRevising(false) }
  }
  // Pick the failed run up where it stopped. Resuming restarts the agent in
  // the preserved workspace with everything it already wrote and captured;
  // ignoring problems accepts that workspace for review as it is.
  const continueFailed = async (strategy: 'resume' | 'ignore-errors') => {
    setContinuing(strategy)
    try {
      await act(
        () => post<{ plan?: DocumentationPlan; job?: UiJob }>(`/api/plans/${plan.id}/continue`, { strategy }),
        strategy === 'resume' ? 'Continuing the documentation run' : 'Continuing with the work already done',
      )
    } finally { setContinuing(undefined) }
  }
  const approveAndGenerate = async () => {
    setApproving(plan.status !== 'approved')
    try {
      if (plan.status !== 'approved') {
        const approved = await act(() => post<DocumentationPlan>(`/api/plans/${plan.id}/approve`), 'Plan approved')
        if (!approved) return
      }
      setGenerating(true)
      await act(() => post<UiJob>(`/api/plans/${plan.id}/generate`), 'Documentation generation started')
    } finally {
      setApproving(false)
      setGenerating(false)
    }
  }
  useEffect(() => {
    if (selectedPageId && !pages.some((page) => page.id === selectedPageId)) setSelectedPageId(undefined)
  }, [selectedPageId, pages])
  useEffect(() => {
    if (!selectedPageId) return
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelectedPageId(undefined) }
    addEventListener('keydown', close)
    return () => removeEventListener('keydown', close)
  }, [selectedPageId])
  if (plan.status === 'generated') return <Panel class="plan-complete-panel">
    <div class="plan-complete"><span><Icon name="check" size={24} /></span><div><h2>Documentation proposal is ready</h2><p>The approved plan was generated in an isolated workspace. Reader-facing files are still unchanged until you review and accept them.</p></div></div>
    <div class="plan-complete-actions"><Button onClick={onStartAnother}>Plan another update</Button><Button tone="primary" icon="proposals" onClick={() => { history.pushState({}, '', '/proposals'); dispatchEvent(new PopStateEvent('popstate')) }}>Review generated files</Button></div>
  </Panel>
  return <div class="documentation-plan-review">
    <section class="plan-review-header">
      <div class="plan-review-heading">
        <span class="plan-review-summary-icon"><Icon name="map" size={18} /></span>
        <div class="plan-review-heading-copy">
          <small>Documentation plan · Version {plan.version}</small>
          <h2>Review documentation structure</h2>
          <div class="plan-review-change-summary" aria-label="Documentation changes">
            {counts.create > 0 && <span class="create"><i />{counts.create} new</span>}
            {counts.update > 0 && <span class="update"><i />{counts.update} updated</span>}
            {counts.remove > 0 && <span class="remove"><i />{counts.remove} deleted</span>}
            {counts.preserve > 0 && <span class="preserve"><i />{counts.preserve} unchanged</span>}
            {plannedCaptures > 0 && <span class="visual"><Icon name="camera" size={12} />{plannedCaptures} screenshot{plannedCaptures === 1 ? '' : 's'}</span>}
          </div>
        </div>
      </div>
      <div class="plan-review-actions"><Badge tone={statusTone(plan.status)}>{statusLabel(plan.status)}</Badge>{editable && <Button size="sm" tone="ghost" onClick={() => setBriefOpen(!briefOpen)}>{briefOpen ? 'Close details' : 'Plan details'}</Button>}</div>
    </section>
    {stale && <Panel class="plan-stale-panel" title="Sources changed since this plan was proposed" description="The plan itself is unchanged and can be approved as it is; generation reads the current sources when it writes each page. Ask the agent to revise only if the change should alter which pages are written.">
      <footer class="plan-stale-actions"><Button size="sm" icon="refresh" busy={resuming} disabled={busy} onClick={() => void resume()}>Clear this notice</Button><Button size="sm" icon="wand" disabled={busy} onClick={() => revisionInput.current?.focus()}>Ask the agent to revise</Button></footer>
    </Panel>}
    {plan.error && !stale && <Note tone="bad">{plan.error}</Note>}
    {plan.status === 'failed' && plan.failure && (plan.failure.resumable || plan.failure.ignorable) && <Panel class="plan-recovery-panel" title="Continue without starting over" description={plan.failure.stage === 'generate'
      ? 'The pages and screenshots the agent already produced are preserved in this run\u2019s workspace. Continue from there instead of paying for another full run.'
      : 'The planner proposed a plan but could not meet every planning gate. You can review and edit that plan yourself instead of running the planner again.'}>
      <ul class="plan-recovery-options">
        {plan.failure.stage === 'generate' && plan.failure.resumable && <li><strong>Resume the run</strong><span>Starts the agent again in the same workspace with a brief of what is finished. Verified screenshots and completed pages are kept; only the unfinished or rejected parts are redone.</span></li>}
        {plan.failure.stage === 'generate' && plan.failure.ignorable && <li><strong>Ignore the problems</strong><span>Accepts the generated files for review now. Each screenshot problem is recorded on its step as text-only and listed on the proposal so you can judge it before publishing.</span></li>}
        {plan.failure.stage !== 'generate' && <li><strong>Review this plan anyway</strong><span>Opens the plan the planner left behind. The unmet gate becomes a note on the review, and approval still checks required screenshots and open questions.</span></li>}
      </ul>
      {plan.failure.stage === 'generate' && plan.failure.proposalId && <section class="plan-recovery-captures" aria-label="Screenshots already captured">
        <h3>Screenshots already captured</h3>
        <p>These images are kept by both choices below. Resume recaptures only the states that are still missing.</p>
        <CaptureGallery live={false} run={plan.failure.proposalId} />
      </section>}
      <footer class="plan-recovery-actions">
        {plan.failure.stage === 'generate' && plan.failure.resumable && <Button tone="primary" icon="play" busy={continuing === 'resume'} disabled={busy || Boolean(continuing)} onClick={() => void continueFailed('resume')}>Resume generation</Button>}
        {plan.failure.stage === 'generate' && plan.failure.ignorable && <Button icon="check" busy={continuing === 'ignore-errors'} disabled={busy || Boolean(continuing)} onClick={() => void continueFailed('ignore-errors')}>Ignore problems & continue</Button>}
        {plan.failure.stage !== 'generate' && plan.failure.ignorable && <Button tone="primary" icon="check" busy={continuing === 'ignore-errors'} disabled={busy || Boolean(continuing)} onClick={() => void continueFailed('ignore-errors')}>Review this plan anyway</Button>}
        <small>{plan.failure.stage === 'generate' ? `“Retry generating” below starts a new run from the approved plan${plan.failure.resumable ? ' only if this workspace can no longer be reused' : ''}.` : 'Or ask the agent to revise the plan below, which runs the planner again.'}</small>
      </footer>
    </Panel>}
    {locked && <Panel class="plan-progress-panel"><div class="plan-progress"><span class="spinner" /><div><strong>{plan.status === 'generating' ? 'Generating the approved documentation' : plan.status === 'revising' ? 'Revising the documentation plan' : 'Researching sources and existing documentation'}</strong><p>You can follow the activity log below. The documentation project remains unchanged during planning.</p></div></div></Panel>}
    {!locked && <>
      {draft.questions.length > 0 && <Panel class="plan-questions" title={`Needs your decision (${draft.questions.length})`} description="Resolve these choices before approving the plan.">
        {draft.questions.map((question) => <article key={question.id}><span><Icon name="help" size={16} /></span><div><strong>{question.question}</strong><p>{question.whyItMatters}</p>{question.recommendation && <small>Recommended: {question.recommendation}</small>}<Input value={clarificationAnswers[question.id] ?? ''} placeholder={question.recommendation ?? 'Enter your decision'} onInput={(event) => setClarificationAnswers({ ...clarificationAnswers, [question.id]: event.currentTarget.value })} /></div>{question.recommendation && (clarificationAnswers[question.id]?.trim() === question.recommendation.trim()
          ? <Button size="sm" tone="ghost" icon="check" disabled>Recommendation applied</Button>
          : <Button size="sm" tone="ghost" onClick={() => setClarificationAnswers({ ...clarificationAnswers, [question.id]: question.recommendation! })}>Use recommendation</Button>)}</article>)}
        <footer><Button size="sm" disabled={busy || !draft.questions.every((question) => question.recommendation)} onClick={() => void continueWithClarifications(true)}>Use all recommendations</Button><Button size="sm" tone="primary" busy={revising} disabled={busy || !draft.questions.every((question) => clarificationAnswers[question.id]?.trim())} onClick={() => void continueWithClarifications()}>Continue planning</Button></footer>
      </Panel>}
      {briefOpen && <Panel class="plan-brief-panel" title="Documentation brief" description="These choices guide every page. Technical guidance stays here instead of crowding the page outline.">
        <div class="plan-brief-summary"><strong>Agent summary</strong><p>{plan.summary || 'No additional summary was provided.'}</p></div>
        <section class="plan-coverage-summary"><header><div><strong>Evidence coverage</strong><small>{draft.discovery.publicSignals} deterministic public signals inspected</small></div><span>{draft.capabilities.filter((capability) => capability.disposition === 'planned' || capability.disposition === 'existing').length} mapped</span></header>{draft.capabilities.length > 0 ? <ul>{draft.capabilities.map((capability, index) => <li key={capability.id}><span><b>{capability.title}</b><small>{capability.kind}</small></span>{editable ? <Select aria-label={`Coverage decision for ${capability.title}`} value={capability.disposition} onChange={(event) => setDraft({ ...draft, scope: 'custom', capabilities: draft.capabilities.map((candidate, item) => item === index ? { ...candidate, disposition: event.currentTarget.value as typeof candidate.disposition } : candidate) })}><option value="planned">Document</option><option value="existing">Existing documentation</option><option value="excluded">Exclude as internal</option><option value="needs-human">Decide later</option></Select> : <em class={capability.disposition}>{capability.disposition === 'needs-human' ? 'Needs decision' : capability.disposition}</em>}</li>)}</ul> : <p>No capability map was returned for this plan.</p>}</section>
        {versionChanges && <section class="plan-version-summary"><header><strong>Changed since version {previousVersion!.version}</strong><small>Version {plan.version}</small></header><div>{versionChanges.added.length > 0 && <span class="create">+ {versionChanges.added.length} page{versionChanges.added.length === 1 ? '' : 's'}</span>}{versionChanges.changed.length > 0 && <span class="update">{versionChanges.changed.length} edited</span>}{versionChanges.removed.length > 0 && <span class="remove">− {versionChanges.removed.length} removed</span>}{versionChanges.briefChanged && <span>Brief updated</span>}</div><details><summary>See version changes</summary><ul>{versionChanges.added.map((title) => <li key={`add-${title}`}>Added “{title}”</li>)}{versionChanges.changed.map((title) => <li key={`change-${title}`}>Changed “{title}”</li>)}{versionChanges.removed.map((title) => <li key={`remove-${title}`}>Removed “{title}”</li>)}</ul></details></section>}
        <div class="form-grid">
          <Field label="Audiences" hint="Comma-separated"><Input disabled={!editable} value={draft.audiences.join(', ')} onInput={(event) => setDraft({ ...draft, scope: 'custom', audiences: splitComma(event.currentTarget.value) })} /></Field>
          <Field label="Reader outcomes" hint="Comma-separated"><Input disabled={!editable} value={draft.outcomes.join(', ')} onInput={(event) => setDraft({ ...draft, scope: 'custom', outcomes: splitComma(event.currentTarget.value) })} /></Field>
          <Field label="Reader experience"><Select disabled={!editable} value={draft.experienceLevel} onChange={(event) => setDraft({ ...draft, scope: 'custom', experienceLevel: event.currentTarget.value as DocumentationPlan['experienceLevel'] })}><option value="beginner">New to the product</option><option value="intermediate">Some experience</option><option value="advanced">Experienced</option><option value="mixed">Mixed audience</option></Select></Field>
          <Field label="Preferred examples" hint="Comma-separated languages or tools"><Input disabled={!editable} value={draft.preferredExamples.join(', ')} onInput={(event) => setDraft({ ...draft, scope: 'custom', preferredExamples: splitComma(event.currentTarget.value) })} /></Field>
          <Field label="Locale"><Input disabled={!editable} value={draft.locale} onInput={(event) => setDraft({ ...draft, scope: 'custom', locale: event.currentTarget.value })} /></Field>
          <Field label="Accessibility target"><Input disabled={!editable} value={draft.accessibilityTarget} onInput={(event) => setDraft({ ...draft, scope: 'custom', accessibilityTarget: event.currentTarget.value })} /></Field>
          <Field label="Style guide"><Input disabled={!editable} value={draft.styleGuide} onInput={(event) => setDraft({ ...draft, scope: 'custom', styleGuide: event.currentTarget.value })} /></Field>
          <Field label="Terminology" hint="One preferred term = guidance per line"><Textarea disabled={!editable} rows={3} value={termText(draft.terminology)} onInput={(event) => setDraft({ ...draft, scope: 'custom', terminology: parseTerms(event.currentTarget.value) })} /></Field>
          <Field label="Exclusions" hint="Comma-separated"><Textarea disabled={!editable} rows={3} value={draft.exclusions.join(', ')} onInput={(event) => setDraft({ ...draft, scope: 'custom', exclusions: splitComma(event.currentTarget.value) })} /></Field>
        </div>
        <Field label="Plan-wide instructions"><Textarea disabled={!editable} rows={3} value={draft.instructions} onInput={(event) => setDraft({ ...draft, scope: 'custom', instructions: event.currentTarget.value })} /></Field>
      </Panel>}
      <Panel class="plan-screenshot-panel" title="Application screenshots" description="Review what the agent will capture before any application is opened.">
        <div class="plan-screenshot-summary">
          <span class="screenshot-camera"><Icon name="camera" size={18} /></span>
          <div><strong>{plannedCaptures > 0 ? `${plannedCaptures} meaningful screenshot candidate${plannedCaptures === 1 ? '' : 's'} across ${visualPages.length} guide${visualPages.length === 1 ? '' : 's'}` : 'No application screenshots planned'}</strong><small>{plannedCaptures > 0 ? 'Doxloop supplies the capture browser. Automatic mode captures the useful states it can verify; required mode enforces every approved image.' : 'API, CLI, reference, and conceptual pages remain text-first.'}</small></div>
          <Select disabled={!editable} value={screenshotIntent} onChange={(event) => { const screenshots = event.currentTarget.value as 'auto' | 'enabled' | 'disabled'; setDraft({ ...draft, execution: { ...draft.execution, screenshots }, pages: draft.pages.map((page) => !page.visuals || page.visuals.mode === 'none' ? page : { ...page, visuals: { ...page.visuals, mode: screenshots === 'enabled' ? 'required' as const : screenshots === 'auto' ? 'recommended' as const : page.visuals.mode } }) }) }}><option value="auto">Automatic</option><option value="enabled">Require screenshots</option><option value="disabled">No screenshots</option></Select>
        </div>
        {screenshotIntent !== 'disabled' && <div class={`plan-capture-readiness ${captureReadiness?.reachable ? 'ready' : 'missing'}`}>
          <Icon name={captureReadiness?.reachable ? 'check' : 'info'} size={15} />
          <span>
            <strong>{captureCheck === 'checking' ? 'Checking the application…' : !captureReadiness ? 'Application check did not complete' : captureReadiness.status === 'authentication-required' ? 'Sign-in may be required during capture' : captureReadiness.reachable ? 'Application reachable' : 'Application setup needed'}</strong>
            <small>{captureReadiness?.message ?? (captureCheck === 'checking' ? 'Confirming the configured application answers before capture.' : 'Doxloop could not reach the readiness check. Start the application, then check again.')}</small>
          </span>
          {captureReadiness?.configured === false
            ? <Button size="sm" onClick={() => { history.pushState({}, '', '/settings'); dispatchEvent(new PopStateEvent('popstate')) }}>Configure application</Button>
            : <Button size="sm" icon="refresh" busy={captureCheck === 'checking'} onClick={() => setCaptureCheckNonce((value) => value + 1)}>Check again</Button>}
        </div>}
        {visualPages.length > 0 && <ul class="plan-screenshot-pages">{visualPages.map((page) => <li key={page.id}><span><strong>{page.title}</strong><small>{page.visuals?.startPath ? `${page.visuals.startPath} · ${page.visuals.rationale}` : `Starting route needed · ${page.visuals?.rationale}`}</small></span><b>{page.visuals?.estimatedCaptures} {screenshotIntent === 'enabled' ? 'required' : 'candidate'}</b></li>)}</ul>}
        {screenshotIntent === 'enabled' && visualPages.length === 0 && <Note tone="bad">Required screenshot mode needs at least one visible UI guide. Open a page and choose “Require screenshots,” or change this run to Automatic.</Note>}
        {plan.advisories?.map((advisory) => <Note key={advisory} tone="info">{advisory}</Note>)}
        {capturePlanned && incompleteCapturePages.length > 0 && <Note tone={captureRequired ? 'bad' : 'info'}>{captureRequired ? 'Add' : 'For better automatic capture, add'} a starting route, capture workflow, and one meaningful capture-sequence line per planned screenshot for {incompleteCapturePages.map((page) => page.title).join(', ')}{captureRequired ? ' before approval.' : '. Documentation generation can continue if those optional captures are skipped.'}</Note>}
      </Panel>
      <Panel class="plan-pages-panel" title="Documentation structure" description={`${pages.length} pages · ${counts.activeChanges} changed`} actions={editable && <Button size="sm" icon="plus" onClick={addPage}>Add page</Button>}>
        <div class="plan-page-filters" role="tablist" aria-label="Filter documentation pages">
          <button type="button" role="tab" aria-selected={pageFilter === 'all'} class={pageFilter === 'all' ? 'active' : ''} onClick={() => setPageFilter('all')}>All pages</button>
          <button type="button" role="tab" aria-selected={pageFilter === 'changes'} class={pageFilter === 'changes' ? 'active' : ''} onClick={() => setPageFilter('changes')}>Changes</button>
          <button type="button" role="tab" aria-selected={pageFilter === 'create'} class={pageFilter === 'create' ? 'active' : ''} onClick={() => setPageFilter('create')}>New</button>
          <button type="button" role="tab" aria-selected={pageFilter === 'update'} class={pageFilter === 'update' ? 'active' : ''} onClick={() => setPageFilter('update')}>Updated</button>
          <button type="button" role="tab" aria-selected={pageFilter === 'preserve'} class={pageFilter === 'preserve' ? 'active' : ''} onClick={() => setPageFilter('preserve')}>Unchanged</button>
          {counts.remove > 0 && <button type="button" role="tab" aria-selected={pageFilter === 'remove'} class={pageFilter === 'remove' ? 'active' : ''} onClick={() => setPageFilter('remove')}>Deleted</button>}
        </div>
        <div class="plan-page-outline">
          {groupedPages.length > 0 && <div class="plan-tree-sections">{groupedPages.map((group) => <section class="plan-tree-section" key={group.id}>
            <header><span class="plan-tree-folder"><Icon name="folder" size={16} /></span><div><strong>{group.title}</strong><small>{group.pages.length} page{group.pages.length === 1 ? '' : 's'}</small></div></header>
            <div class="plan-tree-pages">{group.pages.map(({ page, index }) => <button type="button" class={`plan-tree-page ${page.action} ${page.priority}`} key={page.id} title={page.path} onClick={() => setSelectedPageId(page.id)}>
              <span class="plan-tree-file"><Icon name="file" size={15} /></span>
              <span class="plan-page-copy"><span class="plan-page-title-line"><strong>{page.title}</strong><span class={`plan-page-action ${page.action}`}>{planActionLabel(page.action)}</span></span></span>
              <Icon name="chevronRight" size={15} />
            </button>)}</div>
          </section>)}</div>}
          {groupedPages.length === 0 && <div class="plan-page-empty"><Icon name="file" size={20} /><strong>No pages in this view</strong><p>Choose another filter or add a page to the plan.</p></div>}
        </div>
      </Panel>
      <Panel class="plan-revision-panel" title="Want to change the plan?" description="Tell the agent what you want in normal language. The revised plan will return as a new version.">
        <Textarea ref={revisionInput} disabled={busy} rows={3} maxlength={1500} value={revision} placeholder="For example: Combine the two example pages, focus the quickstart on beginners, and add a migration guide." onInput={(event) => setRevision(event.currentTarget.value)} />
        <div class="plan-revision-actions">{changed && <small>Save your direct edits before asking the agent to revise the plan.</small>}<Button disabled={!revision.trim() || busy || changed} busy={revising} icon="wand" onClick={() => void revise()}>Update plan</Button></div>
      </Panel>
      <footer class="plan-approval-bar">
        <span><Icon name={approvalBlocker ? 'help' : 'lock'} size={16} /><small>{approvalBlocker ?? (unresolvedCapabilities > 0 ? `${unresolvedCapabilities} coverage ${unresolvedCapabilities === 1 ? 'item needs' : 'items need'} a decision; you can save and continue if intentionally deferred.` : 'Nothing will be written until you approve this exact plan.')}</small></span>
        <div>{approvalControls.showSave && <Button busy={saving} onClick={() => void save()}>Save changes</Button>}<Button tone="primary" icon={changed ? 'lock' : 'play'} busy={approving || generating} disabled={approvalControls.approveDisabled} onClick={() => void approveAndGenerate()}>{changed ? 'Save changes before approval' : plan.status === 'approved' ? `Generate ${generationTarget}` : plan.status === 'failed' ? `Retry generating ${generationTarget}` : `Approve & generate ${generationTarget}`}</Button></div>
      </footer>
      {selectedPage && <div class="plan-page-drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setSelectedPageId(undefined) }}>
        <aside class="plan-page-drawer" role="dialog" aria-modal="true" aria-labelledby="plan-page-drawer-title">
          <header><div><small>Page {selectedIndex + 1} of {pages.length}</small><h2 id="plan-page-drawer-title">Page details</h2></div><button type="button" aria-label="Close page details" onClick={() => setSelectedPageId(undefined)}><Icon name="close" size={18} /></button></header>
          <div class="plan-page-drawer-body">
            <div class="plan-page-drawer-name"><Input disabled={!editable} value={selectedPage.title} aria-label="Page title" onInput={(event) => setPage(selectedIndex, { ...selectedPage, title: event.currentTarget.value })} /><span class={`plan-page-action ${selectedPage.action}`}>{planActionLabel(selectedPage.action)}</span></div>
            <Field label="Purpose"><Textarea disabled={!editable} rows={4} value={selectedPage.purpose} onInput={(event) => setPage(selectedIndex, { ...selectedPage, purpose: event.currentTarget.value })} /></Field>
            <div class="plan-page-drawer-grid">
              <Field label="What should happen"><Select disabled={!editable} value={selectedPage.action} onChange={(event) => setPage(selectedIndex, { ...selectedPage, action: event.currentTarget.value as DocumentationPlanPage['action'] })}><option value="create">Create this page</option><option value="update">Update this page</option><option value="preserve">Leave unchanged</option><option value="remove">Delete existing page</option></Select></Field>
              <Field label="Priority in this generation"><Select disabled={!editable} value={selectedPage.priority} onChange={(event) => setPage(selectedIndex, { ...selectedPage, priority: event.currentTarget.value as DocumentationPlanPage['priority'] })}><option value="must-have">Essential</option><option value="next">Recommended</option></Select></Field>
            </div>
            <Field label="Documentation section"><Input disabled={!editable} value={selectedPage.type} onInput={(event) => setPage(selectedIndex, { ...selectedPage, type: event.currentTarget.value })} /></Field>
            <section class="plan-page-visuals">
              <h3>Application screenshots</h3>
              <div class="plan-page-drawer-grid">
                <Field label="Visual treatment"><Select disabled={!editable || screenshotIntent === 'disabled'} value={selectedPage.visuals?.mode ?? 'none'} onChange={(event) => {
                  const mode = event.currentTarget.value as 'none' | 'recommended' | 'required'
                  const enabling = mode !== 'none' && (selectedPage.visuals?.mode ?? 'none') === 'none'
                  const estimatedCaptures = mode === 'none' ? 0 : Math.max(minimumUiPlannedCaptures(selectedPage.type, mode), selectedPage.visuals?.estimatedCaptures ?? 0)
                  setPage(selectedIndex, { ...selectedPage, visuals: {
                    mode,
                    rationale: enabling ? '' : selectedPage.visuals?.rationale ?? '',
                    estimatedCaptures,
                    ...(mode !== 'none' && selectedPage.visuals?.startPath ? { startPath: selectedPage.visuals.startPath } : {}),
                    ...(mode !== 'none' && selectedPage.visuals?.workflow ? { workflow: selectedPage.visuals.workflow } : {}),
                    ...(mode !== 'none' && selectedPage.visuals?.captureSequence ? { captureSequence: selectedPage.visuals.captureSequence } : {}),
                  } })
                }}><option value="none">Text only</option><option value="recommended">Capture when ready</option><option value="required">Require screenshots</option></Select></Field>
                <Field label={selectedPage.visuals?.mode === 'required' || screenshotIntent === 'enabled' ? 'Required captures' : 'Planned captures'}><Input disabled={!editable || screenshotIntent === 'disabled' || (selectedPage.visuals?.mode ?? 'none') === 'none'} type="number" min={minimumUiPlannedCaptures(selectedPage.type, selectedPage.visuals?.mode ?? 'recommended')} max="20" value={selectedPage.visuals?.estimatedCaptures ?? 0} onInput={(event) => { const mode = selectedPage.visuals?.mode ?? 'recommended'; setPage(selectedIndex, { ...selectedPage, visuals: { ...selectedPage.visuals, mode, rationale: selectedPage.visuals?.rationale ?? '', estimatedCaptures: Math.max(minimumUiPlannedCaptures(selectedPage.type, mode), Math.min(20, Number(event.currentTarget.value) || 1)) } }) }} /></Field>
              </div>
              <Field label="Starting route" hint="Relative to the configured application URL"><Input disabled={!editable || screenshotIntent === 'disabled' || (selectedPage.visuals?.mode ?? 'none') === 'none'} value={selectedPage.visuals?.startPath ?? ''} placeholder="/settings/team" onInput={(event) => setPage(selectedIndex, { ...selectedPage, visuals: { ...selectedPage.visuals, mode: selectedPage.visuals?.mode ?? 'recommended', rationale: selectedPage.visuals?.rationale ?? '', estimatedCaptures: Math.max(1, selectedPage.visuals?.estimatedCaptures ?? 1), startPath: event.currentTarget.value } })} /></Field>
              <Field label="Capture workflow" hint="Include the safe test state and ordered actions"><Textarea disabled={!editable || screenshotIntent === 'disabled' || (selectedPage.visuals?.mode ?? 'none') === 'none'} rows={4} value={selectedPage.visuals?.workflow ?? ''} placeholder="Use the demo workspace. Open Team settings, invite a synthetic member, and verify the invitation state." onInput={(event) => setPage(selectedIndex, { ...selectedPage, visuals: { ...selectedPage.visuals, mode: selectedPage.visuals?.mode ?? 'recommended', rationale: selectedPage.visuals?.rationale ?? '', estimatedCaptures: Math.max(1, selectedPage.visuals?.estimatedCaptures ?? 1), workflow: event.currentTarget.value } })} /></Field>
              <Field label="Capture sequence" hint="One screenshot per line: action — visible state — why it helps"><Textarea disabled={!editable || screenshotIntent === 'disabled' || (selectedPage.visuals?.mode ?? 'none') === 'none'} rows={Math.max(4, Math.min(8, selectedPage.visuals?.estimatedCaptures ?? 4))} value={(selectedPage.visuals?.captureSequence ?? []).join('\n')} placeholder={'Open Team settings — Team settings heading and navigation are visible — orients the reader\nSelect Invite member — the empty invitation form is open — confirms where data is entered\nSubmit the demo invitation — success confirmation is visible — proves completion'} onInput={(event) => { const captureSequence = event.currentTarget.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); const mode = selectedPage.visuals?.mode ?? 'recommended'; setPage(selectedIndex, { ...selectedPage, visuals: { ...selectedPage.visuals, mode, rationale: selectedPage.visuals?.rationale ?? '', estimatedCaptures: Math.max(minimumUiPlannedCaptures(selectedPage.type, mode), captureSequence.length), captureSequence } }) }} /></Field>
              <Field label="Why images help"><Textarea disabled={!editable || screenshotIntent === 'disabled' || (selectedPage.visuals?.mode ?? 'none') === 'none'} rows={3} value={selectedPage.visuals?.rationale ?? ''} placeholder="Show the complete invitation journey so readers can verify each meaningful state." onInput={(event) => setPage(selectedIndex, { ...selectedPage, visuals: { ...selectedPage.visuals, mode: selectedPage.visuals?.mode ?? 'recommended', estimatedCaptures: Math.max(1, selectedPage.visuals?.estimatedCaptures ?? 1), rationale: event.currentTarget.value } })} /></Field>
            </section>
            <section class="plan-page-reason"><h3>Why the agent recommends this page</h3><p>{selectedPage.rationale || 'No rationale was provided for this page.'}</p>{selectedPage.evidenceDetails.length > 0 ? <details><summary>View {selectedPage.evidenceDetails.length} supporting source{selectedPage.evidenceDetails.length === 1 ? '' : 's'}</summary><div class="plan-evidence-list">{selectedPage.evidenceDetails.map((item, index) => <article key={`${item.source}-${item.path}-${index}`}><span>{item.source}</span><div><code>{item.path}{item.line ? `:${item.line}` : ''}</code>{(item.label || item.kind) && <small>{item.label ?? item.kind}</small>}</div></article>)}</div></details> : selectedPage.evidence.length > 0 && <details><summary>View {selectedPage.evidence.length} supporting source{selectedPage.evidence.length === 1 ? '' : 's'}</summary><ul>{selectedPage.evidence.map((item) => <li key={item}><code>{item}</code></li>)}</ul></details>}</section>
            <details class="plan-page-advanced"><summary>Advanced settings</summary><div><Field label="File path"><Input disabled={!editable} class="mono" value={selectedPage.path} onInput={(event) => setPage(selectedIndex, { ...selectedPage, path: event.currentTarget.value })} /></Field><small>The documentation section and file path are primarily used by the generator.</small></div></details>
          </div>
          <footer><div class="plan-page-move"><Button size="sm" disabled={!editable || selectedIndex === 0} onClick={() => movePage(selectedIndex, -1)}>Move up</Button><Button size="sm" disabled={!editable || selectedIndex === pages.length - 1} onClick={() => movePage(selectedIndex, 1)}>Move down</Button></div>{editable && <Button size="sm" tone="danger" icon="trash" onClick={() => removePage(selectedIndex)}>Remove page</Button>}<Button size="sm" tone="primary" onClick={() => setSelectedPageId(undefined)}>Done</Button></footer>
        </aside>
      </div>}
    </>}
  </div>
}

function newPlanPage(index: number): DocumentationPlanPage {
  return { id: `new-page-${Date.now()}-${index}`, title: 'New page', path: `new-page-${index + 1}`, type: 'how-to', priority: 'next', action: 'create', purpose: 'Describe the reader outcome for this page.', rationale: 'Added by the reviewer.', evidence: [], evidenceDetails: [], visuals: { mode: 'none', rationale: 'No application capture planned.', estimatedCaptures: 0 } }
}

function planEditablePayload(plan: DocumentationPlan) {
  return {
    scope: plan.scope,
    summary: plan.summary,
    audiences: plan.audiences,
    outcomes: plan.outcomes,
    terminology: plan.terminology,
    exclusions: plan.exclusions,
    instructions: plan.instructions,
    experienceLevel: plan.experienceLevel,
    preferredExamples: plan.preferredExamples,
    locale: plan.locale,
    accessibilityTarget: plan.accessibilityTarget,
    styleGuide: plan.styleGuide,
    capabilities: plan.capabilities,
    navigation: plan.navigation,
    estimatedPages: plan.estimatedPages,
    pages: plan.pages,
    questions: plan.questions,
    execution: plan.execution,
  }
}

function normalizeUiScreenshotIntent(value: DocumentationPlan['execution']['screenshots']): 'auto' | 'enabled' | 'disabled' {
  if (value === true || value === 'enabled') return 'enabled'
  if (value === false || value === 'disabled') return 'disabled'
  return 'auto'
}

function minimumUiPlannedCaptures(type: string, mode: 'none' | 'recommended' | 'required'): number {
  if (mode === 'none') return 0
  const recommended = mode === 'recommended'
  switch (type.trim().toLowerCase()) {
    case 'tutorial': return recommended ? 4 : 5
    case 'getting-started': return recommended ? 3 : 4
    case 'how-to': return recommended ? 3 : 4
    case 'troubleshooting': return recommended ? 2 : 3
    default: return recommended ? 2 : 3
  }
}

function planEditableJson(plan: DocumentationPlan): string {
  return JSON.stringify(planEditablePayload(plan))
}

function comparePlanVersions(previous: DocumentationPlan, current: DocumentationPlan) {
  const before = new Map(previous.pages.map((page) => [page.id, page]))
  const after = new Map(current.pages.map((page) => [page.id, page]))
  const added = current.pages.filter((page) => !before.has(page.id)).map((page) => page.title)
  const removed = previous.pages.filter((page) => !after.has(page.id)).map((page) => page.title)
  const changed = current.pages.filter((page) => {
    const old = before.get(page.id)
    return old && JSON.stringify(old) !== JSON.stringify(page)
  }).map((page) => page.title)
  const briefChanged = JSON.stringify({ audiences: previous.audiences, outcomes: previous.outcomes, terminology: previous.terminology, exclusions: previous.exclusions, instructions: previous.instructions }) !== JSON.stringify({ audiences: current.audiences, outcomes: current.outcomes, terminology: current.terminology, exclusions: current.exclusions, instructions: current.instructions })
  return { added, removed, changed, briefChanged }
}

function workflowActivityLabel(type: string): string {
  if (type === 'plan:propose') return 'Researching and building the documentation plan'
  if (type === 'plan:revise') return 'Revising the documentation plan'
  if (type === 'plan:generate') return 'Generating the approved documentation proposal'
  if (type === 'plan:continue') return 'Continuing the interrupted documentation run'
  if (type.startsWith('proposal:resume:')) return 'Continuing the interrupted documentation run'
  return 'Documentation workflow in progress'
}

interface RunCapture {
  run: string
  file: string
  url: string
  guide?: string
  step?: string
  alt?: string
  status?: string
  duplicateOf?: string
}

/**
 * Captured screenshots for the current run. Polled while the run is live so
 * images appear as they land, then left alone once the run finishes.
 */
function CaptureGallery({ live, run }: { live: boolean; run?: string }) {
  const [captures, setCaptures] = useState<RunCapture[]>([])
  const [loaded, setLoaded] = useState(false)
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      try {
        const result = await api<{ captures: RunCapture[] }>(run ? `/api/captures?run=${encodeURIComponent(run)}` : '/api/captures')
        if (!cancelled) setCaptures(result.captures)
      } catch {
        // A run without a workspace yet simply has nothing to show.
      } finally {
        if (!cancelled) setLoaded(true)
      }
    }
    void load()
    if (!live) return () => { cancelled = true }
    const timer = setInterval(() => void load(), 4000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [live, run])

  const duplicates = captures.filter((capture) => capture.duplicateOf).length
  if (loaded && captures.length === 0) {
    return <Empty icon="camera" title="No screenshots captured yet" detail={live ? 'Images appear here as the agent verifies each state.' : 'This run did not capture application screenshots.'} />
  }
  return <div class="capture-gallery">
    {duplicates > 0 && <Note tone="bad">{duplicates} of {captures.length} captures repeat an earlier image. Steps showing the same screen under different names mislead readers — the agent should reach those states or record them as text-only.</Note>}
    <div class="capture-grid">
      {captures.map((capture) => <figure key={capture.file} class={`capture-tile${capture.duplicateOf ? ' duplicate' : ''}`}>
        <a href={capture.url} target="_blank" rel="noreferrer"><img src={capture.url} alt={capture.alt ?? capture.file} loading="lazy" /></a>
        <figcaption>
          <strong>{capture.guide ? `${capture.guide} · ${capture.step ?? ''}` : capture.file.split('/').slice(-1)[0]}</strong>
          <small>{capture.duplicateOf ? `Identical to ${capture.duplicateOf.split('/').slice(-1)[0]}` : capture.alt ?? capture.file}</small>
        </figcaption>
      </figure>)}
    </div>
  </div>
}

function AuthoringLiveLog({ job, act }: { job: UiJob; act: Action }) {
  const log = useRef<HTMLPreElement>(null)
  const agent = job.agent ? agentLabel(job.agent) : 'Agent'
  const [tab, setTab] = useState<'log' | 'captures'>('log')
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [job.lines.length, tab])
  return <div class="authoring-live-log">
    {job.stages.length > 0 && <ol class="workflow-stages" aria-label="Documentation workflow stages">
      {job.stages.map((stage) => <li class={stage.status} key={stage.id}><span>{stage.status === 'completed' ? <Icon name="check" size={11} /> : stage.status === 'failed' ? <Icon name="alert" size={11} /> : <i />}</span><strong>{stage.label}</strong></li>)}
    </ol>}
    <div class="live-job-meta" aria-live="polite">
      <span><Icon name="bot" size={14} />{agent}</span>
      <span><Icon name="clock" size={14} />Last output {timeText(job.lastOutputAt ?? job.startedAt)}</span>
      <span><Icon name="file" size={14} />{job.lines.length} recent line{job.lines.length === 1 ? '' : 's'}</span>
      <span class="authoring-live-actions">
        <a href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer">Open full log <Icon name="external" size={12} /></a>
        {job.status === 'running' && <Button size="sm" tone="danger" icon="stop" onClick={() => void act(() => post(`/api/jobs/${job.id}/cancel`), 'Update stopped')}>Stop update</Button>}
        {job.status !== 'running' && job.retryable && <Button size="sm" icon="refresh" onClick={() => void act(() => post(`/api/jobs/${job.id}/retry`), 'Workflow restarted')}>Retry stage</Button>}
      </span>
    </div>
    <div class="live-log-tabs"><Segmented value={tab} onChange={setTab} items={[['log', 'Log'], ['captures', 'Screenshots']] as const} /></div>
    {tab === 'log'
      ? <pre ref={log} class="terminal live-terminal" aria-live="polite">{job.lines.length > 0 ? job.lines.join('\n') : `Starting ${agent}…`}</pre>
      : <CaptureGallery live={job.status === 'running'} />}
  </div>
}


/**
 * History is read on demand rather than carried in the shared state: it is only
 * needed on the page showing it, and it refreshes when a run finishes.
 */
interface HistoryFeed<T> {
  entries: T[]
  available: boolean
  loading: boolean
}

function useHistoryFeed<T>(
  path: string,
  read: (payload: Record<string, unknown>) => T[],
  jobs: UiJob[],
  onError: (error: string) => void,
): HistoryFeed<T> {
  const [entries, setEntries] = useState<T[]>([])
  const [available, setAvailable] = useState(true)
  const [loading, setLoading] = useState(true)
  const settled = jobs.filter((job) => job.status !== 'running').map((job) => job.id).join(',')
  useEffect(() => {
    let current = true
    void (async () => {
      try {
        const payload = await api<Record<string, unknown>>(path)
        if (!current) return
        setAvailable(payload.available !== false)
        setEntries(read(payload))
      } catch (cause) {
        if (current) onError(message(cause))
      } finally {
        if (current) setLoading(false)
      }
    })()
    return () => {
      current = false
    }
  }, [path, settled])
  return { entries, available, loading }
}

function HistoryUnavailable() {
  return <Note tone="info">
    Documentation history needs a Node.js runtime with built-in SQLite (Node 22.13 or newer).
    Every other part of this workspace works normally.
  </Note>
}

function changeCountText(pages: HistoryChangedPage[], total: number): string {
  const count = pages.length || total
  return count === 1 ? '1 page' : `${count} pages`
}

const HISTORY_REQUEST_SUMMARY_LENGTH = 140

export function historyRequestSummary(request: string): { text: string; truncated: boolean } {
  const text = request.replace(/\s+/g, ' ').trim()
  if (text.length <= HISTORY_REQUEST_SUMMARY_LENGTH) return { text, truncated: false }
  return {
    text: `${text.slice(0, HISTORY_REQUEST_SUMMARY_LENGTH).replace(/\s+\S*$/, '').trimEnd()}…`,
    truncated: true,
  }
}

export function historyActionLabel(kind: HistoryRequest['kind']): string {
  if (kind === 'create') return 'Create'
  if (kind === 'review') return 'Review'
  return 'Update'
}

export function historyInstruction(entry: Pick<HistoryRequest, 'kind' | 'requestText' | 'trigger'>): string {
  const request = entry.requestText?.replace(/\s+/g, ' ').trim()
  const internalPlanPrompt = request?.startsWith('Implement the approved Doxloop documentation plan at .doxloop/documentation-plan.json')
  if (request && !internalPlanPrompt) return request
  if (entry.kind === 'create') return 'Create documentation from the approved plan.'
  if (entry.kind === 'review') return 'Review the documentation.'
  if (entry.trigger === 'schedule' || entry.trigger === 'watch') {
    return 'Update documentation for detected source changes.'
  }
  return internalPlanPrompt
    ? 'Update documentation from the approved plan.'
    : 'Update documentation from configured sources.'
}

/** Past documentation requests: what was asked, what happened, what changed. */
function RequestHistory({ jobs, onError }: { jobs: UiJob[]; onError: (error: string) => void }) {
  const { entries, available, loading } = useHistoryFeed<HistoryRequest>(
    '/api/history?limit=25',
    (payload) => (payload.requests as HistoryRequest[]) ?? [],
    jobs,
    onError,
  )
  if (!available) return <HistoryUnavailable />
  if (loading && entries.length === 0) return <div class="history-loading">Loading history…</div>
  if (entries.length === 0) {
    return <Empty
      icon="clock"
      title="No documentation history yet"
      detail="Once you start an update, the request and everything it changed are recorded here."
    />
  }
  return <Table class="history-table" head={<><th>Action</th><th>Instruction</th><th>Result</th><th>When</th></>}>
    {entries.map((entry) => {
      const pages = entry.pages ?? []
      const instruction = historyRequestSummary(historyInstruction(entry))
      return <tr key={entry.id} class="history-row">
        <td class="history-action">
          <strong>{historyActionLabel(entry.kind)}</strong>
        </td>
        <td>
          <div class="history-request">
            <strong title={instruction.truncated ? historyInstruction(entry) : undefined}>{instruction.text}</strong>
            {entry.error && <small class="history-error">{entry.error}</small>}
          </div>
        </td>
        <td class="history-result">
          <Badge tone={statusTone(entry.status)}>{statusLabel(entry.status)}</Badge>
          <small>{entry.pagesChanged > 0 || pages.length > 0 ? `${changeCountText(pages, entry.pagesChanged)} changed` : 'No page changes'}</small>
        </td>
        <td class="muted-cell">
          {timeText(entry.createdAt)}
        </td>
      </tr>
    })}
  </Table>
}

/**
 * Every publish attempt, including the ones that failed. The feed is read by the
 * Deploy page itself, which also needs the last successful deployment URL.
 */
function DeploymentHistory({ entries, available, loading }: HistoryFeed<DeploymentRecord>) {
  if (!available) return <HistoryUnavailable />
  if (loading && entries.length === 0) return <div class="history-loading">Loading history…</div>
  if (entries.length === 0) {
    return <Empty
      icon="clock"
      title="Nothing published yet"
      detail="Each deployment is recorded here with the pages it published and whether it succeeded."
    />
  }
  return <Table class="history-table" head={<><th>Destination</th><th>Result</th><th>Pages</th><th>When</th></>}>
    {entries.map((entry) => <tr key={`${entry.startedAt}-${entry.slug ?? entry.target}`} class="history-row">
      <td>
        <div class="history-request">
          <strong>{entry.slug ?? entry.name ?? entry.target}</strong>
          <small>
            {entry.target}
            {entry.visibility && <> · {entry.visibility}</>}
          </small>
          {entry.error && <small class="history-error">{entry.error}</small>}
        </div>
      </td>
      <td><Badge tone={statusTone(entry.status)}>{statusLabel(entry.status)}</Badge></td>
      <td class="history-changed">
        <span>{entry.pagesCount === undefined ? '—' : changeCountText([], entry.pagesCount)}</span>
        {(entry.pagesCreated || entry.pagesUpdated) && <small class="history-lines">
          {entry.pagesCreated ? <i class="added">+{entry.pagesCreated} new</i> : null}
          {entry.pagesUpdated ? <i>{entry.pagesUpdated} updated</i> : null}
        </small>}
      </td>
      <td class="muted-cell">
        {timeText(entry.startedAt)}
        {entry.durationMs !== undefined && <small class="history-duration">{durationText(entry.durationMs)}</small>}
      </td>
    </tr>)}
  </Table>
}

function durationText(milliseconds: number): string {
  if (milliseconds < 1000) return 'under a second'
  const seconds = Math.round(milliseconds / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

function MonitoringDialog({ state, act, onClose }: { state: UiState; act: Action; onClose: () => void }) {
  const project = state.project!
  const [sync, setSync] = useState<SyncConfig>(() => {
    const current = { ...structuredClone(project.sync), mode: 'auto' as const }
    return current.on.length ? current : { ...current, on: [scheduleTrigger(scheduleForm([]))] }
  })
  const [schedule, setSchedule] = useState<ScheduleForm>(() => scheduleForm(project.sync.on))
  const [advanced, setAdvanced] = useState(false)
  const [saving, setSaving] = useState(false)
  const set = <K extends keyof SyncConfig>(key: K, value: SyncConfig[K]) => setSync((current) => ({ ...current, [key]: value }))
  const updateSchedule = (next: Partial<ScheduleForm>) => {
    setSchedule((current) => {
      const updated = { ...current, ...next }
      setSync((value) => ({ ...value, on: [scheduleTrigger(updated)] }))
      return updated
    })
  }
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone
  const missingRemote = project.sources.filter((item) => (item.kind ?? 'directory') === 'directory' && !item.remote)
  const save = async () => {
    setSaving(true)
    try {
      const result = await act(() => post('/api/sync/configure', { ...sync, mode: 'auto' }), 'Monitoring configuration installed')
      if (result !== undefined) onClose()
    } finally {
      setSaving(false)
    }
  }
  return <div class="sources-modal-scrim" onClick={onClose}>
    <section class="monitoring-dialog" role="dialog" aria-modal="true" aria-labelledby="monitoring-dialog-title" onClick={(event) => event.stopPropagation()}>
      <header>
        <span class="sources-dialog-icon"><Icon name="bell" size={23} /></span>
        <div><h2 id="monitoring-dialog-title">Configure project monitoring</h2><p>One project-wide policy checks all {project.sources.length} connected sources. Changes generate a documentation proposal for review.</p></div>
        <button type="button" aria-label="Close" onClick={onClose}><Icon name="close" size={17} /></button>
      </header>
      <div class="monitoring-dialog-body">
        <div class="monitoring-dialog-status"><span class={project.sync.on.length ? 'active' : ''}><i />{project.sync.on.length ? scheduleSummary(scheduleForm(project.sync.on)) : 'Monitoring is not configured'}</span><Button size="sm" icon="refresh" onClick={() => void act(() => post('/api/sync/now'), 'Source check started')}>Check now</Button></div>
        {missingRemote.length > 0 && <Note>Scheduled monitoring needs a read-only remote for {missingRemote.map((item) => item.name).join(', ')}. Connect a Git repository before installing this schedule.</Note>}
        <section class="monitoring-policy-fields">
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
          <button type="button" class="disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={14} />Advanced watch scope and budgets</button>
          {advanced && <div class="form-grid gap-top">
            <Field label="Watched paths"><Lines value={sync.watch} onInput={(value) => set('watch', value)} placeholder={'src/**\nopenapi.yaml'} /></Field>
            <Field label="Ignored paths"><Lines value={sync.ignore} onInput={(value) => set('ignore', value)} placeholder={'**/*.test.ts\npnpm-lock.yaml'} /></Field>
            <Field label="Maximum agent minutes"><Input type="number" min="1" value={sync.budget?.maxMinutes ?? ''} onInput={(event) => setSync({ ...sync, budget: numberBudget(sync.budget, 'maxMinutes', event.currentTarget.value) })} /></Field>
            <Field label="Maximum runs per day"><Input type="number" min="1" value={sync.budget?.maxRunsPerDay ?? ''} onInput={(event) => setSync({ ...sync, budget: numberBudget(sync.budget, 'maxRunsPerDay', event.currentTarget.value) })} /></Field>
            <Field label="Re-verify after (days)" hint="Checks evidence age even when source content is unchanged."><Input type="number" min="1" max="3650" value={sync.maxVerificationAgeDays ?? ''} onInput={(event) => set('maxVerificationAgeDays', event.currentTarget.value ? clampNumber(event.currentTarget.value, 1, 3650) : undefined)} /></Field>
            <Field label="Expired verification"><Select value={sync.maxVerificationAgeSeverity ?? 'warn'} onChange={(event) => set('maxVerificationAgeSeverity', event.currentTarget.value as 'warn' | 'fail')}><option value="warn">Warn</option><option value="fail">Fail validation</option></Select></Field>
          </div>}
          <Note>Monitoring creates the documentation update as a proposal under Review Changes. It never modifies the product source or publishes automatically.</Note>
        </section>
      </div>
      <footer>
        {project.sync.on.length > 0 && <Button tone="danger" onClick={() => confirm('Disable the installed monitoring schedule?') && void act(() => post('/api/sync/off'), 'Monitoring disabled')}>Disable</Button>}
        <span />
        <Button onClick={onClose}>Cancel</Button>
        <Button tone="primary" busy={saving} disabled={missingRemote.length > 0} onClick={() => void save()}>Save and install</Button>
      </footer>
    </section>
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

function Proposals({ state, act, onError }: { state: UiState; act: Action; onError: (error: string) => void }) {
  const runs = validRuns(state.runs)
  const [showArchived, setShowArchived] = useState(false)
  const archivedCount = runs.filter((run) => Boolean(run.archivedAt)).length
  const visibleRuns = runs.filter((run) => showArchived ? Boolean(run.archivedAt) : !run.archivedAt)
  const [selectedId, setSelectedId] = useState('')
  const selected = runs.find((run) => run.id === selectedId)
  const [changeId, setChangeId] = useState('')
  const [confirmingAcceptance, setConfirmingAcceptance] = useState<Proposal | null>(null)
  const [appliedProposal, setAppliedProposal] = useState<Proposal | null>(null)
  const [delivery, setDelivery] = useState<{ branch: string; commit: string; compareUrl?: string; pullRequestCommand?: string; pushedAt?: string; pullRequestUrl?: string } | null>(null)
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [layout, setLayout] = useState<'split' | 'unified'>('split')
  const [onlyChanges, setOnlyChanges] = useState(true)
  const [rationaleChange, setRationaleChange] = useState<ProposalChange | null>(null)
  const [revision, setRevision] = useState<{
    mode: 'current' | 'selected' | 'all'
    instruction: string
    selectedIds: string[]
    hunkIds: string[]
  } | null>(null)
  const [editor, setEditor] = useState<{
    change: ProposalChange
    content: string
    evidenceDisposition: 'preserved' | 'needs-review'
  } | null>(null)
  const change = selected?.changes.find((item) => item.id === changeId) ?? selected?.changes[0]
  useEffect(() => setChangeId(selected?.changes[0]?.id ?? ''), [selected?.id])
  const open = selected ? !selected.archivedAt && OPEN_STATUSES.includes(selected.status) : false
  const counts = selected ? proposalChangeCounts(selected.changes) : { added: 0, modified: 0, deleted: 0 }
  const acceptAll = async (proposal: Proposal) => {
    const result = await act(() => post<Proposal>(`/api/proposals/${proposal.id}/accept`, { scope: 'all' }))
    setConfirmingAcceptance(null)
    if (result?.status === 'applied') setAppliedProposal(result)
  }
  const openEditor = async (proposal: Proposal, selectedChange: ProposalChange) => {
    try {
      const result = await api<{ content: string; evidenceDisposition: 'preserved' | 'needs-review' }>(`/api/proposals/${proposal.id}/changes/${selectedChange.id}/content`)
      setEditor({ change: selectedChange, content: result.content, evidenceDisposition: result.evidenceDisposition })
    } catch (cause) {
      onError(message(cause))
    }
  }
  const requestRevision = async (proposal: Proposal) => {
    if (!revision?.instruction.trim()) return
    const changeIds = revision.mode === 'all'
      ? proposal.changes.map((item) => item.id)
      : revision.mode === 'current'
        ? (change ? [change.id] : [])
        : revision.selectedIds
    const result = await act(
      () => post<UiJob>(`/api/proposals/${proposal.id}/revise`, {
        instruction: revision.instruction,
        changeIds,
        hunkIds: revision.hunkIds,
      }),
      'Revision started',
      false,
    )
    if (result) setRevision(null)
  }
  return <>
    {delivery && <div class="proposal-ready-scrim" role="presentation"><section class="proposal-ready-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-delivery-title"><button class="proposal-ready-close" type="button" aria-label="Close" onClick={() => setDelivery(null)}><Icon name="close" size={16} /></button><span class="proposal-ready-icon"><Icon name="external" size={24} /></span><div><h2 id="proposal-delivery-title">{delivery.pullRequestUrl ? 'Pull request is ready' : delivery.pushedAt ? 'Branch published' : 'Pull-request branch is ready'}</h2><p>{delivery.pushedAt ? 'The reviewed commit is available on the remote without changing your current working tree.' : 'Doxloop created the branch in an isolated Git worktree without changing your current working tree.'}</p></div><div class="proposal-ready-summary"><strong>{delivery.branch}</strong><span>Commit {delivery.commit.slice(0, 12)}</span></div>{!delivery.pushedAt && delivery.pullRequestCommand && <code>{delivery.pullRequestCommand}</code>}<footer>{delivery.pullRequestUrl ? <a class="btn primary md" href={delivery.pullRequestUrl} target="_blank" rel="noreferrer">Open pull request</a> : delivery.pushedAt ? delivery.compareUrl && <a class="btn primary md" href={delivery.compareUrl} target="_blank" rel="noreferrer">Open comparison</a> : <><Button onClick={() => void (async () => { const result = await act(() => post<typeof delivery>(`/api/proposals/${selectedId}/delivery/publish`, { createPullRequest: false }), 'Branch published'); if (result) setDelivery(result) })()}>Push branch</Button><Button tone="primary" onClick={() => void (async () => { const result = await act(() => post<typeof delivery>(`/api/proposals/${selectedId}/delivery/publish`, { createPullRequest: true }), 'Pull request created'); if (result) setDelivery(result) })()}>Push & create PR</Button></>}<Button onClick={() => setDelivery(null)}>Done</Button></footer></section></div>}
    {rationaleChange && <ProposalRationaleDrawer change={rationaleChange} onClose={() => setRationaleChange(null)} />}
    {revision && selected && <ProposalRevisionDialog proposal={selected} current={change} draft={revision} onChange={setRevision} onClose={() => setRevision(null)} onSubmit={() => void requestRevision(selected)} />}
    {editor && selected && <ProposalEditDialog value={editor} onChange={setEditor} onClose={() => setEditor(null)} onSave={() => void (async () => {
      const result = await act(() => patch<Proposal>(`/api/proposals/${selected.id}/changes/${editor.change.id}/content`, {
        content: editor.content,
        evidenceDisposition: editor.evidenceDisposition,
      }), 'Page edit saved')
      if (result) setEditor(null)
    })()} />}
    {confirmingAcceptance && <div class="proposal-ready-scrim" role="presentation">
      <section class="proposal-ready-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-accept-title">
        <button class="proposal-ready-close" type="button" aria-label="Close" onClick={() => setConfirmingAcceptance(null)}><Icon name="close" size={16} /></button>
        <span class="proposal-ready-icon"><Icon name="proposals" size={24} /></span>
        <div><h2 id="proposal-accept-title">Apply these documentation changes?</h2><p>This replaces the current versions of the reviewed files with the proposed versions.</p></div>
        <div class="proposal-ready-summary"><strong>{proposalSummaryText(confirmingAcceptance.changes)}</strong><span>Only the files listed in this proposal will be applied.</span></div>
        <footer><Button onClick={() => setConfirmingAcceptance(null)}>Cancel</Button><Button tone="primary" icon="check" onClick={() => void acceptAll(confirmingAcceptance)}>Apply changes</Button></footer>
      </section>
    </div>}
    {appliedProposal && <div class="proposal-ready-scrim" role="presentation">
      <section class="proposal-ready-dialog proposal-applied-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-applied-title">
        <button class="proposal-ready-close" type="button" aria-label="Close" onClick={() => setAppliedProposal(null)}><Icon name="close" size={16} /></button>
        <span class="proposal-ready-icon applied"><Icon name="check" size={24} /></span>
        <div><h2 id="proposal-applied-title">Documentation changes applied</h2><p>The proposal was accepted and the current documentation now includes these changes.</p></div>
        <div class="proposal-ready-summary"><strong>{proposalSummaryText(appliedProposal.changes)}</strong><span>Use Preview in the navbar to open the updated documentation.</span></div>
        <footer><Button tone="primary" onClick={() => setAppliedProposal(null)}>Done</Button></footer>
      </section>
    </div>}
    {selected
      ? <div class="review-detail-heading">
        <button type="button" class="review-back-button" onClick={() => setSelectedId('')}><Icon name="chevronRight" size={14} />All proposals</button>
        <PageHeader title="Review proposal" description="Compare the current documentation with the proposed update." actions={<><Button icon="external" onClick={() => void openProposalPreview(selected.id, onError)}>Preview documentation</Button>{open && <Button icon="publish" onClick={() => void (async () => { const result = await act(() => post<{ branch: string; commit: string; compareUrl?: string; pullRequestCommand?: string }>(`/api/proposals/${selected.id}/delivery/branch`, {}), 'Pull-request branch prepared'); if (result) setDelivery(result) })()}>Prepare PR branch</Button>}{!selected.archivedAt && selected.status !== 'generating' && <Button onClick={() => confirm('Archive this proposal? It can remain in history until cleanup.') && void act(() => post(`/api/proposals/${selected.id}/archive`), 'Proposal archived')}>Archive</Button>}</>} />
      </div>
      : <PageHeader title="Review Changes" description="Choose a proposal to inspect and approve its documentation changes." />}
    {runs.length === 0
      ? <Panel flush><Empty icon="proposals" title="No proposals yet" detail="Run source monitoring, or start an update when documentation becomes stale." /></Panel>
      : !selected
        ? <Panel class="proposal-index-panel" title={showArchived ? 'Archived proposals' : 'All proposals'} description={visibleRuns.length + ' documentation update' + (visibleRuns.length === 1 ? '' : 's') + (showArchived ? ' retained for audit.' : ' available for review.')} flush>
          <div class="proposal-index-tools"><Button size="sm" onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Back to proposals' : `Archived (${archivedCount})`}</Button>{showArchived && archivedCount > 0 && <Button size="sm" tone="danger" onClick={() => confirm('Permanently remove every archived proposal workspace?') && void act(() => post('/api/proposals/cleanup', {}), 'Archived proposals cleaned up')}>Clean up archived</Button>}</div>
          {visibleRuns.length === 0 ? <Empty title={showArchived ? 'No archived proposals' : 'No active proposals'} detail={showArchived ? 'Archived proposal workspaces will appear here until cleanup.' : 'Archive completed reviews to keep this list focused.'} /> :
          <Table class="proposal-index-table" head={<><th>Proposal</th><th>Changes</th><th>Files</th><th>Created</th><th>Status</th><th><span class="sr-only">Open</span></th></>}>
            {visibleRuns.map((run) => {
              const runCounts = proposalChangeCounts(run.changes)
              return <tr key={run.id} class="proposal-index-row" tabIndex={0} onClick={() => setSelectedId(run.id)} onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return
                event.preventDefault()
                setSelectedId(run.id)
              }}>
                <td><span class="proposal-index-name"><span><Icon name="proposals" size={17} /></span><span><strong>{run.summary || 'Documentation update'}</strong><small>{run.sourceSummary}</small></span></span></td>
                <td><span class="proposal-index-counts"><b class="added">+{runCounts.added}</b><b class="modified">{runCounts.modified} modified</b><b class="deleted">−{runCounts.deleted}</b></span></td>
                <td><span class="proposal-index-files"><Icon name="file" size={14} />{run.changes.length}</span></td>
                <td><time>{timeText(run.createdAt)}</time></td>
                <td><Badge tone={statusTone(run.archivedAt ? 'archived' : run.status)}>{run.archivedAt ? 'Archived' : statusLabel(run.status)}</Badge></td>
                <td><Icon name="chevronRight" size={15} /></td>
              </tr>
            })}
          </Table>
          }
        </Panel>
        : <div class="review">
        <section class="review-main">
          <div class="proposal-card">
            <header class="proposal-summary">
              <span class="proposal-summary-icon"><Icon name="proposals" size={25} /></span>
              <div class="proposal-summary-copy">
                <div class="proposal-summary-line">
                  <h2>{selected.changes.length} file change{selected.changes.length === 1 ? '' : 's'}</h2>
                  <div class="change-counts" aria-label={`${counts.added} added, ${counts.modified} modified, ${counts.deleted} deleted`}>
                    {counts.added > 0 && <span class="added"><i />{counts.added} added</span>}
                    {counts.added > 0 && (counts.modified > 0 || counts.deleted > 0) && <b />}
                    {counts.modified > 0 && <span class="modified"><i />{counts.modified} modified</span>}
                    {counts.modified > 0 && counts.deleted > 0 && <b />}
                    {counts.deleted > 0 && <span class="deleted"><i />{counts.deleted} deleted</span>}
                  </div>
                </div>
                <strong class="source-count">{selected.sourceSummary}</strong>
              </div>
              <div class="proposal-summary-side">
                <div class="proposal-actions">
                  {selected.status === 'applied' && selected.undo?.status === 'available' && <Button onClick={() => confirm('Undo every file applied by this proposal? Newer edits will be protected.') && void act(() => post(`/api/proposals/${selected.id}/undo`), 'Documentation changes undone')}>Undo</Button>}
                  {(open || (selected.status === 'stale' && !selected.archivedAt)) && <Button onClick={() => setRevision({ mode: 'all', instruction: 'Regenerate this proposal using the current approved plan and evidence.', selectedIds: selected.changes.map((item) => item.id), hunkIds: [] })}>Regenerate</Button>}
                  <Button tone="danger" disabled={!open} onClick={() => confirm('Reject this complete proposal?') && void act(() => post(`/api/proposals/${selected.id}/reject`), 'Proposal rejected')}>Reject</Button>
                  <Button tone="primary" icon="check" disabled={!open} onClick={() => selected && setConfirmingAcceptance(selected)}>Accept all</Button>
                </div>
              </div>
            </header>

            {selected.status === 'failed' && !selected.archivedAt && <div class="proposal-lifecycle-notice failed">
              <Icon name="alert" size={15} />
              <span class="proposal-failed-copy"><strong>This run stopped before it could be reviewed.</strong>{selected.error && <small>{selected.error}</small>}{(selected.recovery?.resumable !== false || selected.recovery?.ignorable !== false) && <small>Its workspace is preserved: continue it instead of generating again.</small>}</span>
              {(selected.recovery?.resumable !== false || selected.recovery?.ignorable !== false) && <span class="proposal-failed-actions">
                {selected.recovery?.resumable !== false && <Button size="sm" tone="primary" icon="play" onClick={() => void act(() => post<UiJob>(`/api/proposals/${selected.id}/resume`), 'Continuing the documentation run')}>Resume</Button>}
                {selected.recovery?.ignorable !== false && <Button size="sm" icon="check" onClick={() => void act(() => post<Proposal>(`/api/proposals/${selected.id}/recover`, { ignoreScreenshotProblems: true }), 'Proposal ready for review with problems ignored')}>Ignore problems & review</Button>}
              </span>}
            </div>}
            {selected.advisories?.map((advisory) => <div key={advisory} class="proposal-lifecycle-notice advisory"><Icon name="info" size={15} /><span>{advisory}</span></div>)}
            {(selected.status === 'stale' || selected.status === 'superseded' || selected.archivedAt) && <div class={`proposal-lifecycle-notice ${selected.status}`}>
              <Icon name="info" size={15} />
              <span>{selected.status === 'stale' ? selected.error : selected.status === 'superseded' ? `A newer revision${selected.supersededBy ? ` (${selected.supersededBy})` : ''} replaced this proposal.` : 'This proposal is archived.'}</span>
            </div>}

            {selected.screenshots && selected.screenshots.status !== 'not-requested' && <div class={`proposal-screenshot-result ${selected.screenshots.ignoredProblems ? 'ignored' : selected.screenshots.status}`}><span class="screenshot-camera"><Icon name="camera" size={17} /></span><span><strong>{selected.screenshots.ignoredProblems ? `${selected.screenshots.captured} application screenshot${selected.screenshots.captured === 1 ? '' : 's'} verified · ${selected.screenshots.ignoredProblems} problem${selected.screenshots.ignoredProblems === 1 ? '' : 's'} ignored` : selected.screenshots.status === 'verified' ? `${selected.screenshots.captured} application screenshot${selected.screenshots.captured === 1 ? '' : 's'} verified` : selected.screenshots.status === 'skipped' ? 'Application screenshots skipped' : 'Application screenshot capture needs attention'}</strong><small>{selected.screenshots.message ?? `${selected.screenshots.guides} guide${selected.screenshots.guides === 1 ? '' : 's'} · ${selected.screenshots.textOnly} text-only step${selected.screenshots.textOnly === 1 ? '' : 's'}`}</small></span>{selected.screenshots.status === 'verified' && <Button size="sm" onClick={() => void openProposalPreview(selected.id, onError)}>Review in preview</Button>}</div>}

            <div class="review-workspace">
              <section class="review-diff-panel">
                {change ? <>
                  <header class="review-file-head">
                    <div class="review-file-head-main">
                      <ReviewFilePicker
                        key={selected.id}
                        nodes={proposalFileTree(selected.changes)}
                        selected={change}
                        fileCount={selected.changes.length}
                        onSelect={setChangeId}
                      />
                    </div>
                    <span class="file-position">{Math.max(0, selected.changes.findIndex((item) => item.id === change.id)) + 1} of {selected.changes.length}</span>
                  </header>
                  <div class="review-toolbar">
                    <div class="review-view-control">
                      <span class="toolbar-label">View</span>
                      <Segmented value={view} onChange={setView} items={[['rendered', 'Preview'], ['source', 'Source']] as const} />
                    </div>
                    <div class="row-actions">
                      {view === 'rendered' && <>
                        <div class="review-layout-control"><span class="toolbar-label">Diff layout</span><Segmented value={layout} onChange={setLayout} items={[['split', 'Side-by-side'], ['unified', 'Inline']] as const} /></div>
                        <Button size="sm" class={onlyChanges ? 'active-filter' : ''} onClick={() => setOnlyChanges(!onlyChanges)}>{onlyChanges ? 'Changes only' : 'Show all'}</Button>
                      </>}
                      <Button size="sm" onClick={() => setRationaleChange(change)}>Why this change</Button>
                      <Button size="sm" disabled={!open || change.category !== 'page' || change.binary || change.kind === 'deleted'} onClick={() => void openEditor(selected, change)}>Edit page</Button>
                      <Button size="sm" disabled={!open} onClick={() => setRevision({ mode: 'current', instruction: '', selectedIds: [change.id], hunkIds: [] })}>Ask agent to revise</Button>
                      <Button size="sm" tone="primary" icon="check" disabled={!open} onClick={() => void act(() => post(`/api/proposals/${selected.id}/accept`, { scope: 'page', changeId: change.id }), 'Page accepted')}>Accept file</Button>
                    </div>
                  </div>
                  <div class="review-diff-body">
                    {view === 'source'
                      ? <ProposalSourceDiff runId={selected.id} change={change} act={act} onReviseHunk={(hunkId) => setRevision({ mode: 'current', instruction: '', selectedIds: [change.id], hunkIds: [hunkId] })} />
                      : <div class="review-device"><iframe class="review-frame" title={`Review ${change.title}`} src={`/review-preview/${selected.id}/${change.id}?layout=${layout}${onlyChanges ? '&only=1' : ''}`} /></div>}
                  </div>
                </> : <Empty title="This proposal contains no file changes" />}
              </section>
            </div>
          </div>
        </section>
      </div>}
  </>
}

type ProposalRevisionDraft = {
  mode: 'current' | 'selected' | 'all'
  instruction: string
  selectedIds: string[]
  hunkIds: string[]
}

type ProposalEditorDraft = {
  change: ProposalChange
  content: string
  evidenceDisposition: 'preserved' | 'needs-review'
}

function ProposalRationaleDrawer({ change, onClose }: { change: ProposalChange; onClose: () => void }) {
  const rationale = change.rationale
  const claims = [...rationale.claims.added, ...rationale.claims.changed, ...rationale.claims.removed]
  return <div class="proposal-drawer-scrim" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
    <aside class="proposal-rationale-drawer" role="dialog" aria-modal="true" aria-labelledby="proposal-rationale-title">
      <header><span><small>Why this change</small><h2 id="proposal-rationale-title">{change.title}</h2><code>{change.path}</code></span><button type="button" aria-label="Close rationale" onClick={onClose}><Icon name="close" size={17} /></button></header>
      <div class="proposal-drawer-body">
        <section class="rationale-lead"><Badge tone={statusTone(rationale.confidence)}>{rationale.confidence.replace('-', ' ')}</Badge><p>{rationale.reason}</p></section>
        <section><h3>Supporting evidence</h3>{rationale.evidence.length > 0 ? <div class="rationale-evidence-list">{rationale.evidence.map((item, index) => <article key={index} class={!item.available ? 'unavailable' : ''}><Icon name="link" size={14} /><span><strong>{item.source}</strong><code>{item.path ?? item.operation ?? 'Configured source'}</code>{item.revision && <small>Revision {item.revision.slice(0, 12)}</small>}{!item.available && <small>Unavailable in this environment</small>}</span></article>)}</div> : <p class="muted-copy">No precise source reference was recorded. Review this change manually before acceptance.</p>}</section>
        {claims.length > 0 && <section><h3>Reader-facing claims</h3><ul>{claims.map((claim) => <li key={claim}>{claim}</li>)}</ul></section>}
        {rationale.affectedInterfaces.length > 0 && <section><h3>Public interfaces affected</h3><div class="rationale-tags">{rationale.affectedInterfaces.map((item) => <span key={item}>{item}</span>)}</div></section>}
        <section class="rationale-validation"><h3>Checks</h3><p><Icon name="check" size={14} /> {rationale.validation.errors} errors · {rationale.validation.warnings} warnings</p><small>{rationale.authorship === 'human' ? 'Edited by a reviewer' : rationale.planId ? `From approved plan ${rationale.planId}` : 'Generated from the review request'}</small></section>
        {rationale.assumptions.length > 0 && <details><summary>Assumptions to verify</summary><ul>{rationale.assumptions.map((item) => <li key={item}>{item}</li>)}</ul></details>}
      </div>
    </aside>
  </div>
}

function ProposalRevisionDialog({ proposal, current, draft, onChange, onClose, onSubmit }: {
  proposal: Proposal
  current: ProposalChange | undefined
  draft: ProposalRevisionDraft
  onChange: (next: ProposalRevisionDraft) => void
  onClose: () => void
  onSubmit: () => void
}) {
  const selectedCount = draft.mode === 'all' ? proposal.changes.length : draft.mode === 'current' ? Number(Boolean(current)) : draft.selectedIds.length
  return <div class="proposal-ready-scrim" role="presentation">
    <section class="proposal-revision-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-revision-title">
      <header><span><small>Agent revision</small><h2 id="proposal-revision-title">What should change?</h2><p>Only the selected scope will be regenerated. Everything else stays exactly as reviewed.</p></span><button type="button" aria-label="Close revision" onClick={onClose}><Icon name="close" size={16} /></button></header>
      <div class="revision-scope-tabs">
        {([['current', 'This file'], ['selected', 'Choose files'], ['all', 'Whole proposal']] as const).map(([id, label]) => <button type="button" class={draft.mode === id ? 'active' : ''} onClick={() => onChange({ ...draft, mode: id, selectedIds: id === 'current' && current ? [current.id] : draft.selectedIds, hunkIds: id === 'current' ? draft.hunkIds : [] })}>{label}</button>)}
      </div>
      {draft.hunkIds.length > 0 && <Note tone="info">The request is scoped to one selected source change in {current?.path}.</Note>}
      {draft.mode === 'selected' && <div class="revision-file-list">{proposal.changes.map((item) => <label key={item.id}><input type="checkbox" checked={draft.selectedIds.includes(item.id)} onChange={(event) => onChange({ ...draft, selectedIds: event.currentTarget.checked ? [...draft.selectedIds, item.id] : draft.selectedIds.filter((id) => id !== item.id) })} /><span><strong>{item.title}</strong><code>{item.path}</code></span><Badge tone={statusTone(item.kind)}>{item.kind}</Badge></label>)}</div>}
      <Field label="Revision instructions"><Textarea rows={5} maxlength={2000} value={draft.instruction} placeholder="For example: Make this task more concise, keep the API example, and explain the expected response." onInput={(event) => onChange({ ...draft, instruction: event.currentTarget.value })} /></Field>
      <footer><small>{selectedCount} file{selectedCount === 1 ? '' : 's'} selected</small><span><Button onClick={onClose}>Cancel</Button><Button tone="primary" icon="wand" disabled={!draft.instruction.trim() || selectedCount === 0} onClick={onSubmit}>Send to agent</Button></span></footer>
    </section>
  </div>
}

function ProposalEditDialog({ value, onChange, onClose, onSave }: {
  value: ProposalEditorDraft
  onChange: (next: ProposalEditorDraft) => void
  onClose: () => void
  onSave: () => void
}) {
  return <div class="proposal-ready-scrim" role="presentation">
    <section class="proposal-edit-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-edit-title">
      <header><span><small>Direct page edit</small><h2 id="proposal-edit-title">{value.change.title}</h2><code>{value.change.path}</code></span><button type="button" aria-label="Close editor" onClick={onClose}><Icon name="close" size={16} /></button></header>
      <Textarea class="proposal-code-editor" rows={22} value={value.content} onInput={(event) => onChange({ ...value, content: event.currentTarget.value })} />
      <label class="evidence-disposition"><span><strong>Evidence after this edit</strong><small>Keep the source links only if your edit does not change the factual claims.</small></span><select value={value.evidenceDisposition} onChange={(event) => onChange({ ...value, evidenceDisposition: event.currentTarget.value as ProposalEditorDraft['evidenceDisposition'] })}><option value="preserved">Evidence still applies</option><option value="needs-review">Needs evidence review</option></select></label>
      <footer><Button onClick={onClose}>Cancel</Button><Button tone="primary" icon="check" disabled={!value.content.trim()} onClick={onSave}>Validate and save</Button></footer>
    </section>
  </div>
}

type ReviewTreeNode = {
  name: string
  path: string
  children: ReviewTreeNode[]
  change?: ProposalChange
}

function ReviewFilePicker({ nodes, selected, fileCount, onSelect }: {
  nodes: ReviewTreeNode[]
  selected: ProposalChange
  fileCount: number
  onSelect: (id: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const filteredNodes = filterReviewFileTree(nodes, query)
  const matchingFiles = countReviewTreeFiles(filteredNodes)
  const selectedName = selected.path.split('/').filter(Boolean).pop() ?? selected.path

  useEffect(() => {
    if (!open) return
    searchInput.current?.focus()
    const closeOnOutsidePress = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      setOpen(false)
      root.current?.querySelector<HTMLButtonElement>('.review-file-picker-trigger')?.focus()
    }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsidePress)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [open])

  const selectFile = (id: string) => {
    onSelect(id)
    setOpen(false)
    setQuery('')
  }

  return <div class="review-file-picker" ref={root}>
    <button
      type="button"
      class={`review-file-picker-trigger ${open ? 'open' : ''}`}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls="review-file-picker-menu"
      onClick={() => setOpen(!open)}
    >
      <Icon name="file" size={15} />
      <strong class="review-file-picker-name">{selectedName}</strong>
      <span class={`review-file-picker-status ${selected.kind}`}>{selected.kind}</span>
      <Icon name="chevronRight" size={13} />
    </button>

    {open && <div id="review-file-picker-menu" class="review-file-picker-menu" role="dialog" aria-label="Changed files">
      <header>
        <span><strong>Changed files</strong><small>{fileCount} file{fileCount === 1 ? '' : 's'} in this proposal</small></span>
        <button type="button" aria-label="Close changed files" onClick={() => setOpen(false)}><Icon name="close" size={14} /></button>
      </header>
      <label class="review-file-search">
        <span class="sr-only">Search changed files</span>
        <Icon name="search" size={15} />
        <input
          class="input"
          ref={searchInput}
          type="search"
          value={query}
          placeholder="Search files or folders…"
          onInput={(event) => setQuery(event.currentTarget.value)}
        />
      </label>
      <div class="review-file-picker-tree">
        {matchingFiles > 0
          ? <ReviewFileTree nodes={filteredNodes} selectedId={selected.id} onSelect={selectFile} />
          : <div class="review-file-search-empty"><Icon name="search" size={18} /><strong>No matching files</strong><small>Try a filename or folder path.</small></div>}
      </div>
      {query.trim() && <footer>{matchingFiles} matching file{matchingFiles === 1 ? '' : 's'}</footer>}
    </div>}
  </div>
}

function proposalFileTree(changes: ProposalChange[]): ReviewTreeNode[] {
  const root: ReviewTreeNode[] = []
  for (const change of changes) {
    const parts = change.path.split('/').filter(Boolean)
    let level = root
    let currentPath = ''
    parts.forEach((part, index) => {
      currentPath = currentPath ? currentPath + '/' + part : part
      const isFile = index === parts.length - 1
      let node = level.find((item) => item.name === part && Boolean(item.change) === isFile)
      if (!node) {
        node = { name: part, path: currentPath, children: [], ...(isFile ? { change } : {}) }
        level.push(node)
      }
      level = node.children
    })
  }
  const sort = (nodes: ReviewTreeNode[]): ReviewTreeNode[] => nodes
    .sort((left, right) => Number(Boolean(left.change)) - Number(Boolean(right.change)) || left.name.localeCompare(right.name))
    .map((node) => ({ ...node, children: sort(node.children) }))
  return sort(root)
}

function filterReviewFileTree(nodes: ReviewTreeNode[], rawQuery: string): ReviewTreeNode[] {
  const query = rawQuery.trim().toLocaleLowerCase()
  if (!query) return nodes
  return nodes.flatMap((node): ReviewTreeNode[] => {
    const matches = node.path.toLocaleLowerCase().includes(query)
    if (node.change) return matches ? [node] : []
    if (matches) return [node]
    const children = filterReviewFileTree(node.children, query)
    return children.length > 0 ? [{ ...node, children }] : []
  })
}

function countReviewTreeFiles(nodes: ReviewTreeNode[]): number {
  return nodes.reduce((count, node) => count + (node.change ? 1 : countReviewTreeFiles(node.children)), 0)
}

function ReviewFileTree({ nodes, selectedId, onSelect, depth = 0 }: {
  nodes: ReviewTreeNode[]
  selectedId: string
  onSelect: (id: string) => void
  depth?: number
}) {
  return <div class={depth === 0 ? 'review-file-tree' : 'review-tree-children'}>
    {nodes.map((node) => node.change
      ? <button type="button" key={node.path} class={'review-tree-file ' + (selectedId === node.change?.id ? 'active' : '')} style={'--tree-depth:' + depth} aria-current={selectedId === node.change.id ? 'true' : undefined} title={node.path} onClick={() => onSelect(node.change!.id)}>
        <span class="review-file-icon"><Icon name="file" size={14} /></span>
        <span class="review-file-copy"><strong>{node.name}</strong></span>
        <Badge tone={statusTone(node.change.kind)}>{node.change.kind}</Badge>
      </button>
      : <details key={node.path} class="review-tree-folder" open>
        <summary style={'--tree-depth:' + depth}><Icon name="chevronRight" size={12} /><Icon name="folder" size={15} /><strong>{node.name}</strong></summary>
        <ReviewFileTree nodes={node.children} selectedId={selectedId} onSelect={onSelect} depth={depth + 1} />
      </details>)}
  </div>
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

function ProposalSourceDiff({ runId, change, act, onReviseHunk }: { runId: string; change: ProposalChange; act: Action; onReviseHunk: (hunkId: string) => void }) {
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
        {group.hunkId && group.state === 'pending' && <span class="hunk-actions"><Button size="sm" onClick={() => onReviseHunk(group.hunkId!)}>Revise</Button><Button size="sm" tone="primary" onClick={() => void act(() => post(`/api/proposals/${runId}/accept`, { scope: 'hunk', changeId: change.id, hunkId: group.hunkId }), 'Change accepted')}>Accept change</Button></span>}
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


/**
 * The deploy CLI prints one checklist line per finished step (`✓ label · detail`,
 * or `✗ label` for the step that failed). Nothing is printed while a step runs,
 * so the labels below name the steps up front and the log fills in the details.
 */
const DEPLOY_STEP_LINE = /^\s*([✓✗])\s+(.+)$/
const ANSI = /\x1b\[[0-9;]*m/g

function deployStepLabels(generator: string | undefined, dryRun: boolean): string[] {
  if (generator === 'doxbrix') {
    return dryRun
      ? ['Validating documentation', 'Building bundle']
      : ['Validating documentation', 'Building bundle', 'Locating project', 'Publishing to Doxbrix']
  }
  return dryRun
    ? ['Validating documentation', 'Building site locally']
    : ['Validating documentation', 'Locating project', 'Building site locally', 'Reserving secure upload', 'Uploading static artifact', 'Indexing and deploying']
}

interface DeployStep {
  label: string
  detail?: string
  status: 'done' | 'failed' | 'running' | 'pending'
}

function deploySteps(job: UiJob, labels: string[]): { steps: DeployStep[]; percent: number } {
  const reported: Array<{ text: string; ok: boolean }> = []
  for (const raw of job.lines) {
    const match = DEPLOY_STEP_LINE.exec(raw.replace(ANSI, ''))
    if (match) reported.push({ text: (match[2] ?? '').trim(), ok: match[1] === '✓' })
  }
  const running = job.status === 'running'
  const steps: DeployStep[] = labels.map((label, index) => {
    const entry = reported[index]
    if (entry) {
      const [text, detail] = entry.text.split(' · ')
      return { label: text || label, ...(detail ? { detail } : {}), status: entry.ok ? 'done' : 'failed' }
    }
    if (index === reported.length && running) return { label, status: 'running' }
    return { label, status: 'pending' }
  })
  const done = steps.filter((step) => step.status === 'done').length
  const percent = job.status === 'succeeded'
    ? 100
    : Math.min(95, Math.round((done / Math.max(labels.length, 1)) * 100) + (running ? 6 : 0))
  return { steps, percent }
}

/** Live checklist, progress bar and log for the deployment that is running (or just finished). */
function DeployProgress({ job, generator, act, streamConnected }: {
  job: UiJob
  generator: string | undefined
  act: Action
  streamConnected: boolean
}) {
  const log = useRef<HTMLPreElement>(null)
  const [logOpen, setLogOpen] = useState(true)
  const dryRun = job.type === 'deploy:dry-run'
  const { steps, percent } = deploySteps(job, deployStepLabels(generator, dryRun))
  const running = job.status === 'running'
  const active = steps.find((step) => step.status === 'running')
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [job.lines.length, logOpen])
  const headline = running
    ? active?.label ?? (dryRun ? 'Validating deployment' : 'Deploying documentation')
    : job.status === 'succeeded'
      ? dryRun ? 'Deployment is valid' : 'Documentation published'
      : job.status === 'cancelled' ? 'Deployment cancelled' : 'Deployment failed'
  return <section class={`deploy-progress ${job.status}`} aria-live="polite">
    <header class="deploy-progress-head">
      <span class={`deploy-progress-icon ${job.status}`}>
        <Icon name={running ? 'publish' : job.status === 'succeeded' ? 'check' : 'alert'} size={19} />
      </span>
      <div class="deploy-progress-title">
        <strong>{headline}</strong>
        <small>{dryRun ? 'Validation only — nothing is uploaded.' : 'Uploading the documentation snapshot to Doxbrix.'}</small>
      </div>
      {running
        ? <Badge tone={streamConnected ? 'good' : 'warn'} icon="broadcast">{streamConnected ? 'Live' : 'Reconnecting…'}</Badge>
        : <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge>}
      {running && <Button size="sm" tone="danger" icon="stop" onClick={() => void act(() => post(`/api/jobs/${job.id}/cancel`), 'Deployment stopped')}>Stop</Button>}
    </header>
    <div class="deploy-progress-bar">
      <div class={`deploy-progress-track ${running ? 'running' : ''}`}><i style={{ width: `${percent}%` }} /></div>
      <span>{percent}%</span>
    </div>
    <ol class="deploy-progress-steps">
      {steps.map((step, index) => <li key={index} class={step.status}>
        <span class="deploy-step-mark">{step.status === 'done'
          ? <Icon name="check" size={12} />
          : step.status === 'failed' ? <Icon name="close" size={12} /> : null}</span>
        <span class="deploy-step-copy"><strong>{step.label}</strong>{step.detail && <small>{step.detail}</small>}</span>
      </li>)}
    </ol>
    <div class="deploy-progress-log">
      <div class="live-job-meta">
        <button type="button" class="deploy-log-toggle" aria-expanded={logOpen} onClick={() => setLogOpen(!logOpen)}>
          <Icon name="chevronDown" size={14} />{logOpen ? 'Hide log' : 'Show log'}
        </button>
        <span><Icon name="clock" size={14} />Last output {timeText(job.lastOutputAt ?? job.startedAt)}</span>
        <span class="authoring-live-actions">
          <a href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer">Open full log <Icon name="external" size={12} /></a>
        </span>
      </div>
      {logOpen && <pre ref={log} class="terminal live-terminal">{job.lines.length > 0 ? job.lines.join('\n') : 'Starting deployment…'}</pre>}
    </div>
  </section>
}

function Publish({ state, act, streamConnected, onError }: { state: UiState; act: Action; streamConnected: boolean; onError: (error: string) => void }) {
  const effective = state.effectiveDeployment!
  const [deployment, setDeployment] = useState(effective)
  /** Visibility is asked once. An explicit saved choice means every later deploy runs straight away. */
  const chosenVisibility = state.project?.deployment?.visibility
  const [dialog, setDialog] = useState<'first' | 'change' | null>(null)
  const [choice, setChoice] = useState<'private' | 'public'>(deployment.visibility === 'public' ? 'public' : 'private')
  const [starting, setStarting] = useState(false)
  /** Set when a deploy is attempted while signed out, so the reason is explained in place. */
  const [signInRequired, setSignInRequired] = useState(false)
  const account = state.account
  const signedIn = Boolean(account?.signedIn)
  const activeDeploy = state.jobs.find((job) => job.type.startsWith('deploy') && job.status === 'running')
  const busy = Boolean(activeDeploy || starting)
  const isPublic = deployment.visibility === 'public'
  const deployments = useHistoryFeed<DeploymentRecord>(
    '/api/history/deployments?limit=25',
    (payload) => (payload.deployments as DeploymentRecord[]) ?? [],
    state.jobs,
    onError,
  )
  /**
   * Doxbrix hosts the reader site on a slug it provisions, so the live lookup is
   * the source of truth. Deployments recorded before Doxloop read `hostedUrl`
   * stored an editor link, which must never be offered as the deployed site.
   */
  const [siteUrl, setSiteUrl] = useState<string | null>(null)
  const settledDeploys = state.jobs.filter((job) => job.type.startsWith('deploy') && job.status !== 'running').length
  useEffect(() => {
    if (!signedIn) return
    let current = true
    void api<{ url: string | null }>('/api/deployment/site')
      .then((payload) => { if (current) setSiteUrl(payload.url) })
      .catch(() => undefined)
    return () => { current = false }
  }, [signedIn, settledDeploys])
  const recordedUrl = deployments.entries.find((entry) => entry.status === 'succeeded' && entry.url)?.url
  const publishedUrl = siteUrl ?? (recordedUrl && !recordedUrl.includes('/editor?project=') ? recordedUrl : undefined)

  const start = async (visibility: 'private' | 'public', dryRun: boolean) => {
    setStarting(true)
    try {
      await act(
        () => post('/api/deploy', { ...deployment, visibility, public: visibility === 'public', dryRun }),
        dryRun ? 'Deployment validation started' : 'Deployment started',
      )
    } finally {
      setStarting(false)
    }
  }
  const saveVisibility = async (visibility: 'private' | 'public') => {
    const next = { ...deployment, visibility }
    setDeployment(next)
    return act(() => patch('/api/project', { deployment: next }), undefined)
  }
  const deploy = async (dryRun: boolean) => {
    if (busy) return
    if (!signedIn) {
      setSignInRequired(true)
      return
    }
    setSignInRequired(false)
    if (!dryRun && !chosenVisibility) {
      setChoice(isPublic ? 'public' : 'private')
      setDialog('first')
      return
    }
    await start(isPublic ? 'public' : 'private', dryRun)
  }
  const confirmFirstDeploy = async () => {
    setDialog(null)
    const saved = await saveVisibility(choice)
    if (saved === undefined) return
    await start(choice, false)
  }

  return <div class="publish-page">
    {dialog && <div class="proposal-ready-scrim" role="presentation">
      <section class="proposal-ready-dialog visibility-dialog" role="dialog" aria-modal="true" aria-labelledby="visibility-dialog-title">
        <button class="proposal-ready-close" type="button" aria-label="Close" onClick={() => setDialog(null)}><Icon name="close" size={16} /></button>
        <span class="proposal-ready-icon"><Icon name="shield" size={24} /></span>
        <div>
          <h2 id="visibility-dialog-title">{dialog === 'first' ? 'Who can see this documentation?' : 'Deployment visibility'}</h2>
          <p>{dialog === 'first'
            ? 'Choose once — later deployments publish with this setting without asking again.'
            : 'This applies to the next and every following deployment.'}</p>
        </div>
        <div class="visibility-card-grid" role="radiogroup" aria-label="Deployment visibility">
          <button type="button" role="radio" aria-checked={choice === 'private'} class={`visibility-card ${choice === 'private' ? 'selected' : ''}`} onClick={() => setChoice('private')}>
            <span class="visibility-card-icon private"><Icon name="lock" size={20} /></span>
            <span><strong>Private</strong><small>Only signed-in members with access can open the documentation.</small></span>
            <i class="visibility-radio"><Icon name="check" size={12} /></i>
          </button>
          <button type="button" role="radio" aria-checked={choice === 'public'} class={`visibility-card ${choice === 'public' ? 'selected' : ''}`} onClick={() => setChoice('public')}>
            <span class="visibility-card-icon public"><Icon name="cloud" size={20} /></span>
            <span><strong>Public</strong><small>Anyone with the published URL can open the documentation.</small></span>
            <i class="visibility-radio"><Icon name="check" size={12} /></i>
          </button>
        </div>
        <footer>
          <Button onClick={() => setDialog(null)}>Cancel</Button>
          {dialog === 'first'
            ? <Button tone="primary" icon="publish" onClick={() => void confirmFirstDeploy()}>Deploy {choice === 'public' ? 'publicly' : 'privately'}</Button>
            : <Button tone="primary" icon="check" onClick={() => { setDialog(null); void saveVisibility(choice) }}>Save visibility</Button>}
        </footer>
      </section>
    </div>}

    <PageHeader
      title="Deploy"
      description="Deploy the generated documentation to Doxbrix. Configured product sources are never included."
      actions={publishedUrl
        ? <a class="btn secondary md" href={publishedUrl} target="_blank" rel="noreferrer"><Icon name="external" size={16} />View deployed docs</a>
        : undefined}
    />

    <section class="publish-card">
      <header class="publish-card-head">
        <span class="publish-card-icon"><Icon name="publish" size={20} /></span>
        <div>
          <h2>Deploy to Doxbrix</h2>
          <p>{chosenVisibility
            ? `This documentation publishes ${isPublic ? 'publicly' : 'privately'} — no further prompts.`
            : 'The first deployment asks who can see the documentation.'}</p>
        </div>
        {signedIn
          ? <Badge tone="good" icon="check">Signed in</Badge>
          : <Badge tone="warn" icon="alert">Not signed in</Badge>}
      </header>

      <dl class="publish-destination">
        <div><dt>Project</dt><dd>{deployment.name}</dd></div>
        <div><dt>Address</dt><dd><code class="mono">{deployment.slug}</code></dd></div>
        <div><dt>Doxbrix</dt><dd><code class="mono">{deployment.apiUrl}</code></dd></div>
        <div class="publish-destination-visibility">
          <dt>Visibility</dt>
          <dd>
            <span class={`visibility-pill ${isPublic ? 'public' : 'private'}`}><Icon name={isPublic ? 'cloud' : 'lock'} size={13} />{isPublic ? 'Public' : 'Private'}</span>
            {chosenVisibility
              ? <button type="button" class="publish-link-button" onClick={() => { setChoice(isPublic ? 'public' : 'private'); setDialog('change') }}>Change</button>
              : <small>Chosen on first deploy</small>}
          </dd>
        </div>
      </dl>

      {signedIn
        ? <div class="publish-account-row">
          <span class="avatar">{account?.user?.email.slice(0, 1).toUpperCase()}</span>
          <span class="publish-account-identity">
            <strong>{account?.user?.name ?? account?.user?.email}</strong>
            <small>{account?.user?.email}</small>
          </span>
          <Button icon="logout" onClick={() => void act(() => post('/api/auth/logout'), 'Signed out')}>Sign out</Button>
        </div>
        : <div class="publish-account-row signed-out">
          <span class="avatar muted"><Icon name="user" size={18} /></span>
          <span class="publish-account-identity">
            <strong>Not signed in</strong>
            <small>{account?.detail ?? 'Deploying needs a connected Doxbrix account.'}</small>
          </span>
          <Button tone="primary" icon="key" onClick={() => { setSignInRequired(false); void act(() => post('/api/auth/login', { apiUrl: deployment.apiUrl }), 'Browser sign-in started') }}>Sign in with browser</Button>
        </div>}

      {signInRequired && !signedIn && <div class="publish-signin-required" role="alert">
        <Icon name="alert" size={16} />
        <span>
          <strong>Sign in with Doxbrix to deploy the documentation.</strong>
          <small>Deploying uploads the documentation to your Doxbrix account, so use “Sign in with browser” above to connect it first.</small>
        </span>
      </div>}

      <footer class="publish-card-actions">
        <Button class="publish-deploy-button" tone="primary" icon="publish" busy={busy} onClick={() => void deploy(false)}>Deploy to Doxbrix</Button>
        <Button disabled={busy} onClick={() => void deploy(true)}>Dry run</Button>
        <small>A dry run validates and builds the bundle without uploading anything.</small>
      </footer>
    </section>

    {activeDeploy && <DeployProgress job={activeDeploy} generator={state.project?.generator} act={act} streamConnected={streamConnected} />}

    <Panel
      class="history-panel"
      title="Deployment history"
      description="Past deployments, including the ones that did not succeed."
    >
      <DeploymentHistory {...deployments} />
    </Panel>
  </div>
}

const SETTINGS_SECTIONS = [
  ['general', 'General', 'Project identity and defaults', 'settings'],
  ['experience', 'Audience and voice', 'Writing style and accessibility', 'book'],
  ['capture', 'Visual evidence', 'Application screenshots', 'preview'],
  ['tools', 'Generator', 'Active documentation generator', 'publish'],
] as const

function Settings({ state, act }: { state: UiState; act: Action }) {
  const project = state.project!
  const [section, setSection] = useState<typeof SETTINGS_SECTIONS[number][0]>('general')
  const [identity, setIdentity] = useState({ title: project.title, defaultAgent: project.defaultAgent ?? '' })
  const [docs, setDocs] = useState({ ...project.documentation, audiencesText: project.documentation.audiences?.join(', ') ?? '', customInstructions: project.documentation.customInstructions ?? '', outcomesText: project.documentation.priorityOutcomes?.join(', ') ?? '', preferredExamplesText: project.documentation.preferredExamples?.join(', ') ?? '', toneText: project.documentation.tone.join(', '), exclusionsText: project.documentation.exclusions.join('\n'), termsText: termText(project.documentation.terminology) })
  const [application, setApplication] = useState({
    baseUrl: project.application?.baseUrl ?? '',
    source: project.application?.source ?? '',
    readyPath: project.application?.readyPath ?? '',
    policy: project.application?.screenshots?.policy ?? 'requested',
    highlight: project.application?.screenshots?.highlight ?? true,
    startPath: project.application?.screenshots?.startPath ?? '/',
    workflow: project.application?.screenshots?.workflow ?? '',
    viewportWidth: String(project.application?.screenshots?.viewport?.width ?? 1440),
    viewportHeight: String(project.application?.screenshots?.viewport?.height ?? 900),
  })
  const [applicationReadiness, setApplicationReadiness] = useState<ApplicationReadiness>()
  const [testingApplication, setTestingApplication] = useState(false)
  const applicationPayload = { baseUrl: application.baseUrl, source: application.source, readyPath: application.readyPath, screenshots: { policy: application.policy, highlight: application.highlight, viewport: { width: application.viewportWidth, height: application.viewportHeight }, startPath: application.startPath, workflow: application.workflow } }
  const testApplication = async () => {
    setTestingApplication(true)
    try { setApplicationReadiness(await post<ApplicationReadiness>('/api/application/readiness', applicationPayload)) }
    catch { setApplicationReadiness(undefined) }
    finally { setTestingApplication(false) }
  }
  const saveDocs = () => act(() => patch('/api/project', { documentation: { ...docs, audiences: splitComma(docs.audiencesText), priorityOutcomes: splitComma(docs.outcomesText), preferredExamples: splitComma(docs.preferredExamplesText), tone: splitComma(docs.toneText), exclusions: docs.exclusionsText.split('\n').map((item) => item.trim()).filter(Boolean), terminology: parseTerms(docs.termsText) } }), 'Documentation preferences saved')
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
          <KeyValues items={[['Content directory', <code class="mono">{project.contentDir || 'Project root'}</code>], ['Generator', generatorLabel(state.generators, project.generator)], ['Workspace', <code class="mono">{state.root ?? state.cwd}</code>]]} />
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
            <Field label="Preferred examples"><Input value={docs.preferredExamplesText} placeholder="TypeScript, curl" onInput={(event) => setDocs({ ...docs, preferredExamplesText: event.currentTarget.value })} /></Field>
            <Field label="Design direction"><Input value={docs.designDirection ?? ''} placeholder="Compact, task-led developer documentation" onInput={(event) => setDocs({ ...docs, designDirection: event.currentTarget.value })} /></Field>
            <Field label="Standards profile"><Input value={docs.standardsProfile} onInput={(event) => setDocs({ ...docs, standardsProfile: event.currentTarget.value })} /></Field>
            <Field label="Style guide"><Input value={docs.styleGuide} onInput={(event) => setDocs({ ...docs, styleGuide: event.currentTarget.value })} /></Field>
            <Field label="Preferred terminology" hint="One “term = replacement” per line"><Textarea rows={5} value={docs.termsText} onInput={(event) => setDocs({ ...docs, termsText: event.currentTarget.value })} /></Field>
            <Field label="Content exclusions" hint="One item per line"><Textarea rows={5} value={docs.exclusionsText} onInput={(event) => setDocs({ ...docs, exclusionsText: event.currentTarget.value })} /></Field>
            <Field label="Instructions" hint="Additional guidance reused for future documentation runs" wide><Textarea rows={5} value={docs.customInstructions} placeholder="Use concise explanations and include TypeScript examples." onInput={(event) => setDocs({ ...docs, customInstructions: event.currentTarget.value })} /></Field>
          </div>
          <div class="form-actions"><Button tone="primary" onClick={() => void saveDocs()}>Save changes</Button></div>
        </Panel>}

        {section === 'capture' && <>
          <Panel title="Application screenshots" description="Configure a safe local or test application for guide screenshots.">
            <div class="form-grid">
              <Field label="Application base URL"><Input value={application.baseUrl} placeholder="http://localhost:3000" onInput={(event) => setApplication({ ...application, baseUrl: event.currentTarget.value })} /></Field>
              <Field label="Product source"><Select value={application.source} onChange={(event) => setApplication({ ...application, source: event.currentTarget.value })}><option value="">None</option>{project.sources.map((source) => <option value={source.name}>{source.name}</option>)}</Select></Field>
              <Field label="Ready path"><Input value={application.readyPath} placeholder="/health" onInput={(event) => setApplication({ ...application, readyPath: event.currentTarget.value })} /></Field>
              <Field label="Default starting route"><Input value={application.startPath} placeholder="/settings/team" onInput={(event) => setApplication({ ...application, startPath: event.currentTarget.value })} /></Field>
              <Field label="Screenshot policy"><Select value={application.policy} onChange={(event) => setApplication({ ...application, policy: event.currentTarget.value })}><option value="requested">Only when requested</option><option value="auto">Automatically for UI workflows</option><option value="off">Never</option></Select></Field>
              <Field label="Viewport width"><Input type="number" min="320" max="3840" value={application.viewportWidth} onInput={(event) => setApplication({ ...application, viewportWidth: event.currentTarget.value })} /></Field>
              <Field label="Viewport height"><Input type="number" min="320" max="2160" value={application.viewportHeight} onInput={(event) => setApplication({ ...application, viewportHeight: event.currentTarget.value })} /></Field>
              <Field label="Capture workflow guidance" hint="Safe test state, authentication, actions, and expected outcomes" wide><Textarea rows={4} value={application.workflow} placeholder="Reuse the signed-in demo workspace and synthetic data only." onInput={(event) => setApplication({ ...application, workflow: event.currentTarget.value })} /></Field>
            </div>
            <Toggle checked={application.highlight} onChange={(checked) => setApplication({ ...application, highlight: checked })} label="Highlight captured controls" />
            {applicationReadiness && <div class={`plan-capture-readiness ${applicationReadiness.reachable ? 'ready' : 'missing'}`}><Icon name={applicationReadiness.reachable ? 'check' : 'info'} size={15} /><span><strong>{applicationReadiness.reachable ? 'Application reachable' : 'Application not reachable'}</strong><small>{applicationReadiness.message}</small></span></div>}
            <div class="form-actions">
              <Button tone="danger" onClick={() => void act(() => patch('/api/project', { application: null }), 'Application configuration removed')}>Remove</Button>
              <Button disabled={!application.baseUrl} busy={testingApplication} onClick={() => void testApplication()}>Test application</Button>
              <Button tone="primary" disabled={!application.baseUrl} onClick={() => void act(() => patch('/api/project', { application: applicationPayload }), 'Application settings saved')}>Save application</Button>
            </div>
          </Panel>
        </>}

        {section === 'tools' && <Panel title="Documentation generator" description="The generator selected for this workspace." flush>
          <Table head={<><th>Generator</th><th>Status</th></>}>
            {state.generators.filter((generator) => generator.id === project.generator).map((generator) => <tr key={generator.id}>
              <td><div class="cell-lead"><span class="generator-mark">{generator.displayName.slice(0, 1)}</span><div class="row-copy"><strong>{generator.displayName}</strong><small>{generator.id === 'doxbrix' ? 'Built in' : generator.packageName ?? generator.id}</small></div></div></td>
              <td><Badge tone="good" icon="check">Active</Badge></td>
            </tr>)}
          </Table>
        </Panel>}
      </div>
    </div>
  </>
}




type Action = <T>(run: () => Promise<T>, success?: string, refresh?: boolean) => Promise<T | undefined>

/** Proposal states a reviewer can still act on. */
const OPEN_STATUSES = ['awaiting-review', 'partially-applied', 'conflicted']

function statusTone(status: string): string {
  if (['applied', 'accepted', 'approved', 'generated', 'succeeded', 'pass', 'added'].includes(status)) return 'good'
  if (['awaiting-review', 'ready-for-review', 'planning', 'revising', 'generating', 'pending', 'running', 'modified'].includes(status)) return 'info'
  if (['needs-input', 'stale', 'partially-applied', 'conflicted'].includes(status)) return 'warn'
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

function documentationExists(state: UiState): boolean {
  if (state.receipt?.completedAt) return true
  return validRuns(state.runs).some((run) => run.status === 'applied' || run.status === 'partially-applied')
}

function shouldShowAuthoringForm(state: UiState): boolean {
  const plan = state.documentationPlan
  if (!plan || plan.status === 'cancelled') return true
  if (plan.status !== 'generated') return false
  const proposal = plan.proposalId ? validRuns(state.runs).find((run) => run.id === plan.proposalId) : undefined
  // A generated plan without a loaded proposal is treated as pending so the UI
  // never flashes a second create form while proposal state is being loaded.
  return proposal ? !OPEN_STATUSES.includes(proposal.status) : false
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
