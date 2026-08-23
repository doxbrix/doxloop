import { useEffect, useRef, useState } from 'preact/hooks'
import './WorkspaceApplication.css'
import { api, patch, post, remove } from './api'
import {
  Badge, Button, Combo, Empty, Field, Input, KeyValues, Lines, Note, PageHeader,
  Panel, Segmented, Select, Stat, Table, Tabs, Textarea, Toggle, parseTerms, splitComma, termText, timeText,
} from './components'
import { Icon } from './icons'
import { agentModels, defaultModelForAgent, modelReasoningLevels, preferredReasoningLevel } from './model-options'
import type { DeploymentRecord, DiffRow, GeneratorEntry, HistoryChangedPage, HistoryRequest, Proposal, ProposalChange, Source, SourceDiff, SyncConfig, UiJob, UiState } from './types'

const NAV = [
  ['sources', 'Sources'],
  ['authoring', 'Update'],
  ['proposals', 'Review'],
  ['publish', 'Deploy'],
  ['settings', 'Settings'],
] as const

const DOXLOOP_LOGO = new URL('../../assets/brand/doxloop-logo-light.png', import.meta.url).href

type Page = typeof NAV[number][0]

function currentPage(): Page {
  const segment = location.pathname.split('/').filter(Boolean)[0]
  return NAV.some(([id]) => id === segment) ? segment as Page : 'authoring'
}

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
  const [page, setPage] = useState<Page>(currentPage())
  const [navOpen, setNavOpen] = useState(false)
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      return localStorage.getItem('doxloop.sidebarCollapsed') === 'true'
    } catch {
      return false
    }
  })
  const [jobStreamConnected, setJobStreamConnected] = useState(false)
  const [readyProposal, setReadyProposal] = useState<Proposal | null>(null)
  const runningJobIds = useRef(new Set(state.jobs.filter((job) => job.status === 'running').map((job) => job.id)))
  const announcedJobIds = useRef(new Set<string>())
  const pendingProposalCount = validRuns(state.runs).filter((run) => OPEN_STATUSES.includes(run.status)).length

  const receiveJobs = (jobs: UiJob[]) => {
    const previouslyRunning = runningJobIds.current
    const completedUpdates = jobs.filter((job) =>
      job.type === 'author:update' &&
      job.status === 'succeeded' &&
      previouslyRunning.has(job.id) &&
      !announcedJobIds.current.has(job.id),
    )
    runningJobIds.current = new Set(jobs.filter((job) => job.status === 'running').map((job) => job.id))
    onJobsUpdate(jobs)
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
    const listener = () => setPage(currentPage())
    addEventListener('popstate', listener)
    return () => removeEventListener('popstate', listener)
  }, [])

  useEffect(() => {
    try {
      localStorage.setItem('doxloop.sidebarCollapsed', String(sidebarCollapsed))
    } catch {
      // The preference remains available for this session when storage is unavailable.
    }
  }, [sidebarCollapsed])

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

  const navigate = (next: Page) => {
    history.pushState({}, '', `/${next}`)
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

  return <div class={`shell ${page === 'proposals' ? 'proposal-shell' : ''} ${page === 'sources' ? 'sources-shell' : ''} ${sidebarCollapsed ? 'sidebar-collapsed' : ''}`}>
    {navOpen && <button class="nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}

    <header class="workspace-navbar">
      <div class="workspace-navbar-left">
        <button class="workspace-brand" type="button" aria-label="Open navigation" onClick={() => setNavOpen(true)}><img src={DOXLOOP_LOGO} alt="Doxloop" /></button>
        <div class="workspace-identity" aria-label={`Current workspace: ${project.title}`}>
          <span class="workspace-identity-mark">{project.title.slice(0, 1).toUpperCase()}</span>
          <span class="workspace-identity-copy"><strong>{project.title}</strong><small>Local workspace</small></span>
        </div>
      </div>
      <div class="workspace-navbar-actions">
        <a class="workspace-support-link" href="https://github.com/doxbrix/doxloop" target="_blank" rel="noreferrer"><Icon name="help" size={16} />Support</a>
        <span class="mode-flag navbar-mode-flag"><i />Local</span>
        <button type="button" class="workspace-preview-primary" onClick={() => void openPreview()}><span><Icon name="preview" size={16} /></span><strong>Preview docs</strong><Icon name="external" size={14} /></button>
      </div>
    </header>

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
      <span class="sidebar-section-label">Workspace</span>
      <nav class="reference-sidebar-nav" aria-label="Main navigation">
        {NAV.slice(0, 4).map(([id, label]) => <button key={id} class={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={id} size={17} /><span>{label}</span>{id === 'proposals' && pendingProposalCount > 0 && <b class="nav-count" aria-label={`${pendingProposalCount} pending proposal${pendingProposalCount === 1 ? '' : 's'}`}>{pendingProposalCount}</b>}</button>)}
      </nav>
      <span class="sidebar-section-label settings-label">Settings</span>
      <nav class="reference-sidebar-nav settings-sidebar-nav" aria-label="Settings navigation">
        <button class={page === 'settings' ? 'active' : ''} aria-current={page === 'settings' ? 'page' : undefined} onClick={() => navigate('settings')}><Icon name="settings" size={17} /><span>Settings</span></button>
      </nav>
      <button type="button" class="sidebar-collapse-button" aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} aria-expanded={!sidebarCollapsed} title={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'} onClick={() => setSidebarCollapsed(!sidebarCollapsed)}>
        <Icon name="chevronRight" size={15} /><span>{sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}</span>
      </button>
    </aside>

    <div class="main">
      <div class="page">
        {loading && <div class="loading-bar" />}
        {error && <Banner title="Action failed" detail={error} onClose={onErrorDismiss} />}
        {page === 'sources' && <SourcesReference state={state} act={act} />}
        {page === 'authoring' && <Authoring state={state} act={act} streamConnected={jobStreamConnected} onError={onError} />}
        {page === 'proposals' && <Proposals state={state} act={act} onError={onError} />}
        {page === 'publish' && <Publish state={state} act={act} streamConnected={jobStreamConnected} onError={onError} />}
        {page === 'settings' && <Settings state={state} act={act} />}
      </div>
    </div>
  </div>
}

function Banner({ title, detail, onClose }: { title: string; detail: string; onClose: () => void }) {
  return <div class="banner bad">
    <Icon name="alert" size={16} />
    <div><strong>{title}</strong><span>{detail}</span></div>
    <button aria-label="Dismiss" onClick={onClose}><Icon name="close" size={14} /></button>
  </div>
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


function SourcesReference({ state, act }: { state: UiState; act: Action }) {
  const project = state.project!
  const [menuOpen, setMenuOpen] = useState(false)
  const [dialog, setDialog] = useState<'source' | 'openapi' | null>(null)
  const [monitoringSource, setMonitoringSource] = useState<Source | null>(null)
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
  const remoteSourceCount = filtered.filter((source) => Boolean(source.remote)).length
  const openapiSourceCount = filtered.filter((source) => source.kind === 'openapi').length
  return <div class="sources-reference-page">
    <PageHeader title="Sources" description="Manage the read-only sources Doxloop uses to create and maintain your documentation." actions={<div class="sources-add-wrap"><button type="button" class="sources-add-dropdown-button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><Icon name="plus" size={16} />Add source<Icon name="chevronDown" size={14} /></button>{menuOpen && <div class="sources-add-menu"><button type="button" onClick={() => openDialog('source')}><span><Icon name="api" size={20} /></span><span><strong>Source code</strong></span></button><button type="button" onClick={() => openDialog('openapi')}><span><Icon name="braces" size={20} /></span><span><strong>OpenAPI spec</strong></span></button></div>}</div>} />
    <section class="sources-library">
      <header class="sources-library-header">
        <div><h2>Connected sources</h2><p>Evidence Doxloop can read when it creates and updates your documentation.</p></div>
        <div class="sources-library-summary"><span><strong>{filtered.length}</strong> connected</span><i /><span><strong>{remoteSourceCount}</strong> remote</span><i /><span><strong>{openapiSourceCount}</strong> API</span></div>
      </header>
      {filtered.length ? <div class="sources-card-grid">{filtered.map((source) => <article class="source-card" key={source.name}>
        <div class="source-card-top"><span class={`source-service-icon ${source.kind === 'openapi' ? 'openapi' : source.remote ? `git ${repositoryProvider(source.remote.repository)}` : 'local'}`}><Icon name={source.kind === 'openapi' ? 'braces' : source.remote ? repositoryProviderIcon(source.remote.repository) : 'folder'} size={20} /></span><em class={`source-type-pill ${source.kind === 'openapi' ? 'openapi' : source.remote ? 'git' : 'local'}`}>{source.kind === 'openapi' ? 'OpenAPI' : source.remote ? 'Git' : 'Local'}</em></div>
        <div class="source-card-copy"><strong>{source.name}</strong><small>{source.remote ? source.remote.repository : source.path}</small></div>
        <footer><span class="source-connection-status"><i />Available</span><span class="source-row-menu"><button type="button" class={`monitoring-button ${project.sync.on.length ? 'monitoring-active' : ''}`} aria-label={`Configure monitoring for ${source.name}`} title="Configure monitoring" onClick={() => setMonitoringSource(source)}><Icon name="bell" size={17} /></button><button type="button" aria-label={`Delete ${source.name}`} title="Delete source" onClick={() => { if (confirm(`Remove ${source.name}?`)) void act(() => remove(`/api/sources/${encodeURIComponent(source.name)}`), 'Source removed') }}><Icon name="trash" size={17} /></button></span></footer>
      </article>)}<button type="button" class="sources-add-card" onClick={() => openDialog('source')}><span><Icon name="plus" size={18} /></span><strong>Add another source</strong><small>Connect source code or an API specification.</small></button></div> : <div class="sources-table-empty"><Icon name="sources" size={28} /><strong>No sources yet</strong><small>Add a source to start creating documentation.</small><Button tone="primary" icon="plus" onClick={() => openDialog('source')}>Add source</Button></div>}
    </section>
    {monitoringSource && <MonitoringDialog state={state} source={monitoringSource} act={act} onClose={() => setMonitoringSource(null)} />}
    {dialog && <div class="sources-modal-scrim" onClick={closeDialog}><section class={`sources-reference-dialog ${dialog}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
      <header>{dialog === 'openapi' && <span class="sources-dialog-icon"><Icon name="file" size={24} /></span>}<div><h2>{dialog === 'source' ? 'Add source code' : 'Add OpenAPI spec'}</h2><p>{dialog === 'source' ? 'Choose how you want to connect your source code.' : 'Import your OpenAPI specification from a local file or a public URL.'}</p></div><button type="button" aria-label="Close" onClick={closeDialog}><Icon name="close" size={17} /></button></header>
      {dialog === 'source' ? <div class="sources-dialog-body"><span class="dialog-section-label">Source type</span><div class="source-mode-grid"><button type="button" class={sourceMode === 'git' ? 'selected' : ''} onClick={() => setSourceMode('git')}><span><Icon name="api" size={22} /></span><i /><strong>Git repository</strong><small>Connect a GitHub, GitLab, Azure DevOps or other Git service.</small></button><button type="button" class={sourceMode === 'local' ? 'selected' : ''} onClick={() => setSourceMode('local')}><span><Icon name="folder" size={22} /></span><i /><strong>Local folder</strong><small>Use a folder on your computer or network.</small></button></div>{sourceMode === 'git' ? <div class="source-code-fields"><Field label="Repository access"><Select value={add.authMethod} onChange={(event) => { setAdd({ ...add, authMethod: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }}><option value="automatic">Public repository</option><option value="credentials">Private repository</option></Select></Field><Field label="Repository URL"><div class="repository-connect-input"><Input value={add.repository} onInput={(event) => { setAdd({ ...add, repository: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /><RepositoryConnectButton connected={Boolean(head)} busy={connecting} disabled={!add.repository.trim() || (add.authMethod === 'credentials' && (!add.gitUsername.trim() || !add.gitSecret.trim()))} onClick={() => void connectRepository()} /></div></Field>{add.authMethod === 'credentials' && <div class="private-git-fields"><Field label="Username"><Input value={add.gitUsername} autocomplete="username" onInput={(event) => { setAdd({ ...add, gitUsername: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /></Field><Field label="Personal Access Token (PAT)"><Input type="password" value={add.gitSecret} autocomplete="off" onInput={(event) => { setAdd({ ...add, gitSecret: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /></Field></div>}<div class="source-branch-grid"><Field label="Branch"><Select value={add.branch} disabled={!head || connecting} onChange={(event) => void selectBranch(event.currentTarget.value)}>{branches.length ? branches.map((branch) => <option key={branch}>{branch}</option>) : <option>{connecting ? 'Connecting...' : 'Connect repository first'}</option>}</Select></Field><Field label="Folder (optional)"><Select value={add.subdirectory} disabled={!head || foldersLoading} onChange={(event) => setAdd({ ...add, subdirectory: event.currentTarget.value })}><option value="">/</option>{directories.map((directory) => <option key={directory}>{directory}</option>)}</Select></Field></div></div> : <Field label="Local folder"><div class="source-folder-input"><Input value={add.path} onInput={(event) => setAdd({ ...add, path: event.currentTarget.value })} /><Button icon="folder" onClick={() => void post<{ path: string | null }>('/api/setup/browse-directory').then((result) => result.path && setAdd({ ...add, path: result.path }))}>Browse</Button></div></Field>}</div> : <div class="sources-dialog-body openapi-body"><div class="openapi-tabs"><button type="button" class={openapiMode === 'file' ? 'active' : ''} onClick={() => setOpenapiMode('file')}><Icon name="publish" size={18} />Upload file</button><button type="button" class={openapiMode === 'url' ? 'active' : ''} onClick={() => setOpenapiMode('url')}><Icon name="external" size={18} />From URL</button></div>{openapiMode === 'file' ? <div class={`openapi-dropzone ${add.fileName ? 'has-file' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void readSpecification(event.dataTransfer?.files[0]) }}><input ref={fileInput} type="file" accept=".yaml,.yml,.json,application/json,text/yaml" onChange={(event) => void readSpecification(event.currentTarget.files?.[0])} /><span><Icon name={add.fileName ? 'check' : 'publish'} size={28} /></span><strong>{add.fileName || 'Drag and drop your OpenAPI file here'}</strong>{!add.fileName && <small>or</small>}<Button onClick={() => fileInput.current?.click()}>{add.fileName ? 'Choose another file' : 'Browse file'}</Button><em>Accepted formats: .yaml, .yml, .json</em></div> : <Field label="OpenAPI spec URL"><Input value={add.path} placeholder="https://example.com/openapi.yaml" onInput={(event) => setAdd({ ...add, path: event.currentTarget.value, specContent: '', fileName: '' })} /><small>We support public URLs and standard OpenAPI formats.</small></Field>}</div>}
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

function Authoring({ state, act, streamConnected, onError }: { state: UiState; act: Action; streamConnected: boolean; onError: (error: string) => void }) {
  const hasCompletedRun = Boolean(state.receipt)
  const mode = hasCompletedRun ? 'update' : 'create'
  const pendingSources = state.receipt?.pendingSources ?? []
  const defaultAgent = state.project?.defaultAgent ?? ''
  const defaultModel = defaultModelForAgent(defaultAgent)
  const defaultReasoning = preferredReasoningLevel(defaultAgent, defaultModel)
  const [form, setForm] = useState({ request: '', agent: defaultAgent, model: defaultModel, reasoning: defaultAgent === 'codex' ? defaultReasoning : '', effort: defaultAgent === 'claude' ? defaultReasoning : '', screenshots: false })
  const availableAuthorModels = agentModels(form.agent)
  const supportedAuthorReasoning = modelReasoningLevels(form.agent, form.model)
  const [activityOpen, setActivityOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const runs = state.jobs.filter((job) => job.type.startsWith('author:') || job.type === 'capture')
  const activeRun = runs.find((job) => job.status === 'running')
  const currentRun = activeRun ?? runs[0]
  const runBusy = Boolean(activeRun || submitting)
  useEffect(() => {
    setActivityOpen(Boolean(activeRun))
  }, [activeRun?.id, activeRun?.status])
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
    setActivityOpen(true)
    try {
      const started = await act(() => post<UiJob>('/api/author', request), label)
      if (!started) setActivityOpen(false)
    } finally {
      setSubmitting(false)
    }
  }
  return <div class="authoring-page">
    <PageHeader title="Update documentation" description="Describe what changed and prepare a documentation update." />
    {hasCompletedRun && pendingSources.length > 0 && <div class="source-sync-banner">
      <span class="source-sync-icon"><Icon name="sources" size={18} /></span>
      <div>
        <strong>{pendingSources.length === 1 ? `New source “${pendingSources[0]}” was added` : `${pendingSources.length} new sources were added`}</strong>
        <p>Run Update to synchronize {pendingSources.length === 1 ? 'this source' : 'these sources'} with the existing documentation. Unrelated pages, navigation, and styling will be preserved.</p>
      </div>
    </div>}
    <div class="authoring-workbench">
      <Panel class="authoring-request">
        <fieldset class="authoring-fields" disabled={runBusy}>
          <div class="authoring-prompt-block">
            <div class="authoring-prompt-title"><span><Icon name="chat" size={18} /></span><div><h2>Describe the update</h2><p>Tell the agent what changed, what readers need, or which pages should be improved.</p></div></div>
            <span class="authoring-textarea-wrap"><Textarea rows={6} maxlength={1000} value={form.request} placeholder="For example: Document the new API key rotation flow and update the authentication guide with a TypeScript example." onInput={(event) => setForm({ ...form, request: event.currentTarget.value })} /></span>
          </div>
        </fieldset>
        <section class="authoring-run-config">
        <fieldset class="authoring-options" disabled={runBusy}>
          <Field label="Coding agent"><span class="authoring-control-icon agent"><Icon name="bot" size={16} /><Select value={form.agent} onChange={(event) => {
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
            }}><option value="">Select coding assistant</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select></span></Field>
          <Field label="Model"><span class="authoring-control-icon model"><Icon name="sparkle" size={17} /><Combo value={form.model} options={availableAuthorModels.map((model) => [model.id, model.label] as const)} disabled={!form.agent} placeholder="Search or enter a model ID" onValueChange={(value) => setForm({ ...form, model: value })} /></span></Field>
          <Field label={form.agent === 'claude' ? 'Effort' : 'Reasoning'}><span class="authoring-control-icon reasoning"><Icon name="brain" size={17} /><Combo value={form.agent === 'claude' ? form.effort : form.reasoning} options={supportedAuthorReasoning.map((value) => [value, value] as const)} disabled={!form.agent} placeholder="Search or enter a value" onValueChange={(value) => setForm({ ...form, [form.agent === 'claude' ? 'effort' : 'reasoning']: value })} /></span></Field>
          <div class="screenshot-option">
            <div><span class="screenshot-camera"><Icon name="camera" size={18} /></span><span><strong>Visual evidence</strong><small>Capture application screenshots during the run.</small></span><Toggle checked={form.screenshots} disabled={runBusy} onChange={(checked) => setForm({ ...form, screenshots: checked })} label="Capture screenshots during the run" /></div>
          </div>
        </fieldset>
        <footer><Button disabled={runBusy} busy={submitting} tone="primary" icon="sparkle" onClick={() => void startRun(mode)}>Start documentation update</Button><small>The current documentation stays unchanged until you approve the proposal.</small></footer>
        </section>
      </Panel>
    </div>
    <section class={`authoring-action-card activity-card live-activity-card ${activityOpen ? 'open' : ''}`}>
      <button type="button" class="authoring-action-card-head" aria-expanded={activityOpen} onClick={() => setActivityOpen(!activityOpen)}>
        <span class="action-card-icon activity"><Icon name="record" size={19} /></span>
        <span class="action-card-copy"><strong>Live activity</strong><small>{activeRun ? `${streamConnected ? 'Live · ' : ''}Documentation update in progress` : submitting ? 'Starting documentation update…' : currentRun ? 'Show the latest update log' : 'Logs will appear when an update starts'}</small></span>
        {activeRun && <Badge tone={streamConnected ? 'good' : 'warn'} icon="broadcast">{streamConnected ? 'Live' : 'Reconnecting…'}</Badge>}
        <Icon name="chevronDown" size={17} />
      </button>
      {activityOpen && currentRun && <AuthoringLiveLog job={currentRun} act={act} />}
      {activityOpen && !currentRun && <div class="authoring-live-empty">Starting the documentation agent…</div>}
    </section>
    <Panel
      class="history-panel"
      title="Update history"
      description="Every documentation request, what it changed, and how it was reviewed."
    >
      <RequestHistory jobs={state.jobs} onError={onError} />
    </Panel>
  </div>
}

function AuthoringLiveLog({ job, act }: { job: UiJob; act: Action }) {
  const log = useRef<HTMLPreElement>(null)
  const agent = job.agent ? agentLabel(job.agent) : 'Agent'
  useEffect(() => {
    if (log.current) log.current.scrollTop = log.current.scrollHeight
  }, [job.lines.length])
  return <div class="authoring-live-log">
    <div class="live-job-meta" aria-live="polite">
      <span><Icon name="bot" size={14} />{agent}</span>
      <span><Icon name="clock" size={14} />Last output {timeText(job.lastOutputAt ?? job.startedAt)}</span>
      <span><Icon name="file" size={14} />{job.lines.length} recent line{job.lines.length === 1 ? '' : 's'}</span>
      <span class="authoring-live-actions">
        <a href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer">Open full log <Icon name="external" size={12} /></a>
        {job.status === 'running' && <Button size="sm" tone="danger" icon="stop" onClick={() => void act(() => post(`/api/jobs/${job.id}/cancel`), 'Update stopped')}>Stop update</Button>}
      </span>
    </div>
    <pre ref={log} class="terminal live-terminal" aria-live="polite">{job.lines.length > 0 ? job.lines.join('\n') : `Starting ${agent}…`}</pre>
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
  return <Table class="history-table" head={<><th>Request</th><th>Result</th><th>Changed</th><th>When</th></>}>
    {entries.map((entry) => {
      const pages = entry.pages ?? []
      return <tr key={entry.id} class="history-row">
        <td>
          <div class="history-request">
            {entry.requestText
              ? <strong>{entry.requestText}</strong>
              : <strong class="muted-cell">{entry.sourceSummary ?? 'Source change'}</strong>}
            <small>
              <span class="history-kind">{entry.kind}</span>
              {entry.agent && <> · {agentLabel(entry.agent)}</>}
              {entry.model && <> · {entry.model}</>}
              {entry.trigger === 'schedule' && <> · scheduled</>}
            </small>
            {entry.error && <small class="history-error">{entry.error}</small>}
          </div>
          {pages.length > 0 && <details class="history-pages">
            <summary>View changed {pages.length === 1 ? 'page' : 'pages'}</summary>
            <ul>
              {pages.map((page) => <li key={page.path}>
                <Badge tone={statusTone(page.changeKind)}>{page.changeKind}</Badge>
                <code class="mono">{page.path}</code>
                <Badge tone={statusTone(page.decision)}>{statusLabel(page.decision)}</Badge>
              </li>)}
            </ul>
          </details>}
        </td>
        <td><Badge tone={statusTone(entry.status)}>{statusLabel(entry.status)}</Badge></td>
        <td class="history-changed">
          <span>{changeCountText(pages, entry.pagesChanged)}</span>
          {(entry.linesAdded > 0 || entry.linesRemoved > 0) && <small class="history-lines">
            <i class="added">+{entry.linesAdded}</i>
            <i class="removed">−{entry.linesRemoved}</i>
          </small>}
        </td>
        <td class="muted-cell">
          {timeText(entry.createdAt)}
          {entry.durationMs !== undefined && <small class="history-duration">{durationText(entry.durationMs)}</small>}
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

function MonitoringDialog({ state, source, act, onClose }: { state: UiState; source: Source; act: Action; onClose: () => void }) {
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
        <div><h2 id="monitoring-dialog-title">Configure monitoring</h2><p><strong>{source.name}</strong> · Source changes automatically generate a documentation update for review under Review Changes.</p></div>
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
  const [selectedId, setSelectedId] = useState('')
  const selected = runs.find((run) => run.id === selectedId)
  const [changeId, setChangeId] = useState('')
  const [confirmingAcceptance, setConfirmingAcceptance] = useState<Proposal | null>(null)
  const [appliedProposal, setAppliedProposal] = useState<Proposal | null>(null)
  const [view, setView] = useState<'rendered' | 'source'>('rendered')
  const [layout, setLayout] = useState<'split' | 'unified'>('split')
  const [onlyChanges, setOnlyChanges] = useState(true)
  const change = selected?.changes.find((item) => item.id === changeId) ?? selected?.changes[0]
  useEffect(() => setChangeId(selected?.changes[0]?.id ?? ''), [selected?.id])
  const open = selected ? OPEN_STATUSES.includes(selected.status) : false
  const counts = selected ? proposalChangeCounts(selected.changes) : { added: 0, modified: 0, deleted: 0 }
  const acceptAll = async (proposal: Proposal) => {
    const result = await act(() => post<Proposal>(`/api/proposals/${proposal.id}/accept`, { scope: 'all' }))
    setConfirmingAcceptance(null)
    if (result?.status === 'applied') setAppliedProposal(result)
  }
  return <>
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
        <PageHeader title="Review proposal" description="Compare the current documentation with the proposed update." actions={<Button icon="external" onClick={() => void openProposalPreview(selected.id, onError)}>Preview documentation</Button>} />
      </div>
      : <PageHeader title="Review Changes" description="Choose a proposal to inspect and approve its documentation changes." />}
    {runs.length === 0
      ? <Panel flush><Empty icon="proposals" title="No proposals yet" detail="Run source monitoring, or start an update when documentation becomes stale." /></Panel>
      : !selected
        ? <Panel class="proposal-index-panel" title="All proposals" description={runs.length + ' documentation update' + (runs.length === 1 ? '' : 's') + ' available for review.'} flush>
          <Table class="proposal-index-table" head={<><th>Proposal</th><th>Changes</th><th>Files</th><th>Created</th><th>Status</th><th><span class="sr-only">Open</span></th></>}>
            {runs.map((run) => {
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
                <td><Badge tone={statusTone(run.status)}>{statusLabel(run.status)}</Badge></td>
                <td><Icon name="chevronRight" size={15} /></td>
              </tr>
            })}
          </Table>
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
                  <Button tone="primary" icon="check" disabled={!open} onClick={() => selected && setConfirmingAcceptance(selected)}>Accept all</Button>
                </div>
                <div class="proposal-meta"><span><Icon name="file" size={15} />Review files individually or apply the full proposal</span></div>
              </div>
            </header>

            <div class="review-workspace">
              <aside class="review-file-rail" aria-label="Changed files">
                <header><div><strong>Changed files</strong><small>{selected.changes.length} file{selected.changes.length === 1 ? '' : 's'} in this proposal</small></div></header>
                <ReviewFileTree nodes={proposalFileTree(selected.changes)} selectedId={change?.id ?? ''} onSelect={setChangeId} />
              </aside>

              <section class="review-diff-panel">
                {change ? <>
                  <header class="review-file-head">
                    <div><span class="review-file-head-icon"><Icon name="file" size={16} /></span><span><small>Reviewing file</small><strong>{change.path}</strong></span></div>
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
                      <Button size="sm" tone="primary" icon="check" disabled={!open} onClick={() => void act(() => post(`/api/proposals/${selected.id}/accept`, { scope: 'page', changeId: change.id }), 'Page accepted')}>Accept file</Button>
                    </div>
                  </div>
                  <div class="review-diff-body">
                    {view === 'source'
                      ? <ProposalSourceDiff runId={selected.id} change={change} act={act} />
                      : <iframe class="review-frame" title={`Review ${change.title}`} src={`/review-preview/${selected.id}/${change.id}?layout=${layout}${onlyChanges ? '&only=1' : ''}`} />}
                  </div>
                </> : <Empty title="This proposal contains no file changes" />}
              </section>
            </div>
          </div>
        </section>
      </div>}
  </>
}

type ReviewTreeNode = {
  name: string
  path: string
  children: ReviewTreeNode[]
  change?: ProposalChange
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
  const [docs, setDocs] = useState({ ...project.documentation, audiencesText: project.documentation.audiences?.join(', ') ?? '', customInstructions: project.documentation.customInstructions ?? '', outcomesText: project.documentation.priorityOutcomes?.join(', ') ?? '', toneText: project.documentation.tone.join(', '), exclusionsText: project.documentation.exclusions.join('\n'), termsText: termText(project.documentation.terminology) })
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
