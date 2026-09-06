import { Comments, BulkMetadata, AuditTools, Estimate, Collections } from './WorkspaceTools'
import { TextEditor, PageTools } from './TextEditor'
import { workspaceStatus, coverageRefreshKey } from './workspace-status'
import { useEffect, useRef, useState } from 'preact/hooks'
import './WorkspaceApplication.css'
import './ContentTools.css'
import { api, patch, post, put, remove } from './api'
import {
  Badge, Button, Combo, Empty, Field, Input, KeyValues, Lines, Note, PageHeader,
  Panel, Segmented, Select, Stat, Table, Tabs, Textarea, Toggle, parseTerms, splitComma, termText, timeText,
} from './components'
import { Icon } from './icons'
import { settledPageEditJobs, settledPlanJobs } from './job-transitions'
import { agentModels, defaultModelForAgent, modelReasoningLevels, preferredReasoningLevel } from './model-options'
import { countPlanPages, groupPlanPages, planActionLabel, planApprovalControls, type PlanPageFilter } from './plan-review'
import { canonicalWorkspacePath, workspacePath, workspaceRoute, type ResolvedWorkspaceRoute, type WorkspaceParams, type WorkspaceRoute } from './routes'
import { setLocation, useSearchParams } from './url-state'
import { PollFailureTracker } from './polling'
import { useSeededForm } from './form-sync'
import { screenshotIntentFromChoice } from './setup-plan'
import { ProjectSwitcher } from './ProjectSwitcher'
import { AgentCapabilityMatrix } from './agent-capabilities'
import { ProposalRationaleDrawer, ProposalRenderedDiff, ProposalSourceDiff } from './proposal-diff'
import { AssetLibrary, AssetPicker, readFileAsBase64 } from './AssetLibrary'
import { BrandingPanel } from './BrandingPanel'
import { GlossaryPanel, PageMetadataForm, ReleaseTemplateFields, TermsEditor, recordFromTerms, termsFromRecord, type ReleaseTemplateForm } from './content-types'
import { NavigationView, PlanNavigationEditor } from './NavigationView'
import { defaultReviewChange, hunkStateKey, reviewFileGroups } from './review-presentation'
import type { AgentState, CoverageItem, DeploymentRecord, DocumentationPlan, DocumentationPlanPage, DriftSummary, Failed, GeneratorEntry, HistoryChangedPage, HistoryPageEntry, HistoryRequest, PageSummary, Proposal, ProposalChange, Source, SourceIntelligence, SyncConfig, UiJob, UiState, Validation } from './types'

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
  ['pages', 'Pages', 'file'],
  ['proposals', 'Review', 'review'],
  ['publish', 'Deploy', 'deploy'],
  ['settings', 'Settings', 'settings'],
] as const

const PAGE_TITLES: Record<Page, string> = {
  overview: 'Overview',
  sources: 'Sources',
  authoring: 'Create / Update',
  pages: 'Pages',
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
  /** Open the setup wizard for another project while this one stays registered. */
  onNewProject: () => void
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
  onNewProject,
}: WorkspaceApplicationProps) {
  const project = state.project!
  const [page, setPage] = useState<Page>(() => {
    // Old page names and the bare root land on their canonical address so a
    // bookmark or a `doxloop ui --page` link never shows a stale URL.
    const canonical = canonicalWorkspacePath(location.pathname, location.search)
    if (canonical) history.replaceState({}, '', canonical)
    return workspaceRoute(location.pathname)
  })
  const [navOpen, setNavOpen] = useState(false)
  const [jobStreamConnected, setJobStreamConnected] = useState(false)
  const [readyProposal, setReadyProposal] = useState<Proposal | null>(null)
  const [syncNotice, setSyncNotice] = useState<SyncNotice | null>(null)
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
    const settledPageEdits = settledPageEditJobs(jobs, previouslyRunning, announcedJobIds.current)
    const settledRevisions = jobs.filter((job) =>
      (job.type.startsWith('proposal:revise:') || job.type.startsWith('proposal:resume:')) &&
      job.status !== 'running' &&
      previouslyRunning.has(job.id) &&
      !announcedJobIds.current.has(job.id),
    )
    // A source check reports its result in a notice rather than only in the
    // log, so "Check now" answers the question it was asked.
    const settledSyncs = jobs.filter((job) =>
      job.type === 'sync' && job.status !== 'running' && previouslyRunning.has(job.id) && !announcedJobIds.current.has(job.id),
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
    for (const job of settledSyncs) {
      announcedJobIds.current.add(job.id)
      setSyncNotice(syncOutcomeNotice(job))
      void reload()
    }
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
          setLocation('proposals', { proposal: proposal.id }, 'push')
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
          setLocation('proposals', { proposal: proposal.id }, 'push')
          setPage('proposals')
        } catch (cause) {
          onError(message(cause))
        }
      })()
    }
    for (const job of settledPageEdits) {
      announcedJobIds.current.add(job.id)
      void (async () => {
        await reload()
        const runId = job.type.slice('page-edit:'.length)
        try {
          const proposals = await api<Proposal[]>('/api/proposals')
          if (!proposals.some((run) => run.id === runId && run.editRequest)) return
          // The Pages view reads the run id from the URL on popstate, so a
          // synthetic event lets it pick up the finished edit even when it is
          // already mounted.
          setLocation('pages', { run: runId })
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
          if (proposal.editRequest) {
            setLocation('pages', { run: proposal.id })
          } else {
            setReadyProposal(proposal)
            setLocation('proposals', { proposal: proposal.id }, 'push')
            setPage('proposals')
          }
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
  // A poll that fails once is usually the server being busy with the agent.
  // Only a run of failures is worth interrupting the reader for.
  const pollFailures = useRef(new PollFailureTracker())
  useEffect(() => {
    if (!jobsRunning) return
    const timer = window.setInterval(async () => {
      try {
        const jobs = await api<UiJob[]>('/api/jobs')
        pollFailures.current.succeeded()
        receiveJobs(jobs)
        if (!jobs.some((job) => job.status === 'running')) void reload()
      } catch (cause) {
        if (pollFailures.current.failed()) onError(`The control center stopped answering: ${message(cause)}`)
      }
    }, 1800)
    return () => clearInterval(timer)
  }, [jobsRunning])

  const navigate = (next: WorkspaceRoute, params: WorkspaceParams = {}) => {
    history.pushState({}, '', workspacePath(next, params))
    setPage(next)
    setNavOpen(false)
  }

  const openPreview = async () => {
    const previewTab = window.open('about:blank', '_blank')
    if (previewTab) previewTab.opener = null
    try {
      const result = await post<{ url: string }>('/api/preview/start', { open: !previewTab })
      previewTab?.location.replace(result.url)
      void reload()
    } catch (cause) {
      previewTab?.close()
      onError(message(cause))
    }
  }

  const runningJobs = state.jobs.filter((job) => job.status === 'running').length

  return <div class={`shell ${page === 'proposals' ? 'proposal-shell' : ''} ${page === 'pages' ? 'pages-shell' : ''} ${page === 'sources' ? 'sources-shell' : ''}`}>
    {navOpen && <button class="nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}

    {readyProposal && <div class="proposal-ready-scrim" role="presentation">
      <section class="proposal-ready-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-ready-title">
        <button class="proposal-ready-close" type="button" aria-label="Close" onClick={() => setReadyProposal(null)}><Icon name="close" size={16} /></button>
        <span class="proposal-ready-icon"><Icon name="proposals" size={24} /></span>
        <div><h2 id="proposal-ready-title">Documentation changes are ready</h2><p>Your update finished successfully. Review the proposed changes before they replace the current documentation.</p></div>
        <div class="proposal-ready-summary"><strong>{proposalSummaryText(readyProposal.changes)}</strong><span>The current documentation remains unchanged until you accept the proposal.</span></div>
        <footer><Button icon="external" onClick={() => void openProposalPreview(readyProposal.id, onError)}>Preview changes</Button><Button tone="primary" icon="proposals" onClick={() => { const ready = readyProposal; setReadyProposal(null); navigate('proposals', { proposal: ready.id }) }}>Review changes</Button></footer>
      </section>
    </div>}

    <aside class={`sidebar ${navOpen ? 'open' : ''}`}>
      <div class="sidebar-brand-row">
        <button class="workspace-brand" type="button" aria-label="Doxloop" onClick={() => navigate('overview')}><img src={DOXLOOP_LOGO} alt="Doxloop" /></button>
        <button class="sidebar-close" type="button" aria-label="Close navigation" onClick={() => setNavOpen(false)}><Icon name="close" size={16} /></button>
      </div>
      <ProjectSwitcher
        state={state}
        onNewProject={onNewProject}
        onError={onError}
        onSwitched={async () => {
          // The address and every screen's state belonged to the previous
          // project, so the new one starts from a clean load of its overview.
          window.location.replace(workspacePath('overview'))
        }}
      />
      <nav class="reference-sidebar-nav" aria-label="Main navigation">
        {NAV.map(([id, label, icon]) => <button key={id} class={`nav-item ${page === id ? 'active' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>
          <span class="nav-glyph"><Icon name={icon} size={17} /></span>
          <span class="nav-copy"><span>{id === 'authoring' ? authoringNavigationLabel : label}</span></span>
          {id === 'proposals' && pendingProposalCount > 0 && <b class="nav-count" aria-label={`${pendingProposalCount} pending proposal${pendingProposalCount === 1 ? '' : 's'}`}>{pendingProposalCount}</b>}
        </button>)}
      </nav>
      <button type="button" class="new-project-button" onClick={onNewProject}>
        <span class="nav-glyph"><Icon name="plus" size={15} /></span>
        <span><strong>New documentation project</strong><small>Start new or import existing docs</small></span>
      </button>
    </aside>

    <main class="workspace-main">
      <header class="workspace-navbar">
        <button class="workspace-mobile-menu" type="button" aria-label="Open navigation" onClick={() => setNavOpen(true)}><Icon name="menu" size={18} /></button>
        <div class="workspace-crumbs">
          <button type="button" class="workspace-crumb" onClick={() => navigate('overview')}>{project.title}</button>
          <Icon name="chevronRight" size={14} />
          <strong class="workspace-screen-title">{page === 'authoring' ? `${authoringNavigationLabel} documentation` : PAGE_TITLES[page]}</strong>
        </div>
        <span class="workspace-navbar-spacer" />
        {runningJobs > 0 && <button type="button" class="workspace-activity-chip" title="Open running task progress" onClick={() => { const job = state.jobs.find((item) => item.status === 'running' && !item.type.includes('preview')); const id = job?.type.match(/^proposal:(?:revise|resume):(.+)$/)?.[1]; if (id) location.assign(`/review?proposal=${encodeURIComponent(id)}`); else { navigate(job?.type.startsWith('page-edit:') ? 'pages' : 'authoring'); } }}><i />{runningJobs === 1 ? '1 task running' : `${runningJobs} tasks running`}</button>}
        <a class="workspace-support-link" href="https://github.com/doxbrix/doxloop" target="_blank" rel="noreferrer"><Icon name="help" size={15} />Support</a>
        <button type="button" class="workspace-preview-primary" onClick={() => void openPreview()}><Icon name="preview" size={15} /><strong>Preview docs</strong><Icon name="external" size={12} /></button>
      </header>
      <div class="main">
        <div class="page">
        {loading && <div class="loading-bar" />}
        {error && <Banner title="Action failed" detail={error} onClose={onErrorDismiss} />}
        {syncNotice && <div class={`page-updated-toast sync-outcome-toast ${syncNotice.tone}`} role="status">
          <span class="toast-icon"><Icon name={syncNotice.tone === 'good' ? 'check' : syncNotice.tone === 'bad' ? 'alert' : 'info'} size={15} /></span>
          <span class="toast-copy"><strong>{syncNotice.title}</strong><small>{syncNotice.detail}</small></span>
          {syncNotice.proposalId && <Button size="sm" onClick={() => { setSyncNotice(null); navigate('proposals', { proposal: syncNotice.proposalId! }) }}>Review</Button>}
          <button type="button" class="toast-close" aria-label="Dismiss" onClick={() => setSyncNotice(null)}><Icon name="close" size={14} /></button>
        </div>}
        {page === 'overview' && <Overview state={state} act={act} navigate={navigate} openPreview={openPreview} />}
        {page === 'sources' && <SourcesReference state={state} act={act} navigate={navigate} />}
        {page === 'authoring' && <Authoring state={state} act={act} streamConnected={jobStreamConnected} onError={onError} />}
        {page === 'pages' && <Pages state={state} act={act} streamConnected={jobStreamConnected} onError={onError} />}
        {page === 'proposals' && <Proposals state={state} act={act} onError={onError} />}
        {page === 'publish' && <Publish state={state} act={act} streamConnected={jobStreamConnected} onError={onError} />}
        {page === 'settings' && <Settings state={state} act={act} onError={onError} />}
        {page === 'not-found' && <NotFound navigate={navigate} />}
        </div>
      </div>
    </main>
  </div>
}

function Overview({ state, act, navigate, openPreview }: { state: UiState; act: Action; navigate: (page: WorkspaceRoute, params?: WorkspaceParams) => void; openPreview: () => Promise<void> }) {
  const project = state.project!
  const [intelligence, setIntelligence] = useState<SourceIntelligence>()
  useEffect(() => {
    let active = true
    void api<SourceIntelligence>('/api/source-intelligence')
      .then((report) => { if (active) setIntelligence(report) })
      .catch(() => undefined)
    return () => { active = false }
  }, [coverageRefreshKey(state)])

  const proposals = validRuns(state.runs)
  const openProposal = proposals.find((run) => OPEN_STATUSES.includes(run.status))
  const measuredCoverage = intelligence?.coverage.metrics.filter((metric) => metric.status !== 'unknown') ?? []
  const documentedItems = measuredCoverage.reduce((total, metric) => total + metric.documented, 0)
  const discoveredItems = measuredCoverage.reduce((total, metric) => total + metric.total, 0)
  const coverage = discoveredItems > 0 ? Math.round((documentedItems / discoveredItems) * 100) : 0
  const coverageLabel = !intelligence ? 'Checking evidence' : coverage >= 90 ? 'Strong coverage' : coverage >= 70 ? 'Good foundation' : coverage >= 40 ? 'Gaps remain' : 'Needs attention'
  const hasDocs = documentationExists(state)
  const plan = state.documentationPlan
  const deployedSlug = state.effectiveDeployment?.slug ?? project.deployment?.slug
  const published = state.latestDeployment
  const deployedAddress = published?.url ?? (published ? 'Deployment recorded' : 'Nothing published yet')
  const latestTimestamp = state.jobs[0]?.finishedAt ?? state.jobs[0]?.startedAt ?? plan?.updatedAt
  const changed = openProposal?.changes ?? []
  const added = changed.filter((change) => change.kind === 'added').length
  const modified = changed.filter((change) => change.kind !== 'added' && change.kind !== 'deleted').length
  const recentJobs = state.jobs.slice(0, 5)
  const running = state.jobs.filter((job) => job.status === 'running').length
  const validation = validationState(state.validation)
  const issues = validation.ok ? validation.result.issues : []
  const errors = validation.ok ? validation.result.errors : 0
  const warnings = validation.ok ? validation.result.warnings : 0
  const pageCount = validation.ok ? validation.result.pages.length : plan?.pages.filter((page) => page.priority !== 'later').length ?? 0
  const agent = preferredAgent(state.agents, project.defaultAgent)
  const agentTone = agent ? (agent.authentication.status === 'authenticated' ? 'good' : agent.authentication.status === 'unknown' ? 'neutral' : 'warn') : 'warn'

  const { mood, eyebrow, headline, detail, label: primaryLabel } = workspaceStatus(state, hasDocs, Boolean(openProposal))
  const primaryRoute: WorkspaceRoute = running ? 'authoring' : openProposal ? 'proposals' : primaryLabel === 'Check sources' || !project.sources.length ? 'sources' : 'authoring'

  const planPages = plan?.pages.filter((page) => page.priority !== 'later').length ?? 0
  const pipeline = [
    { label: 'Sources', sub: `${project.sources.length} connected`, icon: 'sources', route: 'sources' as const, state: project.sources.length ? 'done' : 'idle' },
    { label: 'Plan', sub: plan ? `Version ${plan.version}` : 'Not started', icon: 'list', route: 'authoring' as const, state: plan?.status === 'planning' || plan?.status === 'revising' ? 'active' : plan ? 'done' : 'idle' },
    { label: 'Write', sub: plan?.status === 'generating' ? 'In progress' : hasDocs ? `${validation.ok ? validation.result.pages.length : planPages} pages ready` : 'Waiting', icon: 'update', route: 'authoring' as const, state: plan?.status === 'generating' ? 'active' : hasDocs ? 'done' : 'idle' },
    { label: 'Review', sub: openProposal ? 'Awaiting you' : 'No pending changes', icon: 'review', route: 'proposals' as const, state: openProposal ? 'active' : hasDocs ? 'done' : 'idle' },
    { label: 'Deploy', sub: published ? 'Published' : deployedSlug ? 'Not published yet' : 'Not configured', icon: 'deploy', route: 'publish' as const, state: published ? 'done' : 'idle' },
  ]
  const doneSteps = pipeline.filter((step) => step.state === 'done').length

  return <section class="overview-page">
    <PageHeader title="Your documentation loop" description="Everything between your source code and the published docs, in one pass." />

    <section class="pipeline-card" aria-label="Documentation workflow">
      <div class="pipeline-track"><i style={{ width: `${Math.max(0, (doneSteps - 1) / (pipeline.length - 1)) * 100}%` }} /></div>
      {pipeline.map((step) => <button type="button" key={step.label} class={step.state} onClick={() => navigate(step.route)}>
        <span><Icon name={step.state === 'done' ? 'check' : step.icon} size={step.state === 'done' ? 15 : 17} /></span>
        <strong>{step.label}</strong>
        <small>{step.sub}</small>
      </button>)}
    </section>

    <section class={`ov-hero ${mood}`} aria-label="Workspace status">
      <div class="ov-hero-copy">
        <span class="ov-eyebrow"><i />{eyebrow}</span>
        <h2>{headline}</h2>
        <p>{detail}</p>
        <div class="ov-hero-actions">
          <Button tone="primary" icon={openProposal ? 'review' : hasDocs ? 'update' : project.sources.length ? 'sparkle' : 'sources'} onClick={() => navigate(primaryRoute)}>{primaryLabel}</Button>
          {hasDocs && !openProposal && <Button icon="file" onClick={() => navigate('pages')}>Edit a page</Button>}
          {hasDocs && <Button icon="preview" onClick={() => void openPreview()}>Preview docs</Button>}
        </div>
      </div>
      <dl class="ov-hero-facts">
        <div><dt>Coding agent</dt><dd><i class={`ov-dot ${agentTone}`} />{agent ? `${agentLabel(agent.name)} ${agentSignInLabel(agent.authentication.status)}` : 'None detected'}</dd><button type="button" class="ov-fact-link" onClick={() => navigate('settings', { section: 'general' })}>Agent settings</button></div>
        <div><dt>Activity</dt><dd><i class={`ov-dot ${running ? 'info' : 'neutral'}`} />{running ? `${running} task${running === 1 ? '' : 's'} running` : 'Idle'}</dd></div>
        <div><dt>Last checked</dt><dd>{latestTimestamp ? timeText(latestTimestamp) : 'Not yet'}</dd></div>
      </dl>
    </section>

    <div class="ov-metrics">
      <button type="button" class="ov-metric" onClick={() => navigate('sources')}>
        <span class="ov-donut" style={{ '--ov-coverage': `${coverage}%` }}><b>{intelligence ? `${coverage}%` : '—'}</b></span>
        <span class="ov-metric-copy"><small>Coverage</small><strong>{coverageLabel}</strong><span>{intelligence ? `${documentedItems} of ${discoveredItems} discovered items documented` : 'Appears after source discovery completes'}</span></span>
        <Icon name="chevronRight" size={16} class="ov-metric-arrow" />
      </button>
      <button type="button" class={`ov-metric ${errors ? 'bad' : warnings ? 'warn' : 'good'}`} onClick={() => navigate('pages')}>
        <span class="ov-figure">{pageCount}</span>
        <span class="ov-metric-copy"><small>Pages</small><strong>{validation.ok ? validationHeadline(validation.result) : 'Validation unavailable'}</strong><span>{validation.ok ? (issues.length ? 'Fix the issues before deploying.' : 'Navigation, metadata, and links look consistent.') : validation.reason}</span></span>
        <Icon name="chevronRight" size={16} class="ov-metric-arrow" />
      </button>
      <button type="button" class={`ov-metric ${published ? 'good' : ''}`} onClick={() => navigate('publish')}>
        <span class="ov-metric-icon"><Icon name={deployedSlug ? 'cloud' : 'publish'} size={20} /></span>
        <span class="ov-metric-copy"><small>Published site</small><strong>{published ? 'Published successfully' : 'No deployment yet'}</strong><code>{deployedAddress}</code></span>
        <Icon name="chevronRight" size={16} class="ov-metric-arrow" />
      </button>
    </div>

    {issues.length > 0 && <section class="panel ov-issues" aria-label="Validation issues">
      <header class="panel-head">
        <div class="panel-title"><h2>Validation issues</h2><p>{validation.ok ? validationHeadline(validation.result) : ''} across {pageCount} page{pageCount === 1 ? '' : 's'}.</p></div>
        <div class="panel-actions"><Button size="sm" onClick={() => navigate('pages')}>Open pages</Button></div>
      </header>
      <ul>
        {issues.slice(0, 6).map((issue, index) => <li key={`${issue.code}-${index}`}><Badge tone={issue.severity === 'error' ? 'bad' : 'warn'}>{issue.severity}</Badge>{issue.file && <code>{issue.file}</code>}<span>{issue.message}</span></li>)}
        {issues.length > 6 && <li class="more">and {issues.length - 6} more</li>}
      </ul>
    </section>}

    <section class="panel overview-activity-card" aria-label="Recent activity">
      <header class="panel-head">
        <div class="panel-title"><h2>Recent activity</h2><p>Agents run in the background. Every run keeps a full log.</p></div>
        {running > 0 && <Badge tone="info" icon="refresh">{running} running</Badge>}
      </header>
      <ol class="ov-activity">
        {recentJobs.length ? recentJobs.map((job) => <li key={job.id} class={job.status}>
          <span class="ov-activity-icon"><Icon name={workflowActivityIcon(job.type)} size={15} /></span>
          <p><strong>{workflowActivityLabel(job.type)}</strong>{job.status === 'running' ? ' is running' : job.status === 'succeeded' ? ' completed successfully' : job.status === 'failed' ? ` needs attention${jobFailureReason(job) ? `: ${jobFailureReason(job)}` : ''}` : ` was ${job.status}`}</p>
          <time>{timeText(job.finishedAt ?? job.startedAt)}</time>
          <span class="ov-activity-actions">
            {job.status === 'running' && <Button size="sm" tone="danger" icon="stop" onClick={() => void act(() => post(`/api/jobs/${job.id}/cancel`), `${workflowActivityLabel(job.type)} stopped`)}>Stop</Button>}
            <a class="btn secondary sm" href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer" title="Open the full log">Log</a>
          </span>
        </li>) : <li class="empty">
          <span class="ov-activity-icon"><Icon name="check" size={15} /></span>
          <p>Your workspace is ready. Activity appears here after the first run.</p>
        </li>}
      </ol>
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
    {filtered.length > 0 && <DocumentationFreshness value={state.drift} navigate={navigate} />}
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
            const gaps = metric.items.filter((item) => item.state === 'uncovered' || item.state === 'needs-human' || item.state === 'planned' || item.state === 'stale').length
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

/**
 * Drift is computed on every state load but was never drawn. Show which pages
 * fell behind their sources and why, so "stale" is something a reader can act
 * on rather than a word in the sync status.
 */
function DocumentationFreshness({ value, navigate }: { value: UiState['drift']; navigate: (page: WorkspaceRoute) => void }) {
  const drift = driftState(value)
  if (!drift.ok) return <section class="source-freshness unknown" aria-label="Documentation freshness"><header><span class="source-freshness-icon"><Icon name="info" size={16} /></span><div><h2>Documentation freshness</h2><p>{drift.reason}</p></div></header></section>
  const { status, pages, sources = [], trackedPages, notes = [] } = drift.drift
  const changedSources = sources.filter((source) => source.changedPaths.length > 0 || source.filteredPaths > 0)
  const headline = status === 'stale'
    ? `${pages.length} page${pages.length === 1 ? '' : 's'} behind the sources`
    : status === 'current'
      ? 'Documentation matches the sources'
      : 'Freshness not tracked yet'
  const detail = status === 'stale'
    ? 'Plan an update to bring these pages in line with what changed.'
    : status === 'current'
      ? `${trackedPages ?? pages.length} tracked page${(trackedPages ?? pages.length) === 1 ? '' : 's'} have evidence that still matches the connected sources.`
      : notes[0] ?? 'Pages gain freshness tracking once an accepted update records their evidence.'
  return <section class={`source-freshness ${status}`} aria-label="Documentation freshness">
    <header>
      <span class="source-freshness-icon"><Icon name={status === 'stale' ? 'alert' : status === 'current' ? 'check' : 'clock'} size={16} /></span>
      <div><h2>Documentation freshness</h2><p><strong>{headline}.</strong> {detail}</p></div>
      <Badge tone={status === 'stale' ? 'warn' : status === 'current' ? 'good' : 'neutral'}>{status === 'stale' ? `${pages.length} stale` : status === 'current' ? 'Up to date' : 'Not tracked'}</Badge>
      {status === 'stale' && <Button size="sm" tone="primary" icon="update" onClick={() => navigate('authoring')}>Plan an update</Button>}
    </header>
    {status === 'stale' && pages.length > 0 && <ul class="source-freshness-pages">
      {pages.slice(0, 8).map((page) => <li key={page.page}>
        <code>{page.page}</code>
        <span>{(page.reasons ?? []).map((reason) => reason.kind === 'max-age'
          ? `evidence older than ${reason.ageDays ?? '?'} days`
          : `${reason.source}: ${reason.paths?.length ?? 0} changed path${(reason.paths?.length ?? 0) === 1 ? '' : 's'}`).join(' · ') || 'Sources changed'}</span>
      </li>)}
      {pages.length > 8 && <li class="more">and {pages.length - 8} more</li>}
    </ul>}
    {changedSources.length > 0 && <ul class="source-freshness-sources">
      {changedSources.map((source) => <li key={source.name}><Icon name="sources" size={13} /><span>{`${source.name}: ${source.changedPaths.length} changed`}</span>{source.filteredPaths > 0 && <small>{source.filteredPaths} filtered by watch rules</small>}</li>)}
    </ul>}
  </section>
}

function CoverageResolutionDialog({ metric, pages, act, onClose, onReport, onCreateUpdate }: {
  metric: SourceIntelligence['coverage']['metrics'][number]
  pages: string[]
  act: Action
  onClose: () => void
  onReport: (report: SourceIntelligence) => void
  onCreateUpdate: (items: CoverageItem[]) => Promise<boolean>
}) {
  const attentionItems = metric.items.filter((item) => item.state === 'uncovered' || item.state === 'needs-human' || item.state === 'planned' || item.state === 'stale')
  const resolvedItems = metric.items.filter((item) => item.state === 'documented' || item.state === 'excluded')
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
  const needsAttention = item.state === 'uncovered' || item.state === 'needs-human' || item.state === 'planned' || item.state === 'stale'
  return <article class={`coverage-resolution-item ${item.state} ${selected ? 'selected' : ''}`}>
    <div class="coverage-resolution-item-heading"><span><strong>{item.label}</strong><small>{[item.source, item.path].filter(Boolean).join(' · ') || item.page || 'Priority reader outcome'}</small></span>{needsAttention ? <label class="coverage-update-choice"><input type="checkbox" checked={selected} onChange={(event) => onSelectedChange(event.currentTarget.checked)} /><span>{selected ? 'Added' : 'Add to update'}</span></label> : <Badge tone={item.state === 'documented' ? 'good' : 'neutral'}>{item.state}</Badge>}</div>
    {needsAttention && <div class="coverage-resolution-controls">
      <div class="coverage-alternative-actions"><small>Or resolve without an update</small><span>{pages.length > 0 && item.surface !== 'verified-pages' && <button type="button" aria-expanded={resolutionMode === 'link'} onClick={() => setResolutionMode(resolutionMode === 'link' ? null : 'link')}>Link existing page</button>}{item.surface === 'reader-journeys' ? <button type="button" disabled={busy} onClick={() => void run('remove-priority')}>No longer a priority</button> : item.surface !== 'verified-pages' && <button type="button" aria-expanded={resolutionMode === 'exclude'} onClick={() => setResolutionMode(resolutionMode === 'exclude' ? null : 'exclude')}>Mark as internal</button>}<button type="button" disabled={busy} onClick={() => void run('needs-human')}>Decide later</button></span></div>
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
  const [form, setForm] = useState({ request: '', scope: 'starter', limits: { maxPages: 5, maxScreenshots: 0, maxMinutes: 15 }, targetPages: '', clarificationMode: 'review', agent: defaultAgent, model: defaultModel, reasoning: defaultAgent === 'codex' ? defaultReasoning : '', effort: defaultAgent === 'claude' ? defaultReasoning : '', screenshots: 'disabled' as 'auto' | 'enabled' | 'disabled' })
  const [showNewPlan, setShowNewPlan] = useState(() => shouldShowAuthoringForm(state))
  const [agentConfigOpen, setAgentConfigOpen] = useState(false)
  const availableAuthorModels = agentModels(form.agent)
  const supportedAuthorReasoning = modelReasoningLevels(form.agent, form.model)
  const [activityOpen, setActivityOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [discovery, setDiscovery] = useState<PlanDiscoverySummary>()
  const [captureReadiness, setCaptureReadiness] = useState<ApplicationReadiness>()
  const [gitSources, setGitSources] = useState<string[]>([])
  const [contentType, setContentType] = useState<'documentation' | 'release-notes'>('documentation')
  const [release, setRelease] = useState<ReleaseTemplateForm>({ source: '', version: '', from: '', to: '' })
  const runs = state.jobs.filter((job) => job.type.startsWith('plan:') || job.type.startsWith('author:') || job.type.startsWith('page-edit:') || job.type === 'capture' || job.type === 'sync')
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
    let active = true
    void api<{ sources: string[] }>('/api/sources/git')
      .then((result) => { if (active) setGitSources(Array.isArray(result?.sources) ? result.sources : []) })
      .catch(() => { if (active) setGitSources([]) })
    return () => { active = false }
  }, [state.project?.sources.map((source) => `${source.name}:${source.path}`).join('|')])

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
    if (contentType === 'release-notes' && (!release.version.trim() || !release.from.trim() || !release.to.trim())) {
      onError('Release notes need a version label and the two Git refs that bound the release.')
      return
    }
    const { reasoning, effort, targetPages, ...planForm } = form
    const parsedTarget = targetPages.trim() ? Number(targetPages) : undefined
    if (parsedTarget !== undefined && (!Number.isInteger(parsedTarget) || parsedTarget < 1)) {
      onError('Target page count must be a whole number of at least 1.')
      return
    }
    if (parsedTarget !== undefined && parsedTarget > form.limits.maxPages) { onError('The minimum pages exceeds this batch maximum. Raise Maximum pages or lower the minimum.'); return }
    const request = {
      ...planForm,
      scope: mode === 'create' ? form.scope : 'custom',
      ...(parsedTarget !== undefined ? { targetPages: parsedTarget } : {}),
      ...(contentType === 'release-notes' ? { template: { kind: 'release-notes', version: release.version.trim(), from: release.from.trim(), to: release.to.trim(), sources: [release.source || gitSources[0]].filter(Boolean) }, request: form.request.trim() || `Release notes for ${release.version.trim()}` } : {}),
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
      title={visiblePlan?.status === 'generated' ? 'Documentation plan' : mode === 'create' ? 'Create documentation' : 'Update documentation'}
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
            {gitSources.length > 0 && <div class="authoring-content-type"><strong>What should the agent write?</strong><Segmented value={contentType} onChange={setContentType} items={[['documentation', 'Documentation'], ['release-notes', 'Release notes']] as const} /></div>}
            <div class="authoring-prompt-block">
              <div class="authoring-prompt-title"><span><Icon name="chat" size={18} /></span><div><h2>{contentType === 'release-notes' ? 'Anything the release notes must call out?' : 'What should readers be able to do?'}</h2><p>{contentType === 'release-notes' ? 'Optional. The commit range and changelog below are the evidence; add emphasis, audience, or exclusions here.' : 'Describe the outcome or product change. The agent will research the evidence and propose the documentation shape first.'}</p></div></div>
              <span class="authoring-textarea-wrap"><Textarea rows={contentType === 'release-notes' ? 3 : 6} maxlength={2000} value={form.request} placeholder={contentType === 'release-notes' ? 'For example: Lead with the new billing API and mark the removed legacy mode as breaking.' : mode === 'create' ? 'For example: Help developers install the SDK, authenticate, and complete their first successful API request.' : 'For example: Document API key rotation and update the authentication journey with a TypeScript example.'} onInput={(event) => setForm({ ...form, request: event.currentTarget.value })} /></span>
              {contentType === 'release-notes' && <ReleaseTemplateFields sources={gitSources} value={release} onChange={setRelease} disabled={runBusy} />}
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
              <Field label="Minimum pages to write (optional)" hint="Leave empty to let the evidence decide. The batch maximum below limits what can be approved for this run."><Input type="number" min="1" max="500" value={form.targetPages} placeholder={discovery ? String(discovery.suggestedPages[form.scope as 'starter' | 'standard' | 'comprehensive']) : 'For example: 40'} onInput={(event) => setForm({ ...form, targetPages: event.currentTarget.value })} /></Field>
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
              <span>Agent: <b>{form.agent ? agentLabel(form.agent) : 'Automatically detect'}{form.model ? ` · ${form.model}` : ''}{form.agent === 'codex' && form.reasoning ? ` · ${form.reasoning} reasoning` : form.agent === 'claude' && form.effort ? ` · ${form.effort} effort` : ''}</b></span>
              <strong>{agentConfigOpen ? 'Hide options' : 'Change'}</strong>
            </button>
            {agentConfigOpen && <fieldset class="authoring-options" disabled={runBusy}>
              <Field label="Agent"><span class="authoring-control-icon agent"><Icon name="bot" size={16} /><Select value={form.agent} onChange={(event) => {
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
              <Segmented value={form.screenshots === 'disabled' ? 'no' : 'yes'} onChange={(value) => setForm({ ...form, screenshots: screenshotIntentFromChoice(value), limits: { ...form.limits, maxScreenshots: value === 'yes' ? Math.max(5, form.limits.maxScreenshots) : 0 } })} items={[['no', 'No'], ['yes', 'Yes']] as const} />
              {form.screenshots !== 'disabled' && captureReadiness && <small class={`capture-readiness ${captureReadiness.status === 'ready' ? 'ready' : 'missing'}`}><Icon name={captureReadiness.status === 'ready' ? 'check' : 'info'} size={13} />{captureReadiness.message}{!captureReadiness.configured && <> Configure it in <button type="button" onClick={() => setLocation('settings', { section: 'capture' }, 'push')}>Settings</button>.</>}</small>}
            </section>
            <details class="batch-limits-control"><summary>Run limits: {form.limits.maxPages} pages · {form.limits.maxScreenshots} screenshots · {form.limits.maxMinutes} minutes</summary><div class="batch-limits-fields"><label>Batch page limit<input aria-label="Batch page limit" type="range" min="1" max="50" value={Math.min(50, form.limits.maxPages)} onInput={(event) => setForm({ ...form, limits: { ...form.limits, maxPages: Number(event.currentTarget.value) } })} /></label><Button onClick={() => setForm({ ...form, scope: 'starter', targetPages: '', screenshots: 'disabled', limits: { maxPages: 5, maxScreenshots: 0, maxMinutes: 15 } })}>Small first batch</Button>{(['maxPages', 'maxScreenshots', 'maxMinutes'] as const).map((key) => <Field label={key === 'maxPages' ? 'Maximum pages' : key === 'maxScreenshots' ? 'Maximum screenshots' : 'Maximum minutes'}><Input type="number" min={key === 'maxScreenshots' ? 0 : 1} value={form.limits[key]} onInput={(event) => setForm({ ...form, limits: { ...form.limits, [key]: Number(event.currentTarget.value) } })} /></Field>)}</div><Estimate pages={form.limits.maxPages} agent={form.agent} model={form.model} /></details>
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
  // A background refresh (a job finishing, a poll) delivers a newer plan. If
  // the reviewer has unsaved edits, hold the new version behind a prompt
  // instead of discarding what they typed.
  const seededPlan = useRef(plan)
  const [pendingPlan, setPendingPlan] = useState<DocumentationPlan | null>(null)
  const loadPlan = (next: DocumentationPlan) => {
    seededPlan.current = next
    setDraft(next)
    setClarificationAnswers(next.clarification.answers)
    setPendingPlan(null)
  }
  useEffect(() => {
    if (plan.id !== seededPlan.current.id || planEditableJson(draft) === planEditableJson(seededPlan.current)) loadPlan(plan)
    else setPendingPlan(plan)
  }, [plan.id, plan.version, plan.status, plan.updatedAt])
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
    <div class="plan-complete-actions"><Button onClick={onStartAnother}>Plan another update</Button><Button tone="primary" icon="proposals" onClick={() => setLocation('proposals', plan.proposalId ? { proposal: plan.proposalId } : {}, 'push')}>Review generated files</Button></div>
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
    {pendingPlan && <div class="plan-pending-refresh" role="status">
      <Icon name="info" size={15} />
      <span><strong>A newer version of this plan arrived while you were editing.</strong> Keep your unsaved edits, or load the new version and lose them.</span>
      <span class="plan-pending-actions"><Button size="sm" onClick={() => setPendingPlan(null)}>Keep my edits</Button><Button size="sm" tone="primary" onClick={() => loadPlan(pendingPlan)}>Load new version</Button></span>
    </div>}
    <Estimate pages={pages.length} agent={draft.execution.agent} model={draft.execution.model} />
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
      <Panel title="Batch limits" description="Approval and proposal validation enforce these maxima. Mark extra pages Later to keep them out of this run."><div class="form-grid">{(['maxPages', 'maxScreenshots', 'maxMinutes'] as const).map((key) => <Field label={key === 'maxPages' ? 'Maximum pages' : key === 'maxScreenshots' ? 'Maximum screenshots' : 'Maximum minutes'}><Input disabled={!editable} type="number" min={key === 'maxScreenshots' ? 0 : 1} value={(draft.execution.limits ?? { maxPages: 50, maxScreenshots: 20, maxMinutes: 30 })[key]} onInput={(event) => setDraft({ ...draft, execution: { ...draft.execution, limits: { ...(draft.execution.limits ?? { maxPages: 50, maxScreenshots: 20, maxMinutes: 30 }), [key]: Number(event.currentTarget.value) } } })} /></Field>)}</div></Panel>
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
            ? <Button size="sm" onClick={() => setLocation('settings', { section: 'capture' }, 'push')}>Configure application</Button>
            : <Button size="sm" icon="refresh" busy={captureCheck === 'checking'} onClick={() => setCaptureCheckNonce((value) => value + 1)}>Check again</Button>}
        </div>}
        {visualPages.length > 0 && <ul class="plan-screenshot-pages">{visualPages.map((page) => <li key={page.id}><span class="plan-screenshot-page-icon"><Icon name="camera" size={14} /></span><span><strong>{page.title}</strong><small>{page.visuals?.startPath ? <code>{page.visuals.startPath}</code> : <em>Starting route needed</em>}{page.visuals?.rationale && <> · {page.visuals.rationale}</>}</small></span><b>{page.visuals?.estimatedCaptures} {screenshotIntent === 'enabled' ? 'required' : (page.visuals?.estimatedCaptures ?? 0) === 1 ? 'candidate' : 'candidates'}</b></li>)}</ul>}
        {screenshotIntent === 'enabled' && visualPages.length === 0 && <Note tone="bad">Required screenshot mode needs at least one visible UI guide. Open a page and choose “Require screenshots,” or change this run to Automatic.</Note>}
        {plan.advisories?.map((advisory) => <Note key={advisory} tone="info">{advisory}</Note>)}
        {capturePlanned && incompleteCapturePages.length > 0 && <Note tone={captureRequired ? 'bad' : 'info'}>{captureRequired ? 'Add' : 'For better automatic capture, add'} a starting route, capture workflow, and one meaningful capture-sequence line per planned screenshot for {incompleteCapturePages.map((page) => page.title).join(', ')}{captureRequired ? ' before approval.' : '. Documentation generation can continue if those optional captures are skipped.'}</Note>}
      </Panel>
      <Panel class="plan-navigation-panel" title="Navigation" description="Sections and page order for the sidebar. Drag pages between sections or add a section.">
        <PlanNavigationEditor plan={draft} editable={editable} onChange={(navigation) => setDraft({ ...draft, scope: 'custom', navigation })} />
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
          <div class="plan-page-diagram">
            <Field label="Diagram" hint="Concept pages default to a required Mermaid diagram; the writer must include one and the editor previews it."><Select disabled={!editable} value={selectedPage.diagram ?? (selectedPage.type === 'concept' ? 'required' : 'none')} onChange={(event) => setPage(selectedIndex, { ...selectedPage, diagram: event.currentTarget.value === 'required' ? 'required' : 'none' })}><option value="required">Required</option><option value="none">Not needed</option></Select></Field>
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

export interface SyncNotice {
  tone: 'good' | 'warn' | 'bad' | 'info'
  title: string
  detail: string
  proposalId?: string
}

/** Turn a settled source check into the one-line answer the reader was waiting for. */
export function syncOutcomeNotice(job: UiJob): SyncNotice {
  const outcome = job.outcome
  if (job.status === 'cancelled') return { tone: 'info', title: 'Source check stopped', detail: 'The check was stopped before it finished.' }
  if (!outcome) {
    return job.status === 'succeeded'
      ? { tone: 'good', title: 'Source check finished', detail: 'Open the log under Recent activity for details.' }
      : { tone: 'bad', title: 'Source check failed', detail: jobFailureReason(job) ?? 'Open the log under Recent activity for details.' }
  }
  const pages = outcome.pages ?? 0
  const stale = `${pages} page${pages === 1 ? '' : 's'} stale`
  switch (outcome.status) {
    case 'current': return { tone: 'good', title: 'No change', detail: outcome.message }
    case 'stale': return { tone: 'warn', title: stale, detail: outcome.message }
    case 'proposal': return { tone: 'good', title: outcome.proposalId ? 'Proposal ready for review' : stale, detail: outcome.message, ...(outcome.proposalId ? { proposalId: outcome.proposalId } : {}) }
    case 'skipped': return { tone: 'warn', title: `${stale} · update skipped`, detail: outcome.message }
    case 'failed': return { tone: 'bad', title: 'Proposal failed', detail: outcome.message, ...(outcome.proposalId ? { proposalId: outcome.proposalId } : {}) }
    default: return { tone: 'info', title: 'Freshness unknown', detail: outcome.message }
  }
}

export function workflowActivityLabel(type: string): string {
  if (type.startsWith('page-edit:')) return 'Editing a page with the agent'
  if (type === 'plan:propose') return 'Researching and building the documentation plan'
  if (type === 'plan:revise') return 'Revising the documentation plan'
  if (type === 'plan:generate') return 'Generating the approved documentation proposal'
  if (type === 'plan:continue') return 'Continuing the interrupted documentation run'
  if (type.startsWith('proposal:resume:')) return 'Continuing the interrupted documentation run'
  if (type.startsWith('proposal:revise:')) return 'Revising the proposal with the agent'
  if (type === 'author:update') return 'Updating documentation'
  if (type === 'author:create') return 'Creating documentation'
  if (type === 'author:review') return 'Reviewing documentation'
  if (type === 'sync') return 'Checking sources for changes'
  if (type === 'login') return 'Signing in to Doxbrix'
  if (type === 'agent:install') return 'Installing the agent'
  if (type === 'capture') return 'Capturing screenshots'
  if (type === 'generator') return 'Changing the documentation generator'
  if (type === 'deploy:dry-run') return 'Validating the deployment'
  if (type === 'deploy') return 'Deploying documentation'
  if (type === 'preview') return 'Running the local preview'
  return 'Documentation workflow in progress'
}

function workflowActivityIcon(type: string): string {
  if (type.startsWith('deploy')) return 'deploy'
  if (type.startsWith('plan')) return 'list'
  if (type.includes('proposal')) return 'review'
  if (type === 'login') return 'key'
  if (type === 'agent:install') return 'bot'
  if (type === 'capture') return 'camera'
  return 'update'
}

/** The line a failed CLI job printed as its reason, without the command prefix. */
export function jobFailureReason(job: Pick<UiJob, 'lines' | 'status'>): string | undefined {
  if (job.status !== 'failed') return undefined
  const reported = [...job.lines].reverse().find((line) => line.startsWith('doxloop: '))
  const line = reported ?? [...job.lines].reverse().find((candidate) => candidate.trim() && !candidate.startsWith('DOXLOOP_EVENT '))
  return line?.replace(/^doxloop: /, '').trim() || undefined
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
  const [replaceError, setReplaceError] = useState('')
  const [replacing, setReplacing] = useState<RunCapture | null>(null)
  const replaceInput = useRef<HTMLInputElement>(null)
  const replaceCapture = async (capture: RunCapture, file: File) => {
    const runId = run ?? new URL(capture.url, location.origin).searchParams.get('run')
    if (!runId) { setReplaceError('This screenshot no longer belongs to a run.'); return }
    try {
      setReplaceError('')
      await post('/api/captures/replace', { run: runId, path: capture.file, data: await readFileAsBase64(file) })
      setCaptures((current) => current.map((entry) => (entry.file === capture.file ? { ...entry, url: `${entry.url.split('&v=')[0]}&v=${Date.now()}` } : entry)))
    } catch (cause) { setReplaceError(message(cause)) }
  }
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
    <input ref={replaceInput} type="file" accept=".png" hidden onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file && replacing) void replaceCapture(replacing, file) }} />
    {replaceError && <Note tone="bad">{replaceError}</Note>}
    {duplicates > 0 && <Note tone="bad">{duplicates} of {captures.length} captures repeat an earlier image. Steps showing the same screen under different names mislead readers — the agent should reach those states or record them as text-only.</Note>}
    <div class="capture-grid">
      {captures.map((capture) => <figure key={capture.file} class={`capture-tile${capture.duplicateOf ? ' duplicate' : ''}`}>
        <a href={capture.url} target="_blank" rel="noreferrer"><img src={capture.url} alt={capture.alt ?? capture.file} loading="lazy" /></a>
        <figcaption>
          <strong>{capture.guide ? `${capture.guide} · ${capture.step ?? ''}` : capture.file.split('/').slice(-1)[0]}</strong>
          <small>{capture.duplicateOf ? `Identical to ${capture.duplicateOf.split('/').slice(-1)[0]}` : capture.alt ?? capture.file}</small>
          {!live && <button type="button" class="capture-replace" onClick={() => { setReplacing(capture); replaceInput.current?.click() }}><Icon name="refresh" size={12} />Replace screenshot</button>}
        </figcaption>
      </figure>)}
    </div>
  </div>
}

function AuthoringLiveLog({ job, act, stopLabel = 'Stop update' }: { job: UiJob; act: Action; stopLabel?: string }) {
  const log = useRef<HTMLPreElement>(null)
  const agent = job.agent ? agentLabel(job.agent) : 'Agent'
  const [tab, setTab] = useState<'log' | 'captures'>('log')
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [job.lines.length, tab])
  return <div class="authoring-live-log">
    {job.stages.length > 0 && <ol class="workflow-stages" aria-label="Documentation workflow stages">
      {job.stages.map((stage) => <li class={stage.status} key={stage.id}><span>{stage.status === 'completed' ? <Icon name="check" size={11} /> : stage.status === 'failed' ? <Icon name="alert" size={11} /> : <i />}</span><strong>{stage.label}</strong>{stage.progress && (stage.progress.total !== undefined || stage.progress.done > 0) && <small>{stage.progress.total !== undefined ? `${stage.progress.done} of ${stage.progress.total}` : String(stage.progress.done)}</small>}</li>)}
    </ol>}
    <div class="live-job-meta" aria-live="polite">
      <span><Icon name="bot" size={14} />{agent}</span>
      <span><Icon name="clock" size={14} />Last output {timeText(job.lastOutputAt ?? job.startedAt)}</span>
      <span><Icon name="file" size={14} />{job.lines.length} recent line{job.lines.length === 1 ? '' : 's'}</span>
      <span class="authoring-live-actions">
        <a href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer">Open full log <Icon name="external" size={12} /></a>
        {job.status === 'running' && <Button size="sm" tone="danger" icon="stop" onClick={() => void act(() => post(`/api/jobs/${job.id}/cancel`), 'Update stopped')}>{stopLabel}</Button>}
        {job.status !== 'running' && job.retryable && <Button size="sm" icon="refresh" onClick={() => void act(() => post(`/api/jobs/${job.id}/retry`), 'Workflow restarted')}>Retry stage</Button>}
      </span>
    </div>
    <div class="live-log-tabs"><Segmented value={tab} onChange={setTab} items={[['log', 'Log'], ['captures', 'Screenshots']] as const} /></div>
    {tab === 'log'
      ? <pre ref={log} class="terminal live-terminal" aria-live="polite">{job.lines.length > 0 ? job.lines.filter((line) => !line.startsWith('DOXLOOP_EVENT ')).join('\n') : `Starting ${agent}…`}</pre>
      : <CaptureGallery live={job.status === 'running'} />}
  </div>
}

const PAGE_EDIT_INTENTS = [
  ['Fix wording', 'Fix the wording so it is clearer and more precise.'],
  ['Add an example', 'Add a practical example that helps readers complete the task.'],
  ['Update for a recent change', 'Update this page for the recent product change: '],
  ['Add a section', 'Add a section that explains '],
  ['Shorten', 'Shorten this page while preserving the essential instructions.'],
  ['Rewrite for a different audience', 'Rewrite this page for a different audience: '],
] as const

const PAGE_EVIDENCE: Record<PageSummary['evidence'], readonly [string, string]> = {
  verified: ['Verified', 'good'],
  'needs-review': ['Needs review', 'warn'],
  none: ['No evidence', 'neutral'],
}

const MIN_EDIT_INSTRUCTION = 8

/**
 * Refine supersedes the run it refines, so a URL or a remembered id can point at
 * a proposal that has since been replaced. Follow the chain to the live one.
 */
function resolveEditRun(runs: Proposal[], id: string): Proposal | undefined {
  let run = runs.find((candidate) => candidate.id === id)
  const seen = new Set<string>()
  while (run?.supersededBy && !seen.has(run.id)) {
    seen.add(run.id)
    const next = runs.find((candidate) => candidate.id === run!.supersededBy)
    if (!next) break
    run = next
  }
  return run
}

function Pages({ state, act, streamConnected, onError }: { state: UiState; act: Action; streamConnected: boolean; onError: (error: string) => void }) {
  const initial = new URLSearchParams(location.search)
  const [pages, setPages] = useState<PageSummary[]>([])
  const [loadingPages, setLoadingPages] = useState(true)
  const [search, setSearch] = useState('')
  const [collectionFilter, setCollectionFilter] = useState('')
  const [query, setQuery] = useState('')
  const [matches, setMatches] = useState<Array<{ path: string; line: number; section: string; excerpt: string }>>([])
  const [focusLine, setFocusLine] = useState(Number(initial.get('line')) || (initial.get('edit') ? 1 : 0))
  useEffect(() => { let current = true; if (!query) { setMatches([]); return } api<typeof matches>(`/api/pages/search?q=${encodeURIComponent(query)}`).then((value) => { if (current) setMatches(value) }).catch((cause) => { if (current) onError(cause.message) }); return () => { current = false } }, [query, state.runs])
  const [selectedPaths, setSelectedPaths] = useState<string[]>(() => initial.get('path') ? [initial.get('path')!] : [])
  const [runId, setRunId] = useState(initial.get('run') ?? '')
  const [instruction, setInstruction] = useState('')
  const [allowRelated, setAllowRelated] = useState(false)
  const [screenshots, setScreenshots] = useState(false)
  const defaultAgent = state.project?.defaultAgent ?? ''
  const initialModel = defaultModelForAgent(defaultAgent)
  const initialReasoning = preferredReasoningLevel(defaultAgent, initialModel)
  const [agent, setAgent] = useState(defaultAgent)
  const [model, setModel] = useState(initialModel)
  const [reasoning, setReasoning] = useState(defaultAgent === 'codex' ? initialReasoning : '')
  const [effort, setEffort] = useState(defaultAgent === 'claude' ? initialReasoning : '')
  const [agentOpen, setAgentOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [reviewView, setReviewView] = useState<'rendered' | 'source'>('rendered')
  const [reviewLayout, setReviewLayout] = useState<'split' | 'unified'>('split')
  const [onlyChanges, setOnlyChanges] = useState(true)
  const [reviewChangeId, setReviewChangeId] = useState('')
  const [refining, setRefining] = useState(false)
  const [refinement, setRefinement] = useState('')
  const [rationale, setRationale] = useState<ProposalChange | null>(null)
  const [toast, setToast] = useState<Proposal | null>(null)
  const [assetPicker, setAssetPicker] = useState(false)
  const [view, setViewState] = useState<PagesView>(() => pagesViewFrom(initial.get('view')))
  const [previewUrl, setPreviewUrl] = useState(state.preview?.running ? state.preview.url ?? '' : '')
  const [previewState, setPreviewState] = useState<'idle' | 'starting' | 'ready' | 'failed'>(state.preview?.running && state.preview.url ? 'ready' : 'idle')
  const [previewNonce, setPreviewNonce] = useState(0)
  const [undoingPage, setUndoingPage] = useState(false)
  const [historyEntries, setHistoryEntries] = useState<HistoryPageEntry[] | null>(null)
  const [startedJob, setStartedJob] = useState<UiJob | null>(null)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const refineInput = useRef<HTMLTextAreaElement>(null)
  const listbox = useRef<HTMLDivElement>(null)

  const editRuns = validRuns(state.runs).filter((run) => run.editRequest)
  const proposal = resolveEditRun(editRuns, runId)
  const streamedJob = state.jobs.find((job) => job.status === 'running' && (job.type.startsWith('page-edit:') || (job.type.startsWith('proposal:revise:') && editRuns.some((run) => job.type.endsWith(run.id)))))
  const activeJob = streamedJob ?? (startedJob?.status === 'running' ? startedJob : undefined)
  const activeRun = activeJob?.type.startsWith('page-edit:')
    ? editRuns.find((run) => activeJob.type === `page-edit:${run.id}`)
    : editRuns.find((run) => activeJob?.type === `proposal:revise:${run.id}`)
  const activePaths = activeRun?.editRequest?.paths ?? (startedJob ? selectedPaths : proposal?.editRequest?.paths ?? [])
  const titleFor = (path: string) => pages.find((page) => page.path === path)?.title ?? path.split('/').at(-1) ?? path
  const selected = selectedPaths.map((path) => pages.find((page) => page.path === path)).filter((page): page is PageSummary => Boolean(page))
  const activePage = selected[0]
  const pageChanges = proposal?.changes.filter((change) => change.category === 'page') ?? []
  const relatedChanges = proposal?.changes.filter((change) => change.category !== 'page') ?? []
  const reviewChange = pageChanges.find((change) => change.id === reviewChangeId) ?? pageChanges[0]
  const normalizedQuery = query.toLocaleLowerCase()
  const collectionPages = collectionFilter ? pages.filter((page) => `${page.version ?? 'current'} / ${page.locale ?? 'default'}` === collectionFilter) : pages
  const filteredPages = normalizedQuery ? collectionPages.filter((page) => (`${page.title} ${page.path}`.toLocaleLowerCase().includes(normalizedQuery) || matches.some((match) => match.path === page.path))) : collectionPages
  const groups = groupPageSummaries(filteredPages)
  const proposalPaths = proposal?.editRequest?.paths ?? []
  const viewingProposalPage = Boolean(activePage && proposalPaths.includes(activePage.path))
  const otherPageWhileRunning = Boolean(activeJob && activePage && !activePaths.includes(activePage.path))
  const reviewable = Boolean(proposal && !activeJob && ['awaiting-review', 'conflicted'].includes(proposal.status))
  const failed = Boolean(proposal && !activeJob && proposal.status === 'failed')
  const pendingElsewhere = editRuns.filter((run) => run.status === 'awaiting-review' && run.id !== proposal?.id)
  const validationErrors = proposal?.validation?.errors ?? 0
  const instructionReady = instruction.trim().length >= MIN_EDIT_INSTRUCTION
  const composerLabel = selected.length > 1 ? `What should change on these ${selected.length} pages?` : 'What should change on this page?'

  const refreshPages = async () => {
    try { setPages(await api<PageSummary[]>('/api/pages')) }
    catch (cause) { onError(message(cause)) }
    finally { setLoadingPages(false) }
  }
  useEffect(() => { void refreshPages() }, [])
  useEffect(() => {
    const syncUrl = () => {
      const params = new URLSearchParams(location.search)
      setRunId(params.get('run') ?? '')
      setViewState(pagesViewFrom(params.get('view')))
      const nextPath = params.get('path')
      if (nextPath) setSelectedPaths([nextPath])
    }
    addEventListener('popstate', syncUrl)
    return () => removeEventListener('popstate', syncUrl)
  }, [])
  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(search.trim()), 150)
    return () => clearTimeout(timer)
  }, [search])
  useEffect(() => {
    if (selectedPaths.length || !pages.length) return
    setSelectedPaths([pages[0]!.path])
  }, [pages.length])
  useEffect(() => {
    if (!proposal?.editRequest) return
    setSelectedPaths(proposal.editRequest.paths)
    setInstruction(proposal.editRequest.instruction)
    setAllowRelated(proposal.editRequest.allowRelated)
    setReviewChangeId(pageChanges[0]?.id ?? '')
    setRefining(false)
    setRefinement('')
    if (proposal.id !== runId) {
      setRunId(proposal.id)
      updateUrl(proposal.editRequest.paths, proposal.id)
    }
  }, [proposal?.id])
  useEffect(() => {
    if (!startedJob) return
    const matching = state.jobs.find((job) => job.id === startedJob.id)
    const completed = startedJob.type.startsWith('page-edit:')
      ? proposal?.id === startedJob.type.slice('page-edit:'.length) && proposal.status !== 'generating'
      : proposal?.revisionOf === startedJob.type.slice('proposal:revise:'.length)
    if (completed || (matching && matching.status !== 'running')) setStartedJob(null)
  }, [proposal?.id, proposal?.status, state.jobs, startedJob?.id])
  useEffect(() => {
    if (!activePage || previewState !== 'idle') return
    setPreviewState('starting')
    void post<{ url: string }>('/api/preview/start', { open: false }).then((result) => {
      setPreviewUrl(result.url)
      setPreviewState('ready')
    }).catch((cause) => {
      setPreviewState('failed')
      onError(message(cause))
    })
  }, [activePage?.path, previewState])

  const updateUrl = (nextPaths: string[], nextRun = '', nextView: PagesView = view) => {
    const params = new URLSearchParams()
    if (nextView !== 'pages') params.set('view', nextView)
    if (nextRun) params.set('run', nextRun)
    else if (nextPaths[0]) params.set('path', nextPaths[0])
    history.replaceState({}, '', `/pages${params.size ? `?${params}` : ''}`)
  }
  const setView = (next: PagesView) => {
    setViewState(next)
    updateUrl(selectedPaths, proposal && selectedPaths[0] && proposalPaths.includes(selectedPaths[0]) ? proposal.id : '', next)
  }
  const leaveProposal = () => {
    setRunId('')
    setRefining(false)
    setRefinement('')
  }
  const chooseSingle = (path: string) => {
    setSelectedPaths([path])
    setHistoryEntries(null)
    updateUrl([path], proposal && proposalPaths.includes(path) ? proposal.id : '')
  }
  const togglePath = (path: string) => {
    const next = selectedPaths.includes(path) ? selectedPaths.filter((item) => item !== path) : [path, ...selectedPaths]
    setSelectedPaths(next)
    setHistoryEntries(null)
    updateUrl(next, proposal && next[0] && proposalPaths.includes(next[0]) ? proposal.id : '')
  }
  const moveSelection = (path: string, direction: 1 | -1) => {
    const index = filteredPages.findIndex((page) => page.path === path)
    const next = filteredPages[index + direction]
    if (!next) return
    chooseSingle(next.path)
    listbox.current?.querySelector<HTMLElement>(`[data-page-index="${index + direction}"]`)?.focus()
  }
  const insertIntent = (value: string) => {
    const input = textarea.current
    const start = input?.selectionStart ?? instruction.length
    const end = input?.selectionEnd ?? instruction.length
    const spacer = start > 0 && !/\s$/.test(instruction.slice(0, start)) ? ' ' : ''
    const next = `${instruction.slice(0, start)}${spacer}${value}${instruction.slice(end)}`
    const caret = start + spacer.length + value.length
    setInstruction(next)
    requestAnimationFrame(() => { input?.focus(); input?.setSelectionRange(caret, caret) })
  }
  const submit = async (override?: { instruction?: string; allowRelated?: boolean; paths?: string[] }) => {
    const request = (override?.instruction ?? instruction).trim()
    const paths = override?.paths ?? selectedPaths
    if (request.length < MIN_EDIT_INSTRUCTION || paths.length === 0 || activeJob) return
    setSubmitting(true)
    setToast(null)
    try {
      const started = await act(() => post<{ job: UiJob }>('/api/pages/edit', {
        paths,
        instruction: request,
        allowRelated: override?.allowRelated ?? allowRelated,
        screenshots: screenshots ? 'enabled' : 'disabled',
        agent: agent || undefined,
        model: model || undefined,
        ...(agent === 'codex' && reasoning ? { reasoning } : {}),
        ...(agent === 'claude' && effort ? { effort } : {}),
      }), 'Page edit started', false)
      if (started?.job.type.startsWith('page-edit:')) {
        setStartedJob(started.job)
        const id = started.job.type.slice('page-edit:'.length)
        setInstruction(request)
        setSelectedPaths(paths)
        setRunId(id)
        setRefining(false)
        updateUrl(paths, id)
      }
    } finally { setSubmitting(false) }
  }
  const accept = async () => {
    if (!proposal) return
    const result = await act(() => post<Proposal>(`/api/proposals/${proposal.id}/accept`, { scope: 'all' }))
    if (result?.status !== 'applied') return
    const paths = result.editRequest?.paths ?? selectedPaths
    setToast(result)
    leaveProposal()
    setInstruction('')
    setAllowRelated(false)
    setPreviewNonce((value) => value + 1)
    updateUrl(paths)
    await refreshPages()
  }
  const reject = async () => {
    if (!proposal) return
    const result = await act(() => post<Proposal>(`/api/proposals/${proposal.id}/reject`), 'Edit rejected')
    if (result) { leaveProposal(); updateUrl(selectedPaths) }
  }
  const refine = async () => {
    if (!proposal || refinement.trim().length < MIN_EDIT_INSTRUCTION) return
    const result = await act(() => post<{ job: UiJob }>(`/api/proposals/${proposal.id}/refine`, { instruction: refinement.trim() }), 'Refinement started', false)
    if (result) { setStartedJob(result.job); setRefining(false); setRefinement('') }
  }
  const undo = async (applied: Proposal) => {
    setUndoingPage(true)
    try {
      const result = await act(() => post(`/api/proposals/${applied.id}/undo`), 'Page edit undone')
      if (result) { setToast(null); setPreviewNonce((value) => value + 1); await refreshPages() }
    } finally { setUndoingPage(false) }
  }

  const openHistory = async () => {
    if (!activePage) return
    if (historyEntries) { setHistoryEntries(null); return }
    try {
      const result = await api<{ entries: HistoryPageEntry[] }>(`/api/history?page=${encodeURIComponent(activePage.path)}`)
      setHistoryEntries(result.entries)
    } catch (cause) { onError(message(cause)) }
  }
  const openInPreview = async (route: string) => {
    const tab = window.open('about:blank', '_blank')
    if (tab) tab.opener = null
    try {
      const result = await post<{ url: string }>('/api/preview/start', { open: false })
      setPreviewUrl(result.url)
      setPreviewState('ready')
      tab?.location.replace(`${result.url}${route}`)
    } catch (cause) {
      tab?.close()
      onError(message(cause))
    }
  }
  const openProposedPreview = async (route: string) => {
    if (!proposal) return
    const tab = window.open('about:blank', '_blank')
    if (tab) tab.opener = null
    try {
      const result = await post<{ url: string }>(`/api/proposals/${proposal.id}/preview/start`, { open: false })
      tab?.location.replace(`${result.url}${route}`)
    } catch (cause) {
      tab?.close()
      onError(message(cause))
    }
  }
  const openRun = (run: Proposal) => {
    const paths = run.editRequest?.paths ?? []
    setRunId(run.id)
    if (paths[0]) setSelectedPaths(paths)
    setHistoryEntries(null)
    updateUrl(paths, run.id)
  }
  const focusComposer = () => requestAnimationFrame(() => textarea.current?.focus())

  const previewFrame = (page: PageSummary) => <div class="current-page-preview">
    <div class="preview-chrome" aria-hidden="true"><span class="preview-dots"><i /><i /><i /></span><code>{page.route}</code></div>
    {previewState === 'ready' && previewUrl
      ? <iframe key={`${page.path}:${previewNonce}`} title="Current page preview" src={`${previewUrl}${page.route}?embed=page`} />
      : <div class="preview-placeholder">
        {previewState === 'failed'
          ? <><Icon name="alert" size={18} /><strong>The preview could not start</strong><Button size="sm" onClick={() => setPreviewState('idle')}>Try again</Button></>
          : <><span class="spinner" /><strong>Preview is starting…</strong></>}
      </div>}
  </div>

  return <div class="pages-page">
    {rationale && <ProposalRationaleDrawer change={rationale} onClose={() => setRationale(null)} />}
    {assetPicker && <AssetPicker act={act} title="Insert an image" onClose={() => setAssetPicker(false)} onPick={(asset) => { setAssetPicker(false); insertIntent(`Insert the image ${asset.publicPath} with descriptive alt text where it best supports the text.`) }} />}
    {toast && <div class="page-updated-toast" role="status">
      <span class="toast-icon"><Icon name="check" size={15} /></span>
      <span class="toast-copy"><strong>Page updated</strong><small>{(toast.editRequest?.paths ?? []).map(titleFor).join(', ') || 'The change was written to the project.'}</small></span>
      <Button size="sm" onClick={() => void undo(toast)}>Undo</Button>
      <button type="button" class="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}><Icon name="close" size={14} /></button>
    </div>}
    <PageHeader title="Pages" description={view === 'navigation' ? 'Arrange the sidebar: reorder pages, group them into sections, and rename labels.' : view === 'assets' ? 'Images and files the documentation embeds. Upload, replace, and describe them.' : 'Edit a page directly or ask the agent for a reviewed update.'} actions={<Segmented value={view} onChange={setView} items={[['pages', 'Pages'], ['navigation', 'Navigation'], ['assets', 'Images & files']] as const} />} />
    {view === 'pages' && <PageTools root={state.root ?? state.cwd} contentDir={state.project?.contentDir ?? ''} {...(activePage ? { path: activePage.path } : {})} onChanged={async (path) => { const next = await api<PageSummary[]>('/api/pages'); setPages(next); const selected = path ?? next.find((page) => page.path === activePage?.path)?.path ?? next[0]?.path; setSelectedPaths(selected ? [selected] : []); updateUrl(selected ? [selected] : []); setPreviewNonce((value) => value + 1); await act(async () => true) }} />}
    <Collections onChanged={async () => { await refreshPages(); await act(async () => true) }} onTranslate={async (paths, locale) => { await submit({ paths, instruction: `Translate these documentation pages to ${locale}. Preserve code, API names, navigation routes, source associations, and links. Re-verify factual claims. Change only the selected translation pages.`, allowRelated: false }) }} />
    <AuditTools onChanged={async () => { await refreshPages(); await act(async () => true) }} />
    {view === 'pages' && selectedPaths.length > 1 && <BulkMetadata paths={selectedPaths} onChanged={async () => { await refreshPages(); setPreviewNonce((value) => value + 1); await act(async () => true) }} />}
    {view === 'navigation' && <NavigationView act={act} onError={onError} {...(previewState === 'ready' && previewUrl ? { previewUrl } : {})} />}
    {view === 'assets' && <AssetLibrary act={act} onError={onError} onChanged={() => { setPreviewNonce((value) => value + 1); void refreshPages() }} />}
    {view === 'pages' && <div class="pages-workbench">
      <aside class="page-list-panel">
        {[...new Set(pages.map((page) => `${page.version ?? 'current'} / ${page.locale ?? 'default'}`))].length > 1 && <label>Version / locale<select aria-label="Version / locale" value={collectionFilter} onChange={(event) => setCollectionFilter(event.currentTarget.value)}><option value="">All versions and languages</option>{[...new Set(pages.map((page) => `${page.version ?? 'current'} / ${page.locale ?? 'default'}`))].map((label) => <option>{label}</option>)}</select></label>}
        <label class="page-search">
          <span class="sr-only">Search pages</span>
          <Icon name="search" size={16} />
          <Input type="search" value={search} placeholder="Search titles, paths, or page text" onInput={(event) => setSearch(event.currentTarget.value)} />
        </label>
        {matches.length > 0 && <details open><summary>{matches.length} text matches{matches.length === 200 ? ' (first 200)' : ''}</summary><ul class="page-text-matches">{matches.map((match) => <li><button onClick={() => { chooseSingle(match.path); setFocusLine(match.line); }}><strong>{match.section} · line {match.line}</strong><small>{match.excerpt}</small></button></li>)}</ul></details>}
        <div class="page-list-summary">
          <span>{query ? `${filteredPages.length} of ${pages.length}` : pages.length} page{pages.length === 1 ? '' : 's'}</span>
          {selectedPaths.length > 1
            ? <button type="button" class="page-list-clear" onClick={() => activePage && chooseSingle(activePage.path)}>{selectedPaths.length} selected · Clear</button>
            : <span class="page-list-hint">Tick boxes to edit several at once</span>}
        </div>
        <div ref={listbox} class="page-list" role="listbox" aria-label="Documentation pages" aria-multiselectable="true">
          {loadingPages
            ? <div class="page-list-empty"><span class="spinner" />Loading pages…</div>
            : pages.length === 0
              ? <div class="page-list-empty">No pages yet. Create a documentation plan to write the first ones.</div>
              : filteredPages.length === 0
                ? <div class="page-list-empty">No pages match “{query}”.</div>
                : groups.map(([section, entries]) => <section key={section} class="page-list-group">
                  <h2>{section}</h2>
                  {entries.map((page) => {
                    const globalIndex = filteredPages.indexOf(page)
                    const checked = selectedPaths.includes(page.path)
                    const active = selectedPaths[0] === page.path
                    const [evidenceLabel, evidenceTone] = PAGE_EVIDENCE[page.evidence]
                    return <div
                      key={page.path}
                      role="option"
                      aria-selected={checked}
                      aria-current={active ? 'page' : undefined}
                      tabIndex={active || (globalIndex === 0 && !selectedPaths.some((path) => filteredPages.some((candidate) => candidate.path === path))) ? 0 : -1}
                      data-page-index={globalIndex}
                      class={`page-list-row ${checked ? 'selected' : ''} ${active ? 'active' : ''}`}
                      onClick={() => chooseSingle(page.path)}
                      onKeyDown={(event) => {
                        if (event.target instanceof HTMLInputElement) return
                        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); moveSelection(page.path, event.key === 'ArrowDown' ? 1 : -1) }
                        else if (event.key === ' ') { event.preventDefault(); togglePath(page.path) }
                        else if (event.key === 'Enter') { event.preventDefault(); chooseSingle(page.path) }
                      }}
                    >
                      <span class="page-list-check" onClick={(event) => event.stopPropagation()}>
                        <input type="checkbox" aria-label={`Select ${page.title}`} checked={checked} onChange={() => togglePath(page.path)} />
                      </span>
                      <span class="page-list-copy">
                        <strong>{page.title}</strong>
                        <code>{page.path}</code>
                        <small><span class={`evidence-dot ${evidenceTone}`} />{evidenceLabel}<i>·</i>{page.wordCount.toLocaleString()} words{page.updatedAt ? <><i>·</i>{timeText(page.updatedAt)}</> : null}</small>
                      </span>
                    </div>
                  })}
                </section>)}
        </div>
      </aside>

      <section class="page-detail-pane">
        {!activePage ? <div class="page-detail-empty"><Empty icon="file" title="Choose a page" detail="Select a page on the left to preview it and ask the agent for a scoped edit." /></div> : <>
          <header class="page-detail-header">
            <div class="page-detail-copy">
              <small>{activePage.section ?? 'Not in navigation'}</small>
              <h2>{activePage.title}</h2>
              <span class="page-detail-meta">
                <code>{activePage.path}</code>
                <Badge tone={PAGE_EVIDENCE[activePage.evidence][1]}>{PAGE_EVIDENCE[activePage.evidence][0]}</Badge>
                <small>{activePage.wordCount.toLocaleString()} words{activePage.updatedAt ? ` · Updated ${timeText(activePage.updatedAt)}` : ''}</small>
              </span>
            </div>
            <div class="page-detail-actions">
              <Button icon="clock" class={historyEntries ? 'active-filter' : ''} onClick={() => void openHistory()}>Page history</Button>
              <Button icon="external" onClick={() => void openInPreview(activePage.route)}>Open in preview</Button>
            </div>
          </header>

          <Comments key={`comments:${activePage.path}`} path={activePage.path} onRequest={async (text) => { await submit({ paths: [activePage.path], instruction: `Address this reviewer comment on ${activePage.path}: ${text}` }) }} />
          {!undoingPage && !activeJob && !(reviewable && viewingProposalPage) && <TextEditor key={activePage.path} focusLine={focusLine} refreshToken={previewNonce} root={state.root ?? state.cwd} path={activePage.path} onChanged={async () => { await refreshPages(); setPreviewNonce((value) => value + 1); await act(async () => true) }} />}
          {!activeJob && !(reviewable && viewingProposalPage) && <PageMetadataForm path={activePage.path} act={act} onError={onError} onSaved={() => { setPreviewNonce((value) => value + 1); void refreshPages() }} />}

          {selected.length > 1 && <div class="selected-pages-strip" aria-label="Pages selected for this update">
            <strong><Icon name="list" size={14} />{selected.length} pages in this edit</strong>
            {selected.map((page) => <span key={page.path} class={`selected-page-chip ${page.path === activePage.path ? 'active' : ''}`}>
              <button type="button" onClick={() => { const next = [page.path, ...selectedPaths.filter((item) => item !== page.path)]; setSelectedPaths(next); updateUrl(next, proposal && proposalPaths.includes(page.path) ? proposal.id : '') }}>{page.title}</button>
              <button type="button" aria-label={`Remove ${page.title}`} onClick={() => togglePath(page.path)}><Icon name="close" size={12} /></button>
            </span>)}
          </div>}

          {pendingElsewhere.length > 0 && !activeJob && <div class="page-pending-strip">
            <Icon name="info" size={15} />
            <span>{pendingElsewhere.length === 1 ? <>An edit of <strong>{(pendingElsewhere[0]!.editRequest?.paths ?? []).map(titleFor).join(', ')}</strong> is waiting for your review.</> : <><strong>{pendingElsewhere.length} edits</strong> are waiting for your review.</>}</span>
            <Button size="sm" onClick={() => openRun(pendingElsewhere[0]!)}>Open review</Button>
          </div>}

          {historyEntries && <section class="page-history-panel">
            <header><strong><Icon name="clock" size={15} />History for {activePage.title}</strong><button type="button" aria-label="Close page history" onClick={() => setHistoryEntries(null)}><Icon name="close" size={14} /></button></header>
            {historyEntries.length
              ? historyEntries.map((entry) => <div class="page-history-row" key={entry.requestId}><Badge tone={statusTone(entry.requestStatus)}>{statusLabel(entry.requestStatus)}</Badge><span><strong>{entry.requestText ?? 'Documentation update'}</strong><small>{timeText(entry.requestedAt)}</small></span></div>)
              : <p class="page-history-empty">No recorded changes for this page yet.</p>}
          </section>}

          {activeJob && otherPageWhileRunning && <>
            {previewFrame(activePage)}
            <div class="page-inline-notice">
              <span class="notice-icon running"><i /></span>
              <span><strong>An edit is in progress.</strong> Finish or stop it before starting another.</span>
              {activePaths[0] && <Button size="sm" onClick={() => { const next = [...activePaths]; setSelectedPaths(next); updateUrl(next, activeRun?.id ?? runId) }}>Show the edit</Button>}
            </div>
          </>}

          {activeJob && !otherPageWhileRunning && <>
            {previewFrame(activePage)}
            <section class="page-edit-running">
              <header>
                <span class="running-pulse" aria-hidden="true"><i /></span>
                <div>
                  <h2>Editing {activePaths.length === 1 ? titleFor(activePaths[0]!) : `${activePaths.length} pages`}</h2>
                  <blockquote>{activeRun?.editRequest?.followUps.at(-1)?.instruction ?? activeRun?.editRequest?.instruction ?? instruction}</blockquote>
                </div>
                <Badge tone={streamConnected ? 'good' : 'warn'}>{streamConnected ? 'Live' : 'Reconnecting…'}</Badge>
              </header>
              <AuthoringLiveLog job={activeJob} act={act} stopLabel="Stop" />
            </section>
          </>}

          {!activeJob && reviewable && proposal && viewingProposalPage && <section class="page-edit-review">
            <header class="page-review-head">
              <div>
                <small>Agent proposal</small>
                <h2>Review this edit</h2>
                <p>{proposal.summary}</p>
              </div>
              <Badge tone={statusTone(proposal.status)}>{statusLabel(proposal.status)}</Badge>
            </header>
            <blockquote class="page-review-instruction"><Icon name="chat" size={14} /><span>{latestPageEditInstruction(proposal)}</span></blockquote>
            {reviewChange && proposal.status === 'awaiting-review' && reviewChange.hunks.every((hunk) => !hunk.acceptedAt && !hunk.rejectedAt) && <TextEditor key={`${proposal.id}:${reviewChange.id}`} root={state.root ?? state.cwd} path={reviewChange.path} proposal={{ id: proposal.id, changeId: reviewChange.id }} onChanged={async () => { await act(async () => true) }} />}
            {proposal.status === 'conflicted' && <Note tone="bad"><span class="note-body">{proposal.error}<span class="note-actions"><Button size="sm" onClick={() => { leaveProposal(); updateUrl(selectedPaths); setPreviewNonce((value) => value + 1); void refreshPages() }}>Reload and compare</Button><Button size="sm" tone="danger" onClick={() => void reject()}>Reject</Button></span></span></Note>}
            {validationErrors > 0 && <Note tone="bad"><span class="note-body">The proposed edit has {validationErrors} validation error{validationErrors === 1 ? '' : 's'}. Fix the validation errors by refining the instruction, or reject this edit.<ul class="note-issues">{proposal.validation?.issues?.filter((issue) => issue.severity === 'error').map((issue) => <li key={`${issue.code}:${issue.file ?? ''}:${issue.message}`}>{issue.file ? <code>{issue.file}</code> : null}{issue.message}</li>)}</ul></span></Note>}
            {reviewChange ? <>
              <div class="page-review-toolbar">
                {pageChanges.length > 1
                  ? <Select aria-label="Changed page" value={reviewChange.id} onChange={(event) => setReviewChangeId(event.currentTarget.value)}>{pageChanges.map((change) => <option key={change.id} value={change.id}>{change.title} — {change.path}</option>)}</Select>
                  : <code class="page-review-path">{reviewChange.path}</code>}
                <div class="page-review-controls">
                  <Segmented value={reviewView} onChange={setReviewView} items={[['rendered', 'Rendered'], ['source', 'Source']] as const} />
                  {reviewView === 'rendered' && <>
                    <Segmented value={reviewLayout} onChange={setReviewLayout} items={[['split', 'Side-by-side'], ['unified', 'Inline']] as const} />
                    <Button size="sm" class={onlyChanges ? 'active-filter' : ''} onClick={() => setOnlyChanges(!onlyChanges)}>{onlyChanges ? 'Changes only' : 'Show all'}</Button>
                  </>}
                  <Button size="sm" icon="info" onClick={() => setRationale(reviewChange)}>Why this change</Button>
                  <Button size="sm" icon="external" onClick={() => void openProposedPreview(pages.find((page) => page.path === reviewChange.path)?.route ?? activePage.route)}>Open proposed page</Button>
                </div>
              </div>
              <div class="page-review-body">
                {reviewView === 'source'
                  ? <ProposalSourceDiff runId={proposal.id} change={reviewChange} act={act} partialActions={false} />
                  : <ProposalRenderedDiff runId={proposal.id} change={reviewChange} layout={reviewLayout} onlyChanges={onlyChanges} />}
              </div>
            </> : <Empty title="The agent did not change the page" detail="Refine the instruction or reject this edit." />}
            {relatedChanges.length > 0 && <details class="page-related-changes">
              <summary>Also changed <span>{relatedChanges.length}</span></summary>
              {relatedChanges.map((change) => <div key={change.id}><Icon name="file" size={14} /><span><strong>{change.title}</strong><code>{change.path}</code></span><Badge tone="neutral">{change.category}</Badge></div>)}
            </details>}
            {refining && <div class="page-refine">
              <Field label="What should be different?" hint="The agent continues in the same isolated copy, so earlier instructions still apply."><Textarea ref={refineInput} rows={4} value={refinement} placeholder="For example: keep the new example, but shorten the introduction to two sentences." onInput={(event) => setRefinement(event.currentTarget.value)} /></Field>
              <div class="page-refine-actions"><Button tone="primary" icon="sparkles" disabled={refinement.trim().length < MIN_EDIT_INSTRUCTION} onClick={() => void refine()}>Send to the agent</Button><Button tone="ghost" onClick={() => { setRefining(false); setRefinement('') }}>Cancel</Button></div>
            </div>}
            <footer class="page-review-actions">
              <Button tone="primary" icon="check" disabled={proposal.status === 'conflicted' || validationErrors > 0} title={validationErrors > 0 ? 'Fix the validation errors by refining the instruction, or reject this edit.' : undefined} onClick={() => void accept()}>Accept</Button>
              <Button tone="danger" onClick={() => void reject()}>Reject</Button>
              <Button icon="chat" class={refining ? 'active-filter' : ''} onClick={() => { setRefining(!refining); if (!refining) requestAnimationFrame(() => refineInput.current?.focus()) }}>Refine</Button>
              <small>Accepting writes the page to the project. You can undo it afterwards.</small>
            </footer>
          </section>}

          {!activeJob && !(reviewable && viewingProposalPage) && <>
            {previewFrame(activePage)}
            {reviewable && proposal && !viewingProposalPage && <div class="page-inline-notice">
              <Icon name="info" size={15} />
              <span>An edit of <strong>{proposalPaths.map(titleFor).join(', ')}</strong> is waiting for your review.</span>
              <Button size="sm" onClick={() => openRun(proposal)}>Open review</Button>
            </div>}
            {failed && proposal && viewingProposalPage && <PageEditFailure proposal={proposal} onRetry={(related) => void submit({ instruction: latestPageEditInstruction(proposal), allowRelated: related, paths: proposalPaths })} onRefine={() => { setInstruction(latestPageEditInstruction(proposal)); leaveProposal(); updateUrl(proposalPaths); focusComposer() }} />}
            <section class="page-edit-composer">
              <header class="composer-head">
                <span class="composer-icon"><Icon name="sparkles" size={18} /></span>
                <div>
                  <h2>Edit with the agent</h2>
                  <p>Describe the change in plain language. The agent works in an isolated copy and you review the result before anything is written.</p>
                </div>
              </header>
              <div class="composer-body">
                <div class="composer-field">
                  <label for="page-edit-instruction" class="field-label">{composerLabel}</label>
                  <div class="composer-textarea">
                    <Textarea id="page-edit-instruction" ref={textarea} rows={5} maxlength={2000} value={instruction} disabled={submitting} placeholder="For example: add a curl example under Authentication and say that tokens expire after 24 hours." onInput={(event) => setInstruction(event.currentTarget.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit() } }} />
                    <small class={instruction.length > 1900 ? 'warn' : ''}>{instruction.trim().length < MIN_EDIT_INSTRUCTION && instruction.length > 0 ? `At least ${MIN_EDIT_INSTRUCTION} characters` : `${instruction.length}/2000`}</small>
                  </div>
                </div>
                <div class="page-intent-chips" aria-label="Starting points">
                  <span>Start with</span>
                  {PAGE_EDIT_INTENTS.map(([label, value]) => <button key={label} type="button" aria-pressed="false" disabled={submitting} onClick={() => insertIntent(value)}>{label}</button>)}
                  <button type="button" aria-pressed="false" disabled={submitting} onClick={() => setAssetPicker(true)}><Icon name="plus" size={12} /> Insert an image…</button>
                </div>
                <div class="page-edit-options">
                  <div class={`page-option-card ${allowRelated ? 'on' : ''}`}>
                    <Toggle checked={allowRelated} disabled={submitting} onChange={setAllowRelated} label="Also allow related changes" />
                    <small>Lets the agent update navigation and add or replace images for this page.</small>
                  </div>
                  {state.project?.application && <div class={`page-option-card ${screenshots ? 'on' : ''}`}>
                    <Toggle checked={screenshots} disabled={submitting} onChange={setScreenshots} label="Capture product screenshots" />
                    <small>Off by default for page edits. Turn on when the change needs a fresh screenshot.</small>
                  </div>}
                </div>
                <button type="button" class="agent-config-summary" aria-expanded={agentOpen} onClick={() => setAgentOpen(!agentOpen)}><Icon name="bot" size={16} /><span>Agent: <b>{agent ? agentLabel(agent) : 'Automatically detect'}{model ? ` · ${model}` : ''}</b></span><strong>{agentOpen ? 'Done' : 'Change'}</strong></button>
                {agentOpen && <div class="page-agent-options">
                  <Field label="Agent"><Select value={agent} onChange={(event) => { const value = event.currentTarget.value; const nextModel = defaultModelForAgent(value); const level = preferredReasoningLevel(value, nextModel); setAgent(value); setModel(nextModel); setReasoning(value === 'codex' ? level : ''); setEffort(value === 'claude' ? level : '') }}><option value="">Automatically detect</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select></Field>
                  <Field label="Model"><Combo value={model} options={agentModels(agent).map((entry) => [entry.id, entry.label] as const)} disabled={!agent} onValueChange={setModel} /></Field>
                  {(agent === 'codex' || agent === 'claude') && <Field label={agent === 'claude' ? 'Effort' : 'Reasoning'}><Combo value={agent === 'claude' ? effort : reasoning} options={modelReasoningLevels(agent, model).map((value) => [value, value] as const)} onValueChange={agent === 'claude' ? setEffort : setReasoning} /></Field>}
                </div>}
              </div>
              <footer class="composer-foot">
                <Button tone="primary" icon="sparkles" busy={submitting} disabled={!instructionReady || selectedPaths.length === 0} onClick={() => void submit()}>Ask the agent to edit</Button>
                <small>The page stays unchanged until you accept the result.</small>
              </footer>
            </section>
          </>}
        </>}
      </section>
    </div>}
  </div>
}

type PagesView = 'pages' | 'navigation' | 'assets'

function pagesViewFrom(value: string | null): PagesView {
  return value === 'navigation' || value === 'assets' ? value : 'pages'
}

function groupPageSummaries(pages: PageSummary[]): Array<[string, PageSummary[]]> {
  const groups = new Map<string, PageSummary[]>()
  for (const page of pages) {
    const section = page.inNavigation ? page.section ?? 'Documentation' : 'Not in navigation'
    const entries = groups.get(section) ?? []
    entries.push(page)
    groups.set(section, entries)
  }
  const orphan = groups.get('Not in navigation')
  if (orphan) { groups.delete('Not in navigation'); groups.set('Not in navigation', orphan) }
  return [...groups]
}

function latestPageEditInstruction(proposal: Proposal): string {
  return proposal.editRequest?.followUps.at(-1)?.instruction ?? proposal.editRequest?.instruction ?? ''
}

function PageEditFailure({ proposal, onRetry, onRefine }: { proposal: Proposal; onRetry: (allowRelated: boolean) => void; onRefine: () => void }) {
  const error = proposal.error ?? 'The documentation agent could not complete this edit.'
  const outsideScope = error.includes('outside this page') || error.includes('outside these pages')
  const noChange = error.includes('did not change this page') || error.includes('did not change these pages')
  return <div class="page-edit-failure" role="alert">
    <span class="failure-icon"><Icon name="alert" size={16} /></span>
    <div>
      <strong>{outsideScope ? 'The agent changed files outside the selected page' : noChange ? 'The agent did not change the page' : 'The edit did not finish'}</strong>
      <p>{error}</p>
      <div class="note-actions">
        {outsideScope
          ? <><Button size="sm" tone="primary" onClick={() => onRetry(true)}>Retry allowing related changes</Button><Button size="sm" onClick={onRefine}>Refine the instruction</Button></>
          : noChange
            ? <Button size="sm" tone="primary" onClick={onRefine}>Refine the instruction</Button>
            : <><Button size="sm" tone="primary" icon="refresh" onClick={() => onRetry(Boolean(proposal.editRequest?.allowRelated))}>Try again</Button><Button size="sm" onClick={onRefine}>Refine the instruction</Button></>}
      </div>
    </div>
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

/** The pages a request touched, by title, trimmed to a readable few. */
export function historyPageNames(pages: HistoryChangedPage[], limit = 3): string {
  const names = pages.map((page) => page.title?.trim() || page.path.split('/').at(-1) || page.path)
  if (names.length <= limit) return names.join(', ')
  return `${names.slice(0, limit).join(', ')} and ${names.length - limit} more`
}

export function historyActionLabel(kind: HistoryRequest['kind']): string {
  if (kind === 'create') return 'Create'
  if (kind === 'review') return 'Review'
  if (kind === 'edit') return 'Edit'
  if (kind === 'navigation') return 'Navigation'
  if (kind === 'branding') return 'Branding'
  if (kind === 'asset') return 'Asset'
  if (kind === 'metadata') return 'Metadata'
  if (kind === 'glossary') return 'Glossary'
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
      const editPath = entry.kind === 'edit' ? pages[0]?.path : undefined
      const openEdit = () => { if (editPath) setLocation('pages', { path: editPath }, 'push') }
      return <tr key={entry.id} class={`history-row ${editPath ? 'clickable' : ''}`} tabIndex={editPath ? 0 : undefined} onClick={openEdit} onKeyDown={(event) => {
        if (!editPath || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        openEdit()
      }}>
        <td class="history-action">
          <strong>{historyActionLabel(entry.kind)}</strong>
        </td>
        <td>
          <div class="history-request">
            <strong title={instruction.truncated ? historyInstruction(entry) : undefined}>{instruction.text}</strong>
            {pages.length > 0 && <small class="history-pages" title={pages.map((page) => page.path).join('\n')}>{historyPageNames(pages)}</small>}
            {entry.error && <small class="history-error">{entry.error}</small>}
          </div>
        </td>
        <td class="history-result">
          <Badge tone={statusTone(entry.status)}>{statusLabel(entry.status)}</Badge>
          <small>{entry.pagesChanged > 0 ? `${changeCountText(pages, entry.pagesChanged)} changed` : entry.kind === 'edit' && pages.length > 0 ? `${changeCountText(pages, pages.length)} selected` : 'No page changes'}</small>
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
  const localSources = project.sources.filter((item) => (item.kind ?? 'directory') === 'directory' && !item.remote)
  const checking = state.jobs.some((job) => job.type === 'sync' && job.status === 'running')
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
        <div class="monitoring-dialog-status"><span class={project.sync.on.length ? 'active' : ''}><i />{project.sync.on.length ? scheduleSummary(scheduleForm(project.sync.on)) : 'Monitoring is not configured'}</span><Button size="sm" icon="refresh" busy={checking} disabled={checking} onClick={() => void act(() => post('/api/sync/now'), 'Source check started', false)}>{checking ? 'Checking…' : 'Check now'}</Button></div>
        {checking && <Note>A source check is running. Its result appears as a notice when it finishes; the live log is under Update.</Note>}
        {localSources.length > 0 && <Note>{localSources.map((item) => item.name).join(', ')} {localSources.length === 1 ? 'is a local folder and is' : 'are local folders and are'} checked in place: a Git checkout by its HEAD commit and working tree, any other folder by the files recorded at the last sync. Nothing is fetched, pulled, or written there.</Note>}
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
            <Field label="Maximum Claude spend (USD)" hint="Stops a Claude Code run at this cost and names the cap in the run log. Codex and Gemini have no spending flag, so this is ignored for them. 10 is a sensible starting point."><Input type="number" min="0.5" step="0.5" placeholder="10" value={sync.budget?.maxUsd ?? ''} onInput={(event) => setSync({ ...sync, budget: numberBudget(sync.budget, 'maxUsd', event.currentTarget.value) })} /></Field>
            <Field label="Re-verify after (days)" hint="Checks evidence age even when source content is unchanged."><Input type="number" min="1" max="3650" value={sync.maxVerificationAgeDays ?? ''} onInput={(event) => set('maxVerificationAgeDays', event.currentTarget.value ? clampNumber(event.currentTarget.value, 1, 3650) : undefined)} /></Field>
            <Field label="Expired verification"><Select value={sync.maxVerificationAgeSeverity ?? 'warn'} onChange={(event) => set('maxVerificationAgeSeverity', event.currentTarget.value as 'warn' | 'fail')}><option value="warn">Warn</option><option value="fail">Fail validation</option></Select></Field>
          </div>}
          <Note>Monitoring creates the documentation update as a proposal under Review. It never modifies the product source or publishes automatically.</Note>
        </section>
      </div>
      <footer>
        {project.sync.on.length > 0 && <Button tone="danger" onClick={() => confirm('Disable the installed monitoring schedule?') && void act(() => post('/api/sync/off'), 'Monitoring disabled')}>Disable</Button>}
        <span />
        <Button onClick={onClose}>Cancel</Button>
        <Button tone="primary" busy={saving} onClick={() => void save()}>Save and install</Button>
      </footer>
    </section>
  </div>
}

const STATUS_ICONS: Record<string, string> = {
  'Remote source': 'cloud',
  'Local source': 'folder',
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
  // The selected proposal and file live in the URL so a refresh or the back
  // button returns to the same view, and the ready dialog can deep-link here.
  const params = useSearchParams()
  const selectedId = params.get('proposal') ?? ''
  const selected = runs.find((run) => run.id === selectedId)
  const changeId = params.get('file') ?? ''
  const setSelectedId = (id: string) => setLocation('proposals', id ? { proposal: id } : {}, 'push')
  const setChangeId = (id: string) => setLocation('proposals', { proposal: selectedId, file: id })
  const [confirmingAcceptance, setConfirmingAcceptance] = useState<Proposal | null>(null)
  const [overwriteConfirmed, setOverwriteConfirmed] = useState(false)
  const [appliedProposal, setAppliedProposal] = useState<Proposal | null>(null)
  const [delivery, setDelivery] = useState<{ branch: string; commit: string; compareUrl?: string; pullRequestCommand?: string; pushedAt?: string; pullRequestUrl?: string } | null>(null)
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [layout, setLayout] = useState<'split' | 'unified'>('split')
  const [folder, setFolder] = useState('')
  const [folderReason, setFolderReason] = useState('')
  const [onlyChanges, setOnlyChanges] = useState(true)
  const [rationaleChange, setRationaleChange] = useState<ProposalChange | null>(null)
  const [revision, setRevision] = useState<{
    mode: 'current' | 'selected' | 'all'
    instruction: string
    selectedIds: string[]
    hunkIds: string[]
  } | null>(null)
  const change = selected?.changes.find((item) => item.id === changeId) ?? (selected ? defaultReviewChange(selected.changes) : undefined)
  const open = selected ? !selected.archivedAt && OPEN_STATUSES.includes(selected.status) : false
  const concurrentChanges = selected ? reviewFileGroups(selected.changes).concurrent : []
  useEffect(() => setOverwriteConfirmed(false), [confirmingAcceptance?.id])
  /** File- and hunk-level accepts on a file edited during the run ask before replacing that edit. */
  const confirmOverwrite = (target: ProposalChange): boolean =>
    !target.changedDuringRun || confirm(`${target.path} was edited in the project while the agent ran. Applying this change replaces that edit. Continue?`)
  // A revision or resumption runs as its own job; show it where the reviewer
  // is waiting for it, with a way to stop it, and say why when it fails.
  const [dismissedJobIds, setDismissedJobIds] = useState<string[]>([])
  const selectedJobs = selected ? state.jobs.filter((job) => job.type === `proposal:revise:${selected.id}` || job.type === `proposal:resume:${selected.id}`) : []
  const runningRevision = selectedJobs.find((job) => job.status === 'running')
  const failedRevision = runningRevision ? undefined : selectedJobs.find((job) => job.status === 'failed' && !dismissedJobIds.includes(job.id))
  const counts = selected ? proposalChangeCounts(selected.changes) : { added: 0, modified: 0, deleted: 0 }
  const acceptAll = async (proposal: Proposal) => {
    const result = await act(() => post<Proposal>(`/api/proposals/${proposal.id}/accept`, { scope: 'all', ...(overwriteConfirmed ? { confirmChangedDuringRun: true } : {}) }))
    setConfirmingAcceptance(null)
    if (result?.status === 'applied') setAppliedProposal(result)
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
    {confirmingAcceptance && <div class="proposal-ready-scrim" role="presentation">
      <section class="proposal-ready-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-accept-title">
        <button class="proposal-ready-close" type="button" aria-label="Close" onClick={() => setConfirmingAcceptance(null)}><Icon name="close" size={16} /></button>
        <span class="proposal-ready-icon"><Icon name="proposals" size={24} /></span>
        <div><h2 id="proposal-accept-title">Apply these documentation changes?</h2><p>This replaces the current versions of the reviewed files with the proposed versions.</p></div>
        <div class="proposal-ready-summary"><strong>{proposalSummaryText(confirmingAcceptance.changes)}</strong><span>Only the files listed in this proposal will be applied.</span></div>
        {concurrentChanges.length > 0 && <div class="proposal-concurrent-warning" role="group" aria-label="Files edited while the agent ran">
          <strong><Icon name="alert" size={14} />{concurrentChanges.length === 1 ? 'One file was edited while the agent ran' : `${concurrentChanges.length} files were edited while the agent ran`}</strong>
          <p>The agent never saw these edits. Applying the proposal replaces them with the proposed versions.</p>
          <ul>{concurrentChanges.map((item) => <li key={item.id}><code>{item.path}</code></li>)}</ul>
          <Toggle checked={overwriteConfirmed} onChange={setOverwriteConfirmed} label="Replace my edits to these files" />
        </div>}
        <footer><Button onClick={() => setConfirmingAcceptance(null)}>Cancel</Button><Button tone="primary" icon="check" disabled={concurrentChanges.length > 0 && !overwriteConfirmed} onClick={() => void acceptAll(confirmingAcceptance)}>Apply changes</Button></footer>
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
      : <PageHeader title="Review" description="Choose a proposal to inspect and approve its documentation changes." />}
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
                <small>{selected.changes.flatMap((item) => item.hunks).filter((hunk) => hunk.acceptedAt).length} accepted · {selected.changes.flatMap((item) => item.hunks).filter((hunk) => hunk.rejectedAt).length} rejected · {selected.changes.flatMap((item) => item.hunks).filter((hunk) => !hunk.acceptedAt && !hunk.rejectedAt).length} remaining</small>
              </div>
              <div class="proposal-summary-side">
                <div class="proposal-actions">
                  {selected.status === 'applied' && selected.undo?.status === 'available' && <Button onClick={() => confirm('Undo every file applied by this proposal? Newer edits will be protected.') && void act(() => post(`/api/proposals/${selected.id}/undo`), 'Documentation changes undone')}>Undo</Button>}
                  {(open || (selected.status === 'stale' && !selected.archivedAt)) && <Button onClick={() => setRevision({ mode: 'all', instruction: 'Regenerate this proposal using the current approved plan and evidence.', selectedIds: selected.changes.map((item) => item.id), hunkIds: [] })}>Regenerate</Button>}
                  <Button tone="danger" disabled={!open} onClick={() => confirm('Reject the remaining undecided changes? Already accepted changes stay applied.') && void act(() => post(`/api/proposals/${selected.id}/reject`), 'Remaining changes rejected')}>Reject remaining</Button>
                  <Button tone="primary" icon="check" disabled={!open} onClick={() => selected && setConfirmingAcceptance(selected)}>Accept all</Button>
                </div>
              </div>
            </header>

            {open && <details class="text-editor"><summary>Review a folder</summary><div class="text-editor-body"><label>Folder<select value={folder} onChange={(event) => setFolder(event.currentTarget.value)}><option value="">Choose a folder</option>{[...new Set(selected.changes.flatMap((item) => { const parts = item.path.split('/'); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/')) }))].sort().map((path) => <option>{path}</option>)}</select></label>{folder && <ul>{selected.changes.filter((item) => item.path.startsWith(`${folder}/`) && item.hunks.some((hunk) => !hunk.acceptedAt && !hunk.rejectedAt)).map((item) => <li>{item.path}</li>)}</ul>}<label>Rejection reason<input value={folderReason} onInput={(event) => setFolderReason(event.currentTarget.value)} /></label><div class="text-editor-actions"><Button disabled={!folder} onClick={() => { const changes = selected.changes.filter((item) => item.path.startsWith(`${folder}/`)); if (changes.some((item) => item.changedDuringRun)) { onError('A file in this folder changed during generation. Review and accept it individually before accepting the folder.'); return } void act(() => post(`/api/proposals/${selected.id}/accept`, { scope: 'folder', folder }), 'Folder changes accepted') }}>Accept pending changes in folder</Button><Button disabled={!folder || !folderReason.trim()} onClick={() => void act(() => post(`/api/proposals/${selected.id}/reject-changes`, { scope: 'folder', folder, reason: folderReason }), 'Folder changes rejected')}>Reject pending changes in folder</Button></div></div></details>}
            {selected.status === 'failed' && !selected.archivedAt && <div class="proposal-lifecycle-notice failed">
              <Icon name="alert" size={15} />
              <span class="proposal-failed-copy"><strong>This run stopped before it could be reviewed.</strong>{selected.error && <small>{selected.error}</small>}{(selected.recovery?.resumable !== false || selected.recovery?.ignorable !== false) && <small>Its workspace is preserved: continue it instead of generating again.</small>}</span>
              {(selected.recovery?.resumable !== false || selected.recovery?.ignorable !== false) && <span class="proposal-failed-actions">
                {selected.recovery?.resumable !== false && <Button size="sm" tone="primary" icon="play" onClick={() => void act(() => post<UiJob>(`/api/proposals/${selected.id}/resume`), 'Continuing the documentation run')}>Resume</Button>}
                {selected.recovery?.ignorable !== false && <Button size="sm" icon="check" onClick={() => void act(() => post<Proposal>(`/api/proposals/${selected.id}/recover`, { ignoreScreenshotProblems: true }), 'Proposal ready for review with problems ignored')}>Ignore problems & review</Button>}
              </span>}
            </div>}
            {failedRevision && <div class="proposal-lifecycle-notice failed" role="alert">
              <Icon name="alert" size={15} />
              <span class="proposal-failed-copy"><strong>{failedRevision.type.startsWith('proposal:resume:') ? 'The run could not be continued.' : 'The agent could not complete this revision.'}</strong><small>{jobFailureReason(failedRevision) ?? 'The agent stopped without reporting a reason. Open the log for details.'}</small></span>
              <span class="proposal-failed-actions">
                <a class="btn secondary sm" href={`/api/jobs/${failedRevision.id}/log`} target="_blank" rel="noreferrer">Open log</a>
                <Button size="sm" onClick={() => setDismissedJobIds([...dismissedJobIds, failedRevision.id])}>Dismiss</Button>
              </span>
            </div>}
            {runningRevision && <section class="proposal-revision-live" aria-label="Agent revision in progress">
              <header><Icon name="bot" size={15} /><strong>{workflowActivityLabel(runningRevision.type)}</strong><small>The proposal updates when the agent finishes.</small></header>
              <AuthoringLiveLog job={runningRevision} act={act} stopLabel="Stop" />
            </section>}
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
                        changes={selected.changes}
                        selected={change}
                        onSelect={setChangeId}
                      />
                    </div>
                    <span class="file-position">{Math.max(0, selected.changes.findIndex((item) => item.id === change.id)) + 1} of {selected.changes.length}</span>
                  </header>
                  {change.changedDuringRun && <div class="proposal-lifecycle-notice concurrent" role="note">
                    <Icon name="alert" size={15} />
                    <span><strong>This file was edited in the project while the agent ran.</strong> The comparison shows the proposal against your edited version; accepting replaces that edit and asks first.</span>
                  </div>}
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
                      {selected.status === 'applied' && change.category === 'page' && change.kind !== 'deleted' && <Button size="sm" onClick={() => setLocation('pages', { path: change.path }, 'push')}>Edit this page</Button>}
                      <Button size="sm" disabled={!open} onClick={() => setRevision({ mode: 'current', instruction: '', selectedIds: [change.id], hunkIds: [] })}>Ask agent to revise</Button>
                      <Button size="sm" tone="danger" disabled={!open || !change.hunks.some((hunk) => !hunk.acceptedAt && !hunk.rejectedAt)} onClick={() => { const reason = prompt('Why reject the remaining changes in this file? (optional)', ''); if (reason !== null) void act(() => post(`/api/proposals/${selected.id}/reject-changes`, { changeId: change.id, reason }), 'File changes rejected') }}>Reject file</Button>
                      <Button size="sm" tone="primary" icon="check" disabled={!open} onClick={() => confirmOverwrite(change) && void act(() => post(`/api/proposals/${selected.id}/accept`, { scope: 'page', changeId: change.id, ...(change.changedDuringRun ? { confirmChangedDuringRun: true } : {}) }), 'Page accepted')}>Accept file</Button>
                    </div>
                  </div>
                  <Comments key={`comments:${selected.id}:${change.id}`} path={change.path} proposal={{ id: selected.id, change }} onRequest={async (text, hunkId) => { if (!open) throw new Error('This proposal is closed. Comment on the live page to request a new update.'); await act(() => post(`/api/proposals/${selected.id}/revise`, { instruction: `Address this reviewer comment: ${text}`, changeIds: [change.id], hunkIds: hunkId ? [hunkId] : [] }), 'Comment revision started') }} />
                  {open && change.category === 'page' && !change.binary && change.kind !== 'deleted' && change.hunks.every((hunk) => !hunk.acceptedAt && !hunk.rejectedAt) && <TextEditor key={`${selected.id}:${change.id}`} root={state.root ?? state.cwd} path={change.path} proposal={{ id: selected.id, changeId: change.id }} onChanged={async () => { await act(async () => true) }} />}
                  <div class="review-diff-body">
                    {view === 'source'
                      ? <ProposalSourceDiff runId={selected.id} change={change} act={act} partialActions={open} beforeAccept={() => confirmOverwrite(change)} onReviseHunk={(hunkId) => setRevision({ mode: 'current', instruction: '', selectedIds: [change.id], hunkIds: [hunkId] })} />
                      : <ProposalRenderedDiff key={`${selected.id}:${change.afterHash}`} runId={selected.id} change={change} layout={layout} onlyChanges={onlyChanges} />}
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

type ReviewTreeNode = {
  name: string
  path: string
  children: ReviewTreeNode[]
  change?: ProposalChange
}

function ReviewFilePicker({ changes, selected, onSelect }: {
  changes: ProposalChange[]
  selected: ProposalChange
  onSelect: (id: string) => void
}) {
  const root = useRef<HTMLDivElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const groups = reviewFileGroups(changes)
  // Supporting files stay folded unless the reviewer asks for them or the
  // selected file is one of them, so review opens on documentation.
  const [showSupporting, setShowSupporting] = useState(false)
  const supportingVisible = showSupporting || groups.supporting.some((item) => item.id === selected.id) || (groups.documentation.length === 0 && groups.concurrent.length === 0)
  const sections = [
    { id: 'concurrent', label: 'Changed while the agent ran', hint: 'Applying these replaces your edits', changes: groups.concurrent, tone: 'warn' },
    { id: 'documentation', label: 'Documentation', hint: 'Pages, navigation, and assets', changes: groups.documentation, tone: '' },
    ...(supportingVisible ? [{ id: 'supporting', label: 'Supporting files', hint: 'Evidence, configuration, and skills', changes: groups.supporting, tone: '' }] : []),
  ].filter((section) => section.changes.length > 0)
  const filteredSections = sections.map((section) => ({ ...section, nodes: filterReviewFileTree(proposalFileTree(section.changes), query) })).filter((section) => section.nodes.length > 0)
  const matchingFiles = filteredSections.reduce((count, section) => count + countReviewTreeFiles(section.nodes), 0)
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
      {selected.changedDuringRun && <span class="review-file-picker-status concurrent" title="Edited in the project while the agent ran">edited</span>}
      <Icon name="chevronRight" size={13} />
    </button>

    {open && <div id="review-file-picker-menu" class="review-file-picker-menu" role="dialog" aria-label="Changed files">
      <header>
        <span><strong>Changed files</strong><small>{changes.length} file{changes.length === 1 ? '' : 's'} in this proposal</small></span>
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
          ? filteredSections.map((section) => <section key={section.id} class={`review-file-group ${section.tone}`} aria-label={section.label}>
            <header><strong>{section.label}</strong><small>{section.hint}</small></header>
            <ReviewFileTree nodes={section.nodes} selectedId={selected.id} onSelect={selectFile} />
          </section>)
          : <div class="review-file-search-empty"><Icon name="search" size={18} /><strong>No matching files</strong><small>Try a filename or folder path.</small></div>}
        {groups.supporting.length > 0 && !query.trim() && <button type="button" class="review-file-group-toggle" aria-expanded={supportingVisible} onClick={() => setShowSupporting(!supportingVisible)}>
          <Icon name="chevronRight" size={12} />{supportingVisible ? 'Hide' : 'Show'} {groups.supporting.length} supporting file{groups.supporting.length === 1 ? '' : 's'}
        </button>}
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

/**
 * The deploy CLI prints one checklist line per finished step (`✓ label · detail`,
 * or `✗ label` for the step that failed). Nothing is printed while a step runs,
 * so the labels below name the steps up front and the log fills in the details.
 */
const DEPLOY_STEP_LINE = /^\s*([✓✗])\s+(.+)$/
const ANSI = /\x1b\[[0-9;]*m/g

function deployStepLabels(generator: string | undefined, dryRun: boolean, exporting = false): string[] {
  if (exporting) return ['Validating documentation', 'Building static site', 'Writing folder and zip']
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
function DeployProgress({ job, generator, act, streamConnected, onDismiss }: {
  job: UiJob
  generator: string | undefined
  act: Action
  streamConnected: boolean
  onDismiss?: (() => void) | undefined
}) {
  const log = useRef<HTMLPreElement>(null)
  const [logOpen, setLogOpen] = useState(true)
  const dryRun = job.type === 'deploy:dry-run'
  const exporting = job.type === 'export'
  const { steps, percent } = deploySteps(job, deployStepLabels(generator, dryRun, exporting))
  const running = job.status === 'running'
  const active = steps.find((step) => step.status === 'running')
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [job.lines.length, logOpen])
  const headline = running
    ? active?.label ?? (exporting ? 'Exporting static site' : dryRun ? 'Validating deployment' : 'Deploying documentation')
    : job.status === 'succeeded'
      ? exporting ? 'Static site exported' : dryRun ? 'Deployment is valid' : 'Documentation published'
      : job.status === 'cancelled' ? exporting ? 'Export cancelled' : 'Deployment cancelled' : exporting ? 'Export failed' : 'Deployment failed'
  return <section class={`deploy-progress ${job.status}`} aria-live="polite">
    <header class="deploy-progress-head">
      <span class={`deploy-progress-icon ${job.status}`}>
        <Icon name={running ? 'publish' : job.status === 'succeeded' ? 'check' : 'alert'} size={19} />
      </span>
      <div class="deploy-progress-title">
        <strong>{headline}</strong>
        <small>{exporting ? 'Writing a self-hostable folder and zip on this computer.' : dryRun ? 'Validation only — nothing is uploaded.' : 'Publishing the validated static bundle to the selected target.'}</small>
      </div>
      {running
        ? <Badge tone={streamConnected ? 'good' : 'warn'} icon="broadcast">{streamConnected ? 'Live' : 'Reconnecting…'}</Badge>
        : <Badge tone={statusTone(job.status)}>{statusLabel(job.status)}</Badge>}
      {running && <Button size="sm" tone="danger" icon="stop" onClick={() => void act(() => post(`/api/jobs/${job.id}/cancel`), 'Deployment stopped')}>Stop</Button>}
      {!running && onDismiss && <Button size="sm" icon="close" onClick={onDismiss}>Dismiss</Button>}
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
      {logOpen && <pre ref={log} class="terminal live-terminal">{job.lines.length > 0 ? job.lines.filter((line) => !line.startsWith('DOXLOOP_EVENT ')).join('\n') : 'Starting deployment…'}</pre>}
    </div>
  </section>
}

function Publish({ state, act, streamConnected, onError }: { state: UiState; act: Action; streamConnected: boolean; onError: (error: string) => void }) {
  const effective = state.effectiveDeployment!
  const [deployment, setDeployment, deploymentSync] = useSeededForm(() => effective, JSON.stringify(effective))
  /** Visibility is asked once. An explicit saved choice means every later deploy runs straight away. */
  const chosenVisibility = state.project?.deployment?.visibility
  const [dialog, setDialog] = useState<'first' | 'change' | null>(null)
  const [choice, setChoice] = useState<'private' | 'public'>(deployment.visibility === 'public' ? 'public' : 'private')
  const [starting, setStarting] = useState(false)
  const [providerToken, setProviderToken] = useState('')
  /** Set when a deploy is attempted while signed out, so the reason is explained in place. */
  const [signInRequired, setSignInRequired] = useState(false)
  const account = state.account
  const signedIn = Boolean(account?.signedIn)
  const target = deployment.target ?? 'doxbrix'
  const targetLabel = target === 'github-pages' ? 'GitHub Pages' : target === 'netlify' ? 'Netlify' : target === 'vercel' ? 'Vercel' : 'Doxbrix'
  const activeDeploy = state.jobs.find((job) => (job.type.startsWith('deploy') || job.type === 'export') && job.status === 'running')
  const busy = Boolean(activeDeploy || starting)
  // A finished deployment keeps its checklist and log on screen until it is
  // dismissed, so a failure can be read instead of vanishing with the job.
  const [dismissedDeployId, setDismissedDeployId] = useState<string>()
  const shownDeploy = activeDeploy ?? recentSettledJob(state.jobs, (job) => job.type.startsWith('deploy') || job.type === 'export', dismissedDeployId)
  const loginJob = state.jobs.find((job) => job.type === 'login')
  const [dismissedLoginId, setDismissedLoginId] = useState<string>()
  const signingIn = loginJob?.status === 'running' ? loginJob : undefined
  const failedLogin = !signingIn && !signedIn ? recentSettledJob(state.jobs, (job) => job.type === 'login' && job.status === 'failed', dismissedLoginId) : undefined
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
  const settledDeploys = state.jobs.filter((job) => (job.type.startsWith('deploy') || job.type === 'export') && job.status !== 'running').length
  useEffect(() => {
    if (!signedIn || target !== 'doxbrix') return
    let current = true
    void api<{ url: string | null }>('/api/deployment/site')
      .then((payload) => { if (current) setSiteUrl(payload.url) })
      .catch(() => undefined)
    return () => { current = false }
  }, [signedIn, settledDeploys, target])
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
    if (target === 'doxbrix' && !signedIn) {
      setSignInRequired(true)
      return
    }
    setSignInRequired(false)
    if (target === 'doxbrix' && !dryRun && !chosenVisibility) {
      setChoice(isPublic ? 'public' : 'private')
      setDialog('first')
      return
    }
    await start(isPublic ? 'public' : 'private', dryRun)
  }
  const saveDeployment = () => act(() => patch('/api/project', { deployment }), 'Deployment settings saved')
  const exportSite = () => act(() => post('/api/export', { basePath: deployment.basePath }), 'Static export started')
  const saveProviderToken = async () => {
    if (target !== 'netlify' && target !== 'vercel') return
    const result = await act(() => post('/api/deployment/credentials', { target, token: providerToken }), `${targetLabel} token saved outside the project`)
    if (result !== undefined) setProviderToken('')
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
      description="Export a self-hostable site or publish it to a configured host. Product sources are never included."
      actions={publishedUrl
        ? <a class="btn secondary md" href={publishedUrl} target="_blank" rel="noreferrer"><Icon name="external" size={16} />View deployed docs</a>
        : undefined}
    />
    {deploymentSync.stale && <StaleFormNotice onResync={deploymentSync.resync} />}

    <section class="deploy-target-picker" aria-label="Deployment target">
      {([
        ['doxbrix', 'Doxbrix', 'Managed hosting with private or public access'],
        ['github-pages', 'GitHub Pages', 'Publish the static build to gh-pages'],
        ['netlify', 'Netlify', 'Upload directly to an existing Netlify site'],
        ['vercel', 'Vercel', 'Create a production deployment through Vercel'],
      ] as const).map(([id, label, detail]) => <button type="button" key={id} class={target === id ? 'selected' : ''} aria-pressed={target === id} onClick={() => setDeployment({ ...deployment, target: id, ...(id === 'netlify' ? { apiUrl: 'https://api.netlify.com' } : id === 'vercel' ? { apiUrl: 'https://api.vercel.com' } : id === 'doxbrix' ? { apiUrl: account?.apiUrl ?? 'https://app.doxbrix.com' } : {}) })}>
        <strong>{label}</strong><small>{detail}</small>
      </button>)}
    </section>

    <section class="publish-card">
      <header class="publish-card-head">
        <span class="publish-card-icon"><Icon name="publish" size={20} /></span>
        <div>
          <h2>Deploy to {targetLabel}</h2>
          <p>{target === 'doxbrix' && chosenVisibility
            ? `This documentation publishes ${isPublic ? 'publicly' : 'privately'} — no further prompts.`
            : target === 'doxbrix' ? 'The first deployment asks who can see the documentation.' : 'Doxloop builds and validates the same portable static bundle before publishing.'}</p>
        </div>
        {target === 'doxbrix' && (signedIn
          ? <Badge tone="good" icon="check">Signed in</Badge>
          : <Badge tone="warn" icon="alert">Not signed in</Badge>)}
      </header>

      <dl class="publish-destination">
        <div><dt>Project name</dt><dd><input class="input" value={deployment.name} onInput={(event) => setDeployment({ ...deployment, name: event.currentTarget.value })} /></dd></div>
        <div><dt>Slug</dt><dd><input class="input mono" value={deployment.slug} onInput={(event) => setDeployment({ ...deployment, slug: event.currentTarget.value })} /></dd></div>
        {(target === 'doxbrix' || target === 'netlify' || target === 'vercel') && <div><dt>API URL</dt><dd><input class="input mono" value={deployment.apiUrl} onInput={(event) => setDeployment({ ...deployment, apiUrl: event.currentTarget.value })} /></dd></div>}
        {target === 'netlify' && <div><dt>Site ID</dt><dd><input class="input mono" placeholder="Netlify site ID" value={deployment.siteId ?? ''} onInput={(event) => setDeployment({ ...deployment, siteId: event.currentTarget.value })} /></dd></div>}
        {target === 'vercel' && <><div><dt>Project ID or name</dt><dd><input class="input mono" value={deployment.projectId ?? ''} onInput={(event) => setDeployment({ ...deployment, projectId: event.currentTarget.value })} /></dd></div><div><dt>Team ID (optional)</dt><dd><input class="input mono" value={deployment.teamId ?? ''} onInput={(event) => setDeployment({ ...deployment, teamId: event.currentTarget.value })} /></dd></div></>}
        {target === 'github-pages' && <><div><dt>Branch</dt><dd><input class="input mono" value={deployment.branch ?? 'gh-pages'} onInput={(event) => setDeployment({ ...deployment, branch: event.currentTarget.value })} /></dd></div><div><dt>Base path (optional)</dt><dd><input class="input mono" placeholder="/repository" value={deployment.basePath ?? ''} onInput={(event) => setDeployment({ ...deployment, basePath: event.currentTarget.value })} /></dd></div></>}
        {target === 'doxbrix' && <div class="publish-destination-visibility">
          <dt>Visibility</dt>
          <dd>
            <span class={`visibility-pill ${isPublic ? 'public' : 'private'}`}><Icon name={isPublic ? 'cloud' : 'lock'} size={13} />{isPublic ? 'Public' : 'Private'}</span>
            {chosenVisibility
              ? <button type="button" class="publish-link-button" onClick={() => { setChoice(isPublic ? 'public' : 'private'); setDialog('change') }}>Change</button>
              : <small>Chosen on first deploy</small>}
          </dd>
        </div>}
      </dl>

      <div class="deploy-config-actions"><Button icon="check" onClick={() => void saveDeployment()}>Save target settings</Button></div>
      {(target === 'netlify' || target === 'vercel') && <div class="deploy-token-row">
        <label><span>{targetLabel} access token</span><input class="input mono" type="password" autocomplete="off" placeholder="Stored outside this project" value={providerToken} onInput={(event) => setProviderToken(event.currentTarget.value)} /></label>
        <Button disabled={providerToken.length < 8} onClick={() => void saveProviderToken()}>Save token</Button>
        <small>You can also use <code>{target === 'netlify' ? 'DOXLOOP_NETLIFY_TOKEN' : 'DOXLOOP_VERCEL_TOKEN'}</code>.</small>
      </div>}

      {target === 'doxbrix' && (signedIn
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
          {signingIn
            ? <Button tone="danger" icon="stop" onClick={() => void act(() => post(`/api/jobs/${signingIn.id}/cancel`), 'Sign-in cancelled')}>Cancel sign-in</Button>
            : <Button tone="primary" icon="key" onClick={() => { setSignInRequired(false); void act(() => post('/api/auth/login', { apiUrl: deployment.apiUrl }), 'Browser sign-in started') }}>Sign in with browser</Button>}
        </div>)}

      {target === 'doxbrix' && signingIn && <div class="publish-signin-pending" role="status" aria-live="polite">
        <Icon name="external" size={16} />
        <span>
          <strong>Finish signing in in your browser.</strong>
          <small>Doxbrix opened in a new browser tab. Approve the sign-in there; this page updates as soon as the account is connected.</small>
        </span>
        <a href={`/api/jobs/${signingIn.id}/log`} target="_blank" rel="noreferrer">Show log</a>
      </div>}
      {target === 'doxbrix' && failedLogin && <div class="publish-signin-required" role="alert">
        <Icon name="alert" size={16} />
        <span>
          <strong>Sign-in did not complete.</strong>
          <small>{jobFailureReason(failedLogin) ?? 'The sign-in stopped before an account was connected. Try again.'}</small>
        </span>
        <Button size="sm" onClick={() => setDismissedLoginId(failedLogin.id)}>Dismiss</Button>
      </div>}

      {target === 'doxbrix' && signInRequired && !signedIn && <div class="publish-signin-required" role="alert">
        <Icon name="alert" size={16} />
        <span>
          <strong>Sign in with Doxbrix to deploy the documentation.</strong>
          <small>Deploying uploads the documentation to your Doxbrix account, so use “Sign in with browser” above to connect it first.</small>
        </span>
      </div>}

      <footer class="publish-card-actions">
        <Button class="publish-deploy-button" tone="primary" icon="publish" busy={busy} onClick={() => void deploy(false)}>Deploy to {targetLabel}</Button>
        <Button disabled={busy} onClick={() => void deploy(true)}>Dry run</Button>
        <Button disabled={busy} onClick={() => void exportSite()}>Export folder + zip</Button>
        <small>A dry run validates and leaves a zip in <code>.doxloop/exports</code> without uploading.</small>
      </footer>
    </section>

    {shownDeploy && <DeployProgress job={shownDeploy} generator={state.project?.generator} act={act} streamConnected={streamConnected} onDismiss={shownDeploy.status === 'running' ? undefined : () => setDismissedDeployId(shownDeploy.id)} />}

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
  ['branding', 'Branding', 'Logo, colours, and fonts', 'sparkle'],
  ['tools', 'Generator', 'Active documentation generator', 'publish'],
] as const

type SettingsSection = typeof SETTINGS_SECTIONS[number][0]

function Settings({ state, act, onError }: { state: UiState; act: Action; onError: (error: string) => void }) {
  const project = state.project!
  const params = useSearchParams()
  const requestedSection = params.get('section')
  const section: SettingsSection = SETTINGS_SECTIONS.some(([id]) => id === requestedSection) ? requestedSection as SettingsSection : 'general'
  const setSection = (next: SettingsSection) => setLocation('settings', { section: next })
  // Forms reseed from the project after a save or a reload; unsaved edits are
  // kept and flagged instead of being replaced underneath the reader.
  const [identity, setIdentity, identitySync] = useSeededForm(() => ({ title: project.title, defaultAgent: project.defaultAgent ?? '' }), JSON.stringify([project.title, project.defaultAgent]))
  const [docs, setDocs, docsSync] = useSeededForm(() => ({ ...project.documentation, audiencesText: project.documentation.audiences?.join(', ') ?? '', customInstructions: project.documentation.customInstructions ?? '', outcomesText: project.documentation.priorityOutcomes?.join(', ') ?? '', preferredExamplesText: project.documentation.preferredExamples?.join(', ') ?? '', toneText: project.documentation.tone.join(', '), exclusionsText: project.documentation.exclusions.join('\n'), terms: termsFromRecord(project.documentation.terminology) }), JSON.stringify(project.documentation))
  const [application, setApplication, applicationSync] = useSeededForm(() => ({
    baseUrl: project.application?.baseUrl ?? '',
    source: project.application?.source ?? '',
    readyPath: project.application?.readyPath ?? '',
    policy: project.application?.screenshots?.policy ?? 'requested',
    highlight: project.application?.screenshots?.highlight ?? true,
    startPath: project.application?.screenshots?.startPath ?? '/',
    workflow: project.application?.screenshots?.workflow ?? '',
    viewportWidth: String(project.application?.screenshots?.viewport?.width ?? 1440),
    viewportHeight: String(project.application?.screenshots?.viewport?.height ?? 900),
    loginPath: project.application?.authentication?.loginPath ?? '',
  }), JSON.stringify(project.application ?? null))
  const [applicationReadiness, setApplicationReadiness] = useState<ApplicationReadiness>()
  const [testingApplication, setTestingApplication] = useState(false)
  const applicationPayload = { baseUrl: application.baseUrl, source: application.source, readyPath: application.readyPath, screenshots: { policy: application.policy, highlight: application.highlight, viewport: { width: application.viewportWidth, height: application.viewportHeight }, startPath: application.startPath, workflow: application.workflow }, authentication: { loginPath: application.loginPath } }
  const testApplication = async () => {
    setTestingApplication(true)
    try { setApplicationReadiness(await post<ApplicationReadiness>('/api/application/readiness', applicationPayload)) }
    catch { setApplicationReadiness(undefined) }
    finally { setTestingApplication(false) }
  }
  const saveDocs = () => act(() => patch('/api/project', { documentation: { ...docs, audiences: splitComma(docs.audiencesText), priorityOutcomes: splitComma(docs.outcomesText), preferredExamples: splitComma(docs.preferredExamplesText), tone: splitComma(docs.toneText), exclusions: docs.exclusionsText.split('\n').map((item) => item.trim()).filter(Boolean), terminology: recordFromTerms(docs.terms) } }), 'Documentation preferences saved')
  const unsavedTerms = JSON.stringify(recordFromTerms(docs.terms)) !== JSON.stringify(project.documentation.terminology)
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
          {identitySync.stale && <StaleFormNotice onResync={identitySync.resync} />}
          <div class="form-grid">
            <Field label="Site title"><Input value={identity.title} onInput={(event) => setIdentity({ ...identity, title: event.currentTarget.value })} /></Field>
            <Field label="Default documentation agent"><Select value={identity.defaultAgent} onChange={(event) => setIdentity({ ...identity, defaultAgent: event.currentTarget.value })}><option value="">Choose per run</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select></Field>
          </div>
          <KeyValues items={[['Content directory', <code class="mono">{project.contentDir || 'Project root'}</code>], ['Generator', generatorLabel(state.generators, project.generator)], ['Workspace', <code class="mono">{state.root ?? state.cwd}</code>]]} />
          <details class="agent-capabilities-details" open={identity.defaultAgent === 'gemini'}>
            <summary>What each assistant supports</summary>
            <AgentCapabilityMatrix selected={identity.defaultAgent || undefined} />
          </details>
          <div class="form-actions"><Button tone="primary" onClick={() => void act(() => patch('/api/project', identity), 'Identity settings saved')}>Save changes</Button></div>
        </Panel>}

        {section === 'experience' && <Panel title="Audience and voice" description="These preferences guide every documentation run, so results stay consistent.">
          {docsSync.stale && <StaleFormNotice onResync={docsSync.resync} />}
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
            <Field label="Preferred terminology" hint="Product vocabulary with its meaning or preferred wording. Feeds every run and the glossary page." wide><TermsEditor value={docs.terms} onChange={(terms) => setDocs({ ...docs, terms })} /></Field>
            <Field label="Content exclusions" hint="One item per line"><Textarea rows={5} value={docs.exclusionsText} onInput={(event) => setDocs({ ...docs, exclusionsText: event.currentTarget.value })} /></Field>
            <Field label="Instructions" hint="Additional guidance reused for future documentation runs" wide><Textarea rows={5} value={docs.customInstructions} placeholder="Use concise explanations and include TypeScript examples." onInput={(event) => setDocs({ ...docs, customInstructions: event.currentTarget.value })} /></Field>
          </div>
          <div class="form-actions"><Button tone="primary" onClick={() => void saveDocs()}>Save changes</Button></div>
        </Panel>}
        {section === 'experience' && <GlossaryPanel act={act} onError={onError} unsavedTerms={unsavedTerms} onOpenPage={(path) => setLocation('pages', { path }, 'push')} />}

        {section === 'branding' && <BrandingPanel act={act} onError={onError} {...(state.preview?.running && state.preview.url ? { previewUrl: state.preview.url } : {})} onPreviewStart={() => post<{ url: string }>('/api/preview/start', { open: false }).then((result) => result.url).catch((cause) => { onError(message(cause)); return undefined })} />}

        {section === 'capture' && <>
          <Panel title="Application screenshots" description="Configure a safe local or test application for guide screenshots.">
            {applicationSync.stale && <StaleFormNotice onResync={applicationSync.resync} />}
            <div class="form-grid">
              <Field label="Application base URL"><Input value={application.baseUrl} placeholder="http://localhost:3000" onInput={(event) => setApplication({ ...application, baseUrl: event.currentTarget.value })} /></Field>
              <Field label="Product source"><Select value={application.source} onChange={(event) => setApplication({ ...application, source: event.currentTarget.value })}><option value="">None</option>{project.sources.map((source) => <option value={source.name}>{source.name}</option>)}</Select></Field>
              <Field label="Ready path"><Input value={application.readyPath} placeholder="/health" onInput={(event) => setApplication({ ...application, readyPath: event.currentTarget.value })} /></Field>
              <Field label="Default starting route"><Input value={application.startPath} placeholder="/settings/team" onInput={(event) => setApplication({ ...application, startPath: event.currentTarget.value })} /></Field>
              <Field label="Sign-in route" hint="Where the browser sign-in opens; leave empty when the app redirects to its login page"><Input value={application.loginPath} placeholder="/login" onInput={(event) => setApplication({ ...application, loginPath: event.currentTarget.value })} /></Field>
              <Field label="Screenshot policy"><Select value={application.policy} onChange={(event) => setApplication({ ...application, policy: event.currentTarget.value })}><option value="requested">Only when requested</option><option value="auto">Automatically for UI workflows</option><option value="off">Never</option></Select></Field>
              <Field label="Viewport width"><Input type="number" min="320" max="3840" value={application.viewportWidth} onInput={(event) => setApplication({ ...application, viewportWidth: event.currentTarget.value })} /></Field>
              <Field label="Viewport height"><Input type="number" min="320" max="2160" value={application.viewportHeight} onInput={(event) => setApplication({ ...application, viewportHeight: event.currentTarget.value })} /></Field>
              <Field label="Capture workflow guidance" hint="Safe test state, authentication, actions, and expected outcomes" wide><Textarea rows={4} value={application.workflow} placeholder="Reuse the signed-in demo workspace and synthetic data only." onInput={(event) => setApplication({ ...application, workflow: event.currentTarget.value })} /></Field>
            </div>
            <Toggle checked={application.highlight} onChange={(checked) => setApplication({ ...application, highlight: checked })} label="Highlight captured controls" />
            {applicationReadiness && <div class={`plan-capture-readiness ${applicationReadiness.status === 'ready' ? 'ready' : 'missing'}`}><Icon name={applicationReadiness.status === 'ready' ? 'check' : 'info'} size={15} /><span><strong>{applicationReadiness.status === 'ready' ? 'Application reachable' : applicationReadiness.status === 'authentication-required' ? 'Sign-in needed' : 'Application not reachable'}</strong><small>{applicationReadiness.message}</small></span></div>}
            <div class="form-actions">
              <Button tone="danger" onClick={() => void act(() => patch('/api/project', { application: null }), 'Application configuration removed')}>Remove</Button>
              <Button disabled={!application.baseUrl} busy={testingApplication} onClick={() => void testApplication()}>Test application</Button>
              <Button tone="primary" disabled={!application.baseUrl} onClick={() => void act(() => patch('/api/project', { application: applicationPayload }), 'Application settings saved')}>Save application</Button>
            </div>
          </Panel>
          <CaptureSignInPanel application={applicationPayload} configured={Boolean(project.application)} onError={onError} onChanged={() => setApplicationReadiness(undefined)} />
        </>}

        {section === 'tools' && <Panel title="Documentation generator" description="The generator selected for this workspace." flush>
          <Table head={<><th>Generator</th><th>Status</th></>}>
            {state.generators.filter((generator) => generator.id === project.generator).map((generator) => <tr key={generator.id}>
              <td><div class="cell-lead"><span class="generator-mark">{generator.displayName.slice(0, 1)}</span><div class="row-copy"><strong>{generator.displayName}</strong><small>{generator.id === 'doxbrix' ? 'Built in' : generator.packageName ?? generator.id}</small></div></div></td>
              <td><Badge tone="good" icon="check">Active</Badge>{generator.tierLabel && <small class={`generator-tier-label tier-${generator.tier}`} title={generator.tierDescription}>{generator.tierLabel} tier{generator.toolchainLabels?.length ? ` · ${generator.toolchainLabels.join(', ')}` : ''}</small>}</td>
            </tr>)}
          </Table>
        </Panel>}
      </div>
    </div>
  </>
}




/** Shown when the project changed elsewhere while a form holds unsaved edits. */
type CaptureAuthState = {
  credentials?: { username: string; savedAt: string }
  session?: { savedAt: string; origin: string; cookies: number; origins: number }
  signIn: { active: boolean; open?: boolean; url?: string; currentUrl?: string }
}

/**
 * Two ways past a login page: a session recorded from a visible Chrome window
 * the person signs in to by hand, or credentials the agent types by name. Both
 * are stored outside the project, so this panel only ever shows summaries.
 */
function CaptureSignInPanel({ application, configured, onError, onChanged }: { application: Record<string, unknown> & { baseUrl: string }; configured: boolean; onError: (error: string) => void; onChanged: () => void }) {
  const [auth, setAuth] = useState<CaptureAuthState>()
  const [busy, setBusy] = useState<'' | 'start' | 'finish' | 'cancel' | 'forget' | 'save' | 'remove'>('')
  const [credentials, setCredentials] = useState({ username: '', password: '' })
  const load = async () => {
    try { setAuth(await api<CaptureAuthState>('/api/application/auth')) }
    catch (cause) { onError(message(cause)) }
  }
  useEffect(() => { if (configured) void load() }, [configured])
  // While the Chrome window is open, keep an eye on whether it is still there.
  useEffect(() => {
    if (!auth?.signIn.active) return
    const timer = setInterval(() => { void load() }, 2_000)
    return () => clearInterval(timer)
  }, [auth?.signIn.active])
  const run = async (kind: typeof busy, request: () => Promise<CaptureAuthState>) => {
    setBusy(kind)
    try {
      setAuth(await request())
      onChanged()
    } catch (cause) {
      onError(message(cause))
    } finally {
      setBusy('')
    }
  }
  const signIn = auth?.signIn
  return <Panel title="Application sign-in" description="Let the capture browser past a login page without sharing secrets with the agent or the project.">
    {!configured && <Note>Save the application settings above first. Sign-in details are stored on this computer against the project, never in the repository.</Note>}
    <div class="capture-signin">
      <section class="capture-signin-block">
        <header><strong>Recorded browser session</strong><small>Sign in by hand in a Chrome window Doxloop opens, including MFA, SSO, or passkeys. The signed-in cookies and local storage are saved and loaded into every capture run.</small></header>
        {auth?.session
          ? <div class="plan-capture-readiness ready"><Icon name="check" size={15} /><span><strong>Session saved {timeText(auth.session.savedAt)}</strong><small>{auth.session.origin} · {auth.session.cookies} cookie{auth.session.cookies === 1 ? '' : 's'} · {auth.session.origins} storage origin{auth.session.origins === 1 ? '' : 's'}. Sign in again when the application reports the session expired.</small></span></div>
          : auth && <div class="plan-capture-readiness missing"><Icon name="info" size={15} /><span><strong>No session recorded</strong><small>Screenshots of signed-in screens need a session or credentials.</small></span></div>}
        {signIn?.active && <Note tone={signIn.open ? 'info' : 'warn'}><span>{signIn.open
          ? <>A Chrome window is open at {signIn.url}. Complete the sign-in there, wait for the signed-in screen, then choose <strong>Save session</strong>.</>
          : <>The Chrome window was closed. Choose <strong>Save session</strong> to keep the last signed-in state, or start again.</>}</span></Note>}
        <div class="form-actions start">
          {signIn?.active
            ? <>
              <Button busy={busy === 'cancel'} onClick={() => void run('cancel', () => post('/api/application/sign-in/cancel'))}>Cancel</Button>
              <Button tone="primary" icon="check" busy={busy === 'finish'} onClick={() => void run('finish', () => post('/api/application/sign-in/finish'))}>Save session</Button>
            </>
            : <>
              {auth?.session && <Button tone="danger" busy={busy === 'forget'} onClick={() => void run('forget', () => remove('/api/application/session'))}>Forget session</Button>}
              <Button tone="primary" icon="preview" disabled={!application.baseUrl} busy={busy === 'start'} onClick={() => void run('start', () => post('/api/application/sign-in', application))}>{auth?.session ? 'Sign in again with browser' : 'Sign in with browser'}</Button>
            </>}
        </div>
      </section>
      <section class="capture-signin-block">
        <header><strong>Sign-in credentials</strong><small>For a plain username and password form. The agent fills the form by secret name; the capture server substitutes the values and redacts them from every result. Use a test account, never a production one.</small></header>
        {auth?.credentials && <div class="plan-capture-readiness ready"><Icon name="check" size={15} /><span><strong>Credentials saved for {auth.credentials.username}</strong><small>Saved {timeText(auth.credentials.savedAt)}. Enter new values below to replace them.</small></span></div>}
        <div class="form-grid">
          <Field label="Username or email"><Input value={credentials.username} autocomplete="off" placeholder="docs-demo@example.com" onInput={(event) => setCredentials({ ...credentials, username: event.currentTarget.value })} /></Field>
          <Field label="Password"><Input type="password" value={credentials.password} autocomplete="new-password" placeholder="••••••••" onInput={(event) => setCredentials({ ...credentials, password: event.currentTarget.value })} /></Field>
        </div>
        <div class="form-actions start">
          {auth?.credentials && <Button tone="danger" busy={busy === 'remove'} onClick={() => void run('remove', () => remove('/api/application/credentials'))}>Remove credentials</Button>}
          <Button tone="primary" disabled={!configured || !credentials.username.trim() || !credentials.password} busy={busy === 'save'} onClick={() => void run('save', async () => { const next = await put<CaptureAuthState>('/api/application/credentials', credentials); setCredentials({ username: '', password: '' }); return next })}>Save credentials</Button>
        </div>
      </section>
    </div>
  </Panel>
}

function StaleFormNotice({ onResync }: { onResync: () => void }) {
  return <div class="stale-form-notice" role="status">
    <Icon name="info" size={14} />
    <span>These settings changed elsewhere while you were editing. Your unsaved edits are still here.</span>
    <Button size="sm" onClick={onResync}>Load the saved values</Button>
  </div>
}

type Action = <T>(run: () => Promise<T>, success?: string, refresh?: boolean) => Promise<T | undefined>

/** Proposal states a reviewer can still act on. */
const OPEN_STATUSES = ['awaiting-review', 'partially-applied', 'conflicted']

const SETTLED_JOB_VISIBLE_MS = 30 * 60_000

/**
 * The newest job matching the filter that finished recently enough to still
 * matter, unless the reader dismissed it. Jobs arrive newest first.
 */
export function recentSettledJob(jobs: UiJob[], matches: (job: UiJob) => boolean, dismissedId: string | undefined, now = Date.now()): UiJob | undefined {
  const job = jobs.find(matches)
  if (!job || job.status === 'running' || job.id === dismissedId) return undefined
  const finished = Date.parse(job.finishedAt ?? job.startedAt)
  if (Number.isFinite(finished) && now - finished > SETTLED_JOB_VISIBLE_MS) return undefined
  return job
}

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

function isFailed(value: unknown): value is Failed {
  return Boolean(value && typeof value === 'object' && typeof (value as Failed).error === 'string')
}

/**
 * The server reports validation as either a result or a failure object.
 * Treat the failure as "unavailable" rather than reading `.pages` off it.
 */
export function validationState(value: Validation | Failed | undefined): { ok: true; result: Validation } | { ok: false; reason: string } {
  if (!value) return { ok: false, reason: 'Validation has not run yet.' }
  if (isFailed(value) || !Array.isArray((value as Validation).pages)) return { ok: false, reason: `Validation could not run: ${isFailed(value) ? value.error : 'unexpected response'}` }
  return { ok: true, result: { ...value, issues: Array.isArray(value.issues) ? value.issues : [] } }
}

export function validationHeadline(result: Pick<Validation, 'errors' | 'warnings'>): string {
  if (result.errors > 0) return `${result.errors} validation error${result.errors === 1 ? '' : 's'}${result.warnings > 0 ? ` and ${result.warnings} warning${result.warnings === 1 ? '' : 's'}` : ''}`
  if (result.warnings > 0) return `${result.warnings} validation warning${result.warnings === 1 ? '' : 's'}`
  return 'Documentation validates cleanly'
}

export function driftState(value: DriftSummary | Failed | undefined): { ok: true; drift: DriftSummary } | { ok: false; reason: string } {
  if (!value) return { ok: false, reason: 'Freshness has not been checked yet.' }
  if (isFailed(value) || !Array.isArray((value as DriftSummary).pages)) return { ok: false, reason: `Freshness could not be checked: ${isFailed(value) ? value.error : 'unexpected response'}` }
  return { ok: true, drift: value }
}

/** The agent updates run with: the project default when detected, else the first detected agent. */
export function preferredAgent(agents: AgentState[] | undefined, defaultAgent: string | undefined): AgentState | undefined {
  if (!agents?.length) return undefined
  return agents.find((agent) => agent.name === defaultAgent && agent.executable) ?? agents.find((agent) => agent.preferred && agent.executable) ?? agents.find((agent) => agent.executable)
}

function agentSignInLabel(status: string): string {
  if (status === 'authenticated') return 'is signed in'
  if (status === 'unauthenticated' || status === 'missing') return 'needs sign-in'
  if (status === 'unknown') return 'sign-in unknown'
  return status.replaceAll('-', ' ')
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
  key: 'maxRunsPerDay' | 'maxMinutes' | 'maxUsd',
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
