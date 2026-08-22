import { useEffect, useRef, useState } from 'preact/hooks'
import './WorkspaceApplication.css'
import { api, patch, post, remove } from './api'
import {
  Badge, Button, Combo, Empty, Field, Input, JobTable, KeyValues, Lines, Note, PageHeader,
  Panel, Segmented, Select, Stat, Table, Tabs, Textarea, Toggle, parseTerms, splitComma, termText, timeText,
} from './components'
import { Icon } from './icons'
import { agentModels, defaultModelForAgent, modelReasoningLevels, preferredReasoningLevel } from './model-options'
import type { DiffRow, GeneratorEntry, Proposal, ProposalChange, Source, SourceDiff, SyncConfig, UiJob, UiState } from './types'

const NAV = [
  ['sources', 'Sources'],
  ['authoring', 'Update'],
  ['proposals', 'Review'],
  ['publish', 'Publish'],
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
  const [page, setPage] = useState<Page>(currentPage())
  const [navOpen, setNavOpen] = useState(false)
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
    try {
      if (!state.preview?.running) {
        const started = await act(() => post('/api/preview/start'), 'Preview started', false)
        if (started === undefined) return
      }
      const url = state.preview?.url ?? 'http://127.0.0.1:4321'
      location.assign(url)
    } catch (cause) {
      onError(message(cause))
    }
  }

  return <div class={`shell ${page === 'proposals' ? 'proposal-shell' : ''} ${page === 'sources' ? 'sources-shell' : ''}`}>
    {navOpen && <button class="nav-scrim" aria-label="Close navigation" onClick={() => setNavOpen(false)} />}

    <header class="workspace-navbar">
      <div class="workspace-navbar-left">
        <button class="workspace-brand" type="button" aria-label="Open navigation" onClick={() => setNavOpen(true)}><img src={DOXLOOP_LOGO} alt="Doxloop" /></button>
        <span class="mode-flag navbar-mode-flag"><i />Local mode</span>
      </div>
      <Button tone="link" class="workspace-preview-link" icon="external" onClick={() => void openPreview()}>Preview</Button>
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
      <nav class="reference-sidebar-nav" aria-label="Main navigation">
        {NAV.map(([id, label]) => <button key={id} class={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}><Icon name={id} size={17} /><span>{label}</span>{id === 'proposals' && pendingProposalCount > 0 && <b class="nav-count" aria-label={`${pendingProposalCount} pending proposal${pendingProposalCount === 1 ? '' : 's'}`}>{pendingProposalCount}</b>}</button>)}
      </nav>
      <footer class="sidebar-trust-card"><Icon name="shield" size={18} /><p>Your content is read-only and never copied to our servers.</p><a href="https://github.com/doxbrix/doxloop" target="_blank" rel="noreferrer">Learn more <Icon name="external" size={12} /></a></footer>
    </aside>

    <div class="main">
      <div class="page">
        {loading && <div class="loading-bar" />}
        {error && <Banner title="Action failed" detail={error} onClose={onErrorDismiss} />}
        {page === 'sources' && <SourcesReference state={state} act={act} />}
        {page === 'authoring' && <Authoring state={state} act={act} streamConnected={jobStreamConnected} />}
        {page === 'proposals' && <Proposals state={state} act={act} onError={onError} />}
        {page === 'publish' && <Publish state={state} act={act} />}
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
  try {
    const result = await post<{ url: string }>(`/api/proposals/${runId}/preview/start`)
    location.assign(result.url)
  } catch (cause) {
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
  return <div class="sources-reference-page">
    <PageHeader title="Sources" description="Manage the read-only sources Doxloop uses to create and maintain your documentation." actions={<div class="sources-add-wrap"><button type="button" class="sources-add-dropdown-button" aria-expanded={menuOpen} onClick={() => setMenuOpen((open) => !open)}><Icon name="plus" size={16} />Add source<Icon name="chevronDown" size={14} /></button>{menuOpen && <div class="sources-add-menu"><button type="button" onClick={() => openDialog('source')}><span><Icon name="api" size={20} /></span><span><strong>Source code</strong></span></button><button type="button" onClick={() => openDialog('openapi')}><span><Icon name="braces" size={20} /></span><span><strong>OpenAPI spec</strong></span></button></div>}</div>} />
    <section class="sources-data-panel"><header>Connected sources <Badge>{filtered.length}</Badge></header><div class="sources-table-head"><span>Name</span><span>Type</span><span>Actions</span></div>{filtered.length ? <div class="sources-table-body">{filtered.map((source) => <div class="sources-data-row" key={source.name}><span class="sources-name-cell"><span class={`source-service-icon ${source.kind === 'openapi' ? 'openapi' : source.remote ? `git ${repositoryProvider(source.remote.repository)}` : 'local'}`}><Icon name={source.kind === 'openapi' ? 'braces' : source.remote ? repositoryProviderIcon(source.remote.repository) : 'folder'} size={20} /></span><span><strong>{source.name}</strong><small>{source.remote ? source.remote.repository : source.path}</small></span></span><span><em class={`source-type-pill ${source.kind === 'openapi' ? 'openapi' : source.remote ? 'git' : 'local'}`}>{source.kind === 'openapi' ? 'OpenAPI' : source.remote ? 'Git' : 'Local'}</em></span><span class="source-row-menu"><button type="button" class={`monitoring-button ${project.sync.on.length ? 'monitoring-active' : ''}`} aria-label={`Configure monitoring for ${source.name}`} title="Configure monitoring" onClick={() => setMonitoringSource(source)}><Icon name="bell" size={18} /></button><button type="button" aria-label={`Delete ${source.name}`} title="Delete source" onClick={() => { if (confirm(`Remove ${source.name}?`)) void act(() => remove(`/api/sources/${encodeURIComponent(source.name)}`), 'Source removed') }}><Icon name="trash" size={18} /></button></span></div>)}</div> : <div class="sources-table-empty"><Icon name="sources" size={28} /><strong>No sources yet</strong><small>Add a source to start creating documentation.</small></div>}</section>
    {monitoringSource && <MonitoringDialog state={state} source={monitoringSource} act={act} onClose={() => setMonitoringSource(null)} />}
    {dialog && <div class="sources-modal-scrim" onClick={closeDialog}><section class={`sources-reference-dialog ${dialog}`} role="dialog" aria-modal="true" onClick={(event) => event.stopPropagation()}>
      <header>{dialog === 'openapi' && <span class="sources-dialog-icon"><Icon name="file" size={24} /></span>}<div><h2>{dialog === 'source' ? 'Add source code' : 'Add OpenAPI spec'}</h2><p>{dialog === 'source' ? 'Choose how you want to connect your source code.' : 'Import your OpenAPI specification from a local file or a public URL.'}</p></div><button type="button" aria-label="Close" onClick={closeDialog}><Icon name="close" size={17} /></button></header>
      {dialog === 'source' ? <div class="sources-dialog-body"><span class="dialog-section-label">Source type</span><div class="source-mode-grid"><button type="button" class={sourceMode === 'git' ? 'selected' : ''} onClick={() => setSourceMode('git')}><span><Icon name="api" size={22} /></span><i /><strong>Git repository</strong><small>Connect a GitHub, GitLab, Azure DevOps or other Git service.</small></button><button type="button" class={sourceMode === 'local' ? 'selected' : ''} onClick={() => setSourceMode('local')}><span><Icon name="folder" size={22} /></span><i /><strong>Local folder</strong><small>Use a folder on your computer or network.</small></button></div>{sourceMode === 'git' ? <div class="source-code-fields"><Field label="Repository access"><Select value={add.authMethod} onChange={(event) => { setAdd({ ...add, authMethod: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }}><option value="automatic">Public repository</option><option value="credentials">Private repository</option></Select></Field><Field label="Repository URL"><div class="repository-connect-input"><Input value={add.repository} onInput={(event) => { setAdd({ ...add, repository: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /><RepositoryConnectButton connected={Boolean(head)} busy={connecting} disabled={!add.repository.trim() || (add.authMethod === 'credentials' && (!add.gitUsername.trim() || !add.gitSecret.trim()))} onClick={() => void connectRepository()} /></div></Field>{add.authMethod === 'credentials' && <div class="private-git-fields"><Field label="Username"><Input value={add.gitUsername} autocomplete="username" onInput={(event) => { setAdd({ ...add, gitUsername: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /></Field><Field label="Personal Access Token (PAT)"><Input type="password" value={add.gitSecret} autocomplete="off" onInput={(event) => { setAdd({ ...add, gitSecret: event.currentTarget.value }); setHead(''); setBranches([]); setDirectories([]) }} /></Field></div>}<div class="source-branch-grid"><Field label="Branch"><Select value={add.branch} disabled={!head || connecting} onChange={(event) => void selectBranch(event.currentTarget.value)}>{branches.length ? branches.map((branch) => <option key={branch}>{branch}</option>) : <option>{connecting ? 'Connecting...' : 'Connect repository first'}</option>}</Select></Field><Field label="Folder (optional)"><Select value={add.subdirectory} disabled={!head || foldersLoading} onChange={(event) => setAdd({ ...add, subdirectory: event.currentTarget.value })}><option value="">/</option>{directories.map((directory) => <option key={directory}>{directory}</option>)}</Select></Field></div></div> : <Field label="Local folder"><div class="source-folder-input"><Input value={add.path} onInput={(event) => setAdd({ ...add, path: event.currentTarget.value })} /><Button icon="folder" onClick={() => void post<{ path: string | null }>('/api/setup/browse-directory').then((result) => result.path && setAdd({ ...add, path: result.path }))}>Browse</Button></div></Field>}</div> : <div class="sources-dialog-body openapi-body"><div class="openapi-tabs"><button type="button" class={openapiMode === 'file' ? 'active' : ''} onClick={() => setOpenapiMode('file')}><Icon name="publish" size={18} />Upload file</button><button type="button" class={openapiMode === 'url' ? 'active' : ''} onClick={() => setOpenapiMode('url')}><Icon name="external" size={18} />From URL</button></div>{openapiMode === 'file' ? <div class={`openapi-dropzone ${add.fileName ? 'has-file' : ''}`} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); void readSpecification(event.dataTransfer?.files[0]) }}><input ref={fileInput} type="file" accept=".yaml,.yml,.json,application/json,text/yaml" onChange={(event) => void readSpecification(event.currentTarget.files?.[0])} /><span><Icon name={add.fileName ? 'check' : 'publish'} size={28} /></span><strong>{add.fileName || 'Drag and drop your OpenAPI file here'}</strong>{!add.fileName && <small>or</small>}<Button onClick={() => fileInput.current?.click()}>{add.fileName ? 'Choose another file' : 'Browse file'}</Button><em>Accepted formats: .yaml, .yml, .json</em></div> : <Field label="OpenAPI spec URL"><div class="openapi-url-input"><Icon name="external" size={18} /><Input value={add.path} onInput={(event) => setAdd({ ...add, path: event.currentTarget.value, specContent: '', fileName: '' })} /></div><small>We support public URLs and standard OpenAPI formats.</small></Field>}</div>}
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
  const [activityOpen, setActivityOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const runs = state.jobs.filter((job) => job.type.startsWith('author:') || job.type === 'capture')
  const activeRun = runs.find((job) => job.status === 'running')
  const hasPendingProposal = validRuns(state.runs).some((run) => OPEN_STATUSES.includes(run.status))
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
  return <div class="authoring-page">
    <PageHeader title="Update Documentation" description="Apply changes and keep your docs accurate with your connected sources." />
    {hasCompletedRun && pendingSources.length > 0 && <div class="source-sync-banner">
      <span class="source-sync-icon"><Icon name="sources" size={18} /></span>
      <div>
        <strong>{pendingSources.length === 1 ? `New source “${pendingSources[0]}” was added` : `${pendingSources.length} new sources were added`}</strong>
        <p>Run Update to synchronize {pendingSources.length === 1 ? 'this source' : 'these sources'} with the existing documentation. Unrelated pages, navigation, and styling will be preserved.</p>
      </div>
    </div>}
    <Panel class="authoring-request">
      <fieldset class="authoring-fields" disabled={runBusy}>
        <div class="authoring-prompt-block">
          <div class="authoring-prompt-title"><span><Icon name="chat" size={18} /></span><h2>What changes do you need for your agent?</h2></div>
          <span class="authoring-textarea-wrap"><Textarea rows={5} maxlength={1000} value={form.request} placeholder="Describe the changes you want to apply…" onInput={(event) => setForm({ ...form, request: event.currentTarget.value })} /><small>{form.request.length} / 1000</small></span>
        </div>
        <div class="authoring-options">
          <Field label="Agent"><span class="authoring-control-icon agent"><Icon name="bot" size={16} /><Select value={form.agent} onChange={(event) => {
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
            <strong>Capture screenshots</strong>
            <div><span class="screenshot-camera"><Icon name="camera" size={18} /></span><Toggle checked={form.screenshots} disabled={runBusy} onChange={(checked) => setForm({ ...form, screenshots: checked })} label="Capture screenshots during the run" /></div>
          </div>
        </div>
      </fieldset>
      <div class="panel-inline-foot">
        <div class="row-actions">
          <Button disabled={runBusy} busy={submitting} tone="primary" icon="sparkle" onClick={() => void startRun(mode)}>Update documentation</Button>
        </div>
      </div>
    </Panel>
    <section class={`authoring-action-card activity-card ${activityOpen ? 'open' : ''}`}>
      <button type="button" class="authoring-action-card-head" aria-expanded={activityOpen} onClick={() => setActivityOpen(!activityOpen)}>
        <span class="action-card-icon activity"><Icon name="activity" size={19} /></span>
        <span class="action-card-copy"><strong>Run activity</strong><small>{activeRun ? `${streamConnected ? 'Live · ' : ''}Run in progress` : hasPendingProposal ? 'Documentation changes are ready for review' : 'No active runs'}</small></span>
        <Icon name="chevronDown" size={17} />
      </button>
      {activityOpen && runs.length > 0 && <div class="authoring-activity-list">
        {runs.slice(0, 3).map((job) => { const readyForReview = job.type === 'author:update' && job.status === 'succeeded' && hasPendingProposal; return <div class="authoring-activity-row" key={job.id}>
          <span class={`activity-status-icon ${readyForReview ? 'ready' : job.status}`}><Icon name={readyForReview || job.status === 'succeeded' ? 'check' : job.status === 'failed' ? 'alert' : job.status === 'running' ? 'refresh' : 'minus'} size={15} class={job.status === 'running' ? 'spin' : ''} /></span>
          <div><strong>{job.type.replaceAll(':', ' · ')}</strong><a href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer">{job.lines.length.toLocaleString()} output line{job.lines.length === 1 ? '' : 's'}</a></div>
          <Badge tone={readyForReview ? 'warn' : job.status === 'succeeded' ? 'good' : job.status === 'failed' ? 'bad' : job.status === 'running' ? 'info' : 'neutral'}>{readyForReview ? 'Ready for review' : job.status === 'succeeded' ? 'Succeeded' : job.status === 'failed' ? 'Failed' : job.status === 'running' ? 'Running' : 'Cancelled'}</Badge>
          <time>{timeText(job.startedAt)}</time>
          {job.status === 'running' && <Button size="sm" onClick={() => void act(() => post(`/api/jobs/${job.id}/cancel`), 'Job cancelled')}>Cancel</Button>}
        </div>})}
      </div>}
    </section>
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
  const initialRun = runs.find((run) => OPEN_STATUSES.includes(run.status)) ?? runs[0]
  const [selectedId, setSelectedId] = useState(initialRun?.id ?? '')
  const selected = runs.find((run) => run.id === selectedId) ?? initialRun
  const [changeId, setChangeId] = useState(selected?.changes[0]?.id ?? '')
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
    <PageHeader title="Review Changes" description="Preview and approve documentation changes before they replace the current site." actions={selected && <Button icon="external" onClick={() => void openProposalPreview(selected.id, onError)}>Preview proposed documentation</Button>} />
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
                  <Button tone="primary" icon="check" disabled={!open} onClick={() => selected && setConfirmingAcceptance(selected)}>Accept all</Button>
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
          <Field label="Visibility"><Select value={deployment.visibility} onChange={(event) => setDeployment({ ...deployment, visibility: event.currentTarget.value })}><option value="private">Private</option><option value="public">Public</option></Select></Field>
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
