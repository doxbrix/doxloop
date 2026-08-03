import { useEffect, useRef, useState } from 'preact/hooks'
import { api, patch, post, remove } from './api'
import {
  Badge, Button, Combo, Empty, Field, Input, JobTable, KeyValues, Lines, Note, Options, PageHeader,
  Panel, Segmented, Select, Stat, Table, Tabs, Textarea, Toggle, parseTerms, splitComma, termText, timeText,
} from './components'
import { Icon } from './icons'
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
  if (!state.projectFound) return <ProjectSetup state={state} act={act} />

  const project = state.project!
  const currentLabel = NAV.find(([id]) => id === page)?.[1] ?? 'Overview'
  const searchResults = NAV.filter(([, label, group]) => `${label} ${group}`.toLowerCase().includes(searchQuery.toLowerCase()))
  return <div class={`shell ${page === 'proposals' ? 'proposal-shell' : ''}`}>
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
      <button class="account" onClick={() => navigate('settings')}>
        <span class="account-mark">{project.title.slice(0, 1).toUpperCase()}</span>
        <span class="account-name" title={project.title}>{project.title}</span>
        <Icon name="chevronUpDown" size={14} />
      </button>
      <nav aria-label="Main navigation">
        {['', 'Automation', 'Delivery'].map((group) => <div class="nav-group" key={group || 'main'}>
          {group && <span class="nav-label">{group}</span>}
          {NAV.filter(([id, , itemGroup]) => itemGroup === group && id !== 'settings').map(([id, label]) =>
            <button key={id} class={page === id ? 'active' : ''} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>
              <Icon name={id} size={16} /><span>{label}</span>{id === 'proposals' && pendingRuns(state) > 0 && <b>{pendingRuns(state)}</b>}
            </button>)}
        </div>)}
        <div class="nav-group">
          <button class={page === 'settings' ? 'active' : ''} onClick={() => navigate('settings')}><Icon name="settings" size={16} /><span>Settings</span></button>
        </div>
      </nav>
      <footer class="sidebar-foot">
        <span class="dot" />
        <div><strong>Local workspace</strong><small title={state.root}>{shortPath(state.root ?? '')}</small></div>
      </footer>
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
        {page === 'sources' && <Sources state={state} act={act} />}
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

function ProjectSetup({ state, act }: { state: UiState; act: Action }) {
  const [form, setForm] = useState({
    directory: 'my-product-docs',
    title: 'Product documentation',
    sourceKind: 'directory',
    sourceName: 'product',
    sourcePath: '',
    generator: 'doxbrix',
    agent: '',
  })
  const [step, setStep] = useState(1)
  const generators = state.generators
  const steps = [['Project', 'Where the docs live'], ['Evidence', 'Trusted product sources'], ['Tools', 'Generator and agent'], ['Review', 'Confirm the setup']] as const
  const update = (key: string, value: string) => setForm((current) => ({ ...current, [key]: value }))
  return <div class="setup">
    <header class="setup-top"><span class="account-mark">D</span><strong>Doxloop</strong><span class="mode-flag"><i />Local mode</span></header>
    <section class="setup-panel">
      <aside class="setup-rail">
        <h2>Set up your documentation workspace</h2>
        <p>Four short steps. Product source stays read-only the whole way through.</p>
        <ol class="steps">{steps.map(([label, detail], index) => <li key={label}>
          <button type="button" disabled={index + 1 > step} class={`${step === index + 1 ? 'current' : ''} ${step > index + 1 ? 'done' : ''}`} onClick={() => setStep(index + 1)}>
            <span class="step-mark">{step > index + 1 ? <Icon name="check" size={12} /> : index + 1}</span>
            <span><strong>{label}</strong><small>{detail}</small></span>
          </button>
        </li>)}</ol>
        <div class="setup-trust"><Icon name="shield" size={16} /><span>Your product files never enter a deployment bundle.</span></div>
      </aside>
      <div class="setup-body">
        {step === 1 && <><h3>Where should the documentation live?</h3><p class="lede">Doxloop keeps documentation separate from product source, so product files stay read-only.</p>
          <div class="form-grid"><Field label="Documentation directory" wide><Input value={form.directory} onInput={(event) => update('directory', event.currentTarget.value)} /></Field><Field label="Site title" wide><Input value={form.title} onInput={(event) => update('title', event.currentTarget.value)} /></Field></div></>}
        {step === 2 && <><h3>What should the documentation be based on?</h3><p class="lede">Choose a local product repository, an OpenAPI document, or configure evidence later.</p>
          <Options value={form.sourceKind} columns={3} onChange={(value) => update('sourceKind', value)} items={[['directory', 'Product source', 'A local source-code directory'], ['openapi', 'API specification', 'A local or hosted OpenAPI file'], ['none', 'Nothing yet', 'Start with an empty project']] as const} />
          {form.sourceKind !== 'none' && <div class="form-grid gap-top"><Field label="Evidence name"><Input value={form.sourceName} onInput={(event) => update('sourceName', event.currentTarget.value)} /></Field><Field label={form.sourceKind === 'openapi' ? 'File path or URL' : 'Source directory'}><Input value={form.sourcePath} placeholder={form.sourceKind === 'openapi' ? 'openapi.yaml' : '../my-product'} onInput={(event) => update('sourcePath', event.currentTarget.value)} /></Field></div>}</>}
        {step === 3 && <><h3>Choose the site generator and coding agent</h3><p class="lede">Doxbrix is recommended. The agent can be changed for individual documentation runs.</p>
          <div class="form-grid"><Field label="Documentation generator"><Select value={form.generator} onChange={(event) => update('generator', event.currentTarget.value)}>{generators.map((item) => <option value={item.id}>{item.displayName}</option>)}</Select></Field><Field label="Default coding agent"><Select value={form.agent} onChange={(event) => update('agent', event.currentTarget.value)}><option value="">Choose later</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select></Field></div></>}
        {step === 4 && <><h3>Create the documentation project</h3><p class="lede">Review the setup before Doxloop writes any files.</p>
          <KeyValues items={[
            ['Directory', form.directory],
            ['Title', form.title],
            ['Evidence', form.sourceKind === 'none' ? 'None yet' : `${form.sourceName}: ${form.sourcePath}`],
            ['Generator', generatorLabel(generators, form.generator)],
            ['Agent', form.agent ? agentLabel(form.agent) : 'Choose later'],
          ]} />
          <Note>Product source is read-only and is never copied into deployment bundles.</Note></>}
        <footer class="setup-actions">
          <span>Step {step} of 4</span>
          <div><Button disabled={step === 1} onClick={() => setStep((value) => value - 1)}>Back</Button>
            {step < 4
              ? <Button tone="primary" disabled={step === 2 && form.sourceKind !== 'none' && !form.sourcePath.trim()} onClick={() => setStep((value) => value + 1)}>Continue</Button>
              : <Button tone="primary" onClick={() => void act(() => post('/api/project', form), 'Project created')}>Create workspace</Button>}
          </div>
        </footer>
      </div>
    </section>
    <small class="setup-path">Starting from {state.cwd}</small>
  </div>
}

function Home({ state, navigate, reload, act }: { state: UiState; navigate: (page: Page) => void; reload: () => Promise<void>; act: Action }) {
  const project = state.project!
  const validation = validValidation(state.validation)
  const runs = validRuns(state.runs)
  const drift = state.drift
  const stale = drift && 'pages' in drift ? drift.pages.length : 0
  const preferred = state.agents?.find((agent) => agent.preferred) ?? state.agents?.[0]
  const pending = runs.filter((run) => OPEN_STATUSES.includes(run.status)).length
  const healthy = (validation?.errors ?? 0) === 0 && stale === 0
  return <>
    <PageHeader
      title="Overview"
      description={project.title}
      meta={<>
        <Badge tone={healthy ? 'good' : 'warn'} icon={healthy ? 'check' : 'alert'}>{healthy ? 'Healthy' : 'Needs attention'}</Badge>
        <span>{generatorLabel(state.generators, project.generator)}</span>
        <span>{project.sources.length} source{project.sources.length === 1 ? '' : 's'}</span>
        <span>{preferred ? agentLabel(preferred.name) : 'No agent'}</span>
      </>}
      actions={<><Button icon="refresh" onClick={() => void reload()}>Refresh</Button><Button tone="primary" icon="sparkle" onClick={() => navigate('authoring')}>{state.receipt ? 'Maintain documentation' : 'Create documentation'}</Button></>}
    />
    <div class="stat-row">
      <Stat label="Documentation pages" value={validation?.pages.length ?? '—'} detail={`${validation?.errors ?? 0} errors · ${validation?.warnings ?? 0} warnings`} />
      <Stat label="Source drift" value={stale} detail={stale === 1 ? 'stale page' : 'stale pages'} {...(stale ? { tone: 'warn' as const } : {})} />
      <Stat label="Pending proposals" value={pending} detail={`${runs.length} total run${runs.length === 1 ? '' : 's'}`} />
      <Stat label="Monitoring" value={project.sync.on.length ? 'On' : 'Off'} detail={project.sync.on.join(', ') || 'Manual checks only'} />
    </div>
    <div class="split">
      <Panel title="Next steps" description="The most useful actions for this workspace" flush>
        <div class="link-rows">
          {([['authoring', 'Update documentation', 'Start an evidence-grounded agent run'], ['sync', 'Check source drift', 'Compare sources against documented evidence'], ['proposals', 'Review proposals', 'Accept or reject isolated changes'], ['preview', 'Open preview', 'Inspect the generated site locally']] as const).map(([target, title, detail]) =>
            <button key={target} onClick={() => navigate(target)}>
              <span class="row-icon"><Icon name={target} size={16} /></span>
              <span class="row-copy"><strong>{title}</strong><small>{detail}</small></span>
              <Icon name="chevronRight" size={14} class="row-chevron" />
            </button>)}
        </div>
      </Panel>
      <Panel title="Workspace readiness" description="Live checks across the setup" flush>
        <div class="check-rows">
          <Check ok={Boolean(preferred)} label="Coding agent" detail={preferred ? `${agentLabel(preferred.name)} · ${preferred.authentication.status}` : 'No supported agent detected'} />
          <Check ok={(validation?.errors ?? 1) === 0} label="Documentation validation" detail={`${validation?.errors ?? 0} errors and ${validation?.warnings ?? 0} warnings`} />
          <Check ok={project.sources.length > 0} label="Product evidence" detail={`${project.sources.length} configured source${project.sources.length === 1 ? '' : 's'}`} />
          <Check ok={Boolean(state.account?.signedIn)} label="Doxbrix account" detail={state.account?.user?.email ?? state.account?.detail ?? 'Not signed in'} />
        </div>
      </Panel>
    </div>
    <Panel title="Recent activity" actions={<Button size="sm" onClick={() => void act(() => api('/api/jobs'), undefined, false)}>Refresh</Button>} flush>
      <JobTable jobs={state.jobs.slice(0, 5)} onCancel={(id) => void act(() => post(`/api/jobs/${id}/cancel`), 'Job cancelled')} />
    </Panel>
  </>
}

function Sources({ state, act }: { state: UiState; act: Action }) {
  const project = state.project!
  const [selected, setSelected] = useState(project.sources[0]?.name ?? '')
  const [adding, setAdding] = useState(project.sources.length === 0)
  const [add, setAdd] = useState({ kind: 'directory', name: 'product', path: '' })
  const source = project.sources.find((item) => item.name === selected) ?? project.sources[0]
  return <>
    <PageHeader
      title="Sources"
      description="The trusted, read-only evidence Doxloop uses to create and maintain documentation."
      actions={<Button tone="primary" icon="plus" onClick={() => setAdding(true)}>Add source</Button>}
    />
    <div class="stat-row three">
      <Stat label="Connected sources" value={project.sources.length} detail="Read-only evidence" />
      <Stat label="Remote monitored" value={project.sources.filter((item) => item.remote).length} detail="GitHub connections" />
      <Stat label="API specifications" value={project.sources.filter((item) => item.kind === 'openapi').length} detail="OpenAPI documents" />
    </div>

    {adding && <Panel title="Add a source" description="Source paths are validated to stay outside the documentation content directory." actions={<Button size="sm" onClick={() => setAdding(false)}>Cancel</Button>}>
      <div class="form-grid">
        <Field label="Type"><Select value={add.kind} onChange={(event) => setAdd({ ...add, kind: event.currentTarget.value })}><option value="directory">Source directory</option><option value="openapi">OpenAPI specification</option></Select></Field>
        <Field label="Evidence name"><Input value={add.name} onInput={(event) => setAdd({ ...add, name: event.currentTarget.value })} /></Field>
        <Field label={add.kind === 'openapi' ? 'File path or URL' : 'Directory path'} wide><Input value={add.path} placeholder={add.kind === 'openapi' ? 'openapi.yaml or https://…' : '../product'} onInput={(event) => setAdd({ ...add, path: event.currentTarget.value })} /></Field>
      </div>
      <div class="form-actions"><Button tone="primary" disabled={!add.path.trim()} onClick={() => void act(() => post('/api/sources', add), 'Evidence added').then(() => setAdding(false))}>Add source</Button></div>
    </Panel>}

    {project.sources.length === 0
      ? <Panel flush><Empty icon="sources" title="No product evidence configured" detail="Add a source directory or OpenAPI specification to ground your documentation." action={<Button tone="primary" icon="plus" onClick={() => setAdding(true)}>Add source</Button>} /></Panel>
      : <>
        <Panel title="Connected sources" flush>
          <Table head={<><th>Name</th><th>Type</th><th>Location</th><th>Monitoring</th><th class="right" /></>}>
            {project.sources.map((item) => <tr key={item.name} class={`selectable ${item.name === source?.name ? 'selected' : ''}`} onClick={() => setSelected(item.name)}>
              <td><div class="cell-lead"><Icon name={item.kind === 'openapi' ? 'api' : 'folder'} size={15} /><strong>{item.name}</strong></div></td>
              <td class="muted-cell">{item.kind === 'openapi' ? 'OpenAPI' : 'Directory'}</td>
              <td><code class="mono">{item.path}</code></td>
              <td>{item.remote ? <Badge tone="info" icon="github">{item.remote.repository}</Badge> : <span class="muted-cell">Local only</span>}</td>
              <td class="right"><Button size="sm" tone="ghost" onClick={(event) => { event.stopPropagation(); if (confirm(`Remove ${item.name}?`)) void act(() => remove(`/api/sources/${encodeURIComponent(item.name)}`), 'Evidence removed') }}><Icon name="trash" size={14} /></Button></td>
            </tr>)}
          </Table>
        </Panel>
        {source && <SourceDetail key={source.name} source={source} act={act} />}
      </>}
  </>
}

function SourceDetail({ source, act }: { source: Source; act: Action }) {
  const [remote, setRemote] = useState(source.remote ?? { provider: 'github' as const, repository: '', branch: 'main', tokenEnv: 'GITHUB_TOKEN', apiBaseUrl: '' })
  const [location, setLocation] = useState({ kind: source.kind ?? 'directory', path: source.path })
  const [tab, setTab] = useState<'location' | 'remote'>('location')
  return <Panel title={source.name} description={`${source.kind === 'openapi' ? 'OpenAPI specification' : 'Source directory'} · ${source.path}`}>
    {(source.kind ?? 'directory') === 'directory' && <Tabs value={tab} onChange={setTab} items={[['location', 'Location'], ['remote', 'Remote monitoring']] as const} />}
    {tab === 'location' || (source.kind ?? 'directory') !== 'directory'
      ? <>
        <div class="form-grid">
          <Field label="Evidence type"><Select value={location.kind} onChange={(event) => setLocation({ ...location, kind: event.currentTarget.value as 'directory' | 'openapi' })}><option value="directory">Source directory</option><option value="openapi">OpenAPI specification</option></Select></Field>
          <Field label="Path or URL"><Input value={location.path} onInput={(event) => setLocation({ ...location, path: event.currentTarget.value })} /></Field>
        </div>
        <div class="form-actions"><Button tone="primary" disabled={!location.path.trim()} onClick={() => void act(() => patch(`/api/sources/${encodeURIComponent(source.name)}`, location), 'Evidence location saved')}>Save source</Button></div>
      </>
      : <>
        <div class="form-grid">
          <Field label="GitHub repository" hint="owner/repository"><Input value={remote.repository} placeholder="acme/product" onInput={(event) => setRemote({ ...remote, repository: event.currentTarget.value })} /></Field>
          <Field label="Branch"><Input value={remote.branch} onInput={(event) => setRemote({ ...remote, branch: event.currentTarget.value })} /></Field>
          <Field label="Token environment variable"><Input value={remote.tokenEnv ?? ''} onInput={(event) => setRemote({ ...remote, tokenEnv: event.currentTarget.value })} /></Field>
          <Field label="GitHub Enterprise API URL"><Input value={remote.apiBaseUrl ?? ''} placeholder="Optional" onInput={(event) => setRemote({ ...remote, apiBaseUrl: event.currentTarget.value })} /></Field>
        </div>
        <div class="form-actions">
          <Button tone="danger" onClick={() => void act(() => patch(`/api/sources/${encodeURIComponent(source.name)}`, { remote: null }), 'Remote monitoring removed')}>Disconnect</Button>
          <Button disabled={!source.remote} onClick={() => void act(() => post(`/api/sources/${encodeURIComponent(source.name)}/test`), 'Remote connection verified')}>Test connection</Button>
          <Button tone="primary" disabled={!remote.repository || !remote.branch} onClick={() => void act(() => patch(`/api/sources/${encodeURIComponent(source.name)}`, { remote }), 'Remote source saved')}>Save connection</Button>
        </div>
      </>}
  </Panel>
}

function Authoring({ state, act, streamConnected }: { state: UiState; act: Action; streamConnected: boolean }) {
  const hasCompletedRun = Boolean(state.receipt)
  const mode = hasCompletedRun ? 'update' : 'create'
  const pendingSources = state.receipt?.pendingSources ?? []
  const defaultAgent = state.project?.defaultAgent ?? ''
  const [form, setForm] = useState({ request: '', agent: defaultAgent, model: '', reasoning: defaultAgent === 'codex' ? 'high' : '', effort: defaultAgent === 'claude' ? 'high' : '', screenshots: false })
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
      description="Describe the outcome you want. Every change is grounded in your evidence, and product sources stay read-only."
    />
    {hasCompletedRun && pendingSources.length > 0 && <div class="source-sync-banner">
      <span class="source-sync-icon"><Icon name="sources" size={18} /></span>
      <div>
        <strong>{pendingSources.length === 1 ? `New source “${pendingSources[0]}” was added` : `${pendingSources.length} new sources were added`}</strong>
        <p>Run Update to synchronize {pendingSources.length === 1 ? 'this source' : 'these sources'} with the existing documentation. Unrelated pages, navigation, and styling will be preserved.</p>
      </div>
    </div>}
    {activeRun && <LiveJobLog job={activeRun} connected={streamConnected} />}
    <Panel class="authoring-request" icon="wand" title={hasCompletedRun ? 'Update documentation' : 'Create documentation'} description={hasCompletedRun ? 'Maintain the existing documentation after product or source changes.' : 'Generate the first documentation set from the configured evidence.'}>
          <fieldset class="authoring-fields" disabled={runBusy}>
            <legend>Run options</legend>
            <div class="authoring-options">
              <Field label="Agent"><Select icon="bot" value={form.agent} onChange={(event) => {
                const agent = event.currentTarget.value
                setForm({
                  ...form,
                  agent,
                  reasoning: agent === 'codex' ? (form.reasoning || 'high') : '',
                  effort: agent === 'claude' ? (form.effort || 'high') : '',
                })
              }}><option value="">Automatically detect</option><option value="codex">Codex</option><option value="claude">Claude Code</option><option value="gemini">Gemini</option></Select></Field>
              <Field label={form.agent ? `${agentLabel(form.agent)} model` : 'Model override'}>
                <Combo list="doxloop-model-suggestions" value={form.model} placeholder={modelPlaceholder(form.agent)} onInput={(event) => setForm({ ...form, model: event.currentTarget.value })}>
                  <datalist id="doxloop-model-suggestions">{modelSuggestions(form.agent).map((model) => <option key={model} value={model} />)}</datalist>
                </Combo>
              </Field>
              {form.agent === 'codex' && <Field label="Reasoning"><Select value={form.reasoning} onChange={(event) => setForm({ ...form, reasoning: event.currentTarget.value })}>{['minimal', 'low', 'medium', 'high', 'xhigh'].map((value) => <option value={value}>{value}</option>)}</Select></Field>}
              {form.agent === 'claude' && <Field label="Effort"><Select value={form.effort} onChange={(event) => setForm({ ...form, effort: event.currentTarget.value })}>{['low', 'medium', 'high', 'xhigh', 'max'].map((value) => <option value={value}>{value}</option>)}</Select></Field>}
              {!['codex', 'claude'].includes(form.agent) && <Field label="Reasoning"><Select disabled><option>Default</option></Select></Field>}
              <div class="screenshot-option"><span>Capture application screenshots</span><Toggle checked={form.screenshots} disabled={runBusy} onChange={(checked) => setForm({ ...form, screenshots: checked })} label="Capture screenshots during the run" /></div>
            </div>
            <Field label="What should the agent do?" wide hint={hasCompletedRun ? 'Be specific about the user outcome, or leave empty to synchronize detected source changes.' : 'Be specific about the user outcome. Leave empty to receive a complete recommendation.'}>
              <Textarea rows={4} value={form.request} placeholder="For example: Document webhook retries and the new authentication flow for developers integrating our API…" onInput={(event) => setForm({ ...form, request: event.currentTarget.value })} />
            </Field>
          </fieldset>
          <div class="panel-inline-foot">
            <span><Icon name="lock" size={14} />Product evidence stays read-only</span>
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
  const [sync, setSync] = useState<SyncConfig>(structuredClone(project.sync))
  const [advanced, setAdvanced] = useState(false)
  const drift = state.drift
  const stale = drift && 'pages' in drift ? drift.pages.length : 0
  const set = <K extends keyof SyncConfig>(key: K, value: SyncConfig[K]) => setSync((current) => ({ ...current, [key]: value }))
  const modeLabel = { check: 'Notify only', propose: 'Prepare proposal', auto: 'Automatic proposals' }[project.sync.mode]
  return <div class="sync-page">
    <PageHeader
      icon="sparkles"
      title="Monitoring"
      description="Detect when source changes make documentation stale, then prepare safe proposals."
      actions={<><Button tone="danger" onClick={() => confirm('Disable the installed monitoring schedule?') && void act(() => post('/api/sync/off'), 'Monitoring disabled')}>Disable</Button><Button tone="primary" icon="refresh" onClick={() => void act(() => post('/api/sync/now'), 'Source check started')}>Check now</Button></>}
    />
    <div class="stat-row three">
      <Stat icon="calendar" label="Schedule" value={project.sync.on.length ? 'Active' : 'Manual'} detail={project.sync.on.join(', ') || 'No schedule installed'} />
      <Stat icon="file" label="Stale pages" value={stale} detail="Since the last check" {...(stale ? { tone: 'warn' as const } : {})} />
      <Stat icon="bell" label="Response" value={modeLabel} detail="When documentation is stale" />
    </div>
    <div class="split wide-left">
      <div class="stack">
        <Panel icon="shield" title="Monitoring policy" description="The schedule runs locally through the operating system.">
          <div class="form-grid">
            <Field label="Product branch"><Input value={sync.branch ?? ''} placeholder="main" onInput={(event) => set('branch', event.currentTarget.value)} /></Field>
            <Field label="Schedules" hint="Leave blank for manual only. Separate multiple schedules with commas.">
              <Input list="sync-schedules" value={sync.on.join(', ')} placeholder="every@15m or daily@09:00" onInput={(event) => set('on', splitComma(event.currentTarget.value))} />
              <datalist id="sync-schedules"><option value="every@15m" /><option value="every@1h" /><option value="daily@09:00" /></datalist>
            </Field>
          </div>
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
      <Panel icon="broadcast" title="Live status" description="Remote, scheduler, agent and evidence checks">
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
                <select aria-label="Choose a proposal file" value={change?.id ?? ''} onChange={(event) => setChangeId(event.currentTarget.value)}>
                  {selected.changes.map((item) => <option key={item.id} value={item.id}>{item.path} · {item.kind}</option>)}
                </select>
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
          ? <Empty icon="quality" title="No issues to show" detail="Pages, navigation, links and evidence passed validation." />
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
  const [docs, setDocs] = useState({ ...project.documentation, outcomesText: project.documentation.priorityOutcomes?.join(', ') ?? '', toneText: project.documentation.tone.join(', '), exclusionsText: project.documentation.exclusions.join('\n'), termsText: termText(project.documentation.terminology) })
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
  const saveDocs = () => act(() => patch('/api/project', { documentation: { ...docs, priorityOutcomes: splitComma(docs.outcomesText), tone: splitComma(docs.toneText), exclusions: docs.exclusionsText.split('\n').map((item) => item.trim()).filter(Boolean), terminology: parseTerms(docs.termsText) } }), 'Documentation preferences saved')
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
            <Field label="Experience level"><Select value={docs.experienceLevel ?? 'intermediate'} onChange={(event) => setDocs({ ...docs, experienceLevel: event.currentTarget.value })}><option value="beginner">Beginner</option><option value="intermediate">Intermediate</option><option value="advanced">Advanced</option><option value="mixed">Mixed</option></Select></Field>
            <Field label="Locale"><Input value={docs.locale} onInput={(event) => setDocs({ ...docs, locale: event.currentTarget.value })} /></Field>
            <Field label="Accessibility target"><Input value={docs.accessibilityTarget} onInput={(event) => setDocs({ ...docs, accessibilityTarget: event.currentTarget.value })} /></Field>
            <Field label="Tone"><Input value={docs.toneText} placeholder="clear, direct, helpful" onInput={(event) => setDocs({ ...docs, toneText: event.currentTarget.value })} /></Field>
            <Field label="Priority outcomes"><Input value={docs.outcomesText} placeholder="quick start, successful integration" onInput={(event) => setDocs({ ...docs, outcomesText: event.currentTarget.value })} /></Field>
            <Field label="Standards profile"><Input value={docs.standardsProfile} onInput={(event) => setDocs({ ...docs, standardsProfile: event.currentTarget.value })} /></Field>
            <Field label="Style guide"><Input value={docs.styleGuide} onInput={(event) => setDocs({ ...docs, styleGuide: event.currentTarget.value })} /></Field>
            <Field label="Preferred terminology" hint="One “term = replacement” per line"><Textarea rows={5} value={docs.termsText} onInput={(event) => setDocs({ ...docs, termsText: event.currentTarget.value })} /></Field>
            <Field label="Content exclusions" hint="One item per line"><Textarea rows={5} value={docs.exclusionsText} onInput={(event) => setDocs({ ...docs, exclusionsText: event.currentTarget.value })} /></Field>
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

function Check({ ok, warning, label, detail }: { ok: boolean; warning?: boolean; label: string; detail?: string }) {
  return <div class="check">
    <span class={`check-mark ${ok ? 'pass' : warning ? 'warn' : 'fail'}`}><Icon name={ok ? 'check' : warning ? 'alert' : 'close'} size={12} /></span>
    <div><strong>{label}</strong>{detail && <small>{detail}</small>}</div>
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

function validRuns(value: UiState['runs']): Proposal[] {
  return Array.isArray(value) ? value : []
}

function validValidation(value: UiState['validation']): Validation | undefined {
  return value && !value.error ? value : undefined
}

function pendingRuns(state: UiState): number {
  return validRuns(state.runs).filter((run) => OPEN_STATUSES.includes(run.status)).length
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

function modelHint(agent: string): string {
  if (agent === 'claude') return 'Choose a current Claude model ID or type another supported ID. Leave empty for the Claude Code default.'
  if (agent === 'codex') return 'Choose a suggestion or type any Codex model ID. Leave empty for the configured default.'
  if (agent === 'gemini') return 'Choose a suggestion or type any Gemini model ID. Leave empty for the configured default.'
  return 'Select an agent for suggestions, or type any model ID. Leave empty to use the agent default.'
}

function modelPlaceholder(agent: string): string {
  if (agent === 'claude') return 'For example: claude-sonnet-5'
  if (agent === 'codex') return 'For example: gpt-5.6-sol'
  if (agent === 'gemini') return 'For example: gemini-3.1-pro-preview'
  return 'Use agent default'
}

function modelSuggestions(agent: string): string[] {
  if (agent === 'claude') return ['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5', 'claude-haiku-4-5-20251001']
  if (agent === 'codex') return ['gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']
  if (agent === 'gemini') return ['gemini-3.1-pro-preview', 'gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite']
  return []
}
