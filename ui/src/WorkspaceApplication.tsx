import { Comments, BulkMetadata, AuditTools, Collections } from './WorkspaceTools'
import { TextEditor, PageTools } from './TextEditor'
import { PageContentEditor } from './PageContentEditor'
import './PagesEditor.css'
import { workspaceStatus, coverageRefreshKey } from './workspace-status'
import { useEffect, useRef, useState } from 'preact/hooks'
import './WorkspaceApplication.css'
import './ContentTools.css'
import { NO_TIMEOUT, api, patch, post, put, remove } from './api'
import {
  Badge, Button, Combo, Empty, Field, Input, KeyValues, Lines, Note, PageHeader,
  Panel, Segmented, Select, Stat, Table, Tabs, Textarea, Toggle, parseTerms, splitComma, termText, timeText,
} from './components'
import { Icon } from './icons'
import { DocsSiteSourceFields, type DocsSiteInspection } from './DocsSiteSourceFields'
import { settledPageEditJobs, settledPlanJobs } from './job-transitions'
import { stripJobLineStamp } from '../../src/job-events.js'
import { agentModels, defaultModelForAgent, modelReasoningLevels, preferredReasoningLevel } from './model-options'
import { countPlanPages, isGuidePage, planActionLabel, planApprovalControls, planPrimaryAction, planScreenshotCoverage, retryAgentChoice, type PlanPageFilter } from './plan-review'
import { canonicalWorkspacePath, workspacePath, workspaceRoute, type ResolvedWorkspaceRoute, type WorkspaceParams, type WorkspaceRoute } from './routes'
import { setLocation, useSearchParams } from './url-state'
import { PollFailureTracker, jobPollDelay } from './polling'
import { displayLogLines, stripAnsi, summarizeRunActivity } from './log-lines'
import { runEstimateText, type ServerRunEstimate } from './run-estimate'
import { PREVIEW_NOTICE_EVENT, openPreviewTab, type PreviewNotice } from './preview-window'
import { useSeededForm } from './form-sync'
import { batchLimitsForScope, screenshotIntentFromChoice } from './setup-plan'
import { ProjectSwitcher } from './ProjectSwitcher'
import { CommandPalette, useCommandPaletteShortcut, type PaletteCommand } from './CommandPalette'
import { AgentCapabilityMatrix } from './agent-capabilities'
import { ProposalRationaleDrawer, ProposalRenderedDiff, ProposalSourceDiff } from './proposal-diff'
import { AssetLibrary, AssetPicker, readFileAsBase64 } from './AssetLibrary'
import { BrandingPanel } from './BrandingPanel'
import { GlossaryPanel, PageMetadataForm, ReleaseTemplateFields, TermsEditor, recordFromTerms, termsFromRecord, type ReleaseTemplateForm } from './content-types'
import { NavigationView, PlanNavigationEditor } from './NavigationView'
import { defaultReviewChange, hunkStateKey, proposalDecisionCounts, reviewFileGroups, screenshotCoverageText } from './review-presentation'
import type { AgentState, AgentUsage, CoverageItem, DeploymentRecord, DocumentationPlan, DocumentationPlanPage, DriftSummary, Failed, GeneratorEntry, HistoryChangedPage, HistoryPageEntry, HistoryRequest, PageSummary, Proposal, ProposalChange, Source, SourceIntelligence, SyncConfig, UiJob, UiState, Validation } from './types'

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
  /** Where the application's sign-in page is, when it shows one first. */
  signInPath?: string
  message: string
}

/**
 * The sidebar reads as the loop: Home, then Plan → Docs → Review → Publish,
 * then what you set up once (Sources, Settings). A `null` entry is a divider.
 */
const NAV = [
  ['overview', 'Home', 'home'],
  null,
  ['authoring', 'Plan', 'sparkle'],
  ['pages', 'Docs', 'file'],
  ['proposals', 'Review', 'review'],
  ['publish', 'Publish', 'publish'],
  null,
  ['sources', 'Sources', 'sources'],
  ['settings', 'Settings', 'settings'],
] as const

const PAGE_TITLES: Record<Page, string> = {
  overview: 'Home',
  sources: 'Sources',
  authoring: 'Plan',
  pages: 'Docs',
  proposals: 'Review',
  publish: 'Publish',
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
    // Any other job that stopped (a deploy, a capture, a retry) changed what
    // the workspace shows, so it refreshes once, here, rather than every poll.
    const stoppedOther = jobs.some((job) => job.status !== 'running' && previouslyRunning.has(job.id)) &&
      !stoppedPlan && settledSyncs.length + completedUpdates.length + settledPageEdits.length + settledRevisions.length === 0
    runningJobIds.current = new Set(jobs.filter((job) => job.status === 'running').map((job) => job.id))
    onJobsUpdate(jobs)
    if ((stoppedPlan && settledPlans.length === 0) || stoppedOther) void reload()
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
  const [hidden, setHidden] = useState(() => typeof document !== 'undefined' && document.hidden)
  const pollJobs = async () => {
    try {
      const jobs = await api<UiJob[]>('/api/jobs')
      pollFailures.current.succeeded()
      receiveJobs(jobs)
    } catch (cause) {
      if (pollFailures.current.failed()) onError(`The control center stopped answering: ${message(cause)}`)
    }
  }
  // A hidden tab stops asking; coming back refreshes at once instead of
  // showing whatever was on screen when the reader left.
  useEffect(() => {
    const onVisibility = () => {
      setHidden(document.hidden)
      if (!document.hidden) { void pollJobs(); void reload() }
    }
    document.addEventListener('visibilitychange', onVisibility)
    return () => document.removeEventListener('visibilitychange', onVisibility)
  }, [])
  // The live job stream carries every update, so polling is only a safety net
  // unless a job is running while the stream is down.
  useEffect(() => {
    const delay = jobPollDelay({ running: jobsRunning, streamConnected: jobStreamConnected, hidden })
    if (delay === null) return
    const timer = window.setInterval(() => void pollJobs(), delay)
    return () => clearInterval(timer)
  }, [jobsRunning, jobStreamConnected, hidden])

  const navigate = (next: WorkspaceRoute, params: WorkspaceParams = {}) => {
    if (!window.dispatchEvent(new Event('doxloop:before-navigation', { cancelable: true }))) return
    history.pushState({}, '', workspacePath(next, params))
    setPage(next)
    setNavOpen(false)
  }

  const [previewNotice, setPreviewNotice] = useState<PreviewNotice | null>(null)
  useEffect(() => {
    const listener = (event: Event) => {
      const notice = (event as CustomEvent<PreviewNotice>).detail
      // A preview that opened in its own tab needs no further word here.
      setPreviewNotice(notice.state === 'ready' && !notice.blocked ? null : notice)
      if (notice.state === 'failed') onError(`The preview could not start: ${notice.error}`)
    }
    addEventListener(PREVIEW_NOTICE_EVENT, listener)
    return () => removeEventListener(PREVIEW_NOTICE_EVENT, listener)
  }, [])
  const openPreview = async () => {
    if (previewNotice?.state === 'starting') return
    const url = await openPreviewTab((openServerSide) => post<{ url: string }>('/api/preview/start', { open: openServerSide }))
    if (url) void reload()
  }

  // The local preview server stays up for the whole session; it is not a task the reader waits on.
  const runningJobs = state.jobs.filter((job) => job.status === 'running' && job.type !== 'preview').length

  const params = useSearchParams()
  // A single open proposal gets a way back to the list; the sidebar stays.
  const focusMode = page === 'proposals' && Boolean(params.get('proposal'))
  const focusBack: { label: string; route: WorkspaceRoute } | null = focusMode ? { label: 'Back to Review', route: 'proposals' } : null

  const [paletteOpen, setPaletteOpen] = useState(false)
  useCommandPaletteShortcut(() => setPaletteOpen(true))
  const paletteCommands: PaletteCommand[] = [
    { id: 'act:plan', group: 'Actions', label: documentationExists(state) ? 'Plan an update' : 'Create documentation', icon: 'sparkle', run: () => navigate('authoring') },
    { id: 'act:preview', group: 'Actions', label: 'Preview docs', icon: 'external', run: () => void openPreview() },
    { id: 'act:new', group: 'Actions', label: 'New project', icon: 'plus', run: onNewProject },
    ...NAV.flatMap((entry) => entry ? [{ id: `go:${entry[0]}`, group: 'Go to' as const, label: entry[1], icon: entry[2], run: () => navigate(entry[0]) }] : []),
    ...(validationState(state.validation).ok ? (state.validation as Validation).pages : []).map((path) => ({ id: `page:${path}`, group: 'Pages' as const, label: pageTitleFromPath(path), icon: 'file', hint: path, run: () => navigate('pages', { path }) })),
  ]

  return <div class={`shell ${page === 'proposals' ? 'proposal-shell' : ''} ${page === 'pages' ? 'pages-shell' : ''} ${page === 'sources' ? 'sources-shell' : ''} ${focusMode ? 'focus-mode' : ''}`}>
    {navOpen && <button class="nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}
    <CommandPalette open={paletteOpen} commands={paletteCommands} onClose={() => setPaletteOpen(false)} />

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
        <button class="workspace-brand" type="button" aria-label="Doxloop" onClick={() => navigate('overview')}><span class="brand-mark" aria-hidden="true">D</span><span class="brand-word">Doxloop</span><img src={DOXLOOP_LOGO} alt="" /></button>
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
        {NAV.map((entry, index) => entry === null ? <span key={`divider-${index}`} class="nav-divider" role="separator" /> : <button key={entry[0]} type="button" class={`nav-item ${page === entry[0] ? 'active' : ''}`} aria-label={`${entry[1]}${entry[0] === 'proposals' && pendingProposalCount > 0 ? `, ${pendingProposalCount} pending` : ''}`} aria-current={page === entry[0] ? 'page' : undefined} onClick={() => navigate(entry[0])}>
          <span class="nav-glyph"><Icon name={entry[2]} size={17} /></span>
          <span class="nav-copy"><span>{entry[1]}</span></span>
          {entry[0] === 'proposals' && pendingProposalCount > 0 && <b class="nav-count" aria-label={`${pendingProposalCount} pending proposal${pendingProposalCount === 1 ? '' : 's'}`}>{pendingProposalCount}</b>}
        </button>)}
      </nav>
      <div class="sidebar-foot">
        <button type="button" class="new-project-button" aria-label="New documentation project" title="Start new or import existing docs" onClick={onNewProject}>
          <span class="nav-glyph"><Icon name="plus" size={16} /></span>
          <span><strong>New project</strong><small>Start new or import existing docs</small></span>
        </button>
        <a class="sidebar-foot-link" href="https://github.com/doxbrix/doxloop" target="_blank" rel="noreferrer" aria-label="Support (opens GitHub in a new tab)"><span class="nav-glyph"><Icon name="help" size={16} /></span><span>Support</span></a>
      </div>
    </aside>

    <main class="workspace-main">
      <header class="workspace-navbar">
        <button class="workspace-mobile-menu" type="button" aria-label="Open navigation" onClick={() => setNavOpen(true)}><Icon name="menu" size={18} /></button>
        {focusMode && focusBack
          ? <button type="button" class="workspace-back-link" onClick={() => page === 'proposals' ? setLocation('proposals', {}, 'push') : navigate(focusBack.route)}><Icon name="chevronLeft" size={16} /><span>{focusBack.label}</span></button>
          : <div class="workspace-crumbs">
            <button type="button" class="workspace-crumb" title={project.title} aria-label={`${project.title} overview`} onClick={() => navigate('overview')}>{project.title}</button>
            <Icon name="chevronRight" size={14} />
            <strong class="workspace-screen-title">{page === 'authoring' ? `${authoringNavigationLabel} documentation` : PAGE_TITLES[page]}</strong>
          </div>}
        <span class="workspace-navbar-spacer" />
        {runningJobs > 0 && <button type="button" class="workspace-activity-chip" title="Open running task progress" aria-label={`${runningJobs} task${runningJobs === 1 ? '' : 's'} running. Open progress`} onClick={() => { const job = state.jobs.find((item) => item.status === 'running' && !item.type.includes('preview')); const id = job?.type.match(/^proposal:(?:revise|resume):(.+)$/)?.[1]; if (id) location.assign(`/review?proposal=${encodeURIComponent(id)}`); else { navigate(job?.type.startsWith('page-edit:') ? 'pages' : 'authoring'); } }}><i />{runningJobs === 1 ? '1 task running' : `${runningJobs} tasks running`}</button>}
        <button type="button" class="workspace-search-button" aria-label="Search or jump to (⌘K)" onClick={() => setPaletteOpen(true)}><Icon name="search" size={15} /><span>Search or jump to…</span><kbd>⌘K</kbd></button>
        <button type="button" class="workspace-preview-primary" aria-label="Preview docs in a new tab" aria-busy={previewNotice?.state === 'starting'} disabled={previewNotice?.state === 'starting'} onClick={() => void openPreview()}>{previewNotice?.state === 'starting' ? <span class="spinner" /> : <Icon name="preview" size={15} />}<strong>{previewNotice?.state === 'starting' ? 'Starting preview…' : 'Preview docs'}</strong><Icon name="external" size={12} /></button>
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
        {previewNotice && previewNotice.state !== 'failed' && <div class={`page-updated-toast preview-notice-toast ${previewNotice.state === 'ready' ? 'warn' : 'info'}`} role="status">
          <span class="toast-icon"><Icon name={previewNotice.state === 'ready' ? 'external' : 'refresh'} size={15} /></span>
          <span class="toast-copy">{previewNotice.state === 'starting'
            ? <><strong>Starting the documentation preview…</strong><small>It opens in a new tab when it is ready.</small></>
            : <><strong>The preview is ready</strong><small>Your browser did not open a new tab. <a href={previewNotice.url} target="_blank" rel="noreferrer">Open the preview at {previewNotice.url}</a></small></>}</span>
          <button type="button" class="toast-close" aria-label="Dismiss" onClick={() => setPreviewNotice(null)}><Icon name="close" size={14} /></button>
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
  const coverageLabel = !intelligence ? 'Checking evidence' : !documentationExists(state) ? 'Not documented yet' : coverage >= 90 ? 'Strong coverage' : coverage >= 70 ? 'Good foundation' : coverage >= 40 ? 'Gaps remain' : 'Needs attention'
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
  const running = state.jobs.filter((job) => job.status === 'running' && job.type !== 'preview').length
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
    { label: 'Write', sub: plan?.status === 'generating' ? 'In progress' : openProposal && !hasDocs ? `${planPages} pages written` : hasDocs ? `${validation.ok ? validation.result.pages.length : planPages} pages ready` : 'Waiting', icon: 'update', route: 'authoring' as const, state: plan?.status === 'generating' ? 'active' : hasDocs || openProposal ? 'done' : 'idle' },
    { label: 'Review', sub: openProposal ? 'Awaiting you' : 'No pending changes', icon: 'review', route: 'proposals' as const, state: openProposal ? 'active' : hasDocs ? 'done' : 'idle' },
    { label: 'Publish', sub: published ? 'Published' : deployedSlug ? 'Not published yet' : 'Not configured', icon: 'publish', route: 'publish' as const, state: published ? 'done' : 'idle' },
  ]
  const doneSteps = pipeline.filter((step) => step.state === 'done').length

  return <section class="overview-page">
    <PageHeader kicker="Home" title="Your documentation loop" description="Everything between your source code and the published docs, in one pass." />

    <section class="pipeline-card" aria-label="Documentation workflow">
      <div class="pipeline-track"><i style={{ width: `${Math.max(0, (doneSteps - 1) / (pipeline.length - 1)) * 100}%` }} /></div>
      {pipeline.map((step) => <button type="button" key={step.label} class={step.state} onClick={() => navigate(step.route)}>
        <span><Icon name={step.state === 'done' ? 'check' : step.icon} size={step.state === 'done' ? 13 : 17} /></span>
        <span class="pipeline-copy"><strong>{step.label}</strong><small>{step.sub}</small></span>
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
        {state.root && <div><dt>Project folder</dt><dd title={state.root}><code>{state.root}</code></dd></div>}
      </dl>
    </section>

    <div class="ov-metrics">
      <button type="button" class="ov-metric" onClick={() => navigate('sources')}>
        <span class="ov-donut" style={{ '--ov-coverage': `${coverage}%` }}><b>{intelligence ? `${coverage}%` : '—'}</b></span>
        <span class="ov-metric-copy"><small>Coverage</small><strong>{coverageLabel}</strong><span>{intelligence ? `${documentedItems} of ${discoveredItems} discovered items documented` : 'Appears after source discovery completes'}</span></span>
        <Icon name="chevronRight" size={16} class="ov-metric-arrow" />
      </button>
      <button type="button" class={`ov-metric ${!hasDocs ? '' : errors ? 'bad' : warnings ? 'warn' : 'good'}`} onClick={() => navigate('pages')}>
        <span class="ov-figure">{pageCount}</span>
        {hasDocs
          ? <span class="ov-metric-copy"><small>Pages</small><strong>{validation.ok ? validationHeadline(validation.result) : 'Validation unavailable'}</strong><span>{validation.ok ? (issues.some((issue) => issue.severity === 'error') ? 'Fix the errors before publishing.' : issues.length ? 'Worth a look. Warnings do not block publishing.' : 'Navigation, metadata, and links look consistent.') : validation.reason}</span></span>
          : <span class="ov-metric-copy"><small>Pages</small><strong>Starter pages</strong><span>Replaced when you approve your first proposal.</span></span>}
        <Icon name="chevronRight" size={16} class="ov-metric-arrow" />
      </button>
      <button type="button" class={`ov-metric ${published ? 'good' : ''}`} onClick={() => navigate('publish')}>
        <span class="ov-metric-icon"><Icon name={deployedSlug ? 'cloud' : 'publish'} size={20} /></span>
        <span class="ov-metric-copy"><small>Published site</small><strong>{published ? 'Published successfully' : 'Not published yet'}</strong><code>{deployedAddress}</code></span>
        <Icon name="chevronRight" size={16} class="ov-metric-arrow" />
      </button>
    </div>

    {hasDocs && issues.length > 0 && <section class="panel ov-issues" aria-label="Validation issues">
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
          <p><strong>{workflowActivityLabel(job.type)}</strong>{jobActivityText(job)}</p>
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

/** Errors reach the reader through the shell's preview notice, which also reports them as a banner. */
async function openProposalPreview(runId: string, _onError?: (error: string) => void): Promise<void> {
  await openPreviewTab((openServerSide) => post<{ url: string }>(`/api/proposals/${runId}/preview/start`, { open: openServerSide }))
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
  const [dialog, setDialog] = useState<'source' | 'openapi' | 'docs-site' | null>(null)
  const [docsSiteInspection, setDocsSiteInspection] = useState<DocsSiteInspection>()
  const [docsSiteError, setDocsSiteError] = useState('')
  const [recrawling, setRecrawling] = useState('')
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
  /** The source whose ⋯ menu is open. */
  const [rowMenu, setRowMenu] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  const filtered = project.sources
  const resetAdd = () => {
    setAdd({ repository: '', branch: 'main', subdirectory: '', path: '', authMethod: 'automatic', gitUsername: '', gitSecret: '', specContent: '', fileName: '', space: '', routePrefix: '', navigationGroup: '', sharedPages: '' })
    setBranches([])
    setDirectories([])
    setHead('')
    setSourceMode('git')
    setOpenapiMode('file')
    setDocsSiteInspection(undefined)
    setDocsSiteError('')
  }
  const openDialog = (next: 'source' | 'openapi' | 'docs-site') => {
    resetAdd()
    setDialog(next)
  }
  const loadIntelligence = async () => setIntelligence(await api<SourceIntelligence>('/api/source-intelligence'))
  useEffect(() => {
    let active = true
    void api<SourceIntelligence>('/api/source-intelligence').then((report) => { if (active) setIntelligence(report) }).catch(() => undefined)
    return () => { active = false }
  }, [project.sources.map((source) => `${source.name}:${source.path}`).join('|')])
  useEffect(() => {
    if (!rowMenu) return
    const close = (event: MouseEvent) => {
      const target = event.target as Element | null
      if (!target?.closest?.('.source-row-actions')) setRowMenu(null)
    }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setRowMenu(null) }
    addEventListener('mousedown', close)
    addEventListener('keydown', escape)
    return () => { removeEventListener('mousedown', close); removeEventListener('keydown', escape) }
  }, [rowMenu])
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
    const rawName = dialog === 'docs-site'
      ? (() => { try { return new URL(add.path.trim()).hostname.replace(/^www\./, '').replace(/^docs\./, 'docs-') } catch { return 'docs' } })()
      : location.replace(/[?#].*$/, '').replace(/[\\/]+$/, '').split(/[\\/]/).pop()?.replace(/\.git$/i, '').replace(/\.(json|ya?ml)$/i, '') || 'source'
    const name = rawName.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'docs'
    setSaving(true)
    try {
      const scope = add.space.trim() || add.routePrefix.trim() || add.navigationGroup.trim() || add.sharedPages.trim() ? { space: add.space.trim() || undefined, routePrefix: add.routePrefix.trim() || undefined, navigationGroup: add.navigationGroup.trim() || undefined, sharedPages: splitComma(add.sharedPages) } : undefined
      const body = dialog === 'docs-site'
        ? { kind: 'docs-site', name, url: add.path.trim(), inspectionId: docsSiteInspection?.id, scope }
        : dialog === 'openapi'
        ? { kind: 'openapi', name, path: openapiMode === 'url' ? add.path : undefined, specContent: openapiMode === 'file' ? add.specContent : undefined, scope }
        : sourceMode === 'git'
          ? { kind: 'git', name, ...add, scope }
          : { kind: 'directory', name, path: add.path, scope }
      const result = await act(() => post('/api/sources', body, dialog === 'docs-site' ? NO_TIMEOUT : undefined), 'Source added')
      if (result !== undefined) closeDialog()
    } finally {
      setSaving(false)
    }
  }
  const recrawlSource = async (source: Source) => {
    if (!confirm(`Re-crawl ${source.site?.url ?? source.name}? The new snapshot replaces the current one; the next update compares them and names the pages that changed.`)) return
    setRecrawling(source.name)
    try {
      await act(() => post(`/api/sources/${encodeURIComponent(source.name)}/refresh`, {}, NO_TIMEOUT), 'Documentation site re-crawled')
      await loadIntelligence()
    } finally {
      setRecrawling('')
    }
  }
  const checkSource = (source: Source) => {
    setRowMenu(null)
    setCheckingSource(source.name)
    void act(() => post(`/api/sources/${encodeURIComponent(source.name)}/test`), 'Source connection checked').then(() => loadIntelligence()).finally(() => setCheckingSource(''))
  }
  const checkingAll = state.jobs.some((job) => job.type === 'sync' && job.status === 'running')
  const checkBlocked = authoringJobRunning(state.jobs)
  /** The "Where is it?" choice folds the source mode and the repository access method into one list. */
  const whereIs: 'public' | 'private' | 'local' = sourceMode === 'local' ? 'local' : add.authMethod === 'credentials' ? 'private' : 'public'
  const setWhereIs = (next: 'public' | 'private' | 'local') => {
    if (next === 'local') { setSourceMode('local'); return }
    setSourceMode('git')
    setAdd({ ...add, authMethod: next === 'private' ? 'credentials' : 'automatic' })
    setHead('')
    setBranches([])
    setDirectories([])
  }
  const resetConnection = () => { setHead(''); setBranches([]); setDirectories([]) }
  const measuredCoverage = intelligence?.coverage.metrics.filter((metric) => metric.status !== 'unknown') ?? []
  const documentedItems = measuredCoverage.reduce((total, metric) => total + metric.documented, 0)
  const discoveredItems = measuredCoverage.reduce((total, metric) => total + metric.total, 0)
  const overallCoverage = discoveredItems > 0 ? Math.round((documentedItems / discoveredItems) * 100) : null
  const unknownCoverageCount = intelligence?.coverage.metrics.filter((metric) => metric.status === 'unknown').length ?? 0
  const coverageAssessment = overallCoverage === null ? 'Awaiting discovery' : overallCoverage >= 90 ? 'Strong coverage' : overallCoverage >= 70 ? 'Good foundation' : overallCoverage >= 40 ? 'Coverage gaps remain' : 'Needs attention'
  const totalGaps = intelligence?.coverage.metrics.reduce((total, metric) => total + coverageGapCount(metric), 0) ?? 0
  const gapMetric = intelligence?.coverage.metrics.filter((metric) => coverageGapCount(metric) > 0).sort((a, b) => coverageGapCount(b) - coverageGapCount(a))[0]
  const selectedCoverageMetric = intelligence?.coverage.metrics.find((metric) => metric.id === coverageMetricId)
  const addDisabled = dialog === 'docs-site' ? docsSiteInspection?.status !== 'completed' : dialog === 'source' ? sourceMode === 'git' ? !head || foldersLoading : !add.path.trim() : openapiMode === 'file' ? !add.specContent.trim() : !add.path.trim()
  return <div class="sources-reference-page">
    <PageHeader kicker="Sources" title="Sources" description="What Doxloop reads, how well it is covered, and when it was last checked." actions={<><Button icon="bell" onClick={() => setMonitoringOpen(true)}>Monitoring</Button><Button tone="primary" icon="plus" onClick={() => openDialog('source')}>Add source</Button></>} />

    <Panel class="sources-library" title="Connected sources" flush actions={filtered.length > 0 ? <Button size="sm" icon="refresh" busy={checkingAll} disabled={checkingAll || checkBlocked} title={checkBlocked ? 'Available when the running writing task finishes' : undefined} onClick={() => void act(() => post('/api/sync/now'), 'Source check started', false)}>Check now</Button> : undefined}>
      {filtered.length ? <div class="source-rows" role="table" aria-label="Connected sources">
        <div class="sr-only" role="row"><span role="columnheader">Source</span><span role="columnheader">Type</span><span role="columnheader">Details</span><span role="columnheader">Status</span><span role="columnheader">Actions</span></div>
        <div role="rowgroup">{filtered.map((source) => {
          const health = intelligence?.health.find((item) => item.name === source.name)
          const type = source.kind === 'openapi' ? 'OpenAPI' : source.kind === 'docs-site' ? 'Docs site' : source.remote ? gitServiceLabel(source.remote.repository) : 'Local folder'
          const docsSite = health?.docsSite ?? source.site
          const detail = health?.openapi
            ? `v${health.openapi.version} · ${health.openapi.operationCount} operations · ${health.openapi.schemas.length} schemas`
            : source.kind === 'docs-site'
              ? docsSite ? `${docsSite.pages} pages · ${docsSite.words.toLocaleString()} words${docsSite.generator ? ` · ${docsSite.generator}` : ''} · crawled ${timeText(docsSite.crawledAt)}` : 'Existing documentation'
            : health?.branch
              ? `${health.branch}${health.subdirectory ? ` / ${health.subdirectory}` : ''}${health.revision ? ` · ${health.revision.slice(0, 10)}` : ''}`
              : source.scope?.routePrefix
                ? `Owns /${source.scope.routePrefix.replace(/^\//, '')}`
                : 'Project-wide evidence'
          const status = health ? health.status === 'healthy' ? 'Current' : health.status === 'warning' ? 'Needs attention' : 'Unavailable' : 'Checking…'
          const tone = health ? health.status === 'healthy' ? 'good' : health.status === 'warning' ? 'warn' : 'bad' : 'neutral'
          const location = source.site?.url ?? (source.remote ? source.remote.repository : source.path)
          return <div class="source-row" role="row" key={source.name}>
            <span class="source-row-icon" aria-hidden="true"><Icon name={source.kind === 'openapi' ? 'braces' : source.kind === 'docs-site' ? 'globe' : source.remote ? repositoryProviderIcon(source.remote.repository) : 'folder'} size={16} /></span>
            <div class="source-row-copy" role="presentation">
              <div class="source-row-name" role="cell" title={location}>{source.name}</div>
              <p class="source-row-meta" role="presentation">
                <span role="cell">{type}</span>
                <span role="cell" class="source-row-detail" title={health ? `Checked ${timeText(health.checkedAt)}${health.lastMonitoringAt ? ` · Last monitoring check ${timeText(health.lastMonitoringAt)}` : ''}` : location}>
                  {detail}
                  {source.scope?.routePrefix && health?.openapi && <> · owns /{source.scope.routePrefix.replace(/^\//, '')}</>}
                  {health && <> · checked {timeText(health.checkedAt)}</>}
                  {source.kind === 'docs-site' && health?.docsSite && health.docsSite.brokenLinks > 0 && <small>{health.docsSite.brokenLinks} broken internal links on the site</small>}
                  {source.kind === 'docs-site' && health?.status === 'warning' && <small class="source-health-error">{health.summary}</small>}
                  {health?.status === 'error' && <small class="source-health-error">{health.summary}</small>}
                </span>
              </p>
            </div>
            <div class="source-row-status" role="cell"><Badge tone={tone}>{checkingSource === source.name ? 'Checking…' : status}</Badge></div>
            <div class="source-row-actions" role="cell">
              <button type="button" class="ops-icon-button" aria-label={`Source options for ${source.name}`} aria-haspopup="menu" aria-expanded={rowMenu === source.name} onClick={() => setRowMenu(rowMenu === source.name ? null : source.name)}><MoreGlyph /></button>
              {rowMenu === source.name && <div class="ops-menu" role="menu" aria-label={`${source.name} options`}>
                {source.kind === 'docs-site' && <button type="button" role="menuitem" aria-label={`Re-crawl ${source.name}`} disabled={recrawling === source.name} onClick={() => { setRowMenu(null); void recrawlSource(source) }}><Icon name={recrawling === source.name ? 'clock' : 'globe'} size={15} />Re-crawl the site</button>}
                <button type="button" role="menuitem" aria-label={`Test ${source.name}`} disabled={checkingSource === source.name} onClick={() => checkSource(source)}><Icon name="refresh" size={15} />Test connection</button>
                <button type="button" role="menuitem" aria-label={`Configure documentation ownership for ${source.name}`} onClick={() => { setRowMenu(null); setScopeSource(source) }}><Icon name="map" size={15} />Documentation ownership</button>
                <button type="button" role="menuitem" class="danger" aria-label={`Delete ${source.name}`} onClick={() => { setRowMenu(null); if (confirm(`Remove ${source.name}?`)) void act(() => remove(`/api/sources/${encodeURIComponent(source.name)}`), 'Source removed') }}><Icon name="trash" size={15} />Remove source</button>
              </div>}
            </div>
          </div>
        })}</div>
      </div> : <div class="ops-empty-wrap"><Empty icon="sources" title="No sources yet" detail="Connect a repository, an OpenAPI spec, or a live docs site." action={<Button size="sm" tone="primary" icon="plus" onClick={() => openDialog('source')}>Add source</Button>} /></div>}
    </Panel>

    {intelligence && <Panel class="coverage-panel" title="Documentation coverage" flush actions={<>
      {intelligence.evidenceDiagnostics.length > 0 && <Badge tone="warn">{intelligence.evidenceDiagnostics.length} evidence note{intelligence.evidenceDiagnostics.length === 1 ? '' : 's'}</Badge>}
      {gapMetric && <Button size="sm" onClick={() => setCoverageMetricId(gapMetric.id)}>Review {totalGaps} {totalGaps === 1 ? 'gap' : 'gaps'}</Button>}
    </>}>
      <div class="coverage-summary" title={intelligence.coverage.disclaimer}>
        <strong class={`coverage-figure ${overallCoverage === null ? '' : overallCoverage >= 70 ? 'good' : overallCoverage >= 40 ? 'warn' : 'bad'}`} aria-label={overallCoverage === null ? 'Coverage unavailable' : `${overallCoverage}% overall documentation coverage`}>{overallCoverage === null ? '—' : `${overallCoverage}%`}</strong>
        <div class="coverage-summary-copy">
          <span class={`coverage-assessment ${overallCoverage !== null && overallCoverage < 70 ? 'attention' : ''}`}>{coverageAssessment}</span>
          <span class="coverage-summary-detail">{documentedItems} of {discoveredItems} discovered items are documented{totalGaps > 0 && <> · {totalGaps} {totalGaps === 1 ? 'gap' : 'gaps'}</>}{unknownCoverageCount > 0 && <> · {unknownCoverageCount} {unknownCoverageCount === 1 ? 'surface' : 'surfaces'} without items</>}</span>
        </div>
      </div>
      <div class="coverage-rows">{intelligence.coverage.metrics.map((metric) => {
        const measured = metric.status !== 'unknown'
        const gaps = coverageGapCount(metric)
        return <div class={`coverage-row ${measured ? '' : 'unknown'}`} key={metric.id} title={measured ? metric.denominator : `Discovery completed, but no items in this category were found in the connected sources. ${metric.denominator}`}>
          <span class="coverage-row-label">{metric.label}</span>
          <div class={`progress ${measured ? metric.percent >= 90 ? 'good' : metric.percent >= 70 ? '' : 'warn' : ''}`} role="progressbar" aria-label={`${metric.label} coverage`} aria-valuemin={0} aria-valuemax={100} aria-valuenow={measured ? metric.percent : undefined}><i style={{ width: measured ? `${metric.percent}%` : '0%' }} /></div>
          {measured ? <span class="coverage-row-percent" title={`${metric.documented} of ${metric.total}`}>{metric.percent}%</span> : <em class="coverage-row-percent">No items discovered</em>}
          {(gaps > 0 || metric.excluded > 0) && <button type="button" class="coverage-review-action" onClick={() => setCoverageMetricId(metric.id)}>{gaps > 0 ? `${gaps} ${gaps === 1 ? 'gap' : 'gaps'}` : `${metric.excluded} excluded`}</button>}
        </div>
      })}</div>
      {intelligence.evidenceDiagnostics.length > 0 && <details class="source-evidence-notes"><summary>Review evidence precision</summary>{intelligence.evidenceDiagnostics.slice(0, 8).map((item) => <div key={`${item.code}:${item.page}:${item.identifier}`}><strong>{item.page}</strong><p>{item.message}</p><small>{item.suggestion}</small></div>)}</details>}
    </Panel>}

    {filtered.length > 0 && <DocumentationFreshness value={state.drift} navigate={navigate} sync={project.sync} onConfigure={() => setMonitoringOpen(true)} />}

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

    {dialog && <OpsSheet class={`add-source-sheet ${dialog}`} title="Add source" onClose={closeDialog} footer={<><Button tone="ghost" onClick={closeDialog}>Cancel</Button><Button tone="primary" icon="plus" busy={saving} disabled={addDisabled} onClick={() => void addSource()}>Add source</Button></>}>
      <div class="field ops-choice">
        <span class="field-label">What are you adding?</span>
        <RadioRows label="What are you adding?" value={dialog} onChange={openDialog} items={[
          { id: 'source', label: 'Source code', detail: 'A Git repository or local folder' },
          { id: 'openapi', label: 'OpenAPI spec', detail: 'From a URL or an uploaded file' },
          { id: 'docs-site', label: 'Rewrite a live docs site', detail: 'Crawl an existing site to audit and rewrite' },
        ]} />
      </div>
      {dialog === 'source' && <>
        <div class="field ops-choice">
          <span class="field-label">Where is it?</span>
          <RadioRows label="Where is it?" value={whereIs} onChange={setWhereIs} items={[
            { id: 'public', label: 'Public repository' },
            { id: 'private', label: 'Private repository', detail: 'Needs a personal access token' },
            { id: 'local', label: 'Local folder' },
          ]} />
        </div>
        {sourceMode === 'git' ? <>
          {add.authMethod === 'credentials' && <>
            <Field label="Username"><Input value={add.gitUsername} autocomplete="username" onInput={(event) => { setAdd({ ...add, gitUsername: event.currentTarget.value }); resetConnection() }} /></Field>
            <Field label="Personal access token" hint="A token with read access to the repository. It is used to connect and is stored outside the project."><Input type="password" value={add.gitSecret} autocomplete="off" onInput={(event) => { setAdd({ ...add, gitSecret: event.currentTarget.value }); resetConnection() }} /></Field>
          </>}
          <Field label="Repository URL" hint="A GitHub, GitLab, Azure DevOps or other Git URL. Connect to load its branches and folders."><div class="repository-connect-input"><Input class="mono-input" value={add.repository} placeholder="https://github.com/org/repository" onInput={(event) => { setAdd({ ...add, repository: event.currentTarget.value }); resetConnection() }} /><RepositoryConnectButton connected={Boolean(head)} busy={connecting} disabled={!add.repository.trim() || (add.authMethod === 'credentials' && (!add.gitUsername.trim() || !add.gitSecret.trim()))} onClick={() => void connectRepository()} /></div></Field>
          <Field label="Branch"><Select value={add.branch} disabled={!head || connecting} onChange={(event) => void selectBranch(event.currentTarget.value)}>{branches.length ? branches.map((branch) => <option key={branch}>{branch}</option>) : <option>{connecting ? 'Connecting...' : 'Connect repository first'}</option>}</Select></Field>
          <Field label="Folder (optional)" hint="Limit the source to one folder of the repository."><Select value={add.subdirectory} disabled={!head || foldersLoading} onChange={(event) => setAdd({ ...add, subdirectory: event.currentTarget.value })}><option value="">/</option>{directories.map((directory) => <option key={directory}>{directory}</option>)}</Select></Field>
        </> : <Field label="Local folder"><div class="source-folder-input"><Input class="mono-input" value={add.path} onInput={(event) => setAdd({ ...add, path: event.currentTarget.value })} /><Button icon="folder" onClick={() => void post<{ path: string | null }>('/api/setup/browse-directory').then((result) => result.path && setAdd({ ...add, path: result.path }))}>Browse</Button></div></Field>}
      </>}
      {dialog === 'openapi' && <>
        <div class="field ops-choice">
          <span class="field-label">Where is it?</span>
          <RadioRows label="Where is it?" value={openapiMode} onChange={setOpenapiMode} items={[
            { id: 'file', label: 'Upload a file', detail: '.yaml, .yml or .json' },
            { id: 'url', label: 'From a URL', detail: 'A public address' },
          ]} />
        </div>
        {openapiMode === 'file'
          ? <div class={`openapi-dropzone ${add.fileName ? 'has-file' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void readSpecification(event.dataTransfer?.files[0]) }}><input ref={fileInput} type="file" accept=".yaml,.yml,.json,application/json,text/yaml" onChange={(event) => void readSpecification(event.currentTarget.files?.[0])} /><span><Icon name={add.fileName ? 'check' : 'publish'} size={22} /></span><strong>{add.fileName || 'Drag and drop your OpenAPI file here'}</strong><Button size="sm" onClick={() => fileInput.current?.click()}>{add.fileName ? 'Choose another file' : 'Browse file'}</Button></div>
          : <Field label="OpenAPI spec URL" hint="Public URLs in standard OpenAPI formats are supported."><Input class="mono-input" value={add.path} placeholder="https://example.com/openapi.yaml" onInput={(event) => setAdd({ ...add, path: event.currentTarget.value, specContent: '', fileName: '' })} /></Field>}
      </>}
      {dialog === 'docs-site' && <DocsSiteSourceFields url={add.path} onUrl={(value) => { setAdd({ ...add, path: value }); setDocsSiteError('') }} inspection={docsSiteInspection} onInspection={setDocsSiteInspection} error={docsSiteError} onError={setDocsSiteError} />}
      <details class="source-scope-fields"><summary>Documentation ownership (optional)</summary><div><Field label="Route prefix"><Input value={add.routePrefix} placeholder="api or integrations/payments" onInput={(event) => setAdd({ ...add, routePrefix: event.currentTarget.value })} /></Field><Field label="Navigation group"><Input value={add.navigationGroup} placeholder="API reference" onInput={(event) => setAdd({ ...add, navigationGroup: event.currentTarget.value })} /></Field><Field label="Space"><Input value={add.space} placeholder="Developers" onInput={(event) => setAdd({ ...add, space: event.currentTarget.value })} /></Field><Field label="Shared pages" hint="Comma-separated page paths or globs"><Input value={add.sharedPages} placeholder="docs/overview.mdx" onInput={(event) => setAdd({ ...add, sharedPages: event.currentTarget.value })} /></Field></div></details>
    </OpsSheet>}
  </div>
}

/** Items in a coverage metric that still need documentation or a decision. */
function coverageGapCount(metric: SourceIntelligence['coverage']['metrics'][number]): number {
  return metric.items.filter((item) => item.state === 'uncovered' || item.state === 'needs-human' || item.state === 'planned' || item.state === 'stale').length
}

/** The ⋯ glyph for row menus; the icon set has no "more" mark. */
function MoreGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></svg>
}

/** A choice list: one bordered column of radio rows, never a tile grid. */
function RadioRows<T extends string>({ label, value, onChange, items }: {
  label: string
  value: T
  onChange: (value: T) => void
  items: ReadonlyArray<{ id: T; label: string; detail?: string; trailing?: import('preact').ComponentChildren; disabled?: boolean }>
}) {
  return <div class="radio-rows" role="radiogroup" aria-label={label}>
    {items.map((item) => <button key={item.id} type="button" role="radio" aria-checked={value === item.id} class={value === item.id ? 'selected' : ''} disabled={item.disabled} onClick={() => onChange(item.id)}>
      <span><strong>{item.label}</strong>{item.detail && <small>{item.detail}</small>}</span>
      {item.trailing}
    </button>)}
  </div>
}

function ExistingDocumentationAudit({ assessments, pages }: { assessments: NonNullable<DocumentationPlan['existingDocumentation']>; pages: DocumentationPlanPage[] }) {
  const titles = new Map(pages.map((page) => [page.id, page.title]))
  return <div class="plan-existing-docs">{assessments.map((assessment) => {
    const counts = { rewrite: 0, merge: 0, preserve: 0, drop: 0 }
    for (const page of assessment.pages) counts[page.disposition] += 1
    const blockers = assessment.findings.filter((finding) => finding.severity === 'blocker').length
    return <section class="plan-existing-docs-source" key={assessment.source}>
      <header><h3>{assessment.source}</h3><small>{assessment.pages.length} existing page{assessment.pages.length === 1 ? '' : 's'} assessed · {assessment.findings.length} finding{assessment.findings.length === 1 ? '' : 's'}{blockers ? ` (${blockers} blocking)` : ''}</small></header>
      {assessment.summary && <p>{assessment.summary}</p>}
      <div class="plan-existing-docs-stats">
        <div><strong>{counts.rewrite}</strong><span>pages rewritten</span></div>
        <div><strong>{counts.merge}</strong><span>pages merged</span></div>
        <div><strong>{counts.preserve}</strong><span>pages preserved</span></div>
        <div><strong>{counts.drop}</strong><span>pages dropped</span></div>
        <div><strong>{assessment.coverage.gaps.length}</strong><span>coverage gaps filled</span></div>
        <div><strong>{assessment.coverage.contradicted.length}</strong><span>claims corrected</span></div>
      </div>
      <div class="plan-existing-docs-columns">
        <section class="gaps"><h4>Not covered today</h4>{assessment.coverage.gaps.length ? <ul>{assessment.coverage.gaps.map((item) => <li key={item}>{item}</li>)}</ul> : <span class="empty">No gaps against the product sources.</span>}</section>
        <section class="contradicted"><h4>Contradicted by the product</h4>{assessment.coverage.contradicted.length ? <ul>{assessment.coverage.contradicted.map((item) => <li key={item}>{item}</li>)}</ul> : <span class="empty">No claims contradicted.</span>}</section>
        <section class="obsolete"><h4>Obsolete</h4>{assessment.coverage.obsolete.length ? <ul>{assessment.coverage.obsolete.map((item) => <li key={item}>{item}</li>)}</ul> : <span class="empty">Nothing obsolete found.</span>}</section>
        <section class="preserved"><h4>Kept from the existing docs</h4>{assessment.coverage.preserved.length ? <ul>{assessment.coverage.preserved.map((item) => <li key={item}>{item}</li>)}</ul> : <span class="empty">Nothing marked for preservation.</span>}</section>
      </div>
      {assessment.strengths.length > 0 && <Note tone="info">Strengths kept: {assessment.strengths.join(' · ')}</Note>}
      {assessment.findings.length > 0 && <div class="plan-existing-docs-findings">{assessment.findings.map((finding) => <article key={finding.title}><span class={`severity-pill ${finding.severity}`}>{finding.severity}</span><div><strong>{finding.title}</strong>{finding.description && <p>{finding.description}</p>}{finding.pages.length > 0 && <small>{finding.pages.join(', ')}</small>}</div></article>)}</div>}
      {assessment.pages.length > 0 && <details class="plan-existing-docs-dispositions"><summary>Where each existing page lands ({assessment.pages.length})</summary>
        <table><thead><tr><th>Existing page</th><th>Decision</th><th>New page</th><th>Why</th></tr></thead><tbody>{assessment.pages.map((page) => <tr key={page.path}><td>{page.title ?? page.path}<small>{page.url ?? page.path}</small></td><td><span class={`disposition-pill ${page.disposition}`}>{page.disposition}</span></td><td>{page.into.length ? page.into.map((id) => titles.get(id) ?? id).join(', ') : '—'}</td><td>{page.reason}</td></tr>)}</tbody></table>
      </details>}
    </section>
  })}</div>
}

/**
 * Drift is computed on every state load but was never drawn. Show which pages
 * fell behind their sources and why, so "stale" is something a reader can act
 * on rather than a word in the sync status.
 */
function DocumentationFreshness({ value, navigate, sync, onConfigure }: { value: UiState['drift']; navigate: (page: WorkspaceRoute) => void; sync: SyncConfig; onConfigure: () => void }) {
  const drift = driftState(value)
  const monitoringRow = <div class="vrow">
    <span class="vrow-label">Monitoring</span>
    <span class="vrow-value">{sync.on.length ? monitoringSummary(sync) : 'Not configured'}<Button tone="link" onClick={onConfigure}>Configure</Button></span>
  </div>
  if (!drift.ok) {
    return <Panel class="freshness-panel unknown" title="Freshness" flush>
      <div class="vrows">
        <div class="vrow"><span class="vrow-label">Documentation freshness<small>{drift.reason}</small></span></div>
        {monitoringRow}
      </div>
    </Panel>
  }
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
  return <Panel class={`freshness-panel ${status}`} title="Freshness" flush>
    <div class="vrows">
      <div class="vrow">
        <span class="vrow-label">{headline}<small>{detail}</small></span>
        <span class="vrow-value">
          <Badge tone={status === 'stale' ? 'warn' : status === 'current' ? 'good' : 'neutral'}>{status === 'stale' ? `${pages.length} stale` : status === 'current' ? 'Up to date' : 'Not tracked'}</Badge>
          {status === 'stale' && <Button tone="link" onClick={() => navigate('authoring')}>Plan an update</Button>}
        </span>
      </div>
      {status === 'stale' && pages.slice(0, 8).map((page) => <div class="vrow freshness-page" key={page.page}>
        <span class="vrow-label"><code>{page.page}</code></span>
        <span class="vrow-value">{(page.reasons ?? []).map((reason) => reason.kind === 'max-age'
          ? `evidence older than ${reason.ageDays ?? '?'} days`
          : `${reason.source}: ${reason.paths?.length ?? 0} changed path${(reason.paths?.length ?? 0) === 1 ? '' : 's'}`).join(' · ') || 'Sources changed'}</span>
      </div>)}
      {status === 'stale' && pages.length > 8 && <div class="vrow"><span class="vrow-label faint">and {pages.length - 8} more</span></div>}
      {changedSources.map((source) => <div class="vrow" key={source.name}>
        <span class="vrow-label">{source.name}<small>Source changed since the last update</small></span>
        <span class="vrow-value">{source.changedPaths.length} changed{source.filteredPaths > 0 && <> · {source.filteredPaths} filtered by watch rules</>}</span>
      </div>)}
      {monitoringRow}
    </div>
  </Panel>
}

/** One line for the monitoring row: the schedule, then any budget caps. */
function monitoringSummary(sync: SyncConfig): string {
  const parts = [scheduleSummary(scheduleForm(sync.on))]
  if (sync.budget?.maxUsd) parts.push(`$${sync.budget.maxUsd.toFixed(2)} cap per run`)
  if (sync.budget?.maxRunsPerDay) parts.push(`${sync.budget.maxRunsPerDay} run${sync.budget.maxRunsPerDay === 1 ? '' : 's'} per day`)
  if (sync.budget?.maxMinutes) parts.push(`${sync.budget.maxMinutes} min limit`)
  return parts.join(' · ')
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
  // Marking several gaps internal at once: a whole folder of admin-only or
  // generated code is one decision, not one reason typed per row.
  const [internalReason, setInternalReason] = useState('')
  const [bulkOpen, setBulkOpen] = useState(false)
  const markSelectedInternal = async () => {
    const reason = internalReason.trim()
    if (!reason || !selectedItems.length) return
    let latest: SourceIntelligence | undefined
    for (const item of selectedItems) {
      latest = await post<SourceIntelligence>('/api/coverage/resolve', { id: item.id, action: 'exclude', reason }).catch(() => latest)
    }
    if (latest) onReport(latest)
    setSelectedIds([])
    setBulkOpen(false)
    setInternalReason('')
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
      <footer><div class="coverage-plan-summary"><strong>{selectedItems.length ? `${selectedItems.length} ${selectedItems.length === 1 ? 'gap' : 'gaps'} ready to plan` : 'No gaps selected'}</strong><small>{selectedItems.length ? 'One plan will cover your full selection.' : 'Select one or more gaps to continue.'}</small></div><div>{bulkOpen
        ? <span class="coverage-bulk-internal"><Input value={internalReason} aria-label="Why these are not part of the public documentation" placeholder="Why are these internal?" onInput={(event) => setInternalReason(event.currentTarget.value)} /><Button size="sm" tone="ghost" onClick={() => setBulkOpen(false)}>Cancel</Button><Button size="sm" disabled={!internalReason.trim()} onClick={() => void markSelectedInternal()}>Mark internal</Button></span>
        : <><Button onClick={onClose}>Close</Button><Button disabled={!selectedItems.length} onClick={() => setBulkOpen(true)}>Mark internal{selectedItems.length ? ` (${selectedItems.length})` : ''}</Button><Button tone="primary" busy={planning} disabled={!selectedItems.length} onClick={() => void createPlan()}>Create update plan{selectedItems.length ? ` (${selectedItems.length})` : ''}</Button></>}</div></footer>
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
  return <div class="sources-modal-scrim ops-dialog-scrim" onClick={onClose}>
    <section class="sources-reference-dialog source-scope-dialog ops-dialog" role="dialog" aria-modal="true" aria-labelledby="source-scope-title" onClick={(event) => event.stopPropagation()}>
      <header class="ops-dialog-head"><div><h2 id="source-scope-title">Documentation ownership</h2><p>Keep changes from <strong>{source.name}</strong> inside a clear documentation boundary.</p></div><button type="button" class="ops-icon-button" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button></header>
      <div class="sources-dialog-body ops-dialog-body">
        <Field label="Route prefix" hint="Pages grounded in this source stay below this route."><Input value={scope.routePrefix} placeholder="api or integrations/payments" onInput={(event) => setScope({ ...scope, routePrefix: event.currentTarget.value })} /></Field>
        <Field label="Navigation group"><Input value={scope.navigationGroup} placeholder="API reference" onInput={(event) => setScope({ ...scope, navigationGroup: event.currentTarget.value })} /></Field>
        <Field label="Space"><Input value={scope.space} placeholder="Developers" onInput={(event) => setScope({ ...scope, space: event.currentTarget.value })} /></Field>
        <Field label="Shared pages" hint="Comma-separated paths or globs allowed outside the route. Overlapping route prefixes are rejected, and shared pages must be listed explicitly so one source cannot silently rewrite another source's section."><Input value={scope.sharedPages} placeholder="docs/overview.mdx" onInput={(event) => setScope({ ...scope, sharedPages: event.currentTarget.value })} /></Field>
      </div>
      <footer class="ops-dialog-foot"><Button tone="ghost" onClick={onClose}>Cancel</Button><Button tone="primary" busy={saving} onClick={() => void save()}>Save ownership</Button></footer>
    </section>
  </div>
}

function Authoring({ state, act, streamConnected, onError }: { state: UiState; act: Action; streamConnected: boolean; onError: (error: string) => void }) {
  const hasCompletedRun = documentationExists(state)
  const mode = hasCompletedRun ? 'update' : 'create'
  const pendingSources = state.receipt?.pendingSources ?? []
  const defaultAgent = state.project?.defaultAgent ?? ''
  const defaultModel = state.project?.defaultModel || defaultModelForAgent(defaultAgent)
  const defaultReasoning = preferredReasoningLevel(defaultAgent, defaultModel)
  // A configured application means the reviewer set it up to be captured;
  // default to screenshots rather than making them opt in on every plan.
  const [form, setForm] = useState({ request: '', scope: 'starter', limits: { maxPages: 5, maxScreenshots: 0, maxMinutes: 15 }, targetPages: '', clarificationMode: 'review', agent: defaultAgent, model: defaultModel, reasoning: defaultAgent === 'codex' ? defaultReasoning : '', effort: defaultAgent === 'claude' ? defaultReasoning : '', screenshots: 'disabled' as 'auto' | 'enabled' | 'disabled' })
  const [showNewPlan, setShowNewPlan] = useState(() => shouldShowAuthoringForm(state))
  const [agentConfigOpen, setAgentConfigOpen] = useState(false)
  const [scopeOpen, setScopeOpen] = useState(false)
  const [limitsOpen, setLimitsOpen] = useState(false)
  const availableAuthorModels = agentModels(form.agent)
  const supportedAuthorReasoning = modelReasoningLevels(form.agent, form.model)
  const [activityOpen, setActivityOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [discovery, setDiscovery] = useState<PlanDiscoverySummary>()
  const [captureReadiness, setCaptureReadiness] = useState<ApplicationReadiness>()
  const [checkingCapture, setCheckingCapture] = useState(false)
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
  // The application is often started after this form is already open, so the
  // result fetched on load goes stale; both the Check again link and the
  // plan button ask again instead of trusting it.
  const refreshCaptureReadiness = async (): Promise<ApplicationReadiness | undefined> => {
    setCheckingCapture(true)
    let readiness: ApplicationReadiness | undefined
    try { readiness = await api<ApplicationReadiness>('/api/application/readiness') }
    catch { readiness = undefined }
    finally { setCheckingCapture(false) }
    setCaptureReadiness(readiness)
    return readiness
  }

  useEffect(() => {
    setShowNewPlan(shouldShowAuthoringForm(state))
  }, [state.documentationPlan?.id, state.documentationPlan?.status, state.documentationPlan?.proposalId, validRuns(state.runs).map((run) => `${run.id}:${run.status}`).join('|')])

  const startPlan = async () => {
    if (runBusy || checkingCapture) return
    if (form.screenshots === 'enabled') {
      const readiness = captureReadiness?.status === 'ready' ? captureReadiness : await refreshCaptureReadiness()
      if (readiness?.status !== 'ready') {
        onError(readiness
          ? `Screenshots are required for this run, but the application check did not pass: ${readiness.message}`
          : 'Screenshots are required for this run, but Doxloop could not check the application. Start it, then try again.')
        return
      }
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

  const scopeOptions = [
    ['starter', 'Starter', 'First success path and essential reference'],
    ['standard', 'Standard', 'Primary journeys, concepts, troubleshooting, and reference'],
    ['comprehensive', 'Comprehensive', 'Complete evidence-supported public surface'],
  ] as const
  const scopeName = scopeOptions.find(([value]) => value === form.scope)?.[1] ?? 'Custom'
  const agentChipLabel = [form.agent ? agentLabel(form.agent) : 'Automatically detect', form.model, form.agent === 'codex' ? form.reasoning : form.agent === 'claude' ? form.effort : ''].filter(Boolean).join(' · ')
  const setScreenshotChoice = (value: 'yes' | 'no') => setForm({ ...form, screenshots: screenshotIntentFromChoice(value), limits: { ...form.limits, maxScreenshots: value === 'yes' ? (form.limits.maxScreenshots || batchLimitsForScope(form.scope as 'starter' | 'standard' | 'comprehensive' | 'custom', 'auto').maxScreenshots) : 0 } })
  const reviewing = Boolean(visiblePlan && visiblePlan.status !== 'generated')
  const promptQuestion = contentType === 'release-notes' ? 'Anything the release notes must call out?' : 'What should readers be able to do?'
  const promptPlaceholder = contentType === 'release-notes'
    ? 'Optional. For example: Lead with the new billing API and mark the removed legacy mode as breaking.'
    : mode === 'create'
      ? 'For example: Help developers install the SDK, authenticate, and complete their first successful API request.'
      : 'For example: Document API key rotation and update the authentication journey with a TypeScript example.'
  const captureReady = captureReadiness?.status === 'ready'

  return <div class="authoring-page pl-page">
    {!reviewing && <PageHeader
      kicker="Plan"
      title={visiblePlan?.status === 'generated' ? 'Documentation plan' : mode === 'create' ? 'Create documentation' : 'Update documentation'}
      description={visiblePlan?.status === 'generated' ? 'The approved plan was generated. Review the proposal before anything reaches readers.' : 'Ask for what readers should be able to do. Doxloop researches, plans, and waits for your approval.'}
      actions={!visiblePlan && state.documentationPlan && state.documentationPlan.status !== 'cancelled' ? <Button icon="file" onClick={() => setShowNewPlan(false)}>Open plan v{state.documentationPlan.version}</Button> : undefined}
    />}
    {hasCompletedRun && pendingSources.length > 0 && <Note tone="info">{pendingSources.length === 1 ? `New source “${pendingSources[0]}” was added.` : `${pendingSources.length} new sources were added.`} The planning agent will inspect {pendingSources.length === 1 ? 'it' : 'them'} and show where the documentation should change.</Note>}

    {visiblePlan
      ? <DocumentationPlanReview plan={visiblePlan} act={act} busy={runBusy} agents={state.agents ?? []} defaultAgent={defaultAgent} onStartAnother={() => setShowNewPlan(true)} />
      : <div class="authoring-workbench">
        <section class="panel authoring-request pl-composer">
          <fieldset class="authoring-fields pl-composer-prompt" disabled={runBusy}>
            {gitSources.length > 0 && <div class="pl-composer-type"><Segmented value={contentType} onChange={setContentType} items={[['documentation', 'Documentation'], ['release-notes', 'Release notes']] as const} /></div>}
            <label class="pl-composer-field">
              <span class="sr-only">{promptQuestion}</span>
              <Textarea rows={3} maxlength={2000} value={form.request} placeholder={promptPlaceholder} onInput={(event) => setForm({ ...form, request: event.currentTarget.value })} />
            </label>
            {contentType === 'release-notes' && <ReleaseTemplateFields sources={gitSources} value={release} onChange={setRelease} disabled={runBusy} />}
          </fieldset>
          <div class="pl-composer-row">
            <div class="pl-composer-chips">
              {mode === 'create' && <button type="button" class="chip" aria-expanded={scopeOpen} disabled={runBusy} onClick={() => setScopeOpen(!scopeOpen)}><Icon name="layers" size={14} />{scopeName} scope<Icon name="chevronDown" size={13} class={`pl-chevron ${scopeOpen ? 'open' : ''}`} /></button>}
              <button type="button" class="chip" aria-expanded={agentConfigOpen} disabled={runBusy} onClick={() => setAgentConfigOpen(!agentConfigOpen)}><Icon name="bot" size={14} /><span class="sr-only">Agent: </span>{agentChipLabel}<Icon name="chevronDown" size={13} class={`pl-chevron ${agentConfigOpen ? 'open' : ''}`} /></button>
              <button type="button" class="chip" aria-pressed={form.screenshots !== 'disabled'} disabled={runBusy} onClick={() => setScreenshotChoice(form.screenshots === 'disabled' ? 'yes' : 'no')}><Icon name="camera" size={14} />Screenshots {form.screenshots === 'disabled' ? 'off' : 'on'}</button>
              <button type="button" class="chip" aria-expanded={limitsOpen} disabled={runBusy} onClick={() => setLimitsOpen(!limitsOpen)}><Icon name="file" size={14} />Up to {form.limits.maxPages} pages<Icon name="chevronDown" size={13} class={`pl-chevron ${limitsOpen ? 'open' : ''}`} /></button>
            </div>
            <Button disabled={runBusy} busy={submitting || checkingCapture} tone="primary" icon="sparkle" onClick={() => void startPlan()}>{mode === 'create' ? 'Create documentation plan' : 'Plan documentation update'}</Button>
          </div>
          {scopeOpen && mode === 'create' && <section class="pl-composer-expand" aria-label="Documentation scope">
            <div class="radio-rows">
              {scopeOptions.map(([value, label, detail]) => {
                const estimate = discovery?.suggestedPages[value]
                return <button type="button" key={value} class={form.scope === value ? 'selected' : ''} aria-pressed={form.scope === value} disabled={runBusy} onClick={() => setForm({ ...form, scope: value, limits: batchLimitsForScope(value, form.screenshots) })}><span><strong>{label}</strong><small>{detail}</small></span><b>{estimate ? `About ${estimate} pages` : 'Estimating…'}</b></button>
              })}
            </div>
            {discovery && <small class="pl-composer-hint">Based on {discovery.publicSignals} public source signal{discovery.publicSignals === 1 ? '' : 's'}. Small products stay small; unsupported topics are never added as filler.</small>}
          </section>}
          {agentConfigOpen && <fieldset class="authoring-options pl-composer-expand" disabled={runBusy}>
            <Field label="Agent"><Select value={form.agent} onChange={(event) => {
              const agent = event.currentTarget.value
              const model = defaultModelForAgent(agent)
              const level = preferredReasoningLevel(agent, model)
              setForm({ ...form, agent, model, reasoning: agent === 'codex' ? level : '', effort: agent === 'claude' ? level : '' })
            }}><option value="">Automatically detect</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select></Field>
            <Field label="Model"><Combo value={form.model} options={availableAuthorModels.map((model) => [model.id, model.label] as const)} disabled={!form.agent} placeholder="Default model" onValueChange={(value) => setForm({ ...form, model: value })} /></Field>
            <Field label={form.agent === 'claude' ? 'Effort' : 'Reasoning'}><Combo value={form.agent === 'claude' ? form.effort : form.reasoning} options={supportedAuthorReasoning.map((value) => [value, value] as const)} disabled={!form.agent} placeholder="Default" onValueChange={(value) => setForm({ ...form, [form.agent === 'claude' ? 'effort' : 'reasoning']: value })} /></Field>
            <Field label="Planner questions" hint="What the planner does when it needs a decision from you."><Select value={form.clarificationMode} onChange={(event) => setForm({ ...form, clarificationMode: event.currentTarget.value })}><option value="review">Ask in review</option><option value="defaults">Use recommendations</option><option value="stop">Always wait for answers</option></Select></Field>
          </fieldset>}
          {form.screenshots !== 'disabled' && <section class="pl-composer-expand pl-composer-capture" aria-label="Application screenshot behavior">
            {captureReadiness
              ? <small class={`capture-readiness ${captureReady ? 'ready' : 'missing'}`}><Icon name={captureReady ? 'check' : 'info'} size={13} />{captureReadiness.message}{!captureReadiness.configured && <> Configure it in <button type="button" onClick={() => setLocation('settings', { section: 'capture' }, 'push')}>Settings</button>.</>}{captureReadiness.configured && !captureReady && <> <button type="button" disabled={checkingCapture} onClick={() => void refreshCaptureReadiness()}>{checkingCapture ? 'Checking…' : 'Check again'}</button></>}</small>
              : <small class="capture-readiness">Checking the application…</small>}
            {form.screenshots === 'enabled' && !captureReady && <small class="pl-composer-hint">Screenshots are required for this run. Planning checks the application again when you start; start or configure it first.</small>}
          </section>}
          {limitsOpen && <section class="pl-composer-expand pl-composer-limits" aria-label="Run limits">
            <Field label="Minimum pages to write" hint={mode === 'create' ? 'Optional. Leave empty to let the evidence decide; the batch maximum limits what can be approved for this run.' : 'Optional. Ask for a larger update when the existing documentation is thin; the planner adds distinct evidence-backed pages rather than filler.'}><Input type="number" min="1" max="500" value={form.targetPages} placeholder={mode === 'create' ? (discovery ? String(discovery.suggestedPages[form.scope as 'starter' | 'standard' | 'comprehensive']) : 'For example: 40') : 'For example: 25'} onInput={(event) => setForm({ ...form, targetPages: event.currentTarget.value })} /></Field>
            <label class="field"><span class="field-label">Batch page limit</span><input aria-label="Batch page limit" type="range" min="1" max="50" value={Math.min(50, form.limits.maxPages)} onInput={(event) => setForm({ ...form, limits: { ...form.limits, maxPages: Number(event.currentTarget.value) } })} /></label>
            {(['maxPages', 'maxScreenshots', 'maxMinutes'] as const).map((key) => <Field key={key} label={key === 'maxPages' ? 'Maximum pages' : key === 'maxScreenshots' ? 'Maximum screenshots' : 'Maximum minutes'}><Input type="number" min={key === 'maxScreenshots' ? 0 : 1} value={form.limits[key]} onInput={(event) => setForm({ ...form, limits: { ...form.limits, [key]: Number(event.currentTarget.value) } })} /></Field>)}
            <div class="pl-composer-limit-foot"><RunEstimate pages={form.limits.maxPages} agent={form.agent} model={form.model} /><Button size="sm" onClick={() => setForm({ ...form, scope: 'starter', targetPages: '', screenshots: 'disabled', limits: { maxPages: 5, maxScreenshots: 0, maxMinutes: 15 } })}>Small first batch</Button></div>
          </section>}
        </section>
      </div>}

    {(currentRun || submitting) && <section class={`panel pl-live ${activityOpen ? 'open' : ''}`}>
      <header class="panel-head pl-live-head">
        <button type="button" class="pl-live-toggle" aria-expanded={activityOpen} onClick={() => setActivityOpen(!activityOpen)}>
          <Icon name="zap" size={16} />
          <span class="pl-live-title"><strong>Live activity</strong><small>{activeRun ? `${workflowActivityLabel(activeRun.type)} · started ${timeText(activeRun.startedAt)}` : submitting ? 'Starting planning agent…' : currentRun ? `${workflowActivityLabel(currentRun.type)} · ${statusLabel(currentRun.status)} ${timeText(currentRun.finishedAt ?? currentRun.startedAt)}` : 'Show the latest workflow log'}</small></span>
          <Icon name="chevronDown" size={16} class={`pl-chevron ${activityOpen ? 'open' : ''}`} />
        </button>
        <div class="panel-actions">
          {activeRun && <Badge tone={streamConnected ? 'good' : 'warn'}>{streamConnected ? 'Live' : 'Reconnecting…'}</Badge>}
          {activeRun && <Button size="sm" tone="danger" icon="stop" aria-label="Stop update" onClick={() => void act(() => post(`/api/jobs/${activeRun.id}/cancel`), 'Update stopped')}>Stop</Button>}
        </div>
      </header>
      {activityOpen && currentRun && <div class="panel-body flush"><AuthoringLiveLog job={currentRun} act={act} hideStop /></div>}
      {activityOpen && !currentRun && <div class="authoring-live-empty">Starting the planning agent…</div>}
    </section>}
    <Panel class="history-panel pl-history" title="Update history" flush>
      <RequestHistory jobs={state.jobs} onError={onError} />
    </Panel>
  </div>
}

function DocumentationPlanReview({ plan, act, busy, agents, defaultAgent, onStartAnother }: { plan: DocumentationPlan; act: Action; busy: boolean; agents: AgentState[]; defaultAgent: string; onStartAnother: () => void }) {
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
  const [retryingPlanning, setRetryingPlanning] = useState(false)
  const [resuming, setResuming] = useState(false)
  const [continuing, setContinuing] = useState<'resume' | 'ignore-errors'>()
  const [captureReadiness, setCaptureReadiness] = useState<ApplicationReadiness>()
  const [captureCheck, setCaptureCheck] = useState<'idle' | 'checking' | 'done' | 'failed'>('idle')
  const [captureCheckNonce, setCaptureCheckNonce] = useState(0)
  const [retryAgent, setRetryAgent] = useState('')
  const [coverageDismissed, setCoverageDismissed] = useState('')
  const [limitsOpen, setLimitsOpen] = useState(false)
  const [captureDetailsOpen, setCaptureDetailsOpen] = useState(false)
  const [ownAnswers, setOwnAnswers] = useState<Record<string, boolean>>({})
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
  // While the generation job runs the plan can still read "approved".
  const writing = plan.status === 'generating' || (busy && plan.status === 'approved')
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
  const primaryAction = planPrimaryAction(plan)
  const approvalBlocker = primaryAction === 'retry-planning'
    ? 'Planning stopped before it proposed any pages. Retry planning to run it again with the same brief.'
    : draft.questions.length > 0
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
  // A plan that failed before proposing pages is a dead end unless the reader
  // can see why and pick an assistant that can actually run.
  const planningFailed = primaryAction === 'retry-planning'
  const planningFailedEmpty = planningFailed && draft.pages.length === 0
  const installedAgents = agents.filter((agent) => agent.executable)
  const retryOptions = installedAgents.map((agent) => ({ name: agent.name, status: agentAuthStatus(agent.authentication.status) }))
  const planAgentName = plan.execution.agent || defaultAgent
  const planAgentSignedOut = retryOptions.some((agent) => agent.name === planAgentName && agent.status === 'unauthenticated')
  const chosenRetryAgent = retryAgent || retryAgentChoice(retryOptions, planAgentName || undefined, defaultAgent || undefined)
  const chosenRetrySignedOut = retryOptions.some((agent) => agent.name === chosenRetryAgent && agent.status === 'unauthenticated')
  const coverageKey = `${plan.id}:${plan.version}`
  const screenshotCoverage = planningFailed ? undefined : planScreenshotCoverage(pages, screenshotIntent, captureReadiness)
  const approvalControls = planApprovalControls({
    changed,
    busy,
    hasPages: draft.pages.length > 0,
    hasQuestions: draft.questions.length > 0,
    captureRequired,
    hasVisualPages: visualPages.length > 0,
    captureReady,
  })
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
  // The structure editor places the page in a section itself, so this only
  // adds the page to the draft; the navigation change arrives through onChange.
  const createPage = () => {
    const page = newPlanPage(draft.pages.length)
    setDraft((current) => ({ ...current, scope: 'custom', pages: [...current.pages, page] }))
    setSelectedPageId(page.id)
    return page
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
      const updated = await act(() => patch<DocumentationPlan>(`/api/plans/${plan.id}`, planEditablePayload({ ...draft, navigation: { ...draft.navigation, sections: draft.navigation.sections.filter((section) => section.pageIds.length > 0) } })), 'Plan changes saved')
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
  const retryPlanning = async () => {
    setRetryingPlanning(true)
    try {
      await act(() => post<UiJob>(`/api/plans/${plan.id}/retry`, chosenRetryAgent ? { agent: chosenRetryAgent } : {}), 'Planning restarted')
    } finally {
      setRetryingPlanning(false)
    }
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
  if (plan.status === 'generated') return <Panel class="plan-complete-panel pl-complete">
    <div class="plan-complete"><span><Icon name="check" size={22} /></span><div><h2>Documentation proposal is ready</h2><p>The approved plan was generated in an isolated workspace. Reader-facing files stay unchanged until you review and accept them.</p></div></div>
    <div class="plan-complete-actions"><Button onClick={onStartAnother}>Plan another update</Button><Button tone="primary" icon="proposals" onClick={() => setLocation('proposals', plan.proposalId ? { proposal: plan.proposalId } : {}, 'push')}>Review generated files</Button></div>
  </Panel>
  const scopeText = plan.scope === 'custom' ? 'Custom scope' : plan.scope.charAt(0).toUpperCase() + plan.scope.slice(1)
  const agentText = draft.execution.agent ? `${agentLabel(draft.execution.agent)}${draft.execution.model ? ` · ${draft.execution.model}` : ''}` : ''
  const limits = draft.execution.limits ?? { maxPages: 50, maxScreenshots: 20, maxMinutes: 30 }
  const captureBadge: [string, string] | undefined = screenshotIntent === 'disabled'
    ? undefined
    : captureCheck === 'checking'
      ? ['neutral', 'Checking…']
      : captureReadiness?.reachable
        ? [captureReadiness.status === 'authentication-required' ? 'warn' : 'good', captureReadiness.status === 'authentication-required' ? 'Sign-in needed' : 'Reachable']
        : ['warn', 'Not reachable']
  const actionTone = (action: DocumentationPlanPage['action']) => action === 'create' ? 'good' : action === 'update' ? 'info' : action === 'remove' ? 'bad' : 'neutral'
  const pageMatchesFilter = (page: DocumentationPlanPage) => pageFilter === 'all' || (pageFilter === 'changes' ? page.action !== 'preserve' : page.action === pageFilter)
  const priorityBadge = (page: DocumentationPlanPage) => <span class={`badge no-dot ${page.priority === 'must-have' ? 'teal' : 'neutral'}`}>{page.priority === 'must-have' ? 'Essential' : 'Recommended'}</span>
  const pageRowMeta = (page: DocumentationPlanPage) => <>
    <span class="pl-page-purpose">{page.purpose}</span>
    <span class={`pl-page-camera ${page.visuals && page.visuals.mode !== 'none' && screenshotIntent !== 'disabled' ? 'on' : ''}`} title={page.visuals && page.visuals.mode !== 'none' ? `${page.visuals.estimatedCaptures} planned screenshot${page.visuals.estimatedCaptures === 1 ? '' : 's'}` : 'No screenshots planned'}><Icon name="camera" size={15} /></span>
    {(plan.mode === 'update' || page.action !== 'create') && <span class={`badge no-dot ${actionTone(page.action)}`}>{planActionLabel(page.action)}</span>}
    {priorityBadge(page)}
    <button type="button" class="pl-icon-btn" aria-label={`Page options: ${page.title}`} onClick={(event) => { event.stopPropagation(); setSelectedPageId(page.id) }}><Icon name="chevronRight" size={16} /></button>
  </>
  return <div class="documentation-plan-review pl-review">
    <section class="pl-review-head">
      <div class="pl-review-heading">
        <span class="kicker">Plan version {plan.version} · {writing ? 'approved' : plan.status === 'planning' || plan.status === 'revising' ? 'started' : 'proposed'} {timeText(writing ? plan.updatedAt : plan.createdAt)}</span>
        <h1>{writing ? 'Writing your documentation' : plan.status === 'planning' ? 'Researching your documentation plan' : plan.status === 'revising' ? 'Revising your documentation plan' : planningFailedEmpty ? 'No pages proposed yet' : 'Review your documentation plan'}</h1>
      </div>
      <div class="pl-review-actions">
        <div class="pl-review-buttons">
          {plan.status !== 'ready-for-review' && (writing ? <Badge tone="info">Writing</Badge> : <Badge tone={statusTone(plan.status)}>{statusLabel(plan.status)}</Badge>)}
          {approvalControls.showSave && <Button busy={saving} onClick={() => void save()}>Save changes</Button>}
          {!locked && !planningFailed && <Button icon="sparkle" disabled={busy} onClick={() => { revisionInput.current?.focus(); revisionInput.current?.scrollIntoView({ block: 'center', behavior: 'smooth' }) }}>Ask the agent to revise</Button>}
          {!locked && (primaryAction === 'retry-planning'
            ? <Button tone="primary" icon="refresh" busy={retryingPlanning} disabled={busy} onClick={() => void retryPlanning()}>Retry planning</Button>
            : <Button tone="primary" icon={changed ? 'lock' : 'play'} busy={approving || generating} disabled={approvalControls.approveDisabled} onClick={() => void approveAndGenerate()}>{changed ? 'Save changes before approval' : primaryAction === 'generate' ? `Generate ${generationTarget}` : primaryAction === 'retry-generating' ? `Retry generating ${generationTarget}` : `Approve & generate ${generationTarget}`}</Button>)}
        </div>
        {!locked && <small class="pl-review-hint"><Icon name={approvalBlocker ? 'help' : 'lock'} size={13} />{approvalBlocker ?? (unresolvedCapabilities > 0 ? `${unresolvedCapabilities} coverage ${unresolvedCapabilities === 1 ? 'item needs' : 'items need'} a decision; you can save and continue if intentionally deferred.` : 'Nothing is written until you approve this exact plan.')}</small>}
      </div>
    </section>
    {pendingPlan && <div class="plan-pending-refresh pl-pending" role="status">
      <Icon name="info" size={15} />
      <span><strong>A newer version of this plan arrived while you were editing.</strong> Keep your unsaved edits, or load the new version and lose them.</span>
      <span class="plan-pending-actions"><Button size="sm" onClick={() => setPendingPlan(null)}>Keep my edits</Button><Button size="sm" tone="primary" onClick={() => loadPlan(pendingPlan)}>Load new version</Button></span>
    </div>}
    {stale && <Panel class="plan-stale-panel" title="Sources changed since this plan was proposed" description="The plan itself is unchanged and can be approved as it is; generation reads the current sources when it writes each page. Ask the agent to revise only if the change should alter which pages are written." actions={<><Button size="sm" icon="refresh" busy={resuming} disabled={busy} onClick={() => void resume()}>Clear this notice</Button><Button size="sm" icon="wand" disabled={busy} onClick={() => revisionInput.current?.focus()}>Ask the agent to revise</Button></>}>
      <p class="pl-stale-copy">Approve to generate from the current sources, or ask the agent to revise the plan first.</p>
    </Panel>}
    {planningFailed && <Panel class="plan-failed-panel pl-failed" icon="alert" title="Planning did not finish" description={planAgentSignedOut
      ? `${agentLabel(planAgentName)} is signed out on this computer, so it could not research your sources. Retry with a signed-in assistant, or sign ${agentLabel(planAgentName)} in again first.`
      : 'The planning agent stopped before it proposed any pages. Nothing in your project changed.'}>
      {plan.error && <pre class="plan-failed-error pl-error">{stripAnsi(plan.error)}</pre>}
      {installedAgents.length > 0 && <Field label="Retry with"><Select aria-label="Assistant to retry planning with" value={chosenRetryAgent} disabled={busy} onChange={(event) => setRetryAgent(event.currentTarget.value)}>{installedAgents.map((agent) => <option key={agent.name} value={agent.name}>{`${agentLabel(agent.name)} · ${retryStatusLabel(agent.authentication.status)}`}</option>)}</Select></Field>}
      <div class="pl-inline-actions"><Button tone="primary" icon="refresh" busy={retryingPlanning} disabled={busy} onClick={() => void retryPlanning()}>Retry planning</Button></div>
      {chosenRetrySignedOut && <Note tone="warn">{agentLabel(chosenRetryAgent)} is signed out. {agentSignInHint(chosenRetryAgent)}</Note>}
    </Panel>}
    {plan.error && !stale && !planningFailed && <Note tone="bad">{plan.error}</Note>}
    {plan.status === 'failed' && plan.failure && (plan.failure.resumable || plan.failure.ignorable) && <Panel class="plan-recovery-panel pl-recovery" title="Continue without starting over" description={plan.failure.stage === 'generate'
      ? 'The pages and screenshots the agent already produced are preserved in this run’s workspace. Continue from there instead of paying for another full run.'
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
      <footer class="plan-recovery-actions pl-inline-actions">
        {plan.failure.stage === 'generate' && plan.failure.resumable && <Button tone="primary" icon="play" busy={continuing === 'resume'} disabled={busy || Boolean(continuing)} onClick={() => void continueFailed('resume')}>Resume generation</Button>}
        {plan.failure.stage === 'generate' && plan.failure.ignorable && <Button icon="check" busy={continuing === 'ignore-errors'} disabled={busy || Boolean(continuing)} onClick={() => void continueFailed('ignore-errors')}>Ignore problems & continue</Button>}
        {plan.failure.stage !== 'generate' && plan.failure.ignorable && <Button tone="primary" icon="check" busy={continuing === 'ignore-errors'} disabled={busy || Boolean(continuing)} onClick={() => void continueFailed('ignore-errors')}>Review this plan anyway</Button>}
        <small>{plan.failure.stage === 'generate' ? `“Retry generating” above starts a new run from the approved plan${plan.failure.resumable ? ' only if this workspace can no longer be reused' : ''}.` : 'Or ask the agent to revise the plan below, which runs the planner again.'}</small>
      </footer>
    </Panel>}
    {locked && <Panel class="plan-progress-panel pl-progress"><div class="plan-progress"><span class="spinner" /><div><strong>{writing ? 'Writing the approved documentation' : plan.status === 'revising' ? 'Revising the documentation plan' : 'Researching sources and existing documentation'}</strong><p>{writing ? 'Pages are written in batches. The proposal opens in Review when writing finishes; your current documentation stays unchanged until you apply it.' : 'Follow the activity log below. The documentation project stays unchanged during planning.'}</p></div></div></Panel>}
    {!locked && <>
      <Panel class="pl-brief" title="Documentation brief" actions={(editable || briefOpen) ? <Button tone="link" onClick={() => setBriefOpen(!briefOpen)}>{briefOpen ? 'Close brief' : editable ? 'Edit brief' : 'Show details'}</Button> : undefined}>
        {plan.productProfile && <p class="pl-brief-text">{plan.productProfile}</p>}
        <p class="pl-brief-text">{plan.summary || 'No additional summary was provided.'}</p>
        <div class="pl-brief-badges">
          {(() => {
            // Pages kept exactly as they are are not written, so the badge
            // agrees with the "Approve & generate N pages" button.
            const kept = pages.filter((page) => page.action === 'preserve').length
            const written = pages.length - kept
            return <span class="badge no-dot">{written} page{written === 1 ? '' : 's'} to write{kept > 0 ? ` · ${kept} kept as is` : ''}</span>
          })()}
          <span class="badge no-dot">{draft.navigation.sections.length} section{draft.navigation.sections.length === 1 ? '' : 's'}</span>
          {plannedCaptures > 0 && screenshotIntent !== 'disabled' && <span class="badge no-dot">{plannedCaptures} screenshot{plannedCaptures === 1 ? '' : 's'}</span>}
          <span class="badge no-dot teal">{scopeText}</span>
          {agentText && <span class="badge no-dot">{agentText}</span>}
          {plan.mode === 'update' && counts.create > 0 && <span class="badge no-dot good">{counts.create} new</span>}
          {plan.mode === 'update' && counts.update > 0 && <span class="badge no-dot info">{counts.update} updated</span>}
          {plan.mode === 'update' && counts.remove > 0 && <span class="badge no-dot bad">{counts.remove} deleted</span>}
          {plan.mode === 'update' && counts.preserve > 0 && <span class="badge no-dot">{counts.preserve} unchanged</span>}
        </div>
        {briefOpen && <div class="pl-brief-editor">
          <section class="plan-coverage-summary pl-coverage-summary"><header><div><strong>Evidence coverage</strong><small>{draft.discovery.publicSignals} deterministic public signals inspected</small></div><span>{draft.capabilities.filter((capability) => capability.disposition === 'planned' || capability.disposition === 'existing').length} mapped</span></header>{draft.capabilities.length > 0 ? <ul>{draft.capabilities.map((capability, index) => <li key={capability.id}><span><b>{capability.title}</b><small>{capability.kind}</small></span>{editable ? <Select aria-label={`Coverage decision for ${capability.title}`} value={capability.disposition} onChange={(event) => setDraft({ ...draft, scope: 'custom', capabilities: draft.capabilities.map((candidate, item) => item === index ? { ...candidate, disposition: event.currentTarget.value as typeof candidate.disposition } : candidate) })}><option value="planned">Document</option><option value="existing">Existing documentation</option><option value="excluded">Exclude as internal</option><option value="needs-human">Decide later</option></Select> : <em class={capability.disposition}>{capability.disposition === 'needs-human' ? 'Needs decision' : capability.disposition}</em>}</li>)}</ul> : <p>No capability map was returned for this plan.</p>}</section>
          <Field label="Audiences" hint="Comma-separated"><Input disabled={!editable} value={draft.audiences.join(', ')} onInput={(event) => setDraft({ ...draft, scope: 'custom', audiences: splitComma(event.currentTarget.value) })} /></Field>
          <Field label="Reader outcomes" hint="Comma-separated"><Input disabled={!editable} value={draft.outcomes.join(', ')} onInput={(event) => setDraft({ ...draft, scope: 'custom', outcomes: splitComma(event.currentTarget.value) })} /></Field>
          <Field label="Reader experience"><Select disabled={!editable} value={draft.experienceLevel} onChange={(event) => setDraft({ ...draft, scope: 'custom', experienceLevel: event.currentTarget.value as DocumentationPlan['experienceLevel'] })}><option value="beginner">New to the product</option><option value="intermediate">Some experience</option><option value="advanced">Experienced</option><option value="mixed">Mixed audience</option></Select></Field>
          <Field label="Preferred examples" hint="Comma-separated languages or tools"><Input disabled={!editable} value={draft.preferredExamples.join(', ')} onInput={(event) => setDraft({ ...draft, scope: 'custom', preferredExamples: splitComma(event.currentTarget.value) })} /></Field>
          <Field label="Locale"><Input disabled={!editable} value={draft.locale} onInput={(event) => setDraft({ ...draft, scope: 'custom', locale: event.currentTarget.value })} /></Field>
          <Field label="Accessibility target"><Input disabled={!editable} value={draft.accessibilityTarget} onInput={(event) => setDraft({ ...draft, scope: 'custom', accessibilityTarget: event.currentTarget.value })} /></Field>
          <Field label="Style guide"><Input disabled={!editable} value={draft.styleGuide} onInput={(event) => setDraft({ ...draft, scope: 'custom', styleGuide: event.currentTarget.value })} /></Field>
          <Field label="Terminology" hint="One preferred term = guidance per line"><Textarea disabled={!editable} rows={3} value={termText(draft.terminology)} onInput={(event) => setDraft({ ...draft, scope: 'custom', terminology: parseTerms(event.currentTarget.value) })} /></Field>
          <Field label="Exclusions" hint="Comma-separated"><Textarea disabled={!editable} rows={3} value={draft.exclusions.join(', ')} onInput={(event) => setDraft({ ...draft, scope: 'custom', exclusions: splitComma(event.currentTarget.value) })} /></Field>
          <Field label="Plan-wide instructions"><Textarea disabled={!editable} rows={3} value={draft.instructions} onInput={(event) => setDraft({ ...draft, scope: 'custom', instructions: event.currentTarget.value })} /></Field>
        </div>}
      </Panel>
      {draft.questions.length > 0 && <Panel class="pl-questions" icon="alert" title="Needs your decision" actions={<Badge tone="warn">{draft.questions.length} open question{draft.questions.length === 1 ? '' : 's'}</Badge>}>
        {draft.questions.map((question) => {
          const answer = clarificationAnswers[question.id] ?? ''
          const recommended = Boolean(question.recommendation) && answer.trim() === question.recommendation!.trim()
          const writing = !question.recommendation || ownAnswers[question.id] || (answer.trim() !== '' && !recommended)
          return <article key={question.id} class="pl-question">
            <strong>{question.question}</strong>
            {question.whyItMatters && <p>{question.whyItMatters}</p>}
            {question.recommendation && <div class="pl-recommendation"><Icon name="sparkle" size={16} /><div><strong>Recommendation</strong><span>{question.recommendation}</span></div></div>}
            <div class="pl-question-actions">
              {question.recommendation && (recommended
                ? <Button size="sm" tone="ghost" icon="check" disabled>Recommendation applied</Button>
                : <Button size="sm" tone="primary" onClick={() => { setClarificationAnswers({ ...clarificationAnswers, [question.id]: question.recommendation! }); setOwnAnswers({ ...ownAnswers, [question.id]: false }) }}>Use recommendation</Button>)}
              {question.recommendation && !writing && <Button size="sm" tone="ghost" onClick={() => setOwnAnswers({ ...ownAnswers, [question.id]: true })}>Write my own answer</Button>}
            </div>
            {writing && <Input aria-label={`Your answer: ${question.question}`} value={answer} placeholder={question.recommendation ?? 'Enter your decision'} onInput={(event) => setClarificationAnswers({ ...clarificationAnswers, [question.id]: event.currentTarget.value })} />}
          </article>
        })}
        <footer class="pl-question-foot"><Button size="sm" disabled={busy || !draft.questions.every((question) => question.recommendation)} onClick={() => void continueWithClarifications(true)}>Use all recommendations</Button><Button size="sm" tone="primary" busy={revising} disabled={busy || !draft.questions.every((question) => clarificationAnswers[question.id]?.trim())} onClick={() => void continueWithClarifications()}>Continue planning</Button></footer>
      </Panel>}
      {!planningFailedEmpty && <section class="pl-structure" aria-label="Documentation structure">
        <h2>Review documentation structure</h2>
        <div class="pl-structure-tools">
          <Segmented value={pageFilter} onChange={setPageFilter} items={[['all', 'All pages'], ['changes', 'Changes'], ['create', 'New'], ['update', 'Updated'], ['preserve', 'Unchanged'], ...(counts.remove > 0 ? [['remove', 'Deleted'] as const] : [])] as ReadonlyArray<readonly [PlanPageFilter, string]>} />
          {editable && <Button size="sm" icon="plus" onClick={addPage}>Add page</Button>}
        </div>
        <PlanNavigationEditor
          plan={draft}
          editable={editable}
          onChange={(navigation) => setDraft((current) => ({ ...current, scope: 'custom', navigation }))}
          pageClass={(page) => `plan-tree-page ${page.action} ${page.priority} ${pageMatchesFilter(page) ? '' : 'pl-filtered-out'}`}
          renderPage={pageRowMeta}
          onOpenPage={(page) => setSelectedPageId(page.id)}
          {...(editable ? { onCreatePage: createPage } : {})}
        />
        {pages.some((page) => page.action === 'remove' && pageMatchesFilter(page)) && <div class="pl-removed" role="list" aria-label="Pages to delete">
          <header><Icon name="trash" size={15} /><strong>Pages to delete</strong><span>{pages.filter((page) => page.action === 'remove').length} page{pages.filter((page) => page.action === 'remove').length === 1 ? '' : 's'}</span></header>
          {pages.flatMap((page, index) => page.action === 'remove' && pageMatchesFilter(page) ? [<div key={page.id} class={`pl-removed-row plan-tree-page ${page.action} ${page.priority}`} role="listitem"><button type="button" class="pl-removed-title" title={page.path} onClick={() => setSelectedPageId(page.id)}><strong>{page.title}</strong></button>{pageRowMeta(pages[index]!)}</div>] : [])}
        </div>}
        <small class="pl-structure-hint">Drag pages between sections, or focus a row and use Alt with the arrow keys. Open a page to edit its purpose, priority, and screenshots.</small>
      </section>}
      {!planningFailedEmpty && <Panel class="pl-facts" flush>
        <div class="vrows">
          <div class="vrow">
            <span class="vrow-label">Application screenshots<small>{plannedCaptures > 0 ? `${plannedCaptures} planned across ${visualPages.length} page${visualPages.length === 1 ? '' : 's'}` : 'No application screenshots planned'}{captureReadiness?.status === 'authentication-required' && screenshotIntent !== 'disabled' ? ' · needs sign-in' : ''}</small></span>
            <span class="vrow-value">
              {captureBadge && <Badge tone={captureBadge[0]}>{captureBadge[1]}</Badge>}
              <Select aria-label="Screenshot policy" disabled={!editable} value={screenshotIntent} onChange={(event) => { const screenshots = event.currentTarget.value as 'auto' | 'enabled' | 'disabled'; setDraft({ ...draft, execution: { ...draft.execution, screenshots }, pages: draft.pages.map((page) => !page.visuals || page.visuals.mode === 'none' ? page : { ...page, visuals: { ...page.visuals, mode: screenshots === 'enabled' ? 'required' as const : screenshots === 'auto' ? 'recommended' as const : page.visuals.mode } }) }) }}><option value="auto">Automatic</option><option value="enabled">Require screenshots</option><option value="disabled">No screenshots</option></Select>
            </span>
          </div>
          {screenshotIntent !== 'disabled' && <div class="pl-fact-detail">
            <div class={`plan-capture-readiness pl-readiness ${captureReadiness?.reachable ? 'ready' : 'missing'}`}>
              <Icon name={captureReadiness?.reachable ? 'check' : 'info'} size={15} />
              <span>
                <strong>{captureCheck === 'checking' ? 'Checking the application…' : !captureReadiness ? 'Application check did not complete' : captureReadiness.status === 'authentication-required' ? 'Sign-in may be required during capture' : captureReadiness.reachable ? 'Application reachable' : 'Application setup needed'}</strong>
                <small>{captureReadiness?.message ?? (captureCheck === 'checking' ? 'Confirming the configured application answers before capture.' : 'Doxloop could not reach the readiness check. Start the application, then check again.')}</small>
              </span>
              {captureReadiness?.configured === false
                ? <Button size="sm" onClick={() => setLocation('settings', { section: 'capture' }, 'push')}>Configure application</Button>
                : <Button size="sm" icon="refresh" busy={captureCheck === 'checking'} onClick={() => setCaptureCheckNonce((value) => value + 1)}>Check again</Button>}
            </div>
            {visualPages.length > 0 && <button type="button" class="btn link" aria-expanded={captureDetailsOpen} onClick={() => setCaptureDetailsOpen(!captureDetailsOpen)}>{captureDetailsOpen ? 'Hide planned screenshots' : `Show planned screenshots for ${visualPages.length} page${visualPages.length === 1 ? '' : 's'}`}</button>}
            {captureDetailsOpen && visualPages.length > 0 && <ul class="plan-screenshot-pages">{visualPages.map((page) => <li key={page.id}><span class="plan-screenshot-page-icon"><Icon name="camera" size={14} /></span><span><strong>{page.title}</strong><small>{page.visuals?.startPath ? <code>{page.visuals.startPath}</code> : <em>Starting route needed</em>}{page.visuals?.rationale && <> · {page.visuals.rationale}</>}</small></span><b>{page.visuals?.estimatedCaptures} {screenshotIntent === 'enabled' ? 'required' : (page.visuals?.estimatedCaptures ?? 0) === 1 ? 'candidate' : 'candidates'}</b></li>)}</ul>}
            {screenshotIntent === 'enabled' && visualPages.length === 0 && <Note tone="bad">Required screenshot mode needs at least one visible UI guide. Open a page and choose “Require screenshots,” or change this run to Automatic.</Note>}
            {plan.advisories?.filter((advisory) => !(screenshotCoverage && /procedural pages? ha(s|ve) application screenshots/.test(advisory))).map((advisory) => <Note key={advisory} tone="info">{advisory}</Note>)}
            {capturePlanned && incompleteCapturePages.length > 0 && <Note tone={captureRequired ? 'bad' : 'info'}>{captureRequired ? 'Add' : 'For better automatic capture, add'} a starting route, capture workflow, and one meaningful capture-sequence line per planned screenshot for {incompleteCapturePages.map((page) => page.title).join(', ')}{captureRequired ? ' before approval.' : '. Documentation generation can continue if those optional captures are skipped.'}</Note>}
          </div>}
          <div class="vrow">
            <span class="vrow-label">Batch limits<small>Approval and proposal validation enforce these maxima.</small></span>
            <span class="vrow-value">{limits.maxPages} pages · {limits.maxScreenshots} screenshots · {limits.maxMinutes} minutes per batch{editable && <button type="button" class="pl-icon-btn" aria-label="Edit batch limits" aria-expanded={limitsOpen} onClick={() => setLimitsOpen(!limitsOpen)}><Icon name={limitsOpen ? 'chevronUp' : 'chevronRight'} size={16} /></button>}</span>
          </div>
          {limitsOpen && editable && <div class="pl-fact-detail">
            {(['maxPages', 'maxScreenshots', 'maxMinutes'] as const).map((key) => <Field key={key} label={key === 'maxPages' ? 'Maximum pages' : key === 'maxScreenshots' ? 'Maximum screenshots' : 'Maximum minutes'}><Input disabled={!editable} type="number" min={key === 'maxScreenshots' ? 0 : 1} value={limits[key]} onInput={(event) => setDraft({ ...draft, execution: { ...draft.execution, limits: { ...limits, [key]: Number(event.currentTarget.value) } } })} /></Field>)}
          </div>}
          <div class="vrow">
            <span class="vrow-label">Sources changed since this plan</span>
            <span class="vrow-value">{stale ? 'Sources changed' : 'None'}<Badge tone={stale ? 'warn' : 'good'}>{stale ? 'Review advised' : 'Current'}</Badge></span>
          </div>
          <div class="vrow">
            <span class="vrow-label">Estimated run</span>
            <span class="vrow-value"><RunEstimate pages={counts.pagesToWrite || pages.length} agent={draft.execution.agent} model={draft.execution.model} /></span>
          </div>
        </div>
      </Panel>}
      {plan.existingDocumentation && plan.existingDocumentation.length > 0 && <Panel class="plan-existing-docs-panel" title="Existing documentation audit" description="What the agent found in the documentation being rewritten, and where every existing page lands in this plan.">
        <ExistingDocumentationAudit assessments={plan.existingDocumentation} pages={draft.pages} />
      </Panel>}
      {versionChanges && <Panel class="pl-version" title={`Changed since version ${previousVersion!.version}`} actions={<span class="badge no-dot">Version {plan.version}</span>}>
        <div class="pl-brief-badges">{versionChanges.added.length > 0 && <span class="badge no-dot good">+ {versionChanges.added.length} page{versionChanges.added.length === 1 ? '' : 's'}</span>}{versionChanges.changed.length > 0 && <span class="badge no-dot info">{versionChanges.changed.length} edited</span>}{versionChanges.removed.length > 0 && <span class="badge no-dot bad">− {versionChanges.removed.length} removed</span>}{versionChanges.briefChanged && <span class="badge no-dot">Brief updated</span>}</div>
        <details class="pl-version-details"><summary>See version changes</summary><ul>{versionChanges.added.map((title) => <li key={`add-${title}`}>Added “{title}”</li>)}{versionChanges.changed.map((title) => <li key={`change-${title}`}>Changed “{title}”</li>)}{versionChanges.removed.map((title) => <li key={`remove-${title}`}>Removed “{title}”</li>)}</ul></details>
      </Panel>}
      {screenshotCoverage && coverageDismissed !== coverageKey && <section class="plan-coverage-warning pl-coverage-warning" role="status" aria-label="Screenshot coverage">
        <span class="plan-coverage-warning-icon"><Icon name="camera" size={18} /></span>
        <div>
          <strong>{screenshotCoverage.withScreenshots === 0 ? `None of the ${screenshotCoverage.guides} how-to guides has a planned screenshot.` : `Only ${screenshotCoverage.withScreenshots} of ${screenshotCoverage.guides} how-to guides have a planned screenshot.`}{screenshotCoverage.explained > 0 ? (screenshotCoverage.explained === screenshotCoverage.guides - screenshotCoverage.withScreenshots ? ' The planner gave a reason for every text-only guide; open a page to read it.' : ` The planner gave a reason for ${screenshotCoverage.explained} text-only guide${screenshotCoverage.explained === 1 ? '' : 's'}; open a page to read it.`) : ''}</strong>
          <p>{screenshotCoverage.reason === 'sign-in'
            ? 'Doxloop could not get past the sign-in page of your app. Sign in under Settings → Screenshots, then ask the agent to update the plan.'
            : screenshotCoverage.reason === 'unreachable'
              ? 'Doxloop could not reach your app while planning. Start it and check Settings → Screenshots, then ask the agent to update the plan.'
              : 'Your app is reachable, so the plan can include more. Ask the agent to add screenshots to the guides that walk through the app.'}</p>
        </div>
        <div class="plan-coverage-warning-actions">
          {screenshotCoverage.reason === 'unknown'
            ? <Button icon="sparkle" onClick={() => { setRevision('Add screenshots to every guide that walks through the app, with one screenshot for each step that changes the screen.'); revisionInput.current?.focus() }}>Ask for more screenshots</Button>
            : <Button icon={screenshotCoverage.reason === 'sign-in' ? 'key' : 'settings'} onClick={() => setLocation('settings', { section: 'capture' }, 'push')}>{screenshotCoverage.reason === 'sign-in' ? 'Sign in to your app' : 'Open screenshot settings'}</Button>}
          <Button tone="ghost" onClick={() => setCoverageDismissed(coverageKey)}>Continue without</Button>
        </div>
      </section>}
      <div class="plan-revision-panel pl-revise">
        <span class="pl-revise-icon"><Icon name="sparkle" size={16} /></span>
        <Textarea ref={revisionInput} aria-label="Want to change the plan?" disabled={busy} rows={1} maxlength={1500} value={revision} placeholder="Want to change the plan? Tell the agent what to revise…" onInput={(event) => setRevision(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void revise() } }} />
        <Button disabled={!revision.trim() || busy || changed} busy={revising} onClick={() => void revise()}>Send</Button>
      </div>
      {changed && <small class="pl-revise-hint">Save your direct edits before asking the agent to revise the plan.</small>}
      {selectedPage && <div class="plan-page-drawer-backdrop" onMouseDown={(event) => { if (event.currentTarget === event.target) setSelectedPageId(undefined) }}>
        <aside class="plan-page-drawer pl-drawer" role="dialog" aria-modal="true" aria-labelledby="plan-page-drawer-title">
          <header><div><span class="kicker">Page {selectedIndex + 1} of {pages.length}</span><h2 id="plan-page-drawer-title">Page details</h2></div><button type="button" aria-label="Close page details" onClick={() => setSelectedPageId(undefined)}><Icon name="close" size={18} /></button></header>
          <div class="plan-page-drawer-body">
            <div class="plan-page-drawer-name"><Input disabled={!editable} value={selectedPage.title} aria-label="Page title" onInput={(event) => setPage(selectedIndex, { ...selectedPage, title: event.currentTarget.value })} /><span class={`badge no-dot ${actionTone(selectedPage.action)}`}>{planActionLabel(selectedPage.action)}</span></div>
            <Field label="Purpose"><Textarea disabled={!editable} rows={4} value={selectedPage.purpose} onInput={(event) => setPage(selectedIndex, { ...selectedPage, purpose: event.currentTarget.value })} /></Field>
            <Field label="What should happen"><Select disabled={!editable} value={selectedPage.action} onChange={(event) => setPage(selectedIndex, { ...selectedPage, action: event.currentTarget.value as DocumentationPlanPage['action'] })}><option value="create">Create this page</option><option value="update">Update this page</option><option value="preserve">Leave unchanged</option><option value="remove">Delete existing page</option></Select></Field>
            <Field label="Priority in this generation"><Select disabled={!editable} value={selectedPage.priority} onChange={(event) => setPage(selectedIndex, { ...selectedPage, priority: event.currentTarget.value as DocumentationPlanPage['priority'] })}><option value="must-have">Essential</option><option value="next">Recommended</option></Select></Field>
            <Field label="Documentation section" hint="The page type the generator files this page under, such as how-to or reference."><Input disabled={!editable} value={selectedPage.type} onInput={(event) => setPage(selectedIndex, { ...selectedPage, type: event.currentTarget.value })} /></Field>
            <Field label="Diagram" hint="Concept pages default to a required Mermaid diagram; the writer must include one and the editor previews it."><Select disabled={!editable} value={selectedPage.diagram ?? (selectedPage.type === 'concept' ? 'required' : 'none')} onChange={(event) => setPage(selectedIndex, { ...selectedPage, diagram: event.currentTarget.value === 'required' ? 'required' : 'none' })}><option value="required">Required</option><option value="none">Not needed</option></Select></Field>
            <section class="plan-page-visuals pl-drawer-section">
              <h3>Application screenshots</h3>
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
                  ...(mode !== 'none' && selectedPage.visuals?.captureSequence ? { captureSequence: selectedPage.visuals.captureSequence, captureIds: selectedPage.visuals.captureIds } : {}),
                } })
              }}><option value="none">Text only</option><option value="recommended">Capture when ready</option><option value="required">Require screenshots</option></Select></Field>
              <Field label={selectedPage.visuals?.mode === 'required' || screenshotIntent === 'enabled' ? 'Required captures' : 'Planned captures'}><Input disabled={!editable || screenshotIntent === 'disabled' || (selectedPage.visuals?.mode ?? 'none') === 'none'} type="number" min={minimumUiPlannedCaptures(selectedPage.type, selectedPage.visuals?.mode ?? 'recommended')} max="20" value={selectedPage.visuals?.estimatedCaptures ?? 0} onInput={(event) => { const mode = selectedPage.visuals?.mode ?? 'recommended'; setPage(selectedIndex, { ...selectedPage, visuals: { ...selectedPage.visuals, mode, rationale: selectedPage.visuals?.rationale ?? '', estimatedCaptures: Math.max(minimumUiPlannedCaptures(selectedPage.type, mode), Math.min(20, Number(event.currentTarget.value) || 1)) } }) }} /></Field>
              <Field label="Starting route" hint="Relative to the configured application URL"><Input disabled={!editable || screenshotIntent === 'disabled' || (selectedPage.visuals?.mode ?? 'none') === 'none'} value={selectedPage.visuals?.startPath ?? ''} placeholder="/settings/team" onInput={(event) => setPage(selectedIndex, { ...selectedPage, visuals: { ...selectedPage.visuals, mode: selectedPage.visuals?.mode ?? 'recommended', rationale: selectedPage.visuals?.rationale ?? '', estimatedCaptures: Math.max(1, selectedPage.visuals?.estimatedCaptures ?? 1), startPath: event.currentTarget.value, captureIds: [] } })} /></Field>
              <Field label="Capture workflow" hint="Include the safe test state and ordered actions"><Textarea disabled={!editable || screenshotIntent === 'disabled' || (selectedPage.visuals?.mode ?? 'none') === 'none'} rows={4} value={selectedPage.visuals?.workflow ?? ''} placeholder="Use the demo workspace. Open Team settings, invite a synthetic member, and verify the invitation state." onInput={(event) => setPage(selectedIndex, { ...selectedPage, visuals: { ...selectedPage.visuals, mode: selectedPage.visuals?.mode ?? 'recommended', rationale: selectedPage.visuals?.rationale ?? '', estimatedCaptures: Math.max(1, selectedPage.visuals?.estimatedCaptures ?? 1), workflow: event.currentTarget.value, captureIds: [] } })} /></Field>
              <Field label="Capture sequence" hint="One screenshot per line: action — visible state — why it helps"><Textarea disabled={!editable || screenshotIntent === 'disabled' || (selectedPage.visuals?.mode ?? 'none') === 'none'} rows={Math.max(4, Math.min(8, selectedPage.visuals?.estimatedCaptures ?? 4))} value={(selectedPage.visuals?.captureSequence ?? []).join('\n')} placeholder={'Open Team settings — Team settings heading and navigation are visible — orients the reader\nSelect Invite member — the empty invitation form is open — confirms where data is entered\nSubmit the demo invitation — success confirmation is visible — proves completion'} onInput={(event) => { const captureSequence = event.currentTarget.value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean); const mode = selectedPage.visuals?.mode ?? 'recommended'; setPage(selectedIndex, { ...selectedPage, visuals: { ...selectedPage.visuals, mode, rationale: selectedPage.visuals?.rationale ?? '', estimatedCaptures: Math.max(minimumUiPlannedCaptures(selectedPage.type, mode), captureSequence.length), captureSequence, captureIds: captureSequence.map((item) => { const index = selectedPage.visuals?.captureSequence?.indexOf(item) ?? -1; return index >= 0 ? selectedPage.visuals?.captureIds?.[index] ?? '' : '' }) } }) }} /></Field>
              <Field label="Why images help"><Textarea disabled={!editable || screenshotIntent === 'disabled' || (selectedPage.visuals?.mode ?? 'none') === 'none'} rows={3} value={selectedPage.visuals?.rationale ?? ''} placeholder="Show the complete invitation journey so readers can verify each meaningful state." onInput={(event) => setPage(selectedIndex, { ...selectedPage, visuals: { ...selectedPage.visuals, mode: selectedPage.visuals?.mode ?? 'recommended', estimatedCaptures: Math.max(1, selectedPage.visuals?.estimatedCaptures ?? 1), rationale: event.currentTarget.value } })} /></Field>
            </section>
            <section class="plan-page-reason pl-drawer-reason"><h3>Why the agent recommends this page</h3><p>{selectedPage.rationale || 'No rationale was provided for this page.'}</p>{selectedPage.evidenceDetails.length > 0 ? <details><summary>View {selectedPage.evidenceDetails.length} supporting source{selectedPage.evidenceDetails.length === 1 ? '' : 's'}</summary><div class="plan-evidence-list">{selectedPage.evidenceDetails.map((item, index) => <article key={`${item.source}-${item.path}-${index}`}><span>{item.source}</span><div><code>{item.path}{item.line ? `:${item.line}` : ''}</code>{(item.label || item.kind) && <small>{item.label ?? item.kind}</small>}</div></article>)}</div></details> : selectedPage.evidence.length > 0 && <details><summary>View {selectedPage.evidence.length} supporting source{selectedPage.evidence.length === 1 ? '' : 's'}</summary><ul>{selectedPage.evidence.map((item) => <li key={item}><code>{item}</code></li>)}</ul></details>}</section>
            <details class="plan-page-advanced pl-drawer-advanced"><summary>Advanced settings</summary><div><Field label="File path" hint="Used by the generator to place the file."><Input disabled={!editable} class="mono" value={selectedPage.path} onInput={(event) => setPage(selectedIndex, { ...selectedPage, path: event.currentTarget.value })} /></Field></div></details>
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

function minimumUiPlannedCaptures(_type: string, mode: 'none' | 'recommended' | 'required'): number {
  if (mode === 'none') return 0
  return 1
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

/** Jobs that hold the project's authoring lock, so a source check started now would only be skipped. */
export function authoringJobRunning(jobs: UiJob[]): boolean {
  return jobs.some((job) => job.status === 'running' && (
    job.type.startsWith('page-edit:') || job.type === 'plan:generate' || job.type === 'plan:continue' ||
    job.type.startsWith('proposal:revise:') || job.type.startsWith('proposal:resume:')))
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
    case 'current': return { tone: 'good', title: 'Sources checked · docs are current', detail: outcome.message }
    case 'stale': return { tone: 'warn', title: stale, detail: outcome.message }
    case 'proposal': return { tone: 'good', title: outcome.proposalId ? 'Proposal ready for review' : stale, detail: outcome.message, ...(outcome.proposalId ? { proposalId: outcome.proposalId } : {}) }
    // No page count means the check never ran (another task held the project);
    // a count of zero means nothing was held back.
    case 'skipped':
      if (outcome.pages === undefined) return { tone: 'info', title: 'Source check postponed', detail: 'Another task is running for this project. Choose Check now again when it finishes.' }
      return pages === 0
        ? { tone: 'good', title: 'Sources checked · docs are current', detail: 'No page depends on a changed source file.' }
        : { tone: 'warn', title: `${stale} · update skipped`, detail: outcome.message }
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
  const lines = job.lines.map((line) => stripAnsi(stripJobLineStamp(line))).reverse()
  // A rejected token is the most common deploy failure; name the fix, not the HTTP status.
  if (lines.some(isSignInFailure)) return 'Doxbrix did not accept the saved sign-in. Sign in again from Publish.'
  const reported = lines.find((line) => line.startsWith('doxloop: '))
  const line = reported ?? lines.find((candidate) => candidate.trim() && !candidate.startsWith('DOXLOOP_EVENT '))
  return line?.replace(/^doxloop: /, '').trim() || undefined
}

/** The status half of a Recent activity sentence ("… completed successfully"). */
export function jobActivityText(job: Pick<UiJob, 'lines' | 'status' | 'type' | 'outcome'>): string {
  if (job.status === 'running') return ' is running'
  if (job.status === 'succeeded') return ' completed successfully'
  // A check that could not take the project lock never ran; it did not fail.
  if (job.type === 'sync' && job.outcome?.status === 'skipped' && job.outcome.pages === undefined) return ' was postponed because another task was running'
  if (job.status === 'failed') {
    const reason = jobFailureReason(job)
    return ` needs attention${reason ? `: ${reason}` : ''}`
  }
  return ` was ${job.status}`
}

/**
 * A plain time and token figure for a run of this size: observed history when
 * there is enough of it, a typical-run rate otherwise.
 */
function RunEstimate({ pages, agent, model }: { pages: number; agent?: string | undefined; model?: string | undefined }) {
  const [observed, setObserved] = useState<ServerRunEstimate>()
  useEffect(() => {
    let current = true
    setObserved(undefined)
    void api<ServerRunEstimate>(`/api/authoring-estimate?pages=${pages}&agent=${encodeURIComponent(agent ?? '')}&model=${encodeURIComponent(model ?? '')}`)
      .then((value) => { if (current && typeof value?.samples === 'number') setObserved(value) })
      .catch(() => undefined)
    return () => { current = false }
  }, [pages, agent, model])
  return <p class="run-estimate"><Icon name="clock" size={14} /><span>{runEstimateText(pages, observed)}</span></p>
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
function CaptureGallery({ live, run, plan }: { live: boolean; run?: string; plan?: string | undefined }) {
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
        const result = await api<{ captures: RunCapture[] }>(plan ? `/api/captures?plan=${encodeURIComponent(plan)}` : run ? `/api/captures?run=${encodeURIComponent(run)}` : '/api/captures')
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
  }, [live, run, plan])

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
          {!live && !plan && <button type="button" class="capture-replace" onClick={() => { setReplacing(capture); replaceInput.current?.click() }}><Icon name="refresh" size={12} />Replace screenshot</button>}
        </figcaption>
      </figure>)}
    </div>
  </div>
}

/** Overall progress of a job from its stages, or undefined when there is nothing to measure yet. */
/**
 * Stages are announced as a run reaches them, so the total is unknown up
 * front and a stage-count percentage jumps backwards. Only a stage that
 * reports its own counts ("2 of 5 sessions") gives a real percentage;
 * otherwise the bar is indeterminate (undefined here, `null` = no bar).
 */
function jobProgressPercent(job: Pick<UiJob, 'status' | 'stages'>): number | undefined | null {
  if (job.status === 'succeeded') return 100
  if (job.status !== 'running') return null
  const counted = [...job.stages].reverse().find((stage) => stage.status === 'running' && stage.progress?.total)
  if (counted?.progress?.total) return Math.min(100, Math.round((counted.progress.done / counted.progress.total) * 100))
  return undefined
}

function elapsedText(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  if (seconds < 60) return `${seconds} s`
  const minutes = Math.floor(seconds / 60)
  return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`
}

/** The trailing detail on a stage row: a counter when the stage reports one, otherwise its timing. */
function stageDetailText(stage: UiJob['stages'][number]): string {
  if (stage.progress && (stage.progress.total !== undefined || stage.progress.done > 0)) return stage.progress.total !== undefined ? `${stage.progress.done} of ${stage.progress.total}` : String(stage.progress.done)
  const started = stage.startedAt ? Date.parse(stage.startedAt) : Number.NaN
  if (Number.isNaN(started)) return ''
  if (stage.status === 'running') return `running for ${elapsedText(Date.now() - started)}`
  const finished = stage.finishedAt ? Date.parse(stage.finishedAt) : Number.NaN
  return Number.isNaN(finished) ? '' : elapsedText(finished - started)
}

function AuthoringLiveLog({ job, act, stopLabel = 'Stop update', hideStop = false }: { job: UiJob; act: Action; stopLabel?: string; hideStop?: boolean }) {
  const log = useRef<HTMLPreElement>(null)
  const agent = job.agent ? agentLabel(job.agent) : 'Agent'
  const [tab, setTab] = useState<'log' | 'captures'>('log')
  const percent = jobProgressPercent(job)
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [job.lines.length, tab])
  return <div class="authoring-live-log pl-livelog">
    {percent !== null && <div class={`pl-live-progress ${job.status}`}><div class={`progress ${job.status === 'succeeded' ? 'good' : 'info'} ${percent === undefined ? 'indeterminate' : ''}`} role="progressbar" aria-label="Run progress" {...(percent === undefined ? {} : { 'aria-valuenow': percent, 'aria-valuemin': 0, 'aria-valuemax': 100 })}><i style={percent === undefined ? undefined : `width:${percent}%`} /></div>{percent !== undefined && <span>{percent}%</span>}</div>}
    {job.stages.length > 0 && <ol class="workflow-stages pl-stages" aria-label="Documentation workflow stages">
      {job.stages.map((stage) => <li class={stage.status} key={stage.id}><span class="pl-stage-mark">{stage.status === 'completed' ? <Icon name="check" size={12} /> : stage.status === 'failed' ? <Icon name="alert" size={12} /> : stage.status === 'running' ? <i /> : null}</span><strong>{stage.label}</strong><small>{stageDetailText(stage)}</small></li>)}
    </ol>}
    {(() => {
      const activity = summarizeRunActivity(job.lines)
      if (!activity.sessions.length && !activity.screenshots && !activity.sourceReads) return null
      return <div class="pl-activity-summary" aria-live="polite">
        {activity.latestNote && <p><strong>{activity.latestNote.session}</strong><span>{activity.latestNote.text.length > 240 ? `${activity.latestNote.text.slice(0, 237)}…` : activity.latestNote.text}</span></p>}
        <ul>
          {activity.sessions.length > 0 && <li><Icon name="bot" size={14} />{activity.sessions.join(' · ')}</li>}
          <li><Icon name="camera" size={14} />{activity.screenshots} screenshot{activity.screenshots === 1 ? '' : 's'} captured</li>
          <li><Icon name="file" size={14} />{activity.sourceReads} source read{activity.sourceReads === 1 ? '' : 's'}</li>
        </ul>
      </div>
    })()}
    <div class="pl-log">
      <div class="live-job-meta pl-log-meta" aria-live="polite">
        <span><Icon name="bot" size={14} />{agent}</span>
        <span><Icon name="clock" size={14} />Last output {timeText(job.lastOutputAt ?? job.startedAt)}</span>
        <span class="authoring-live-actions">
          <Segmented value={tab} onChange={setTab} items={[['log', 'Log'], ['captures', 'Screenshots']] as const} />
          {job.status === 'running' && !hideStop && <Button size="sm" tone="danger" icon="stop" onClick={() => void act(() => post(`/api/jobs/${job.id}/cancel`), 'Update stopped')}>{stopLabel}</Button>}
          {job.status !== 'running' && job.retryable && <Button size="sm" icon="refresh" onClick={() => void act(() => post(`/api/jobs/${job.id}/retry`), 'Workflow restarted')}>Retry stage</Button>}
        </span>
      </div>
      {tab === 'log'
        ? <pre ref={log} class="terminal live-terminal pl-log-lines" aria-live="polite">{job.lines.length > 0 ? displayLogLines(job.lines).join('\n') : `Starting ${agent}…`}</pre>
        : <div class="pl-log-captures"><CaptureGallery live={job.status === 'running'} plan={job.type === 'plan:propose' || job.type === 'plan:revise' ? job.planId : undefined} /></div>}
      <div class="pl-log-foot"><a class="btn link" href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer">Open full log <Icon name="arrowRight" size={14} /></a></div>
    </div>
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
  const [focusLine, setFocusLine] = useState(Number(initial.get('line')) || 0)
  useEffect(() => { let current = true; if (!query) { setMatches([]); return } api<typeof matches>(`/api/pages/search?q=${encodeURIComponent(query)}`).then((value) => { if (current) setMatches(value) }).catch((cause) => { if (current) onError(cause.message) }); return () => { current = false } }, [query, state.runs])
  const [selectedPaths, setSelectedPaths] = useState<string[]>(() => initial.get('path') ? [initial.get('path')!] : [])
  const [runId, setRunId] = useState(initial.get('run') ?? '')
  // Navigation and validation name pages by slug ("glossary"); the page list
  // names files ("glossary.mdx"). Resolve a slug to its file once pages load.
  useEffect(() => {
    if (pages.length === 0) return
    const known = new Set(pages.map((page) => page.path))
    const resolved = selectedPaths.map((path) => known.has(path) ? path
      : [`${path}.mdx`, `${path}.md`, `${path}/index.mdx`, `${path}/index.md`].find((candidate) => known.has(candidate)) ?? path)
    if (resolved.some((path, index) => path !== selectedPaths[index])) setSelectedPaths(resolved)
  }, [pages, selectedPaths])
  const [instruction, setInstruction] = useState('')
  const [allowRelated, setAllowRelated] = useState(false)
  const [screenshots, setScreenshots] = useState(false)
  const defaultAgent = state.project?.defaultAgent ?? ''
  const initialModel = state.project?.defaultModel || defaultModelForAgent(defaultAgent)
  const initialReasoning = preferredReasoningLevel(defaultAgent, initialModel)
  const [agent, setAgent] = useState(defaultAgent)
  const [model, setModel] = useState(initialModel)
  const [reasoning, setReasoning] = useState(defaultAgent === 'codex' ? initialReasoning : '')
  const [effort, setEffort] = useState(defaultAgent === 'claude' ? initialReasoning : '')
  const [agentOpen, setAgentOpen] = useState(false)
  const [agentPanelOpen, setAgentPanelOpen] = useState(Boolean(initial.get('run')))
  // Opening the agent panel moves the reader to it and puts the cursor in the
  // instruction box; it opens at the foot of a long page otherwise.
  useEffect(() => {
    if (!agentPanelOpen) return
    requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLElement>('.page-agent-panel')
      panel?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      panel?.querySelector<HTMLInputElement | HTMLTextAreaElement>('input:not([type=checkbox]), textarea')?.focus({ preventScroll: true })
    })
  }, [agentPanelOpen])
  const [editingContent, setEditingContent] = useState(Boolean(initial.get('edit') || initial.get('line')))
  // The editor's Content / Source mode is lifted here so the tab row above the
  // page can show and switch it; the editor keeps its own default rules.
  const nativeEditor = state.project?.generator === 'doxbrix'
  const [editorMode, setEditorMode] = useState<'visual' | 'source'>(nativeEditor && !focusLine ? 'visual' : 'source')
  const [contentDirty, setContentDirty] = useState(false)
  const [contentBusy, setContentBusy] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [pageOptionsOpen, setPageOptionsOpen] = useState(false)
  const [pageListOpen, setPageListOpen] = useState(false)
  const navigationOpen = true
  const [navigationDirty, setNavigationDirty] = useState(false)
  const [navigationBusy, setNavigationBusy] = useState(false)
  const canLeaveNavigation = () => {
    if (!navigationDirty && !navigationBusy) return true
    onError('Save or discard your navigation changes before leaving the navigation editor.')
    return false
  }
  const contentLocked = contentDirty || contentBusy
  const canLeaveContent = () => {
    if (!contentLocked) return true
    onError('Save or discard your content edits before changing pages or starting an agent edit.')
    return false
  }

  const [submitting, setSubmitting] = useState(false)
  const [reviewView, setReviewView] = useState<'rendered' | 'source'>('rendered')
  const [reviewLayout, setReviewLayout] = useState<'split' | 'unified'>('unified')
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
  const nativePreview = useRef<HTMLIFrameElement>(null)

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
  const needsReview = pages.filter((page) => page.evidence === 'needs-review').length
  const proposalPaths = proposal?.editRequest?.paths ?? []
  const viewingProposalPage = Boolean(activePage && proposalPaths.includes(activePage.path))
  const otherPageWhileRunning = Boolean(activeJob && activePage && !activePaths.includes(activePage.path))
  const reviewable = Boolean(proposal && !activeJob && ['awaiting-review', 'conflicted'].includes(proposal.status))
  const failed = Boolean(proposal && !activeJob && proposal.status === 'failed')
  const pendingElsewhere = editRuns.filter((run) => run.status === 'awaiting-review' && run.id !== proposal?.id)
  const validationErrors = proposal?.validation?.errors ?? 0
  const instructionReady = instruction.trim().length >= MIN_EDIT_INSTRUCTION
  const composerLabel = selected.length > 1 ? `What should change on these ${selected.length} pages?` : 'What should change on this page?'

  useEffect(() => { if (activeJob || reviewable || failed) setAgentPanelOpen(true) }, [activeJob?.id, reviewable, failed])
  useEffect(() => { setContentDirty(false); setContentBusy(false); setPageOptionsOpen(false); setEditorMode(nativeEditor && !focusLine ? 'visual' : 'source') }, [activePage?.path])
  useEffect(() => {
    const guard = (event: Event) => { if (contentLocked || navigationDirty || navigationBusy) { event.preventDefault(); if (!canLeaveContent()) return; canLeaveNavigation() } }
    addEventListener('doxloop:before-navigation', guard)
    return () => removeEventListener('doxloop:before-navigation', guard)
  }, [contentLocked, navigationDirty, navigationBusy])

  const [pagesError, setPagesError] = useState('')
  // The page list is small and fast; a request that stalls behind a busy
  // server is retried once, then shown as an error with a Retry button
  // instead of a spinner that never ends.
  const refreshPages = async (attempt = 0): Promise<void> => {
    try {
      setPages(await api<PageSummary[]>('/api/pages', { signal: AbortSignal.timeout(20_000) }))
      setPagesError('')
    } catch (cause) {
      if (attempt === 0) { await new Promise((resolve) => setTimeout(resolve, 1500)); return await refreshPages(1) }
      setPagesError(message(cause))
    }
    setLoadingPages(false)
  }
  useEffect(() => { void refreshPages() }, [])
  useEffect(() => {
    const syncUrl = () => {
      const params = new URLSearchParams(location.search)
      if (contentLocked || navigationDirty || navigationBusy) {
        updateUrl(selectedPaths, runId)
        if (canLeaveContent()) canLeaveNavigation()
        return
      }
      setRunId(params.get('run') ?? '')
      setViewState(pagesViewFrom(params.get('view')))
      const nextPath = params.get('path')
      if (nextPath) setSelectedPaths([nextPath])
    }
    addEventListener('popstate', syncUrl)
    return () => removeEventListener('popstate', syncUrl)
  }, [contentLocked, navigationDirty, navigationBusy, navigationOpen, view, selectedPaths, runId])
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
    if (!canLeaveContent() || !canLeaveNavigation()) return
    setViewState(next)
    updateUrl(selectedPaths, proposal && selectedPaths[0] && proposalPaths.includes(selectedPaths[0]) ? proposal.id : '', next)
  }
  const leaveProposal = () => {
    setRunId('')
    setRefining(false)
    setRefinement('')
  }
  const chooseSingle = (path: string) => {
    if (!canLeaveContent()) return
    setFocusLine(0); setEditingContent(false)
    setSelectedPaths([path])
    setHistoryEntries(null)
    updateUrl([path], proposal && proposalPaths.includes(path) ? proposal.id : '')
  }
  useEffect(() => {
    const navigatePreview = (event: MessageEvent) => {
      if (!previewUrl || event.source !== nativePreview.current?.contentWindow || event.origin !== new URL(previewUrl).origin || event.data?.type !== 'doxloop:preview-navigate' || typeof event.data.href !== 'string') return
      try {
        const href = new URL(event.data.href)
        if (href.origin !== new URL(previewUrl).origin) return
        const route = (value: string) => decodeURIComponent(value).replace(/\.(md|mdx)$/, '').replace(/\/$/, '') || '/'
        const page = pages.find(item => route(item.route) === route(href.pathname))
        if (page) chooseSingle(page.path)
        else onError('This link is outside the documentation page list. Open it in the full site preview.')
      } catch { /* Ignore malformed messages from preview content. */ }
    }
    addEventListener('message', navigatePreview)
    return () => removeEventListener('message', navigatePreview)
  }, [previewUrl, pages, contentLocked, proposal?.id])
  const togglePath = (path: string) => {
    if (!canLeaveContent()) return
    setFocusLine(0); setEditingContent(false)
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
    if (request.length < MIN_EDIT_INSTRUCTION || paths.length === 0 || activeJob || !canLeaveContent()) return
    setEditingContent(false); setAgentPanelOpen(true)
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
    if (!canLeaveContent()) return
    setEditingContent(false); setAgentPanelOpen(true)
    const paths = run.editRequest?.paths ?? []
    setRunId(run.id)
    if (paths[0]) setSelectedPaths(paths)
    setHistoryEntries(null)
    updateUrl(paths, run.id)
  }
  const focusComposer = () => { setAgentPanelOpen(true); requestAnimationFrame(() => textarea.current?.focus()) }

  const previewFrame = (page: PageSummary) => <div class="current-page-preview">

    {previewState === 'ready' && previewUrl
      ? <iframe ref={nativePreview} key={`${page.path}:${previewNonce}`} title="Current page preview" src={`${previewUrl}${page.route}?embed=page&workspace=1`} />
      : <div class="preview-placeholder">
        {previewState === 'failed'
          ? <><Icon name="alert" size={18} /><strong>The preview could not start</strong><Button size="sm" onClick={() => setPreviewState('idle')}>Try again</Button></>
          : <><span class="spinner" /><strong>Preview is starting…</strong></>}
      </div>}
  </div>

  const reviewingHere = Boolean(!activeJob && reviewable && proposal && viewingProposalPage)
  return <div class={`pages-page preview-first-pages ${agentPanelOpen ? 'agent-panel-open' : ''} ${pageListOpen || !activePage ? 'page-list-open' : ''} navigation-open ${reviewingHere ? 'reviewing' : ''} ${activeJob ? 'running' : ''}`}>
    {rationale && <ProposalRationaleDrawer change={rationale} onClose={() => setRationale(null)} />}
    {assetPicker && <AssetPicker act={act} title="Insert an image" onClose={() => setAssetPicker(false)} onPick={(asset) => { setAssetPicker(false); insertIntent(`Insert the image ${asset.publicPath} with descriptive alt text where it best supports the text.`) }} />}
    {toast && <div class="page-updated-toast" role="status">
      <span class="toast-icon"><Icon name="check" size={15} /></span>
      <span class="toast-copy"><strong>Page updated</strong><small>{(toast.editRequest?.paths ?? []).map(titleFor).join(', ') || 'The change was written to the project.'}</small></span>
      <Button size="sm" onClick={() => void undo(toast)}>Undo</Button>
      <button type="button" class="toast-close" aria-label="Dismiss" onClick={() => setToast(null)}><Icon name="close" size={14} /></button>
    </div>}
    <PageHeader kicker="Docs" title="Docs" actions={<div class="pages-view-actions"><Segmented value={view} onChange={setView} items={[['pages', 'Pages'], ['assets', 'Images & files']] as const} /><Button icon="settings" disabled={contentBusy} aria-pressed={toolsOpen} onClick={() => { if (canLeaveContent() && canLeaveNavigation()) setToolsOpen(!toolsOpen) }}>Workspace tools</Button></div>} />
    {toolsOpen && <section class="pages-workspace-tools" aria-label="Workspace tools">
    {view === 'pages' && <PageTools root={state.root ?? state.cwd} contentDir={state.project?.contentDir ?? ''} {...(activePage ? { path: activePage.path } : {})} onChanged={async (path) => { const next = await api<PageSummary[]>('/api/pages'); setPages(next); const selected = path ?? next.find((page) => page.path === activePage?.path)?.path ?? next[0]?.path; setSelectedPaths(selected ? [selected] : []); updateUrl(selected ? [selected] : []); setPreviewNonce((value) => value + 1); await act(async () => true) }} />}
    <Collections onChanged={async () => { await refreshPages(); await act(async () => true) }} onTranslate={async (paths, locale) => { await submit({ paths, instruction: `Translate these documentation pages to ${locale}. Preserve code, API names, navigation routes, source associations, and links. Re-verify factual claims. Change only the selected translation pages.`, allowRelated: false }) }} />
    <AuditTools onChanged={async () => { await refreshPages(); await act(async () => true) }} />
    </section>}
    {view === 'pages' && selectedPaths.length > 1 && <BulkMetadata paths={selectedPaths} onChanged={async () => { await refreshPages(); setPreviewNonce((value) => value + 1); await act(async () => true) }} />}
    {view === 'assets' && <AssetLibrary act={act} onError={onError} onChanged={() => { setPreviewNonce((value) => value + 1); void refreshPages() }} />}
    {view === 'pages' && <div class="pages-workbench">
      <aside class="page-list-panel" aria-label={navigationOpen ? 'Edit site navigation' : 'Page browser'}>
        <label class="page-search">
          <span class="sr-only">Search pages</span>
          <Icon name="search" size={16} />
          <Input type="search" value={search} placeholder="Search titles, paths, or page text" onInput={(event) => setSearch(event.currentTarget.value)} />
        </label>
        <div hidden={Boolean(search.trim() || collectionFilter)}><NavigationView act={act} onError={onError} embedded pages={pages} refreshToken={previewNonce} selectedPaths={selectedPaths} onTogglePage={togglePath} onStatus={(dirty, saving) => { setNavigationDirty(dirty); setNavigationBusy(saving) }} onSaved={async () => { await refreshPages(); if (!contentLocked) setPreviewNonce(value => value + 1) }} onSelectPage={chooseSingle} {...(activePage ? { activePath: activePage.path } : {})} /></div>
        {[...new Set(pages.map((page) => `${page.version ?? 'current'} / ${page.locale ?? 'default'}`))].length > 1 && <label>Version / locale<select aria-label="Version / locale" value={collectionFilter} onChange={(event) => setCollectionFilter(event.currentTarget.value)}><option value="">All versions and languages</option>{[...new Set(pages.map((page) => `${page.version ?? 'current'} / ${page.locale ?? 'default'}`))].map((label) => <option>{label}</option>)}</select></label>}

        {matches.length > 0 && <details open><summary>{matches.length} text matches{matches.length === 200 ? ' (first 200)' : ''}</summary><ul class="page-text-matches">{matches.map((match) => <li><button onClick={() => { if (!canLeaveContent()) return; chooseSingle(match.path); setFocusLine(match.line); setEditingContent(true) }}><strong>{match.section} · line {match.line}</strong><small>{match.excerpt}</small></button></li>)}</ul></details>}
        {Boolean(search.trim() || collectionFilter) && <>
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
                      aria-disabled={contentBusy}
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
                        <input type="checkbox" aria-label={`Select ${page.title}`} disabled={contentBusy} checked={checked} onChange={() => togglePath(page.path)} />
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
        </>}
        {pagesError && <Note tone="bad"><span>The page list did not load: {pagesError}</span><Button size="sm" onClick={() => { setLoadingPages(true); setPagesError(''); void refreshPages(1) }}>Retry</Button></Note>}
        <div class="page-list-foot">
          <span>{loadingPages ? 'Loading pages…' : `${pages.length} page${pages.length === 1 ? '' : 's'}${needsReview > 0 ? ` · ${needsReview} need${needsReview === 1 ? 's' : ''} review` : ''}`}</span>
          <Button tone="link" aria-label="Open images &amp; files" onClick={() => setView('assets')}>Images &amp; files</Button>
        </div>
      </aside>

      <section class="page-detail-pane">
        {!activePage ? <div class="page-detail-empty"><Empty icon="file" title="Choose a page" detail="Select a page to preview it, edit its content, or ask the agent." /></div> : <>
          <header class="page-detail-header">
            <div class="page-detail-copy">
              <Button size="sm" icon="menu" class="page-outline-toggle" onClick={() => setPageListOpen(!pageListOpen)}>Pages</Button>
              <div class="page-detail-title"><h2>{activePage.title}</h2><Badge tone={PAGE_EVIDENCE[activePage.evidence][1]}>{PAGE_EVIDENCE[activePage.evidence][0]}</Badge></div>
              <code class="page-detail-path">{activePage.path}</code>
            </div>
            <div class="page-detail-actions">
              <Button size="sm" tone="ghost" icon="clock" aria-pressed={Boolean(historyEntries)} onClick={() => void openHistory()}>History</Button>
              <Button size="sm" icon="external" onClick={() => void openInPreview(activePage.route)}>Open in preview</Button>
              <button type="button" class={`page-agent-toggle ${agentPanelOpen ? 'active' : ''}`} aria-label="Instruct agent" title="Instruct agent" aria-expanded={agentPanelOpen} onClick={() => setAgentPanelOpen(!agentPanelOpen)}><Icon name="sparkles" size={14} />Instruct agent{(activeJob || reviewable) && <i />}</button>
              <button type="button" class="page-options-toggle" disabled={contentBusy} aria-label="Page options" title="Page options" aria-expanded={pageOptionsOpen} onClick={() => { if (canLeaveContent()) setPageOptionsOpen(!pageOptionsOpen) }}><EllipsisGlyph /></button>
            </div>
          </header>
          <div class="page-detail-tabs" role="tablist" aria-label="Page views">
            <button type="button" role="tab" aria-selected={!pageOptionsOpen && (!editingContent || editorMode === 'visual')} class={!pageOptionsOpen && (!editingContent || editorMode === 'visual') ? 'active' : ''} onClick={() => { setPageOptionsOpen(false); if (editingContent) setEditorMode('visual') }}>Content</button>
            <button type="button" role="tab" aria-selected={!pageOptionsOpen && editingContent && editorMode === 'source'} class={!pageOptionsOpen && editingContent && editorMode === 'source' ? 'active' : ''} disabled={Boolean(contentBusy || activeJob || (reviewable && viewingProposalPage))} onClick={() => { setPageOptionsOpen(false); if (!editingContent) { if (!canLeaveContent()) return; setEditingContent(true) } setEditorMode('source') }}>Source</button>
            <button type="button" role="tab" aria-selected={pageOptionsOpen} class={pageOptionsOpen ? 'active' : ''} disabled={contentBusy} onClick={() => { if (canLeaveContent()) setPageOptionsOpen(!pageOptionsOpen) }}>Evidence</button>
            <span class="page-detail-tabs-side">
              {activePage.updatedAt && !editingContent && <small>Updated {timeText(activePage.updatedAt)}</small>}
              <button type="button" class={`page-content-toggle ${editingContent ? 'active' : ''}`} aria-pressed={editingContent} disabled={Boolean(contentBusy || activeJob || (reviewable && viewingProposalPage))} onClick={() => { if (canLeaveContent()) setEditingContent(!editingContent) }}><Icon name="update" size={14} />Edit content</button>
            </span>
          </div>
          {pageOptionsOpen && <section class="page-options-panel" aria-label="Page options">
            <Comments key={`comments:${activePage.path}`} path={activePage.path} onRequest={async text => { await submit({ paths: [activePage.path], instruction: `Address this reviewer comment on ${activePage.path}: ${text}` }) }} />
            {!activeJob && !(reviewable && viewingProposalPage) && <PageMetadataForm path={activePage.path} act={act} onError={onError} onSaved={() => { setPreviewNonce(value => value + 1); void refreshPages() }} />}
          </section>}
          {selected.length > 1 && <div class="selected-pages-strip" aria-label="Pages selected for this update">
            <strong><Icon name="list" size={14} />{selected.length} pages in this edit</strong>
            {selected.map((page) => <span key={page.path} class={`selected-page-chip ${page.path === activePage.path ? 'active' : ''}`}>
              <button type="button" onClick={() => { if (!canLeaveContent()) return; const next = [page.path, ...selectedPaths.filter((item) => item !== page.path)]; setSelectedPaths(next); updateUrl(next, proposal && proposalPaths.includes(page.path) ? proposal.id : '') }}>{page.title}</button>
              <button type="button" aria-label={`Remove ${page.title}`} onClick={() => togglePath(page.path)}><Icon name="close" size={12} /></button>
            </span>)}
          </div>}

          {pendingElsewhere.length > 0 && !activeJob && <div class="page-pending-strip">
            <Icon name="info" size={15} />
            <span>{pendingElsewhere.length === 1 ? <>An edit of <strong>{(pendingElsewhere[0]!.editRequest?.paths ?? []).map(titleFor).join(', ')}</strong> is waiting for your review.</> : <><strong>{pendingElsewhere.length} edits</strong> are waiting for your review.</>}</span>
            <Button size="sm" onClick={() => openRun(pendingElsewhere[0]!)}>Open review</Button>
          </div>}

          {historyEntries && <div class="proposal-drawer-scrim page-history-scrim" role="presentation" onClick={(event) => event.target === event.currentTarget && setHistoryEntries(null)}>
            <aside class="page-history-panel" role="dialog" aria-modal="true" aria-labelledby="page-history-title" onKeyDown={(event) => { if (event.key === 'Escape') setHistoryEntries(null) }}>
              <header><span><span class="kicker">History</span><strong id="page-history-title">{activePage.title}</strong></span><button type="button" aria-label="Close page history" onClick={() => setHistoryEntries(null)}><Icon name="close" size={16} /></button></header>
              <div class="page-history-body">
                {historyEntries.length
                  ? historyEntries.map((entry) => <div class="page-history-row" key={entry.requestId}><Badge tone={statusTone(entry.requestStatus)}>{statusLabel(entry.requestStatus)}</Badge><span><strong>{entry.requestText ?? 'Documentation update'}</strong><small>{timeText(entry.requestedAt)}</small></span></div>)
                  : <p class="page-history-empty">No recorded changes for this page yet.</p>}
              </div>
            </aside>
          </div>}


          <div class="page-editor-layout">
            <section class="page-editor-canvas" aria-label="Page content">
              {!activeJob && !(reviewable && viewingProposalPage) && <PageContentEditor key={`${state.root ?? state.cwd}:${activePage.path}`} root={state.root ?? state.cwd} path={activePage.path} native={nativeEditor} base={previewUrl ? `${previewUrl}${activePage.route}` : ''} focusLine={focusLine} refreshToken={previewNonce} editing={editingContent} mode={editorMode} onModeChange={setEditorMode} onEditingChange={setEditingContent} onStatus={(dirty, busy) => { setContentDirty(dirty); setContentBusy(busy) }} onChanged={async () => { await refreshPages(); setFocusLine(0); setPreviewNonce(value => value + 1); await act(async () => true) }}>{previewFrame(activePage)}</PageContentEditor>}
              {activeJob && previewFrame(activePage)}
              {!activeJob && reviewable && proposal && viewingProposalPage && <section class="page-edit-review" aria-label="Proposed changes">
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
            {reviewChange && proposal.status === 'awaiting-review' && reviewChange.hunks.every((hunk) => !hunk.acceptedAt && !hunk.rejectedAt) && <TextEditor key={`${proposal.id}:${reviewChange.id}`} root={state.root ?? state.cwd} path={reviewChange.path} proposal={{ id: proposal.id, changeId: reviewChange.id }} onChanged={async () => { await act(async () => true) }} />}

              </section>}
            </section>
            {agentPanelOpen && <aside class="page-agent-panel" aria-label="Agent instructions" onKeyDown={event => { if (event.key === 'Escape') { setAgentPanelOpen(false); document.querySelector<HTMLButtonElement>('.page-agent-toggle')?.focus() } }}>
              <header class="page-agent-panel-header"><h2 class="kicker">Instruct the agent</h2><span class="page-agent-scope">{selected.length > 1 ? `${selected.length} pages selected` : activePage.title}</span><button type="button" aria-label="Close agent panel" onClick={() => { setAgentPanelOpen(false); requestAnimationFrame(() => document.querySelector<HTMLButtonElement>('.page-agent-toggle')?.focus()) }}><Icon name="close" size={16} /></button></header>
              {activeJob && !otherPageWhileRunning && <>
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
              {activeJob && otherPageWhileRunning && <div class="page-agent-other-run"><p>An edit is running on another page.</p><Button onClick={() => { setSelectedPaths([...activePaths]); updateUrl(activePaths, activeRun?.id ?? runId) }}>Show the edit</Button></div>}
              {!activeJob && reviewable && proposal && viewingProposalPage && <div class="page-agent-review">
            <header class="page-review-head">
              <div>
                <small>Agent proposal</small>
                <h2>Review this edit</h2>
                <p>{pageEditSummary(proposal)}</p>
              </div>
              <Badge tone={statusTone(proposal.status)}>{statusLabel(proposal.status)}</Badge>
            </header>
            <blockquote class="page-review-instruction"><Icon name="chat" size={14} /><span>{latestPageEditInstruction(proposal)}</span></blockquote>
            {proposal.status === 'conflicted' && <Note tone="bad"><span class="note-body">{proposal.error}<span class="note-actions"><Button size="sm" onClick={() => { leaveProposal(); updateUrl(selectedPaths); setPreviewNonce((value) => value + 1); void refreshPages() }}>Reload and compare</Button><Button size="sm" tone="danger" onClick={() => void reject()}>Reject</Button></span></span></Note>}
            {validationErrors > 0 && <Note tone="bad"><span class="note-body">The proposed edit has {validationErrors} validation error{validationErrors === 1 ? '' : 's'}. Fix the validation errors by refining the instruction, or reject this edit.<ul class="note-issues">{proposal.validation?.issues?.filter((issue) => issue.severity === 'error').map((issue) => <li key={`${issue.code}:${issue.file ?? ''}:${issue.message}`}>{issue.file ? <code>{issue.file}</code> : null}{issue.message}</li>)}</ul></span></Note>}
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

              </div>}
              {!activeJob && !(reviewable && viewingProposalPage) && <>
                {failed && proposal && viewingProposalPage && <PageEditFailure proposal={proposal} onRetry={related => void submit({ instruction: latestPageEditInstruction(proposal), allowRelated: related, paths: proposalPaths })} onRefine={() => { setInstruction(latestPageEditInstruction(proposal)); leaveProposal(); updateUrl(proposalPaths); focusComposer() }} />}
            <section class="page-edit-composer">
              <div class="composer-body">
                <div class="page-intent-chips" aria-label="Starting points">
                  <span class="sr-only">Start with</span>
                  {PAGE_EDIT_INTENTS.map(([label, value]) => <button key={label} type="button" class="chip" aria-pressed="false" disabled={submitting} onClick={() => insertIntent(value)}>{label}</button>)}
                  <button type="button" class="chip" aria-pressed="false" disabled={submitting} onClick={() => setAssetPicker(true)}><Icon name="plus" size={12} />Insert an image…</button>
                </div>
                <div class="composer-line">
                  <div class="composer-field">
                    <label for="page-edit-instruction" class="sr-only">{composerLabel}</label>
                    <div class="composer-textarea">
                      <Icon name="update" size={16} />
                      <Textarea id="page-edit-instruction" ref={textarea} rows={1} maxlength={2000} value={instruction} disabled={submitting} placeholder={selected.length > 1 ? `What should be different on these ${selected.length} pages?` : 'What should be different on this page?'} onInput={(event) => setInstruction(event.currentTarget.value)} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); void submit() } }} />
                      <small class={instruction.length > 1900 ? 'warn' : ''}>{instruction.trim().length < MIN_EDIT_INSTRUCTION && instruction.length > 0 ? `At least ${MIN_EDIT_INSTRUCTION} characters` : instruction.length > 0 ? `${instruction.length}/2000` : ''}</small>
                    </div>
                  </div>
                  <Button tone="primary" icon="sparkles" busy={submitting} disabled={!instructionReady || selectedPaths.length === 0 || contentLocked} onClick={() => void submit()}>Generate proposal</Button>
                </div>
                <div class="composer-options">
                  <Toggle checked={allowRelated} disabled={submitting} onChange={setAllowRelated} label="Also allow related changes" />
                  {state.project?.application && <Toggle checked={screenshots} disabled={submitting} onChange={setScreenshots} label="Capture product screenshots" />}
                  <details class="page-agent-advanced"><summary>Options &amp; agent settings</summary>
                    <button type="button" class="agent-config-summary" aria-expanded={agentOpen} onClick={() => setAgentOpen(!agentOpen)}><Icon name="bot" size={16} /><span>Agent: <b>{agent ? agentLabel(agent) : 'Automatically detect'}{model ? ` · ${model}` : ''}</b></span><strong>{agentOpen ? 'Done' : 'Change'}</strong></button>
                    {agentOpen && <div class="page-agent-options">
                      <Field label="Agent"><Select value={agent} onChange={(event) => { const value = event.currentTarget.value; const nextModel = defaultModelForAgent(value); const level = preferredReasoningLevel(value, nextModel); setAgent(value); setModel(nextModel); setReasoning(value === 'codex' ? level : ''); setEffort(value === 'claude' ? level : '') }}><option value="">Automatically detect</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select></Field>
                      <Field label="Model"><Combo value={model} options={agentModels(agent).map((entry) => [entry.id, entry.label] as const)} disabled={!agent} onValueChange={setModel} /></Field>
                      {(agent === 'codex' || agent === 'claude') && <Field label={agent === 'claude' ? 'Effort' : 'Reasoning'}><Combo value={agent === 'claude' ? effort : reasoning} options={modelReasoningLevels(agent, model).map((value) => [value, value] as const)} onValueChange={agent === 'claude' ? setEffort : setReasoning} /></Field>}
                    </div>}
                  </details>
                </div>
                {contentLocked && <small class="composer-note">Save or discard your content edits before generating a proposal.</small>}
              </div>
            </section>
              </>}
            </aside>}
          </div>
          <footer class="page-canvas-status"><Icon name="preview" size={14} /><span>{reviewable && viewingProposalPage ? 'Proposed changes · Not applied' : contentDirty ? 'Unsaved draft' : 'Local preview'}</span><code>{activePage.path}</code></footer>
        </>}
      </section>
    </div>}
  </div>
}

type PagesView = 'pages' | 'assets'

/** Three dots for a "more actions" button; the icon set has no ellipsis. */
function EllipsisGlyph() {
  return <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.7" /><circle cx="12" cy="12" r="1.7" /><circle cx="19" cy="12" r="1.7" /></svg>
}

function pagesViewFrom(value: string | null): PagesView {
  return value === 'assets' ? value : 'pages'
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

/** What a Review row is, in words: a plan's documentation, or a source update. */
export function proposalRowTitle(run: Pick<Proposal, 'planId' | 'changes' | 'summary' | 'authoringMode'>): string {
  const pages = run.changes.filter((change) => change.category === 'page' && change.kind !== 'deleted').length
  if (run.planId) return `${run.authoringMode === 'create' ? 'New documentation' : 'Documentation update'} from the approved plan · ${pages} page${pages === 1 ? '' : 's'}`
  return run.summary || 'Documentation update'
}

/** "1 page changed · evidence updated" rather than a file-count ledger. */
export function pageEditSummary(proposal: Pick<Proposal, 'changes'>): string {
  const pages = proposal.changes.filter((change) => change.category === 'page').length
  const others = proposal.changes.filter((change) => change.category !== 'page')
  const parts = [`${pages} page${pages === 1 ? '' : 's'} changed`]
  if (others.some((change) => change.category === 'evidence')) parts.push('evidence updated')
  const rest = others.filter((change) => change.category !== 'evidence').length
  if (rest > 0) parts.push(`${rest} other file${rest === 1 ? '' : 's'}`)
  return parts.join(' · ')
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
  return <Table class="history-table pl-history-table" head={<><th>Request</th><th>Result</th><th>Cost</th><th>When</th></>}>
    {entries.map((entry) => {
      const pages = entry.pages ?? []
      const instruction = historyRequestSummary(historyInstruction(entry))
      const editPath = entry.kind === 'edit' ? pages[0]?.path : undefined
      const openEdit = () => { if (editPath) setLocation('pages', { path: editPath }, 'push') }
      const changes = entry.pagesChanged > 0 ? `${changeCountText(pages, entry.pagesChanged)} changed` : entry.kind === 'edit' && pages.length > 0 ? `${changeCountText(pages, pages.length)} selected` : ''
      return <tr key={entry.id} class={`history-row ${editPath ? 'clickable' : ''}`} tabIndex={editPath ? 0 : undefined} onClick={openEdit} onKeyDown={(event) => {
        if (!editPath || (event.key !== 'Enter' && event.key !== ' ')) return
        event.preventDefault()
        openEdit()
      }}>
        <td>
          <div class="history-request">
            <strong title={instruction.truncated ? historyInstruction(entry) : undefined}>{instruction.text}</strong>
            <small>{historyActionLabel(entry.kind)}{pages.length > 0 && <span class="history-pages" title={pages.map((page) => page.path).join('\n')}> · {historyPageNames(pages)}</span>}</small>
            {entry.error && <small class="history-error" title={entry.error}>{friendlyDeployError(entry.error)}</small>}
          </div>
        </td>
        <td class="history-result">
          <Badge tone={statusTone(entry.status)}>{statusLabel(entry.status)}</Badge>
          {changes && <small>{changes}</small>}
        </td>
        <td class="history-cost">{entry.usage ? <span title={`${entry.usage.totalTokens.toLocaleString()} tokens · ${entry.usage.turns} turns · largest context ${entry.usage.maxContextTokens.toLocaleString()} tokens`}>{usageText(entry.usage)}</span> : <span>—</span>}</td>
        <td class="muted-cell">{timeText(entry.createdAt)}</td>
      </tr>
    })}
  </Table>
}

/**
 * Every publish attempt, including the ones that failed. The feed is read by the
 * Deploy page itself, which also needs the last successful deployment URL.
 */
function DeploymentHistory({ entries, available, loading }: HistoryFeed<DeploymentRecord>) {
  if (!available) return <div class="ops-empty-wrap"><HistoryUnavailable /></div>
  if (loading && entries.length === 0) return <div class="history-loading ops-empty-wrap">Loading history…</div>
  if (entries.length === 0) {
    return <div class="ops-empty-wrap"><Empty
      icon="clock"
      title="Nothing published yet"
      detail="Each deployment is recorded here with the pages it published and whether it succeeded."
    /></div>
  }
  return <Table class="history-table deploy-history" head={<><th>Publish</th><th>Access</th><th>Result</th><th>When</th></>}>
    {entries.map((entry) => <tr key={`${entry.startedAt}-${entry.slug ?? entry.target}`} class="history-row">
      <td>
        <span class="deploy-history-name">{entry.slug ?? entry.name ?? entry.target}{entry.pagesCount !== undefined && <> · {changeCountText([], entry.pagesCount)}</>}</span>
        {(entry.pagesCreated || entry.pagesUpdated) && <small class="history-lines">
          {entry.pagesCreated ? <i class="added">+{entry.pagesCreated} new</i> : null}
          {entry.pagesUpdated ? <i>{entry.pagesCreated ? ' · ' : ''}{entry.pagesUpdated} updated</i> : null}
        </small>}
      </td>
      <td class="deploy-history-target">{entry.target === 'doxbrix' ? (entry.visibility === 'public' ? 'Public' : entry.visibility === 'private' ? 'Private' : 'Doxbrix') : deployTargetLabel(entry.target)}</td>
      <td>
        <Badge tone={statusTone(entry.status)}>{entry.status === 'succeeded' ? 'Published' : entry.status === 'failed' ? 'Failed' : statusLabel(entry.status)}</Badge>
        {entry.error && <small class="history-error" title={entry.error}>{friendlyDeployError(entry.error)}</small>}
      </td>
      <td class="muted-cell">
        {timeText(entry.startedAt)}
        {entry.durationMs !== undefined && <small class="history-duration">{durationText(entry.durationMs)}</small>}
      </td>
    </tr>)}
  </Table>
}

/** Reader-facing name of a deployment target id. */
function deployTargetLabel(target: string): string {
  return target === 'github-pages' ? 'GitHub Pages' : target === 'netlify' ? 'Netlify' : target === 'vercel' ? 'Vercel' : target === 'doxbrix' ? 'Doxbrix' : target === 'export' ? 'Export' : target
}

/** Mirrors `formatAgentUsage` in src/agent-log.ts: `1.2M tokens · 98% cached · $1.42 · 3 sessions`. */
function usageText(usage: AgentUsage): string {
  const count = (value: number): string => {
    const scaled = (n: number, suffix: string) => { const text = n.toFixed(1); return `${text.endsWith('.0') ? text.slice(0, -2) : text}${suffix}` }
    return value >= 1_000_000 ? scaled(value / 1_000_000, 'M') : value >= 1_000 ? scaled(value / 1_000, 'k') : String(Math.round(value))
  }
  const parts = [`${count(usage.totalTokens)} tokens`]
  const context = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
  if (context > 0 && (usage.cacheReadTokens > 0 || usage.cacheCreationTokens > 0)) parts.push(`${Math.round((usage.cacheReadTokens / context) * 100)}% cached`)
  if (usage.costUsd !== undefined) parts.push(usage.costUsd > 0 && usage.costUsd < 0.01 ? '<$0.01' : `$${usage.costUsd.toFixed(2)}`)
  if (usage.sessions !== 1) parts.push(`${usage.sessions} sessions`)
  return parts.join(' · ')
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
  const checkBlocked = authoringJobRunning(state.jobs)
  const save = async () => {
    setSaving(true)
    try {
      const result = await act(() => post('/api/sync/configure', { ...sync, mode: 'auto' }), 'Monitoring configuration installed')
      if (result !== undefined) onClose()
    } finally {
      setSaving(false)
    }
  }
  return <div class="sources-modal-scrim ops-dialog-scrim" onClick={onClose}>
    <section class="monitoring-dialog ops-dialog" role="dialog" aria-modal="true" aria-labelledby="monitoring-dialog-title" onClick={(event) => event.stopPropagation()}>
      <header class="ops-dialog-head">
        <div><h2 id="monitoring-dialog-title">Configure project monitoring</h2><p>One project-wide policy checks all {project.sources.length} connected sources. Changes generate a documentation proposal for review.</p></div>
        <button type="button" class="ops-icon-button" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
      </header>
      <div class="monitoring-dialog-body ops-dialog-body">
        <div class="monitoring-dialog-status"><span class={project.sync.on.length ? 'active' : ''}><i />{project.sync.on.length ? scheduleSummary(scheduleForm(project.sync.on)) : 'Monitoring is not configured'}</span><Button size="sm" icon="refresh" busy={checking} disabled={checking || checkBlocked} title={checkBlocked ? 'Available when the running writing task finishes' : undefined} onClick={() => void act(() => post('/api/sync/now'), 'Source check started', false)}>{checking ? 'Checking…' : 'Check now'}</Button></div>
        {checking && <Note>A source check is running. Its result appears as a notice when it finishes; the live log is under Plan.</Note>}
        {localSources.length > 0 && <Note>{localSources.map((item) => item.name).join(', ')} {localSources.length === 1 ? 'is a local folder and is' : 'are local folders and are'} checked in place: a Git checkout by its HEAD commit and working tree, any other folder by the files recorded at the last sync. Nothing is fetched, pulled, or written there.</Note>}
        <section class="monitoring-policy-fields">
          <Field label="Product branch" hint="The branch monitoring compares against. Leave empty for the source's default branch."><Input value={sync.branch ?? ''} placeholder={project.sources.find((item) => item.remote?.branch)?.remote?.branch ?? 'main'} onInput={(event) => set('branch', event.currentTarget.value)} /></Field>
          <div class="field ops-choice">
            <span class="field-label">Schedule</span>
            <RadioRows label="Schedule" value={schedule.kind} onChange={(kind) => updateSchedule({ kind })} items={[
              { id: 'daily', label: 'Daily' },
              { id: 'weekdays', label: 'Weekdays' },
              { id: 'weekly', label: 'Weekly' },
              { id: 'monthly', label: 'Monthly' },
              { id: 'custom', label: 'Custom interval', detail: 'Every few minutes or hours' },
            ] as const} />
          </div>
          {schedule.kind === 'weekly' && <Field label="Day of week"><Select value={schedule.weekday} onChange={(event) => updateSchedule({ weekday: event.currentTarget.value })}>{WEEKDAY_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>}
          {schedule.kind === 'monthly' && <Field label="Day of month" hint="The 1st through 28th runs reliably every month."><Input type="number" min="1" max="28" value={schedule.day} onInput={(event) => updateSchedule({ day: clampNumber(event.currentTarget.value, 1, 28) })} /></Field>}
          {schedule.kind !== 'custom' && <Field label="Time" hint={`Uses your device timezone (${timezone}).`}><Input type="time" value={schedule.time} onInput={(event) => updateSchedule({ time: event.currentTarget.value || '09:00' })} /></Field>}
          {schedule.kind === 'custom' && <>
            <Field label="Repeat every"><Input type="number" min="1" max={schedule.unit === 'm' ? '59' : '24'} value={schedule.interval} onInput={(event) => updateSchedule({ interval: clampNumber(event.currentTarget.value, 1, schedule.unit === 'm' ? 59 : 24) })} /></Field>
            <Field label="Interval"><Select value={schedule.unit} onChange={(event) => { const unit = event.currentTarget.value as ScheduleUnit; updateSchedule({ unit, interval: Math.min(schedule.interval, unit === 'm' ? 59 : 24) }) }}><option value="m">Minutes</option><option value="h">Hours</option></Select></Field>
          </>}
          <p class="schedule-summary"><Icon name="calendar" size={15} />{scheduleSummary(schedule)}</p>
          <button type="button" class="disclosure" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}><Icon name={advanced ? 'chevronDown' : 'chevronRight'} size={14} />Advanced watch scope and budgets</button>
          {advanced && <div class="form-grid gap-top">
            <Field label="Watched paths" hint="One glob per line. Only changes under these paths trigger an update."><Lines value={sync.watch} onInput={(value) => set('watch', value)} placeholder={'src/**\nopenapi.yaml'} /></Field>
            <Field label="Ignored paths" hint="One glob per line. Changes here never trigger an update."><Lines value={sync.ignore} onInput={(value) => set('ignore', value)} placeholder={'**/*.test.ts\npnpm-lock.yaml'} /></Field>
            <Field label="Maximum agent minutes"><Input type="number" min="1" value={sync.budget?.maxMinutes ?? ''} onInput={(event) => setSync({ ...sync, budget: numberBudget(sync.budget, 'maxMinutes', event.currentTarget.value) })} /></Field>
            <Field label="Maximum runs per day"><Input type="number" min="1" value={sync.budget?.maxRunsPerDay ?? ''} onInput={(event) => setSync({ ...sync, budget: numberBudget(sync.budget, 'maxRunsPerDay', event.currentTarget.value) })} /></Field>
            {/* Only Claude Code has a spending flag; Codex and Gemini projects never see a cap that would not apply. */}
            {(!state.project?.defaultAgent || state.project.defaultAgent === 'claude') && <Field label="Maximum Claude spend (USD)" hint="Stops a Claude Code run at this cost and names the cap in the run log. Codex and Gemini have no spending flag, so this is ignored for them. Leave it empty for no cap."><Input type="number" min="0.5" step="0.5" placeholder="No cap" value={sync.budget?.maxUsd ?? ''} onInput={(event) => setSync({ ...sync, budget: numberBudget(sync.budget, 'maxUsd', event.currentTarget.value) })} /></Field>}
            <Field label="Re-verify after (days)" hint="Checks evidence age even when source content is unchanged."><Input type="number" min="1" max="3650" value={sync.maxVerificationAgeDays ?? ''} onInput={(event) => set('maxVerificationAgeDays', event.currentTarget.value ? clampNumber(event.currentTarget.value, 1, 3650) : undefined)} /></Field>
            <Field label="Expired verification"><Select value={sync.maxVerificationAgeSeverity ?? 'warn'} onChange={(event) => set('maxVerificationAgeSeverity', event.currentTarget.value as 'warn' | 'fail')}><option value="warn">Warn</option><option value="fail">Fail validation</option></Select></Field>
          </div>}
          <Note>Save and install adds a background schedule on this computer, so checks run even when the control center is closed. Updates arrive as proposals under Review. Monitoring never changes the product source or publishes on its own.</Note>
        </section>
      </div>
      <footer class="ops-dialog-foot">
        {project.sync.on.length > 0 && <Button tone="danger" onClick={() => confirm('Disable the installed monitoring schedule?') && void act(() => post('/api/sync/off'), 'Monitoring disabled')}>Disable</Button>}
        <span />
        <Button tone="ghost" onClick={onClose}>Cancel</Button>
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
  const decisions = selected ? proposalDecisionCounts(selected.changes, selected.status === 'applied') : { accepted: 0, rejected: 0, remaining: 0 }
  // Screenshot coverage is measured against the guides the plan asked for.
  const linkedPlan = selected && state.documentationPlan && (state.documentationPlan.proposalId === selected.id || state.documentationPlan.id === selected.planId) ? state.documentationPlan : undefined
  const planGuides = linkedPlan ? linkedPlan.pages.filter((page) => page.priority !== 'later' && page.action !== 'remove' && page.action !== 'preserve' && isGuidePage(page)).length : undefined
  // The header keeps one primary action; everything rarer sits behind "⋯".
  const [menuOpen, setMenuOpen] = useState(false)
  const menuRoot = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!menuOpen) return
    const closeOnOutsidePress = (event: PointerEvent) => { if (event.target instanceof Node && !menuRoot.current?.contains(event.target)) setMenuOpen(false) }
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false) }
    document.addEventListener('pointerdown', closeOnOutsidePress)
    document.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('pointerdown', closeOnOutsidePress); document.removeEventListener('keydown', closeOnEscape) }
  }, [menuOpen])
  useEffect(() => { setMenuOpen(false); setReviseDraft('') }, [selectedId])
  // The revise bar under the diff sends straight to the agent; "Choose files" opens the dialog.
  const [reviseDraft, setReviseDraft] = useState('')
  const [reviseScope, setReviseScope] = useState<'current' | 'all' | 'selected'>('current')
  const diffMode: 'rendered' | 'split' | 'source' = view === 'source' ? 'source' : layout === 'split' ? 'split' : 'rendered'
  const setDiffMode = (next: 'rendered' | 'split' | 'source') => { if (next === 'source') setView('source'); else { setView('rendered'); setLayout(next === 'split' ? 'split' : 'unified') } }
  // Written pages and removed pages are counted apart so this line agrees
  // with the "N pages applied" confirmation.
  const pageChangeCount = selected ? selected.changes.filter((item) => item.category === 'page' && item.kind !== 'deleted').length : 0
  const pageRemovedCount = selected ? selected.changes.filter((item) => item.category === 'page' && item.kind === 'deleted').length : 0
  const logJob = selected ? state.jobs.find((job) => job.type.endsWith(`:${selected.id}`)) : undefined
  const acceptedShare = selected && selected.changes.length > 0 ? Math.round((decisions.accepted / selected.changes.length) * 100) : 0
  const [accepting, setAccepting] = useState(false)
  const acceptAll = async (proposal: Proposal) => {
    if (accepting) return
    setAccepting(true)
    try {
      // Apply first and close the dialog on the answer; refreshing the
      // workspace afterwards can take a while on a large proposal and must not
      // hold the confirmation open.
      const result = await act(() => post<Proposal>(`/api/proposals/${proposal.id}/accept`, { scope: 'all', ...(overwriteConfirmed ? { confirmChangedDuringRun: true } : {}) }), 'Documentation changes applied', false)
      setConfirmingAcceptance(null)
      if (result) {
        setAppliedProposal(result)
        void act(async () => true)
      }
    } finally {
      setAccepting(false)
    }
  }
  const requestRevision = async (proposal: Proposal, draft: ProposalRevisionDraft | null = revision): Promise<boolean> => {
    if (!draft?.instruction.trim()) return false
    const changeIds = draft.mode === 'all'
      ? proposal.changes.map((item) => item.id)
      : draft.mode === 'current'
        ? (change ? [change.id] : [])
        : draft.selectedIds
    const result = await act(
      () => post<UiJob>(`/api/proposals/${proposal.id}/revise`, {
        instruction: draft.instruction,
        changeIds,
        hunkIds: draft.hunkIds,
      }),
      'Revision started',
      false,
    )
    if (result) setRevision(null)
    return Boolean(result)
  }
  const sendRevision = async () => {
    if (!selected || !change || !reviseDraft.trim() || !open) return
    if (reviseScope === 'selected') { setRevision({ mode: 'selected', instruction: reviseDraft.trim(), selectedIds: [change.id], hunkIds: [] }); return }
    if (await requestRevision(selected, { mode: reviseScope, instruction: reviseDraft.trim(), selectedIds: [change.id], hunkIds: [] })) setReviseDraft('')
  }
  return <>
    {delivery && <div class="proposal-ready-scrim" role="presentation"><section class="proposal-ready-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-delivery-title"><button class="proposal-ready-close" type="button" aria-label="Close" onClick={() => setDelivery(null)}><Icon name="close" size={16} /></button><span class="proposal-ready-icon"><Icon name="external" size={24} /></span><div><h2 id="proposal-delivery-title">{delivery.pullRequestUrl ? 'Pull request is ready' : delivery.pushedAt ? 'Branch published' : 'Pull-request branch is ready'}</h2><p>{delivery.pushedAt ? 'The reviewed commit is available on the remote without changing your current working tree.' : 'Doxloop created the branch in an isolated Git worktree without changing your current working tree.'}</p></div><div class="proposal-ready-summary"><strong>{delivery.branch}</strong><span>Commit {delivery.commit.slice(0, 12)}</span></div>{!delivery.pushedAt && delivery.pullRequestCommand && <code>{delivery.pullRequestCommand}</code>}<footer>{delivery.pullRequestUrl ? <a class="btn primary md" href={delivery.pullRequestUrl} target="_blank" rel="noreferrer">Open pull request</a> : delivery.pushedAt ? delivery.compareUrl && <a class="btn primary md" href={delivery.compareUrl} target="_blank" rel="noreferrer">Open comparison</a> : <><Button onClick={() => void (async () => { const result = await act(() => post<typeof delivery>(`/api/proposals/${selectedId}/delivery/publish`, { createPullRequest: false }), 'Branch published'); if (result) setDelivery(result) })()}>Push branch</Button><Button tone="primary" onClick={() => void (async () => { const result = await act(() => post<typeof delivery>(`/api/proposals/${selectedId}/delivery/publish`, { createPullRequest: true }), 'Pull request created'); if (result) setDelivery(result) })()}>Push & create PR</Button></>}<Button onClick={() => setDelivery(null)}>Done</Button></footer></section></div>}
    {rationaleChange && <ProposalRationaleDrawer change={rationaleChange} onClose={() => setRationaleChange(null)} />}
    {revision && selected && <ProposalRevisionDialog proposal={selected} current={change} draft={revision} onChange={setRevision} onClose={() => setRevision(null)} onSubmit={() => void requestRevision(selected)} />}
    {confirmingAcceptance && <div class="proposal-ready-scrim" role="presentation">
      <section class="proposal-ready-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-accept-title">
        <button class="proposal-ready-close" type="button" aria-label="Close" disabled={accepting} onClick={() => setConfirmingAcceptance(null)}><Icon name="close" size={16} /></button>
        <span class="proposal-ready-icon"><Icon name="proposals" size={24} /></span>
        <div><h2 id="proposal-accept-title">Apply these documentation changes?</h2><p>This replaces the current versions of the reviewed files with the proposed versions.</p></div>
        <div class="proposal-ready-summary"><strong>{proposalSummaryText(confirmingAcceptance.changes)}</strong><span>Only the files listed in this proposal will be applied.</span></div>
        {concurrentChanges.length > 0 && <div class="proposal-concurrent-warning" role="group" aria-label="Files edited while the agent ran">
          <strong><Icon name="alert" size={14} />{concurrentChanges.length === 1 ? 'One file was edited while the agent ran' : `${concurrentChanges.length} files were edited while the agent ran`}</strong>
          <p>The agent never saw these edits. Applying the proposal replaces them with the proposed versions.</p>
          <ul>{concurrentChanges.map((item) => <li key={item.id}><code>{item.path}</code></li>)}</ul>
          <Toggle checked={overwriteConfirmed} onChange={setOverwriteConfirmed} label="Replace my edits to these files" />
        </div>}
        <footer><Button disabled={accepting} onClick={() => setConfirmingAcceptance(null)}>Cancel</Button><Button tone="primary" icon="check" busy={accepting} disabled={concurrentChanges.length > 0 && !overwriteConfirmed} onClick={() => void acceptAll(confirmingAcceptance)}>Apply changes</Button></footer>
      </section>
    </div>}
    {appliedProposal && <div class="proposal-ready-scrim" role="presentation">
      <section class="proposal-ready-dialog proposal-applied-dialog" role="dialog" aria-modal="true" aria-labelledby="proposal-applied-title">
        <button class="proposal-ready-close" type="button" aria-label="Close" onClick={() => setAppliedProposal(null)}><Icon name="close" size={16} /></button>
        <span class="proposal-ready-icon applied"><Icon name="check" size={24} /></span>
        <div><h2 id="proposal-applied-title">{appliedProposal.status === 'applied' ? 'Documentation changes applied' : 'Some changes were applied'}</h2><p>{appliedPageText(appliedProposal)} Preview the result, then publish it when it looks right.</p></div>
        <div class="proposal-ready-summary"><strong>{proposalSummaryText(appliedProposal.changes)}</strong><span>{appliedProposal.status === 'applied' ? 'Undo stays available from this proposal until newer edits replace these files.' : 'The remaining changes are still waiting for a decision in this proposal.'}</span></div>
        <footer><Button onClick={() => setAppliedProposal(null)}>Done</Button><Button icon="preview" onClick={() => void openPreviewTab((openServerSide) => post<{ url: string }>('/api/preview/start', { open: openServerSide }))}>Preview docs</Button><Button tone="primary" icon="deploy" onClick={() => { setAppliedProposal(null); setLocation('publish', {}, 'push') }}>Publish</Button></footer>
      </section>
    </div>}
    {selected
      ? <PageHeader kicker={linkedPlan ? `Proposal · plan v${linkedPlan.version}` : selected.editRequest ? 'Proposal · page edit' : 'Proposal'} title="Review proposal" actions={<>
        <div class="review-more" ref={menuRoot}>
          <button type="button" class="btn secondary md review-more-trigger" aria-label="More actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen(!menuOpen)}><EllipsisGlyph /></button>
          {menuOpen && <div class="review-more-menu" role="menu" aria-label="More actions">
            {(open || (selected.status === 'stale' && !selected.archivedAt)) && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); setRevision({ mode: 'all', instruction: 'Regenerate this proposal using the current approved plan and evidence.', selectedIds: selected.changes.map((item) => item.id), hunkIds: [] }) }}>Regenerate</button>}
            {selected.status === 'awaiting-review' && !selected.archivedAt && (selected.validation?.errors ?? 0) > 0 && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void act(() => post<Proposal>(`/api/proposals/${selected.id}/repair`), 'Proposal repaired and validated again') }}>Repair proposal</button>}
            {selected.status === 'failed' && !selected.archivedAt && selected.recovery?.resumable !== false && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void act(() => post<UiJob>(`/api/proposals/${selected.id}/resume`), 'Continuing the documentation run') }}>Resume</button>}
            {selected.status === 'failed' && !selected.archivedAt && selected.recovery?.ignorable !== false && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void act(() => post<Proposal>(`/api/proposals/${selected.id}/recover`, { ignoreScreenshotProblems: true }), 'Proposal ready for review with problems ignored') }}>Ignore problems &amp; review</button>}
            {selected.status === 'applied' && selected.undo?.status === 'available' && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); if (confirm('Undo every file applied by this proposal? Newer edits will be protected.')) void act(() => post(`/api/proposals/${selected.id}/undo`), 'Documentation changes undone') }}>Undo</button>}
            {!selected.archivedAt && selected.status !== 'generating' && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); if (confirm('Archive this proposal? It can remain in history until cleanup.')) void act(() => post(`/api/proposals/${selected.id}/archive`), 'Proposal archived') }}>Archive</button>}
            {delivery && !delivery.pushedAt && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void (async () => { const result = await act(() => post<typeof delivery>(`/api/proposals/${selected.id}/delivery/publish`, { createPullRequest: false }), 'Branch published'); if (result) setDelivery(result) })() }}>Push branch</button>}
            {delivery && !delivery.pushedAt && <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); void (async () => { const result = await act(() => post<typeof delivery>(`/api/proposals/${selected.id}/delivery/publish`, { createPullRequest: true }), 'Pull request created'); if (result) setDelivery(result) })() }}>Push &amp; create PR</button>}
            {delivery?.pullRequestUrl && <a role="menuitem" href={delivery.pullRequestUrl} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>Open pull request</a>}
            {delivery?.pushedAt && !delivery.pullRequestUrl && delivery.compareUrl && <a role="menuitem" href={delivery.compareUrl} target="_blank" rel="noreferrer" onClick={() => setMenuOpen(false)}>Open comparison</a>}
          </div>}
        </div>
        {open && <Button icon="publish" onClick={() => void (async () => { const result = await act(() => post<{ branch: string; commit: string; compareUrl?: string; pullRequestCommand?: string }>(`/api/proposals/${selected.id}/delivery/branch`, {}), 'Pull-request branch prepared'); if (result) setDelivery(result) })()}>Prepare PR branch</Button>}
        {/* An applied proposal has nothing left to apply; its useful action is undo. */}
        {selected.status === 'applied'
          ? selected.undo?.status === 'available'
            ? <Button icon="undo" onClick={() => { if (confirm('Undo every file applied by this proposal? Newer edits will be protected.')) void act(() => post(`/api/proposals/${selected.id}/undo`), 'Documentation changes undone') }}>Undo apply</Button>
            : <Badge tone="good">Applied</Badge>
          : <Button tone="primary" icon="check" disabled={!open} onClick={() => setConfirmingAcceptance(selected)}>Apply changes</Button>}
      </>} />
      : <PageHeader kicker="Review" title="Review" actions={runs.length > 0 ? <><Button onClick={() => setShowArchived(!showArchived)}>{showArchived ? 'Back to proposals' : `Archived (${archivedCount})`}</Button>{showArchived && archivedCount > 0 && <Button tone="danger" onClick={() => confirm('Permanently remove every archived proposal workspace?') && void act(() => post('/api/proposals/cleanup', {}), 'Archived proposals cleaned up')}>Clean up archived</Button>}</> : undefined} />}
    {runs.length === 0
      ? <Panel flush><Empty icon="review" title="No changes waiting for review" detail="When the agent finishes writing, the proposal appears here." /></Panel>
      : !selected
        ? <Panel class="proposal-index-panel" flush>
          {visibleRuns.length === 0 ? <Empty icon="review" title={showArchived ? 'No archived proposals' : 'No changes waiting for review'} detail={showArchived ? 'Archived proposal workspaces appear here until cleanup.' : 'When the agent finishes writing, the proposal appears here.'} /> :
          <div class="proposal-index-list">
            {visibleRuns.map((run) => {
              const runCounts = proposalChangeCounts(run.changes)
              // A page edit is reviewed beside the page it changed, so its row
              // names that page and the request and opens the Docs review panel.
              const edit = run.editRequest
              if (edit) {
                const pages = edit.paths.length === 1 ? edit.paths[0]! : `${edit.paths.length} pages`
                return <button type="button" key={run.id} class="proposal-index-row" onClick={() => setLocation('pages', { run: run.id }, 'push')}>
                  <span class="proposal-index-copy"><strong>Page edit · {pages}</strong><small>{timeText(run.createdAt)} · {latestPageEditInstruction(run)}</small></span>
                  <Badge tone={statusTone(run.archivedAt ? 'archived' : run.status)}>{run.archivedAt ? 'Archived' : statusLabel(run.status)}</Badge>
                  <Icon name="chevronRight" size={15} />
                </button>
              }
              return <button type="button" key={run.id} class="proposal-index-row" onClick={() => setSelectedId(run.id)}>
                <span class="proposal-index-copy"><strong>{proposalRowTitle(run)}</strong><small>{[timeText(run.createdAt), `${run.changes.length} file${run.changes.length === 1 ? '' : 's'}: ${runCounts.added} added, ${runCounts.modified} changed${runCounts.deleted ? `, ${runCounts.deleted} removed` : ''}`, run.validation ? (run.validation.errors ? `${run.validation.errors} validation error${run.validation.errors === 1 ? '' : 's'}` : 'validates') : ''].filter(Boolean).join(' · ')}</small></span>
                <Badge tone={statusTone(run.archivedAt ? 'archived' : run.status)}>{run.archivedAt ? 'Archived' : statusLabel(run.status)}</Badge>
                <Icon name="chevronRight" size={15} />
              </button>
            })}
          </div>}
        </Panel>
        : <div class="review">
        <section class="review-summary-bar" aria-label="Proposal summary">
          <div class="review-summary-copy">
            <strong>{linkedPlan ? `Generated from plan v${linkedPlan.version}` : selected.editRequest ? 'Page edit' : 'Documentation update'} · {selected.changes.length} file{selected.changes.length === 1 ? '' : 's'}{pageChangeCount > 0 ? ` · ${pageChangeCount} page${pageChangeCount === 1 ? '' : 's'}` : ''}{pageRemovedCount > 0 ? ` · ${pageRemovedCount} removed` : ''}{selected.screenshots && selected.screenshots.status !== 'not-requested' ? ` · ${selected.screenshots.captured} screenshot${selected.screenshots.captured === 1 ? '' : 's'}` : ''}</strong>
            <small>{[selected.sourceSummary, timeText(selected.createdAt), selected.usage ? usageText(selected.usage) : ''].filter(Boolean).join(' · ')}</small>
          </div>
          <div class="review-summary-side">
            {selected.validation && <Badge tone={selected.validation.errors > 0 ? 'bad' : selected.validation.warnings > 0 ? 'warn' : 'good'}>{selected.validation.errors > 0 ? `${selected.validation.errors} validation error${selected.validation.errors === 1 ? '' : 's'}` : selected.validation.warnings > 0 ? `${selected.validation.warnings} validation warning${selected.validation.warnings === 1 ? '' : 's'}` : 'Navigation valid'}</Badge>}
            {selected.screenshots && selected.screenshots.status !== 'not-requested' && <Badge tone={selected.screenshots.status === 'verified' ? 'good' : selected.screenshots.status === 'failed' ? 'bad' : 'neutral'}>{selected.screenshots.status === 'verified' ? `Screenshots verified ${selected.screenshots.captured} / ${selected.screenshots.planned}` : selected.screenshots.status === 'failed' ? 'Screenshots need attention' : selected.screenshots.status === 'skipped' ? 'Screenshots skipped' : 'Screenshots planned'}</Badge>}
            <Badge tone={statusTone(selected.archivedAt ? 'archived' : selected.status)}>{selected.archivedAt ? 'Archived' : statusLabel(selected.status)}</Badge>
            <Button size="sm" icon="external" onClick={() => void openProposalPreview(selected.id, onError)}>Preview docs</Button>
            {logJob && <a class="btn ghost sm" href={`/api/jobs/${logJob.id}/log`} target="_blank" rel="noreferrer">Open log</a>}
          </div>
        </section>
        <div class="review-notices">
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
            {selected.status === 'awaiting-review' && !selected.archivedAt && (selected.validation?.errors ?? 0) > 0 && <div class="proposal-lifecycle-notice failed">
              <Icon name="alert" size={15} />
              <span class="proposal-failed-copy"><strong>{selected.validation!.errors} validation error{selected.validation!.errors === 1 ? '' : 's'} keep this proposal from being applied.</strong><small>Repair lets Doxloop fix navigation placement and unresolvable links deterministically, without starting an agent.</small></span>
              <span class="proposal-failed-actions"><Button size="sm" tone="primary" icon="check" onClick={() => void act(() => post<Proposal>(`/api/proposals/${selected.id}/repair`), 'Proposal repaired and validated again')}>Repair proposal</Button></span>
            </div>}
            {selected.advisories?.map((advisory) => <div key={advisory} class="proposal-lifecycle-notice advisory"><Icon name="info" size={15} /><span>{advisory}</span></div>)}
            {(selected.status === 'stale' || selected.status === 'superseded' || selected.archivedAt) && <div class={`proposal-lifecycle-notice ${selected.status}`}>
              <Icon name="info" size={15} />
              <span>{selected.status === 'stale' ? selected.error : selected.status === 'superseded' ? `A newer revision${selected.supersededBy ? ` (${selected.supersededBy})` : ''} replaced this proposal.` : 'This proposal is archived.'}</span>
            </div>}

            {selected.screenshots && selected.screenshots.status !== 'not-requested' && <div class={`proposal-screenshot-result ${selected.screenshots.ignoredProblems ? 'ignored' : selected.screenshots.status === 'verified' && planGuides !== undefined && selected.screenshots.guides * 2 < planGuides ? 'thin' : selected.screenshots.status}`}><span class="screenshot-camera"><Icon name="camera" size={17} /></span><span><strong>{selected.screenshots.status === 'skipped' ? 'Application screenshots skipped' : selected.screenshots.status === 'failed' ? 'Application screenshot capture needs attention' : screenshotCoverageText(selected.screenshots, planGuides)}</strong><small>{selected.screenshots.ignoredProblems ? `${selected.screenshots.ignoredProblems} screenshot problem${selected.screenshots.ignoredProblems === 1 ? '' : 's'} to review. ` : ''}{selected.screenshots.message ? <ScreenshotMessage message={selected.screenshots.message} /> : (selected.screenshots.textOnly > 0 ? `${selected.screenshots.textOnly} step${selected.screenshots.textOnly === 1 ? '' : 's'} could not be captured and are described in text.` : planGuides !== undefined && selected.screenshots.guides < planGuides ? `The other ${planGuides - selected.screenshots.guides} guide${planGuides - selected.screenshots.guides === 1 ? ' is' : 's are'} text-only.` : '')}</small></span>{selected.screenshots.status === 'verified' && <Button size="sm" onClick={() => void openProposalPreview(selected.id, onError)}>Review in preview</Button>}</div>}
        </div>

        <div class="review-workspace">
          <aside class="review-files" aria-label="Files in this proposal">
            <div class="review-files-card">
              <div class="review-files-head"><strong>{selected.changes.length} file{selected.changes.length === 1 ? '' : 's'}</strong><small>{decisions.accepted} accepted · {decisions.remaining} pending{decisions.rejected > 0 ? ` · ${decisions.rejected} rejected` : ''}</small></div>
              <div class="progress good" role="progressbar" aria-label="Accepted files" aria-valuemin={0} aria-valuemax={100} aria-valuenow={acceptedShare}><i style={{ width: `${acceptedShare}%` }} /></div>
              <div class="review-files-actions">
                <Button size="sm" disabled={!open} onClick={() => selected && setConfirmingAcceptance(selected)}>Accept all</Button>
                <Button size="sm" tone="ghost" disabled={!open} onClick={() => confirm('Reject the remaining undecided changes? Already accepted changes stay applied.') && void act(() => post(`/api/proposals/${selected.id}/reject`), 'Remaining changes rejected')}>Reject remaining</Button>
              </div>
            </div>
            {change && <ReviewFilePicker key={selected.id} changes={selected.changes} selected={change} onSelect={setChangeId} />}
            {open && <details class="text-editor review-folder-tools"><summary>Review a folder</summary><div class="text-editor-body"><label>Folder<select value={folder} onChange={(event) => setFolder(event.currentTarget.value)}><option value="">Choose a folder</option>{[...new Set(selected.changes.flatMap((item) => { const parts = item.path.split('/'); return parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join('/')) }))].sort().map((path) => <option>{path}</option>)}</select></label>{folder && <ul>{selected.changes.filter((item) => item.path.startsWith(`${folder}/`) && item.hunks.some((hunk) => !hunk.acceptedAt && !hunk.rejectedAt)).map((item) => <li>{item.path}</li>)}</ul>}<label>Rejection reason<input value={folderReason} onInput={(event) => setFolderReason(event.currentTarget.value)} /></label><div class="text-editor-actions"><Button disabled={!folder} onClick={() => { const changes = selected.changes.filter((item) => item.path.startsWith(`${folder}/`)); if (changes.some((item) => item.changedDuringRun)) { onError('A file in this folder changed during generation. Review and accept it individually before accepting the folder.'); return } void act(() => post(`/api/proposals/${selected.id}/accept`, { scope: 'folder', folder }), 'Folder changes accepted') }}>Accept pending changes in folder</Button><Button disabled={!folder || !folderReason.trim()} onClick={() => void act(() => post(`/api/proposals/${selected.id}/reject-changes`, { scope: 'folder', folder, reason: folderReason }), 'Folder changes rejected')}>Reject pending changes in folder</Button></div></div></details>}
          </aside>

          <section class="review-diff-panel">
            {change ? <>
              <header class="review-file-head">
                <div class="review-file-head-main">
                  <div class="review-file-title"><code>{change.path}</code><span class={`badge no-dot ${change.kind === 'added' ? 'good' : change.kind === 'deleted' ? 'bad' : 'warn'}`}>{change.kind === 'added' ? 'Added' : change.kind === 'deleted' ? 'Deleted' : 'Modified'}</span>{change.changedDuringRun && <span class="badge warn">Edited while the agent ran</span>}</div>
                  <small>{change.hunks.length} change{change.hunks.length === 1 ? '' : 's'} · {change.category}{change.title && change.title !== change.path ? ` · ${change.title}` : ''} · {Math.max(0, selected.changes.findIndex((item) => item.id === change.id)) + 1} of {selected.changes.length}</small>
                </div>
                <div class="review-file-head-actions">
                  <Segmented value={diffMode} onChange={setDiffMode} items={[['rendered', 'Rendered'], ['split', 'Side-by-side'], ['source', 'Source']] as const} />
                  <Button size="sm" tone="danger" disabled={!open || !change.hunks.some((hunk) => !hunk.acceptedAt && !hunk.rejectedAt)} onClick={() => { const reason = prompt('Why reject the remaining changes in this file? (optional)', ''); if (reason !== null) void act(() => post(`/api/proposals/${selected.id}/reject-changes`, { changeId: change.id, reason }), 'File changes rejected') }}>Reject file</Button>
                  <Button size="sm" tone="primary" icon="check" disabled={!open} onClick={() => confirmOverwrite(change) && void act(() => post(`/api/proposals/${selected.id}/accept`, { scope: 'page', changeId: change.id, ...(change.changedDuringRun ? { confirmChangedDuringRun: true } : {}) }), 'Page accepted')}>Accept file</Button>
                </div>
              </header>
              <div class="review-file-tools">
                {view === 'rendered' && <button type="button" class="chip" aria-pressed={onlyChanges} onClick={() => setOnlyChanges(!onlyChanges)}>Changes only</button>}
                <Button size="sm" tone="ghost" icon="info" onClick={() => setRationaleChange(change)}>Why this change</Button>
                {selected.status === 'applied' && change.category === 'page' && change.kind !== 'deleted' && <Button size="sm" tone="ghost" icon="update" onClick={() => setLocation('pages', { path: change.path }, 'push')}>Edit this page</Button>}
              </div>
              {change.changedDuringRun && <div class="proposal-lifecycle-notice concurrent" role="note">
                <Icon name="alert" size={15} />
                <span><strong>This file was edited in the project while the agent ran.</strong> The comparison shows the proposal against your edited version; accepting replaces that edit and asks first.</span>
              </div>}
              <div class="review-diff-body">
                {view === 'source'
                  ? <ProposalSourceDiff runId={selected.id} change={change} act={act} partialActions={open} beforeAccept={() => confirmOverwrite(change)} onReviseHunk={(hunkId) => setRevision({ mode: 'current', instruction: '', selectedIds: [change.id], hunkIds: [hunkId] })} />
                  : <ProposalRenderedDiff key={`${selected.id}:${change.afterHash}`} runId={selected.id} change={change} layout={layout} onlyChanges={onlyChanges} />}
              </div>
              <div class="review-file-extras">
                <Comments key={`comments:${selected.id}:${change.id}`} path={change.path} proposal={{ id: selected.id, change }} onRequest={async (text, hunkId) => { if (!open) throw new Error('This proposal is closed. Comment on the live page to request a new update.'); await act(() => post(`/api/proposals/${selected.id}/revise`, { instruction: `Address this reviewer comment: ${text}`, changeIds: [change.id], hunkIds: hunkId ? [hunkId] : [] }), 'Comment revision started') }} />
                {open && change.category === 'page' && !change.binary && change.kind !== 'deleted' && change.hunks.every((hunk) => !hunk.acceptedAt && !hunk.rejectedAt) && <TextEditor key={`${selected.id}:${change.id}`} root={state.root ?? state.cwd} path={change.path} proposal={{ id: selected.id, changeId: change.id }} onChanged={async () => { await act(async () => true) }} />}
              </div>
              <footer class="review-revise-bar">
                <div class="review-revise-input"><Icon name="sparkles" size={16} /><input class="input" type="text" aria-label="Ask the agent to revise" placeholder={open ? 'Ask the agent to revise this file…' : 'This proposal is closed'} value={reviseDraft} disabled={!open} onInput={(event) => setReviseDraft(event.currentTarget.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void sendRevision() } }} /></div>
                <label class="review-revise-scope"><span class="sr-only">Revision scope</span><select class="chip" value={reviseScope} disabled={!open} onChange={(event) => setReviseScope(event.currentTarget.value as 'current' | 'all' | 'selected')}><option value="current">This file</option><option value="all">Whole proposal</option><option value="selected">Choose files</option></select><Icon name="chevronDown" size={13} /></label>
                <Button disabled={!open || !reviseDraft.trim()} onClick={() => void sendRevision()}>Send</Button>
              </footer>
            </> : <Empty title="This proposal contains no file changes" />}
          </section>
        </div>
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

/**
 * The changed files, always visible beside the diff: one row per file with the
 * change kind as a letter, grouped by what the reviewer cares about first.
 */
function ReviewFilePicker({ changes, selected, onSelect }: {
  changes: ProposalChange[]
  selected: ProposalChange
  onSelect: (id: string) => void
}) {
  const [query, setQuery] = useState('')
  const groups = reviewFileGroups(changes)
  // Supporting files stay folded unless the reviewer asks for them or the
  // selected file is one of them, so review opens on documentation.
  const [showSupporting, setShowSupporting] = useState(false)
  const supportingVisible = showSupporting || groups.supporting.some((item) => item.id === selected.id) || (groups.documentation.length === 0 && groups.concurrent.length === 0)
  const sections = [
    { id: 'concurrent', label: 'Changed while the agent ran', changes: groups.concurrent, tone: 'warn' },
    { id: 'documentation', label: 'Pages, navigation, and assets', changes: groups.documentation, tone: '' },
    ...(supportingVisible ? [{ id: 'supporting', label: 'Evidence, configuration, and skills', changes: groups.supporting, tone: '' }] : []),
  ].filter((section) => section.changes.length > 0)
  const needle = query.trim().toLocaleLowerCase()
  const byPath = (left: ProposalChange, right: ProposalChange) => left.path.localeCompare(right.path)
  const filteredSections = sections
    .map((section) => ({ ...section, changes: [...section.changes].filter((item) => !needle || item.path.toLocaleLowerCase().includes(needle)).sort(byPath) }))
    .filter((section) => section.changes.length > 0)
  const matchingFiles = filteredSections.reduce((count, section) => count + section.changes.length, 0)
  const decision = (item: ProposalChange): 'accepted' | 'rejected' | 'partial' | 'pending' => {
    if (item.hunks.length === 0) return 'pending'
    if (item.hunks.every((hunk) => hunk.acceptedAt)) return 'accepted'
    if (item.hunks.every((hunk) => hunk.rejectedAt)) return 'rejected'
    return item.hunks.some((hunk) => hunk.acceptedAt || hunk.rejectedAt) ? 'partial' : 'pending'
  }

  return <nav class="review-file-list" aria-label="Changed files">
    {changes.length > 8 && <label class="review-file-search">
      <span class="sr-only">Search changed files</span>
      <Icon name="search" size={15} />
      <input class="input" type="search" value={query} placeholder="Filter files…" onInput={(event) => setQuery(event.currentTarget.value)} />
    </label>}
    {matchingFiles > 0
      ? filteredSections.map((section) => <section key={section.id} class={`review-file-group ${section.tone}`} aria-label={section.label}>
        <header><span class="kicker">{section.label}</span><small>{section.changes.length}</small></header>
        {section.changes.map((item) => {
          const state = decision(item)
          return <button type="button" key={item.id} class={`review-file-row ${selected.id === item.id ? 'active' : ''} ${state}`} aria-current={selected.id === item.id ? 'true' : undefined} title={item.path} onClick={() => onSelect(item.id)}>
            <b class={`review-file-kind ${item.kind}`} aria-hidden="true">{item.kind === 'added' ? 'A' : item.kind === 'deleted' ? 'D' : 'M'}</b>
            <span class="review-file-path">{item.path}</span>
            {state === 'accepted' && <Icon name="check" size={13} />}
            {state === 'rejected' && <Icon name="close" size={13} />}
            {state === 'partial' && <i class="review-file-partial" title="Partly decided" />}
          </button>
        })}
      </section>)
      : <div class="review-file-search-empty"><strong>No matching files</strong><small>Try a filename or folder path.</small></div>}
    {groups.supporting.length > 0 && !needle && <button type="button" class="review-file-group-toggle" aria-expanded={supportingVisible} onClick={() => setShowSupporting(!supportingVisible)}>
      <Icon name="chevronRight" size={12} />{supportingVisible ? 'Hide' : 'Show'} {groups.supporting.length} supporting file{groups.supporting.length === 1 ? '' : 's'}
    </button>}
  </nav>
}

function proposalChangeCounts(changes: ProposalChange[]): { added: number; modified: number; deleted: number } {
  return changes.reduce((counts, change) => {
    if (change.kind === 'added') counts.added += 1
    else if (change.kind === 'deleted') counts.deleted += 1
    else counts.modified += 1
    return counts
  }, { added: 0, modified: 0, deleted: 0 })
}

function appliedPageText(proposal: Proposal): string {
  const pages = proposal.changes.filter((change) => change.category === 'page' && change.kind !== 'deleted' && (proposal.status === 'applied' || change.hunks.some((hunk) => hunk.acceptedAt))).length
  return pages > 0 ? `${pages} page${pages === 1 ? '' : 's'} applied.` : 'The accepted files were applied.'
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
/** A deploy step line, with or without the arrival-time stamp the control center adds. */
const DEPLOY_STEP_LINE = /^\s*(?:\d{2}:\d{2}:\d{2}\s+)?([✓✗])\s+(.+)$/

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
    const match = DEPLOY_STEP_LINE.exec(stripAnsi(raw))
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
function DeployProgress({ job, generator, act, streamConnected, onDismiss, siteUrl }: {
  job: UiJob
  generator: string | undefined
  act: Action
  streamConnected: boolean
  onDismiss?: (() => void) | undefined
  /** The published site, offered once the deployment has finished. */
  siteUrl?: string | undefined
}) {
  const log = useRef<HTMLPreElement>(null)
  // A successful run folds its log away; anything still running or failed keeps it open.
  const [logOpen, setLogOpen] = useState(job.status !== 'succeeded')
  const dryRun = job.type === 'deploy:dry-run'
  const exporting = job.type === 'export'
  const { steps, percent } = deploySteps(job, deployStepLabels(generator, dryRun, exporting))
  const running = job.status === 'running'
  const active = steps.find((step) => step.status === 'running')
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [job.lines.length, logOpen])
  const signInExpired = job.status === 'failed' && job.lines.some((line) => isSignInFailure(line))
  const headline = running
    ? active?.label ?? (exporting ? 'Exporting static site' : dryRun ? 'Validating deployment' : 'Publishing to Doxbrix')
    : job.status === 'succeeded'
      ? exporting ? 'Static site exported' : dryRun ? 'Deployment is valid' : 'Documentation published'
      : job.status === 'cancelled' ? exporting ? 'Export cancelled' : 'Publish cancelled' : exporting ? 'Export failed' : 'Publish failed'
  // A deploy started from the page header must be visible without hunting
  // for it two screens down: bring a new run's panel into view once.
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    if (job.status === 'running') panel.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [job.id])
  return <section ref={panel} class={`panel deploy-progress ${job.status}`} aria-live="polite">
    {signInExpired && <Note tone="warn"><span>Doxbrix did not accept the saved sign-in, so nothing was uploaded. It may have expired, been revoked, or belong to a different Doxbrix server. Choose <strong>Sign in with browser</strong> above, then deploy again.</span></Note>}
    <header class="panel-head deploy-progress-head">
      <span class={`deploy-progress-icon ${job.status}`}>
        <Icon name={running ? 'publish' : job.status === 'succeeded' ? 'check' : 'alert'} size={17} />
      </span>
      <div class="panel-title deploy-progress-title">
        <h2>{exporting ? 'Latest export' : dryRun ? 'Latest dry run' : 'Latest publish'}</h2>
        <p><strong>{headline}</strong> · {running ? `started ${timeText(job.startedAt)}` : exporting ? 'Self-hostable folder and zip on this computer' : dryRun ? 'Validation only, nothing uploaded' : job.status !== 'succeeded' ? 'Nothing was changed on the live site' : siteUrl ? `Live at ${hostOf(siteUrl)}` : 'Published to Doxbrix'}</p>
      </div>
      <div class="panel-actions">
        {running
          ? <Badge tone={streamConnected ? 'info' : 'warn'}>{streamConnected ? 'In progress' : 'Reconnecting…'}</Badge>
          : <Badge tone={statusTone(job.status)}>{job.status === 'succeeded' ? (exporting ? 'Exported' : dryRun ? 'Valid' : 'Live') : job.status === 'failed' ? 'Failed' : statusLabel(job.status)}</Badge>}
        {!running && job.status === 'succeeded' && siteUrl && !exporting && !dryRun && <a class="btn secondary sm" href={siteUrl} target="_blank" rel="noreferrer"><Icon name="external" size={14} />View site</a>}
        {running && <Button size="sm" tone="danger" icon="stop" onClick={() => void act(() => post(`/api/jobs/${job.id}/cancel`), 'Deployment stopped')}>Stop</Button>}
        {!running && onDismiss && <Button size="sm" tone="ghost" icon="close" onClick={onDismiss}>Dismiss</Button>}
      </div>
    </header>
    {running && <div class="deploy-progress-bar">
      <div class="deploy-progress-track running"><i style={{ width: `${percent}%` }} /></div>
      <span>{percent}%</span>
    </div>}
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
      {logOpen && <pre ref={log} class="terminal live-terminal">{job.lines.length > 0 ? displayLogLines(job.lines).join('\n') : 'Starting deployment…'}</pre>}
    </div>
  </section>
}

/** The pre-publish checklist: what Doxloop verified before anything is uploaded. */
type PublishCheck = { state: 'ok' | 'warn' | 'bad'; title: string; detail: string; action?: { label: string; run: () => void } }

function PublishChecklist({ checks }: { checks: PublishCheck[] }) {
  return <ul class="publish-checklist" aria-label="Before publishing">
    {checks.map((check) => <li key={check.title} class={check.state}>
      <span class="publish-check-mark" aria-hidden="true"><Icon name={check.state === 'ok' ? 'check' : 'alert'} size={13} /></span>
      <span class="publish-check-copy"><strong>{check.title}</strong><small>{check.detail}</small></span>
      {check.action && <button type="button" class="btn link" onClick={check.action.run}>{check.action.label}</button>}
    </li>)}
  </ul>
}

/** Public or private, as radio rows. */
function VisibilityRows({ value, onChange }: { value: 'public' | 'private'; onChange: (value: 'public' | 'private') => void }) {
  return <div class="radio-rows publish-visibility" role="radiogroup" aria-label="Who can read it">
    <button type="button" role="radio" aria-checked={value === 'public'} class={value === 'public' ? 'selected' : ''} onClick={() => onChange('public')}>
      <Icon name="globe" size={17} /><span><strong>Public</strong><small>Anyone with the link can read it. Search engines can index it.</small></span>
    </button>
    <button type="button" role="radio" aria-checked={value === 'private'} class={value === 'private' ? 'selected' : ''} onClick={() => onChange('private')}>
      <Icon name="lock" size={17} /><span><strong>Private</strong><small>Only people you invite in Doxbrix can open it.</small></span>
    </button>
  </div>
}

/** The device-code sign-in in progress: the code large, the fallback link, and when it expires. */
function DoxbrixSigningIn({ job, onCancel }: { job: UiJob; onCancel: () => void }) {
  const text = job.lines.join('\n')
  const link = /Open (https?:\/\/\S+)/.exec(text)?.[1]
  const code = /Enter code:\s*([A-Z0-9-]{4,})/.exec(text)?.[1]
  const minutes = Number(/The code expires in (\d+) minute/.exec(text)?.[1])
  const until = minutes && job.startedAt ? new Date(Date.parse(job.startedAt) + minutes * 60_000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : ''
  return <section class="publish-hero" role="status" aria-live="polite">
    <div class="publish-hero-head">
      <span class="publish-mark" aria-hidden="true"><Icon name="rocket" size={22} /></span>
      <div>
        <h2>Approve the sign-in in your browser</h2>
        <p>Doxbrix opened in a new tab. Check that it shows this code, then choose <strong>Approve</strong>. This page continues by itself.</p>
      </div>
    </div>
    <div class="publish-code">
      <span class="kicker">Your code</span>
      <code>{code ?? '…'}</code>
      <span class="publish-code-wait"><span class="spinner" />Waiting for approval{until && <> · the code works until {until}</>}</span>
    </div>
    <div class="publish-hero-foot">
      <span>{link ? <>Tab did not open? Go to <a href={link} target="_blank" rel="noreferrer">{link.replace(/^https?:\/\//, '')}</a></> : 'Starting the sign-in…'}</span>
      <Button onClick={onCancel}>Cancel sign-in</Button>
    </div>
  </section>
}

function Publish({ state, act, streamConnected, onError }: { state: UiState; act: Action; streamConnected: boolean; onError: (error: string) => void }) {
  const effective = state.effectiveDeployment!
  // The UI publishes to Doxbrix only; other targets remain available from the CLI.
  const [deployment, setDeployment, deploymentSync] = useSeededForm(() => ({ ...effective, target: 'doxbrix' as const }), JSON.stringify(effective))
  const chosenVisibility = state.project?.deployment?.visibility
  const [visibilityDialog, setVisibilityDialog] = useState<'public' | 'private' | null>(null)
  const [starting, setStarting] = useState(false)
  const [editingSite, setEditingSite] = useState(false)
  const [copied, setCopied] = useState(false)
  const account = state.account
  const signedIn = Boolean(account?.signedIn)
  const activeDeploy = state.jobs.find((job) => job.type.startsWith('deploy') && job.status === 'running')
  const busy = Boolean(activeDeploy || starting)
  const [dismissedDeployId, setDismissedDeployId] = useState<string>()
  const shownDeploy = activeDeploy ?? recentSettledJob(state.jobs, (job) => job.type.startsWith('deploy'), dismissedDeployId)
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
  const requests = useHistoryFeed<HistoryRequest>('/api/history?limit=50', (payload) => (payload.requests as HistoryRequest[]) ?? [], state.jobs, onError)
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
  const lastSuccess = deployments.entries.find((entry) => entry.status === 'succeeded' && entry.target === 'doxbrix')
  const recordedUrl = lastSuccess?.url
  const publishedUrl = siteUrl ?? (recordedUrl && !recordedUrl.includes('/editor?project=') ? recordedUrl : undefined)
  const published = Boolean(publishedUrl && lastSuccess)
  const slugSuffix = (() => {
    try {
      if (!publishedUrl || !deployment.slug) return '.sites.doxbrix.com'
      const host = new URL(publishedUrl).hostname
      return host.startsWith(`${deployment.slug}.`) ? host.slice(deployment.slug.length) : '.sites.doxbrix.com'
    } catch { return '.sites.doxbrix.com' }
  })()
  // Doxbrix may prefix a new site's host with the team, so an unpublished address is only the name.
  const address = publishedUrl ? hostOf(publishedUrl) : `${deployment.slug} · address confirmed on first publish`

  // What Doxloop checks before it uploads.
  const validation = validationState(state.validation)
  const waiting = validRuns(state.runs).filter((run) => OPEN_STATUSES.includes(run.status) && !run.archivedAt)
  const pageCount = validation.ok ? validation.result.pages.length : 0
  const errors = validation.ok ? validation.result.issues.filter((issue) => issue.severity === 'error') : []
  const checks: PublishCheck[] = [
    ...(validation.ok
      ? errors.length === 0
        ? [{ state: 'ok' as const, title: `${pageCount} page${pageCount === 1 ? ' passes' : 's pass'} validation`, detail: 'Links, navigation, and page names are publish-safe' }]
        : errors.slice(0, 3).map((issue) => ({ state: 'bad' as const, title: issue.code === 'duplicate-page-name' ? 'Two pages share a name' : `${issue.file ?? 'Documentation'} needs a fix`, detail: issue.message, action: { label: 'Open Docs', run: () => setLocation('pages', issue.file && /\.mdx?$/.test(issue.file) ? { path: issue.file } : {}, 'push') } }))
      : [{ state: 'warn' as const, title: 'Validation has not finished', detail: validation.reason }]),
    waiting.length === 0
      ? { state: 'ok', title: 'Nothing waiting in Review', detail: 'Every accepted change is included' }
      : { state: 'warn', title: `${waiting.length} proposal${waiting.length === 1 ? '' : 's'} waiting in Review`, detail: 'Publishing now leaves those changes out', action: { label: 'Review changes', run: () => setLocation('proposals', { proposal: waiting[0]!.id }, 'push') } },
    // The address already belongs to a site this workspace never published (another project, or an older copy).
    ...(siteUrl && !lastSuccess && !deployments.loading
      ? [{ state: 'warn' as const, title: 'This address already has a Doxbrix site', detail: `${hostOf(siteUrl)} was published from another workspace. Publishing replaces it; change the address to keep both.`, action: { label: 'Change address', run: () => setEditingSite(true) } }]
      : []),
  ]
  const blocked = errors.length > 0 || !validation.ok

  // Accepted since the last successful publish: what the live site does not show yet.
  const since = lastSuccess ? Date.parse(lastSuccess.startedAt) : undefined
  const pending = since === undefined ? [] : requests.entries.filter((entry) =>
    ['applied', 'completed', 'partially-applied'].includes(entry.status) && Date.parse(entry.finishedAt ?? entry.createdAt) > since && entry.pagesChanged > 0)
  // Direct edits (the editor, glossary, branding) record a count without a page list; show the request itself.
  const pendingPages = [...new Map(pending.flatMap((entry) => (entry.pages?.length
    ? entry.pages.filter((page) => page.decision !== 'rejected').map((page) => [page.path, { path: page.path, title: page.title, changeKind: page.changeKind }] as const)
    : [[`request:${entry.id}`, { path: historyActionLabel(entry.kind), title: historyInstruction(entry), changeKind: 'modified' as const }] as const]))).values()]

  const signInExpired = shownDeploy?.status === 'failed' && shownDeploy.lines.some((line) => isSignInFailure(line))
  const startSignIn = () => void act(() => post('/api/auth/login', { apiUrl: deployment.apiUrl }), 'Browser sign-in started')
  const saveVisibility = async (visibility: 'private' | 'public') => {
    const next = { ...deployment, visibility }
    setDeployment(next)
    return act(() => patch('/api/project', { deployment: next }), undefined)
  }
  const publish = async () => {
    if (busy || blocked || !signedIn) return
    setStarting(true)
    try {
      const visibility = isPublic ? 'public' : 'private'
      // The first publish records the choice made on this page; later ones use the saved one.
      if (!chosenVisibility && (await saveVisibility(visibility)) === undefined) return
      await act(() => post('/api/deploy', { ...deployment, target: 'doxbrix', visibility, public: visibility === 'public', dryRun: false }), 'Publishing to Doxbrix')
    } finally {
      setStarting(false)
    }
  }
  const saveSite = async () => {
    const result = await act(() => patch('/api/project', { deployment: { ...deployment, target: 'doxbrix' } }), 'Site settings saved')
    if (result !== undefined) setEditingSite(false)
  }
  const chooseVisibility = (next: 'public' | 'private') => {
    if (next === (isPublic ? 'public' : 'private')) return
    // Only a live site has readers to warn about; before the first publish the choice just applies.
    if (published) { setVisibilityDialog(next); return }
    if (chosenVisibility) void saveVisibility(next)
    else setDeployment({ ...deployment, visibility: next })
  }
  const copyAddress = () => {
    if (!publishedUrl) return
    void navigator.clipboard?.writeText(publishedUrl).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600) }).catch(() => undefined)
  }
  const title = state.project?.title ?? 'your documentation'
  const summary = `${pageCount} page${pageCount === 1 ? '' : 's'} · ${isPublic ? 'public' : 'private'}`

  const siteSettings = <Panel class="publish-site" title="Site" {...(editingSite ? { description: 'Changes apply from the next publish.' } : {})} actions={editingSite
    ? <><Button size="sm" tone="ghost" onClick={() => { deploymentSync.resync(); setEditingSite(false) }}>Cancel</Button><Button size="sm" tone="primary" icon="check" onClick={() => void saveSite()}>Save</Button></>
    : <Button size="sm" onClick={() => setEditingSite(true)}>Change</Button>}>
    {editingSite
      ? <>
        <Field label="Site name"><Input value={deployment.name} onInput={(event) => setDeployment({ ...deployment, name: event.currentTarget.value })} /></Field>
        <Field label="Address" hint={publishedUrl ? 'The part before the Doxbrix domain.' : 'Doxbrix may add your team as a prefix; the full address is shown after the first publish.'}><div class="input-addon-row"><Input class="mono-input" value={deployment.slug} onInput={(event) => setDeployment({ ...deployment, slug: event.currentTarget.value })} /><span class="input-addon">{slugSuffix}</span></div></Field>
      </>
      : <div class="vrows">
        <div class="vrow"><span class="vrow-label">Address</span><span class="vrow-value mono">{address}</span></div>
        <div class="vrow"><span class="vrow-label">Site name</span><span class="vrow-value">{deployment.name}</span></div>
      </div>}
  </Panel>

  return <div class="publish-page publish-doxbrix">
    {visibilityDialog && <div class="proposal-ready-scrim" role="presentation">
      <section class="proposal-ready-dialog visibility-dialog" role="dialog" aria-modal="true" aria-labelledby="visibility-dialog-title">
        <button class="proposal-ready-close" type="button" aria-label="Close" onClick={() => setVisibilityDialog(null)}><Icon name="close" size={16} /></button>
        <span class="proposal-ready-icon"><Icon name={visibilityDialog === 'public' ? 'globe' : 'lock'} size={24} /></span>
        <div>
          <h2 id="visibility-dialog-title">Make the site {visibilityDialog}?</h2>
          <p>{visibilityDialog === 'public' ? 'Anyone with the link will be able to read it.' : 'Only people you invite in Doxbrix will be able to open it.'} This applies from the next publish.</p>
        </div>
        <footer>
          <Button tone="ghost" onClick={() => setVisibilityDialog(null)}>Cancel</Button>
          <Button tone="primary" icon="check" onClick={() => { const next = visibilityDialog; setVisibilityDialog(null); void saveVisibility(next) }}>Make it {visibilityDialog}</Button>
        </footer>
      </section>
    </div>}

    <PageHeader kicker="Publish" title="Publish" description={published ? 'Your documentation is live on Doxbrix.' : 'Your documentation, live on Doxbrix.'} />
    {deploymentSync.stale && <StaleFormNotice onResync={deploymentSync.resync} />}

    {/* Connect: signed out, or signing in. */}
    {!signedIn && (signingIn
      ? <DoxbrixSigningIn job={signingIn} onCancel={() => void act(() => post(`/api/jobs/${signingIn.id}/cancel`), 'Sign-in cancelled')} />
      : <section class="publish-hero">
        <div class="publish-hero-head">
          <span class="publish-mark" aria-hidden="true"><Icon name="rocket" size={22} /></span>
          <div>
            <h2>{published ? 'Sign in to Doxbrix to publish changes' : `Put ${title} online`}</h2>
            <p>Doxbrix hosts your documentation with search, a reader assistant, and access control, free to start. Sign in once, choose who can read it, and publish.</p>
          </div>
        </div>
        <div class="publish-connect">
          <Icon name="key" size={20} />
          <span><strong>Connect your Doxbrix account</strong><small>{account?.signedInElsewhere?.length
            ? `You are signed in to ${account.signedInElsewhere.map(hostOf).join(', ')}; this project publishes to ${hostOf(account.apiUrl)}. That sign-in is kept.`
            : 'Opens your browser. You approve once; the session stays on this computer.'}</small></span>
          <Button tone="primary" icon="external" onClick={startSignIn}>Sign in to Doxbrix</Button>
        </div>
        {failedLogin && <Note tone="warn"><span class="note-body"><strong>Sign-in did not complete.</strong> {loginFailureText(failedLogin)}<span class="note-actions"><Button size="sm" onClick={() => setDismissedLoginId(failedLogin.id)}>Dismiss</Button></span></span></Note>}
      </section>)}

    {/* Live: the site, with Copy and Visit. */}
    {published && <section class="publish-live" aria-label="Live site">
      <div class="publish-live-meta">
        <Badge tone="good">Live</Badge>
        <span>{isPublic ? 'Public' : 'Private'} · published {timeText(lastSuccess!.startedAt)}</span>
      </div>
      <div class="publish-live-address">
        <a class="mono" href={publishedUrl} target="_blank" rel="noreferrer">{hostOf(publishedUrl!)}</a>
        <Button icon="copy" aria-label="Copy site address" onClick={copyAddress}>{copied ? 'Copied' : 'Copy'}</Button>
        <a class="btn primary md" href={publishedUrl} target="_blank" rel="noreferrer"><Icon name="external" size={16} />Visit site</a>
      </div>
      <div class="publish-live-stats">
        <span><Icon name="file" size={15} />{lastSuccess!.pagesCount ?? pageCount} pages</span>
        <span><Icon name={isPublic ? 'globe' : 'lock'} size={15} />{isPublic ? 'Anyone with the link' : 'Invited readers only'}</span>
        <span><Icon name="sparkle" size={15} />Reader assistant included</span>
      </div>
    </section>}

    {signInExpired && <section class="publish-attention" role="alert">
      <span class="publish-attention-icon"><Icon name="key" size={18} /></span>
      <div><h2>Doxbrix did not accept the saved sign-in</h2><p>It expired, was revoked, or belongs to another Doxbrix server, so nothing was uploaded. Sign in again; your changes are still ready.</p></div>
      <Button tone="primary" icon="key" onClick={startSignIn}>Sign in again</Button>
    </section>}

    {shownDeploy && <DeployProgress job={shownDeploy} generator={state.project?.generator} act={act} streamConnected={streamConnected} siteUrl={publishedUrl} onDismiss={shownDeploy.status === 'running' ? undefined : () => setDismissedDeployId(shownDeploy.id)} />}

    {signedIn && !published && <div class="publish-account-row">
      <span class="avatar">{(account?.user?.name || account?.user?.email || '?').slice(0, 2).toUpperCase()}</span>
      <span class="publish-account-identity"><strong>Signed in to Doxbrix</strong><small>{account?.user?.email}</small></span>
      <Button size="sm" tone="ghost" icon="logout" onClick={() => void act(() => post('/api/auth/logout'), 'Signed out')}>Switch account</Button>
    </div>}

    {published && pendingPages.length > 0 && <Panel class="publish-changes" title="Changes since the last publish" description="Saved or accepted since then, not yet on the live site." actions={<Badge tone="warn">{pendingPages.length} page{pendingPages.length === 1 ? '' : 's'}</Badge>} flush>
      <ul class="publish-change-list">
        {pendingPages.slice(0, 8).map((page) => <li key={page.path}><code>{page.changeKind === 'added' ? 'A' : page.changeKind === 'deleted' ? 'D' : 'M'}</code><span>{page.title || page.path}</span><small>{page.path}</small></li>)}
      </ul>
    </Panel>}

    <Panel class="publish-ready" title={published ? 'Before the next publish' : 'Ready to publish'} description="Doxloop checks everything before it uploads." flush>
      <PublishChecklist checks={checks} />
    </Panel>

    {!published && <Panel class="publish-visibility-panel" title="Who can read it" description="You can change this later; it applies from the next publish.">
      <VisibilityRows value={isPublic ? 'public' : 'private'} onChange={chooseVisibility} />
    </Panel>}
    {!published && siteSettings}

    <div class="publish-bar">
      <span><strong>{published ? (pendingPages.length ? `${pendingPages.length} changed page${pendingPages.length === 1 ? '' : 's'} to publish` : 'The live site is up to date') : summary}</strong>
        <small>{!signedIn ? 'Sign in to Doxbrix to publish.' : blocked ? 'Fix the checks above to publish.' : 'Usually live in under a minute.'}</small></span>
      <Button class="publish-deploy-button" tone="primary" icon="publish" busy={busy} disabled={!signedIn || blocked || busy} onClick={() => void publish()}>{published ? (pendingPages.length ? `Publish ${pendingPages.length} change${pendingPages.length === 1 ? '' : 's'}` : 'Publish again') : 'Publish to Doxbrix'}</Button>
    </div>

    {published && <details class="publish-settings">
      <summary><Icon name="settings" size={15} />Site settings<small>{address} · {isPublic ? 'public' : 'private'}</small></summary>
      <div class="publish-settings-body">
        <Panel class="publish-visibility-panel" title="Who can read it"><VisibilityRows value={isPublic ? 'public' : 'private'} onChange={chooseVisibility} /></Panel>
        {siteSettings}
        {signedIn && <div class="publish-account-row">
          <span class="avatar">{(account?.user?.name || account?.user?.email || '?').slice(0, 2).toUpperCase()}</span>
          <span class="publish-account-identity"><strong>Signed in to Doxbrix</strong><small>{account?.user?.email}</small></span>
          <Button size="sm" tone="ghost" icon="logout" onClick={() => void act(() => post('/api/auth/logout'), 'Signed out')}>Sign out</Button>
        </div>}
      </div>
    </details>}

    <Panel class="history-panel" title="History" flush>
      <DeploymentHistory {...deployments} />
    </Panel>
  </div>
}

const SETTINGS_SECTIONS = [
  ['general', 'General', 'Project identity and defaults', 'settings'],
  ['experience', 'Audience and voice', 'Writing style and accessibility', 'book'],
  ['capture', 'Screenshots', 'Application screenshots', 'preview'],
  ['branding', 'Branding', 'Logo, colours, and fonts', 'sparkle'],
  ['tools', 'Generator', 'Active documentation generator', 'publish'],
  ['monitoring', 'Monitoring', 'Schedule and budgets', 'bell'],
] as const

type SettingsSection = typeof SETTINGS_SECTIONS[number][0]

/** Which sheet is open: one per setting row, or a compound editor. */
type SettingsSheet =
  | 'title' | 'agent'
  | 'primaryAudience' | 'audiences' | 'experienceLevel' | 'locale' | 'accessibilityTarget' | 'tone' | 'outcomes' | 'preferredExamples' | 'designDirection' | 'standardsProfile' | 'styleGuide' | 'terms' | 'exclusions' | 'instructions'
  | 'applicationUrl' | 'signIn' | 'screenshotPolicy' | 'viewport'

const SCREENSHOT_POLICIES: Record<string, string> = { requested: 'Only when requested', auto: 'Automatically for UI workflows', off: 'Never' }
const EXPERIENCE_LEVELS: Record<string, string> = { beginner: 'Beginner', intermediate: 'Intermediate', advanced: 'Advanced', mixed: 'Mixed' }

function Settings({ state, act, onError }: { state: UiState; act: Action; onError: (error: string) => void }) {
  const project = state.project!
  const params = useSearchParams()
  const requestedSection = params.get('section')
  const section: SettingsSection = SETTINGS_SECTIONS.some(([id]) => id === requestedSection) ? requestedSection as SettingsSection : 'general'
  const setSection = (next: SettingsSection) => setLocation('settings', { section: next })
  // Forms reseed from the project after a save or a reload; unsaved edits are
  // kept and flagged instead of being replaced underneath the reader.
  const [identity, setIdentity, identitySync] = useSeededForm(() => ({ title: project.title, defaultAgent: project.defaultAgent ?? '', defaultModel: project.defaultModel ?? '' }), JSON.stringify([project.title, project.defaultAgent, project.defaultModel]))
  const [docs, setDocs, docsSync] = useSeededForm(() => ({ ...project.documentation, audiencesText: project.documentation.audiences?.join(', ') ?? '', customInstructions: project.documentation.customInstructions ?? '', outcomesText: project.documentation.priorityOutcomes?.join('\n') ?? '', preferredExamplesText: project.documentation.preferredExamples?.join(', ') ?? '', toneText: project.documentation.tone.join(', '), exclusionsText: project.documentation.exclusions.join('\n'), terms: termsFromRecord(project.documentation.terminology) }), JSON.stringify(project.documentation))
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
  const [sheet, setSheet] = useState<SettingsSheet | null>(null)
  /** The form values when the sheet opened, restored on Cancel. */
  const [snapshot, setSnapshot] = useState<{ identity: typeof identity; docs: typeof docs; application: typeof application } | null>(null)
  const [monitoringOpen, setMonitoringOpen] = useState(false)
  // The sign-in row shows what is stored; the sheet's panel manages it.
  const [captureAuth, setCaptureAuth] = useState<CaptureAuthState>()
  const applicationConfigured = Boolean(project.application)
  useEffect(() => {
    if (!applicationConfigured) { setCaptureAuth(undefined); return }
    let live = true
    void api<CaptureAuthState>('/api/application/auth').then((auth) => { if (live) setCaptureAuth(auth) }).catch(() => undefined)
    return () => { live = false }
  }, [applicationConfigured, sheet])
  const applicationPayload = { baseUrl: application.baseUrl, source: application.source, readyPath: application.readyPath, screenshots: { policy: application.policy, highlight: application.highlight, viewport: { width: application.viewportWidth, height: application.viewportHeight }, startPath: application.startPath, workflow: application.workflow }, authentication: { loginPath: application.loginPath } }
  const testApplication = async () => {
    setTestingApplication(true)
    try { setApplicationReadiness(await post<ApplicationReadiness>('/api/application/readiness', applicationPayload)) }
    catch { setApplicationReadiness(undefined) }
    finally { setTestingApplication(false) }
  }
  const saveIdentity = () => act(() => patch('/api/project', identity), 'Identity settings saved')
  const saveDocs = () => act(() => patch('/api/project', { documentation: { ...docs, audiences: splitComma(docs.audiencesText), priorityOutcomes: splitLines(docs.outcomesText), preferredExamples: splitComma(docs.preferredExamplesText), tone: splitComma(docs.toneText), exclusions: docs.exclusionsText.split('\n').map((item) => item.trim()).filter(Boolean), terminology: recordFromTerms(docs.terms) } }), 'Documentation preferences saved')
  const saveApplication = () => act(() => patch('/api/project', { application: applicationPayload }), 'Application settings saved')
  const unsavedTerms = JSON.stringify(recordFromTerms(docs.terms)) !== JSON.stringify(project.documentation.terminology)
  const openSheet = (next: SettingsSheet) => { setSnapshot({ identity, docs, application }); setSheet(next) }
  const cancelSheet = () => {
    if (snapshot) { setIdentity(snapshot.identity); setDocs(snapshot.docs); setApplication(snapshot.application) }
    setSheet(null)
  }
  const [sheetSaving, setSheetSaving] = useState(false)
  const commitSheet = async (save: () => Promise<unknown>) => {
    setSheetSaving(true)
    try {
      const result = await save()
      if (result !== undefined) setSheet(null)
    } finally { setSheetSaving(false) }
  }
  const agentSummary = identity.defaultAgent ? `${agentLabel(identity.defaultAgent)}${identity.defaultModel ? ` · ${identity.defaultModel}` : ''}` : 'Choose per run'
  const listSummary = (items: string[], limit = 3): string => items.length === 0 ? '' : items.length <= limit ? items.join(', ') : `${items.slice(0, limit).join(', ')} · ${items.length - limit} more`
  const generator = state.generators.find((entry) => entry.id === project.generator)
  const sync = project.sync
  const budgetSummary = [
    sync.budget?.maxMinutes ? `${sync.budget.maxMinutes} min` : '',
    sync.budget?.maxRunsPerDay ? `${sync.budget.maxRunsPerDay} runs per day` : '',
    sync.budget?.maxUsd ? `$${sync.budget.maxUsd.toFixed(2)} cap` : '',
  ].filter(Boolean).join(' · ')
  const docsField = (label: string, key: 'primaryAudience' | 'audiencesText' | 'locale' | 'accessibilityTarget' | 'toneText' | 'outcomesText' | 'preferredExamplesText' | 'designDirection' | 'standardsProfile' | 'styleGuide', placeholder?: string, hint?: string) =>
    <Field label={label} {...(hint ? { hint } : {})}><Input value={docs[key] ?? ''} {...(placeholder ? { placeholder } : {})} onInput={(event) => setDocs({ ...docs, [key]: event.currentTarget.value })} /></Field>

  const sheetSpec = (): { title: string; body: import('preact').ComponentChildren; save: () => Promise<unknown>; disabled?: boolean } | null => {
    switch (sheet) {
      case 'title': return { title: 'Site title', save: saveIdentity, body: <Field label="Site title"><Input value={identity.title} onInput={(event) => setIdentity({ ...identity, title: event.currentTarget.value })} /></Field> }
      case 'agent': return { title: 'Default coding agent', save: saveIdentity, body: <>
        <Field label="Default documentation agent"><Select value={identity.defaultAgent} onChange={(event) => { const agent = event.currentTarget.value; setIdentity({ ...identity, defaultAgent: agent, defaultModel: agent === identity.defaultAgent ? identity.defaultModel : defaultModelForAgent(agent) }) }}><option value="">Choose per run</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select></Field>
        <Field label="Default model" hint={identity.defaultAgent ? `Used by ${agentLabel(identity.defaultAgent)} runs unless a run picks another model. Search suggested models or enter another model ID.` : 'Choose a default agent to set its model.'}><Combo value={identity.defaultModel} options={agentModels(identity.defaultAgent).map((model) => [model.id, model.label] as const)} disabled={!identity.defaultAgent} placeholder="Agent default" onValueChange={(value) => setIdentity({ ...identity, defaultModel: value })} /></Field>
        <details class="agent-capabilities-details" open={identity.defaultAgent === 'gemini'}>
          <summary>What each assistant supports</summary>
          <AgentCapabilityMatrix selected={identity.defaultAgent || undefined} />
        </details>
      </> }
      case 'primaryAudience': return { title: 'Primary audience', save: saveDocs, body: docsField('Primary audience', 'primaryAudience', 'Developers integrating our API') }
      case 'audiences': return { title: 'Audiences', save: saveDocs, body: docsField('Audiences', 'audiencesText', 'Developers, API consumers, administrators', 'Separate multiple audiences with commas') }
      case 'experienceLevel': return { title: 'Experience level', save: saveDocs, body: <Field label="Experience level"><Select value={docs.experienceLevel ?? 'intermediate'} onChange={(event) => setDocs({ ...docs, experienceLevel: event.currentTarget.value })}>{Object.entries(EXPERIENCE_LEVELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field> }
      case 'locale': return { title: 'Locale', save: saveDocs, body: docsField('Locale', 'locale', 'en-US') }
      case 'accessibilityTarget': return { title: 'Accessibility target', save: saveDocs, body: docsField('Accessibility target', 'accessibilityTarget', 'WCAG 2.2 AA') }
      case 'tone': return { title: 'Tone', save: saveDocs, body: docsField('Tone', 'toneText', 'clear, direct, helpful', 'Separate several qualities with commas') }
      // One outcome per line: outcomes are sentences and contain commas, so
      // a comma list split a single goal into fragments on every save.
      case 'outcomes': return { title: 'Priority outcomes', save: saveDocs, body: <Field label="Priority outcomes" hint="What readers must be able to do, one outcome per line."><Textarea rows={5} value={docs.outcomesText ?? ''} placeholder={'Install the product and send the first request\nDiagnose and fix common errors'} onInput={(event) => setDocs({ ...docs, outcomesText: event.currentTarget.value })} /></Field> }
      case 'preferredExamples': return { title: 'Preferred examples', save: saveDocs, body: docsField('Preferred examples', 'preferredExamplesText', 'TypeScript, curl', 'Languages and tools examples are written in') }
      case 'designDirection': return { title: 'Design direction', save: saveDocs, body: docsField('Design direction', 'designDirection', 'Compact, task-led developer documentation') }
      case 'standardsProfile': return { title: 'Standards profile', save: saveDocs, body: docsField('Standards profile', 'standardsProfile') }
      case 'styleGuide': return { title: 'Style guide', save: saveDocs, body: docsField('Style guide', 'styleGuide') }
      case 'terms': return { title: 'Preferred terminology', save: saveDocs, body: <Field label="Preferred terminology" hint="Product vocabulary with its meaning or preferred wording. Feeds every run and the glossary page." wide><TermsEditor value={docs.terms} onChange={(terms) => setDocs({ ...docs, terms })} /></Field> }
      case 'exclusions': return { title: 'Content exclusions', save: saveDocs, body: <Field label="Content exclusions" hint="One item per line"><Textarea rows={6} value={docs.exclusionsText} onInput={(event) => setDocs({ ...docs, exclusionsText: event.currentTarget.value })} /></Field> }
      case 'instructions': return { title: 'Instructions', save: saveDocs, body: <Field label="Instructions" hint="Additional guidance reused for future documentation runs" wide><Textarea rows={8} value={docs.customInstructions} placeholder="Use concise explanations and include TypeScript examples." onInput={(event) => setDocs({ ...docs, customInstructions: event.currentTarget.value })} /></Field> }
      case 'applicationUrl': return { title: 'Application URL', save: saveApplication, disabled: !application.baseUrl, body: <>
        <Field label="Application base URL" hint="A safe local or test instance of the product; screenshots are taken there."><Input value={application.baseUrl} placeholder="http://localhost:3000" onInput={(event) => setApplication({ ...application, baseUrl: event.currentTarget.value })} /></Field>
        <Field label="Product source" hint="The connected source this application is built from."><Select value={application.source} onChange={(event) => setApplication({ ...application, source: event.currentTarget.value })}><option value="">None</option>{project.sources.map((source) => <option key={source.name} value={source.name}>{source.name}</option>)}</Select></Field>
        <Field label="Ready path" hint="A path that answers once the application is up, for example /health."><Input value={application.readyPath} placeholder="/health" onInput={(event) => setApplication({ ...application, readyPath: event.currentTarget.value })} /></Field>
        <Field label="Default starting route" hint="Where capture sessions begin."><Input value={application.startPath} placeholder="/settings/team" onInput={(event) => setApplication({ ...application, startPath: event.currentTarget.value })} /></Field>
      </> }
      case 'signIn': return { title: 'Sign-in', save: saveApplication, disabled: !application.baseUrl, body: <>
        <Field label="Sign-in route" hint="Where the browser sign-in opens; leave empty when the app redirects to its login page"><Input value={application.loginPath} placeholder="/login" onInput={(event) => setApplication({ ...application, loginPath: event.currentTarget.value })} /></Field>
        <CaptureSignInPanel embedded application={applicationPayload} configured={applicationConfigured} onError={onError} onChanged={() => setApplicationReadiness(undefined)} />
      </> }
      case 'screenshotPolicy': return { title: 'Screenshot policy', save: saveApplication, disabled: !application.baseUrl, body: <>
        <Field label="Screenshot policy"><Select value={application.policy} onChange={(event) => setApplication({ ...application, policy: event.currentTarget.value })}>{Object.entries(SCREENSHOT_POLICIES).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
        <Field label="Capture workflow guidance" hint="Safe test state, authentication, actions, and expected outcomes" wide><Textarea rows={5} value={application.workflow} placeholder="Reuse the signed-in demo workspace and synthetic data only." onInput={(event) => setApplication({ ...application, workflow: event.currentTarget.value })} /></Field>
      </> }
      case 'viewport': return { title: 'Viewport', save: saveApplication, disabled: !application.baseUrl, body: <>
        <Field label="Viewport width"><Input type="number" min="320" max="3840" value={application.viewportWidth} onInput={(event) => setApplication({ ...application, viewportWidth: event.currentTarget.value })} /></Field>
        <Field label="Viewport height"><Input type="number" min="320" max="2160" value={application.viewportHeight} onInput={(event) => setApplication({ ...application, viewportHeight: event.currentTarget.value })} /></Field>
        <Toggle checked={application.highlight} onChange={(checked) => setApplication({ ...application, highlight: checked })} label="Highlight captured controls" />
      </> }
      default: return null
    }
  }
  const openSheetSpec = sheetSpec()

  return <>
    <PageHeader kicker="Settings" title="Settings" description="Choose a row to change it. Nothing is saved until you choose Save." />
    <div class="settings">
      <nav class="settings-nav" aria-label="Settings sections">
        {SETTINGS_SECTIONS.map(([id, label, detail, icon]) => <button key={id} class={section === id ? 'active' : ''} aria-pressed={section === id} onClick={() => setSection(id)}>
          <Icon name={icon} size={16} /><span><strong>{label}</strong><small>{detail}</small></span>
        </button>)}
      </nav>
      <div class="stack">
        {section === 'general' && <>
          {identitySync.stale && <StaleFormNotice onResync={identitySync.resync} />}
          <Panel title="Project identity" flush>
            <div class="vrows">
              <SettingRow label="Site title" value={identity.title} onOpen={() => openSheet('title')} />
              <SettingRow label="Default coding agent" value={agentSummary} onOpen={() => openSheet('agent')} />
              <SettingRow label="Content directory" value={<code>{project.contentDir || 'Project root'}</code>} />
              <SettingRow label="Documentation generator" value={generatorLabel(state.generators, project.generator)} onOpen={() => setSection('tools')} />
              <SettingRow label="Project folder" value={<code>{state.root ?? state.cwd}</code>} />
            </div>
          </Panel>
        </>}

        {section === 'experience' && <>
          {docsSync.stale && <StaleFormNotice onResync={docsSync.resync} />}
          <Panel title="Audience and voice" flush>
            <div class="vrows">
              {/* The wizard writes the audiences joined as the primary audience; the row only earns its place when someone wrote something different. */}
              {(docs.primaryAudience ?? '').trim() && (docs.primaryAudience ?? '').trim() !== splitComma(docs.audiencesText).join(', ') && <SettingRow label="Primary audience" value={docs.primaryAudience ?? ''} onOpen={() => openSheet('primaryAudience')} />}
              <SettingRow label="Audiences" value={listSummary(splitComma(docs.audiencesText))} onOpen={() => openSheet('audiences')} />
              <SettingRow label="Experience level" value={EXPERIENCE_LEVELS[docs.experienceLevel ?? 'intermediate'] ?? docs.experienceLevel ?? ''} onOpen={() => openSheet('experienceLevel')} />
              <SettingRow label="Locale" value={docs.locale} onOpen={() => openSheet('locale')} />
              <SettingRow label="Accessibility target" value={docs.accessibilityTarget} onOpen={() => openSheet('accessibilityTarget')} />
              <SettingRow label="Tone" value={listSummary(splitComma(docs.toneText))} onOpen={() => openSheet('tone')} />
              <SettingRow label="Priority outcomes" value={listSummary(splitLines(docs.outcomesText))} onOpen={() => openSheet('outcomes')} />
              <SettingRow label="Preferred examples" value={listSummary(splitComma(docs.preferredExamplesText))} onOpen={() => openSheet('preferredExamples')} />
              <SettingRow label="Design direction" value={docs.designDirection ?? ''} onOpen={() => openSheet('designDirection')} />
              <SettingRow label="Standards profile" value={docs.standardsProfile} onOpen={() => openSheet('standardsProfile')} />
              <SettingRow label="Style guide" value={docs.styleGuide} onOpen={() => openSheet('styleGuide')} />
              <SettingRow label="Preferred terminology" value={listSummary(docs.terms.map((term) => term.term))} onOpen={() => openSheet('terms')} />
              <SettingRow label="Content exclusions" value={listSummary(docs.exclusionsText.split('\n').map((item) => item.trim()).filter(Boolean), 2)} onOpen={() => openSheet('exclusions')} />
              <SettingRow label="Instructions" value={docs.customInstructions} onOpen={() => openSheet('instructions')} />
            </div>
          </Panel>
          <GlossaryPanel act={act} onError={onError} unsavedTerms={unsavedTerms} onOpenPage={(path) => setLocation('pages', { path }, 'push')} />
        </>}

        {section === 'branding' && <BrandingPanel act={act} onError={onError} {...(state.preview?.running && state.preview.url ? { previewUrl: state.preview.url } : {})} onPreviewStart={() => post<{ url: string }>('/api/preview/start', { open: false }).then((result) => result.url).catch((cause) => { onError(message(cause)); return undefined })} />}

        {section === 'capture' && <>
          {applicationSync.stale && <StaleFormNotice onResync={applicationSync.resync} />}
          <Panel title="Application screenshots" flush
            actions={<Button size="sm" disabled={!application.baseUrl} busy={testingApplication} onClick={() => void testApplication()}>Test application</Button>}
            {...(applicationConfigured ? { footer: <Button size="sm" tone="danger" onClick={() => void act(() => patch('/api/project', { application: null }), 'Application configuration removed')}>Remove application</Button> } : {})}>
            <div class="vrows">
              {applicationReadiness && <div class="vrow"><span class="vrow-label">{applicationReadiness.status === 'ready' ? 'Application reachable' : applicationReadiness.status === 'authentication-required' ? 'Sign-in needed' : 'Application not reachable'}<small>{applicationReadiness.message}</small></span><span class="vrow-value"><Badge tone={applicationReadiness.status === 'ready' ? 'good' : 'warn'}>{applicationReadiness.status === 'ready' ? 'Reachable' : 'Check'}</Badge></span></div>}
              <SettingRow label="Application URL" value={application.baseUrl ? <code>{application.baseUrl}</code> : ''} sub={application.source ? `Built from ${application.source}` : undefined} onOpen={() => openSheet('applicationUrl')} />
              <SettingRow label="Sign-in" value={captureAuth?.session
                ? <Badge tone="good">Session saved {timeText(captureAuth.session.savedAt)}</Badge>
                : captureAuth?.credentials
                  ? <Badge tone="good">Credentials for {captureAuth.credentials.username}</Badge>
                  : application.loginPath ? <code>{application.loginPath}</code> : 'Not set up'} onOpen={() => openSheet('signIn')} />
              <SettingRow label="Screenshot policy" value={SCREENSHOT_POLICIES[application.policy] ?? application.policy} onOpen={() => openSheet('screenshotPolicy')} />
              <SettingRow label="Viewport" value={`${application.viewportWidth} × ${application.viewportHeight}${application.highlight ? ' · highlight captured controls' : ''}`} onOpen={() => openSheet('viewport')} />
            </div>
          </Panel>
        </>}

        {section === 'tools' && <Panel title="Documentation generator" flush>
          <div class="vrows">
            <SettingRow label="Generator" value={<>{generator?.displayName ?? project.generator}<Badge tone="good">Active</Badge></>} />
            <SettingRow label="Package" value={generator?.id === 'doxbrix' ? 'Built in' : <code>{generator?.packageName ?? project.generator}</code>} />
            {generator?.tierLabel && <SettingRow label="Tier" sub={generator.tierDescription} value={`${generator.tierLabel}${generator.toolchainLabels?.length ? ` · ${generator.toolchainLabels.join(', ')}` : ''}`} />}
          </div>
        </Panel>}

        {section === 'monitoring' && <Panel title="Monitoring" flush actions={<Button size="sm" icon="bell" onClick={() => setMonitoringOpen(true)}>Configure</Button>}>
          <div class="vrows">
            <SettingRow label="Schedule" value={sync.on.length ? scheduleSummary(scheduleForm(sync.on)) : 'Not configured'} onOpen={() => setMonitoringOpen(true)} />
            <SettingRow label="Product branch" value={sync.branch ?? ''} onOpen={() => setMonitoringOpen(true)} />
            <SettingRow label="Budgets" value={budgetSummary || 'No limits'} onOpen={() => setMonitoringOpen(true)} />
            <SettingRow label="Re-verify after" value={sync.maxVerificationAgeDays ? `${sync.maxVerificationAgeDays} days · ${sync.maxVerificationAgeSeverity === 'fail' ? 'fail validation' : 'warn'}` : 'Only on source changes'} onOpen={() => setMonitoringOpen(true)} />
            <SettingRow label="Watched paths" value={sync.watch.length ? listSummary(sync.watch, 2) : 'Everything'} sub={sync.ignore.length ? `${sync.ignore.length} ignored` : undefined} onOpen={() => setMonitoringOpen(true)} />
          </div>
        </Panel>}
      </div>
    </div>
    {monitoringOpen && <MonitoringDialog state={state} act={act} onClose={() => setMonitoringOpen(false)} />}
    {sheet && openSheetSpec && <OpsSheet class="settings-sheet" title={openSheetSpec.title} onClose={cancelSheet} footer={<><Button tone="ghost" onClick={cancelSheet}>Cancel</Button><Button tone="primary" busy={sheetSaving} disabled={openSheetSpec.disabled} onClick={() => void commitSheet(openSheetSpec.save)}>Save</Button></>}>
      {openSheetSpec.body}
    </OpsSheet>}
  </>
}

/** One settings fact: label left, current value right, a chevron when it opens a sheet. */
function SettingRow({ label, value, sub, onOpen }: { label: string; value: import('preact').ComponentChildren; sub?: string | undefined; onOpen?: () => void }) {
  const shown = value === '' || value === undefined || value === null ? <em>Not set</em> : typeof value === 'string' ? <span class="value-text">{value}</span> : value
  const inner = <>
    <span class="vrow-label">{label}{sub && <small>{sub}</small>}</span>
    <span class="vrow-value">{shown}{onOpen && <Icon name="chevronRight" size={16} />}</span>
  </>
  return onOpen
    ? <button type="button" class="vrow settings-row" onClick={onOpen}>{inner}</button>
    : <div class="vrow settings-row static">{inner}</div>
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
 * With `embedded` it renders its two blocks without the panel frame, for use
 * inside the Settings sheet.
 */
function CaptureSignInPanel({ application, configured, onError, onChanged, embedded }: { application: Record<string, unknown> & { baseUrl: string }; configured: boolean; onError: (error: string) => void; onChanged: () => void; embedded?: boolean }) {
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
  const body = <>
    {!configured && <Note>Save the application settings first. Sign-in details are stored on this computer against the project, never in the repository.</Note>}
    <div class="capture-signin">
      <section class="capture-signin-block">
        <header><strong>Recorded browser session</strong><small>Sign in by hand in a Chrome window Doxloop opens, including MFA, SSO, or passkeys. The signed-in cookies and local storage are loaded into every capture run.</small></header>
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
              <Button icon="preview" disabled={!application.baseUrl} busy={busy === 'start'} onClick={() => void run('start', () => post('/api/application/sign-in', application))}>{auth?.session ? 'Sign in again with browser' : 'Sign in with browser'}</Button>
            </>}
        </div>
      </section>
      <section class="capture-signin-block">
        <header><strong>Sign-in credentials</strong><small>For a plain username and password form. The agent fills the form by secret name; the capture server substitutes the values and redacts them from every result. Use a test account, never a production one.</small></header>
        {auth?.credentials && <div class="plan-capture-readiness ready"><Icon name="check" size={15} /><span><strong>Credentials saved for {auth.credentials.username}</strong><small>Saved {timeText(auth.credentials.savedAt)}. Enter new values below to replace them.</small></span></div>}
        <Field label="Username or email"><Input value={credentials.username} autocomplete="off" placeholder="docs-demo@example.com" onInput={(event) => setCredentials({ ...credentials, username: event.currentTarget.value })} /></Field>
        <Field label="Password"><Input type="password" value={credentials.password} autocomplete="new-password" placeholder="••••••••" onInput={(event) => setCredentials({ ...credentials, password: event.currentTarget.value })} /></Field>
        <div class="form-actions start">
          {auth?.credentials && <Button tone="danger" busy={busy === 'remove'} onClick={() => void run('remove', () => remove('/api/application/credentials'))}>Remove credentials</Button>}
          <Button disabled={!configured || !credentials.username.trim() || !credentials.password} busy={busy === 'save'} onClick={() => void run('save', async () => { const next = await put<CaptureAuthState>('/api/application/credentials', credentials); setCredentials({ username: '', password: '' }); return next })}>Save credentials</Button>
        </div>
      </section>
    </div>
  </>
  if (embedded) return <div class="capture-signin-embedded">{body}</div>
  return <Panel title="Application sign-in" description="Let the capture browser past a login page without sharing secrets with the agent or the project.">{body}</Panel>
}

function StaleFormNotice({ onResync }: { onResync: () => void }) {
  return <div class="stale-form-notice" role="status">
    <Icon name="info" size={14} />
    <span>These settings changed elsewhere while you were editing. Your unsaved edits are still here.</span>
    <Button size="sm" onClick={onResync}>Load the saved values</Button>
  </div>
}

/**
 * A right-side sheet: a title, one column of controls, and the action in the
 * footer. Escape and the scrim close it the same way as the Cancel button.
 */
function OpsSheet({ title, description, onClose, footer, children, class: className }: {
  title: string
  description?: string
  onClose: () => void
  footer?: import('preact').ComponentChildren
  children: import('preact').ComponentChildren
  class?: string
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    addEventListener('keydown', onKey)
    return () => removeEventListener('keydown', onKey)
  }, [onClose])
  return <div class="sources-modal-scrim ops-sheet-scrim" onClick={onClose}>
    <section class={`ops-sheet ${className ?? ''}`} role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <header class="ops-sheet-head">
        <div><h2>{title}</h2>{description && <p>{description}</p>}</div>
        <button type="button" class="ops-icon-button" aria-label="Close" onClick={onClose}><Icon name="close" size={16} /></button>
      </header>
      <div class="ops-sheet-body">{children}</div>
      {footer && <footer class="ops-sheet-foot">{footer}</footer>}
    </section>
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

/** Calm, sentence-case status words for badges. */
function statusLabel(status: string): string {
  if (status === 'awaiting-review') return 'Awaiting review'
  const words = status.replaceAll('-', ' ').replaceAll('_', ' ')
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/**
 * Screenshot notes can name dozens of image paths. The sentence stays on
 * screen; the paths fold into a list the reviewer opens when needed.
 */
function ScreenshotMessage({ message }: { message: string }) {
  const paths = [...new Set(message.match(/assets\/[^\s;=,]+?\.(?:png|jpe?g|webp)/g) ?? [])]
  if (paths.length < 3) return <>{message}</>
  const summary = message.replace(/:\s*assets\/[\s\S]*\.(?:png|jpe?g|webp)\.?/, '.').replace(/\s+/g, ' ').trim()
  return <>{summary}<details class="screenshot-message-paths"><summary>Show {paths.length} image{paths.length === 1 ? '' : 's'}</summary><ul>{paths.map((path) => <li key={path}><code>{path}</code></li>)}</ul></details></>
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

function agentAuthStatus(status: string): 'authenticated' | 'unauthenticated' | 'unknown' {
  if (status === 'authenticated') return 'authenticated'
  if (status === 'unauthenticated' || status === 'missing') return 'unauthenticated'
  return 'unknown'
}

function retryStatusLabel(status: string): string {
  const normalized = agentAuthStatus(status)
  return normalized === 'authenticated' ? 'signed in' : normalized === 'unauthenticated' ? 'signed out' : 'sign-in not checked'
}

function agentSignInHint(agent: string): string {
  if (agent === 'claude') return 'Run `claude auth login` in a terminal, or choose another assistant.'
  if (agent === 'codex') return 'Run `codex login` in a terminal, or choose another assistant.'
  if (agent === 'gemini') return 'Run `gemini` in a terminal and sign in, or choose another assistant.'
  return 'Sign it in from a terminal, or choose another assistant.'
}

function agentSignInLabel(status: string): string {
  if (status === 'authenticated') return 'is signed in'
  if (status === 'unauthenticated' || status === 'missing') return 'needs sign-in'
  if (status === 'unknown') return 'sign-in unknown'
  return status.replaceAll('-', ' ')
}

function pageTitleFromPath(path: string): string {
  const stem = path.split('/').pop()?.replace(/\.(mdx?|md)$/i, '') ?? path
  return stem.replace(/[-_]+/g, ' ').replace(/^\w/, (letter) => letter.toUpperCase())
}

function documentationExists(state: UiState): boolean {
  if ((state.mintlifyImport?.pageCount ?? 0) > 0) return true
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


/** Non-empty trimmed lines, for settings that hold sentences. */
function splitLines(value: string | undefined): string[] {
  return (value ?? '').split('\n').map((line) => line.trim()).filter(Boolean)
}


/** A deploy that failed only because the Doxbrix session is missing or expired. */
/** Why a browser sign-in stopped, phrased for the button the reader can press. */
export function loginFailureText(job: Pick<UiJob, 'lines' | 'status'>): string {
  const reason = jobFailureReason(job)
  if (reason && /authori[sz]ation expired|expired_token|code expired/i.test(reason)) return 'The sign-in code expired before it was approved. Choose Sign in with browser to get a new code.'
  if (reason && /access_denied|denied/i.test(reason)) return 'The sign-in was declined in the browser. Choose Sign in with browser to try again.'
  return reason?.replace(/\s*Run `doxloop login` again\.?/, ' Choose Sign in with browser to try again.') ?? 'The sign-in stopped before an account was connected. Try again.'
}

/** A deployment error in reader terms; the raw text stays in the log and the title. */
function friendlyDeployError(error: string): string {
  return isSignInFailure(error) ? 'Doxbrix did not accept the saved sign-in. Sign in again, then redeploy.' : error
}

function hostOf(url: string): string {
  try { return new URL(url).host } catch { return url }
}

function isSignInFailure(text: string): boolean {
  return /\b401\b.*unauthori[sz]ed|authentication required|provide a dxb_token/i.test(text)
}
