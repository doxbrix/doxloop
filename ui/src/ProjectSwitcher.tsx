import { useEffect, useRef, useState } from 'preact/hooks'
import { api, post, NO_TIMEOUT } from './api'
import { Button, Field, Input, Note, Select } from './components'
import { Icon } from './icons'
import { generatorLabel, inspectionSummary, projectFolderName, recentProjectChoices } from './project-presentation'
import type { GeneratorEntry, ProjectInspection, RecentProject, UiState } from './types'

type ProjectsResponse = { current: string | null; recent: RecentProject[]; generators: GeneratorEntry[] }

/**
 * The sidebar control that names the open workspace and switches to another:
 * a recent project, a folder that is already a Doxloop project, or an
 * existing documentation folder that is imported first.
 */
export function ProjectSwitcher({ state, onSwitched, onNewProject, onError }: {
  state: UiState
  onSwitched: () => Promise<void>
  onNewProject: () => void
  onError: (message: string) => void
}) {
  const project = state.project!
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState('')
  const [recent, setRecent] = useState<RecentProject[]>(state.recentProjects ?? [])
  const [importing, setImporting] = useState<{ path: string; inspection?: ProjectInspection } | null>(null)
  // The sidebar clips its overflow, so the menu is fixed to the viewport at the toggle's position.
  const [anchor, setAnchor] = useState({ top: 0, left: 0 })
  const menu = useRef<HTMLDivElement>(null)
  const toggle = useRef<HTMLButtonElement>(null)

  useEffect(() => { setRecent(state.recentProjects ?? []) }, [state.recentProjects])
  useEffect(() => {
    if (!open) return
    const close = (event: MouseEvent) => { if (menu.current && !menu.current.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', escape) }
  }, [open])

  const choices = recentProjectChoices(recent, state.root)
  const openProject = async (path: string) => {
    setBusy(path)
    try {
      await post('/api/projects/open', { path })
      setOpen(false)
      await onSwitched()
    } catch (cause) {
      onError(message(cause))
    } finally {
      setBusy('')
    }
  }
  const forget = async (path: string) => {
    try {
      const result = await post<{ recent: RecentProject[] }>('/api/projects/forget', { path })
      setRecent(result.recent)
    } catch (cause) {
      onError(message(cause))
    }
  }
  const openFolder = async () => {
    setBusy('browse')
    try {
      const chosen = await post<{ path: string | null }>('/api/projects/browse', {}, NO_TIMEOUT)
      if (!chosen.path) return
      const inspection = await post<ProjectInspection>('/api/projects/inspect', { path: chosen.path })
      if (inspection.alreadyProject) {
        await openProject(chosen.path)
        return
      }
      setOpen(false)
      setImporting({ path: chosen.path, inspection })
    } catch (cause) {
      onError(message(cause))
    } finally {
      setBusy('')
    }
  }

  return <div class="project-switcher" ref={menu}>
    <button
      type="button"
      class="workspace-identity project-switcher-toggle"
      aria-haspopup="menu"
      aria-expanded={open}
      aria-label={`Current workspace: ${project.title}. Switch project`}
      ref={toggle}
      onClick={() => {
        const rect = toggle.current?.getBoundingClientRect()
        if (rect) setAnchor({ top: rect.bottom + 6, left: rect.left })
        setOpen((value) => !value)
      }}
    >
      <span class="workspace-identity-mark">{project.title.slice(0, 1).toUpperCase()}</span>
      <span class="workspace-identity-copy"><strong>{project.title}</strong><small>{state.root ? projectFolderName(state.root) : 'Local workspace'}</small></span>
      <Icon name="chevronUpDown" size={14} />
    </button>
    {open && <div class="project-switcher-menu" role="menu" aria-label="Projects" style={{ top: `${anchor.top}px`, left: `${anchor.left}px` }}>
      <div class="project-switcher-current"><small>Open now</small><strong>{project.title}</strong><span title={state.root}>{state.root}</span></div>
      <div class="project-switcher-section"><small>Recent</small>
        {choices.length === 0 && <p class="project-switcher-empty">No other projects opened yet.</p>}
        {choices.map((item) => <div key={item.path} class={`project-recent-row ${item.missing ? 'missing' : ''}`}>
          <button type="button" role="menuitem" disabled={Boolean(busy) || item.missing} title={item.path} onClick={() => void openProject(item.path)}>
            <span class="project-recent-mark">{item.title.slice(0, 1).toUpperCase()}</span>
            <span class="project-recent-copy"><strong>{item.title}</strong><small>{item.missing ? 'Folder no longer has a Doxloop project' : `${item.generator} · ${projectFolderName(item.path)}`}</small></span>
            {busy === item.path && <span class="spinner" />}
          </button>
          <button type="button" class="project-recent-forget" aria-label={`Remove ${item.title} from recent projects`} title="Remove from recent" onClick={() => void forget(item.path)}><Icon name="close" size={13} /></button>
        </div>)}
      </div>
      <div class="project-switcher-actions">
        <button type="button" role="menuitem" disabled={Boolean(busy)} onClick={() => void openFolder()}><Icon name="folder" size={16} /><span><strong>Open folder…</strong><small>A Doxloop project, or existing docs to import</small></span>{busy === 'browse' && <span class="spinner" />}</button>
        <button type="button" role="menuitem" disabled={Boolean(busy)} onClick={() => { setOpen(false); setImporting({ path: '' }) }}><Icon name="publish" size={16} /><span><strong>Import existing documentation…</strong><small>Adopt a Docusaurus, MkDocs, Hugo, or other site</small></span></button>
        <button type="button" role="menuitem" disabled={Boolean(busy)} onClick={() => { setOpen(false); onNewProject() }}><Icon name="plus" size={16} /><span><strong>New documentation project</strong><small>Open the setup wizard</small></span></button>
      </div>
    </div>}
    {importing && <div class="proposal-ready-scrim project-dialog-scrim" role="presentation">
      <section class="project-dialog" role="dialog" aria-modal="true" aria-labelledby="import-project-title">
        <button class="proposal-ready-close" type="button" aria-label="Close" onClick={() => setImporting(null)}><Icon name="close" size={16} /></button>
        <header><span class="proposal-ready-icon"><Icon name="publish" size={22} /></span><div><h2 id="import-project-title">Import existing documentation</h2><p>Doxloop adopts the folder as it is: it reads the site's configuration, lists its pages, and adds only its own project files.</p></div></header>
        <ImportExistingPanel
          initialPath={importing.path}
          initialInspection={importing.inspection}
          onCancel={() => setImporting(null)}
          onImported={async () => { setImporting(null); await onSwitched() }}
        />
      </section>
    </div>}
  </div>
}

/**
 * Inspect a folder, let the person correct the detected generator, content
 * directory, and title, then import it. Used by the switcher dialog and by
 * the setup wizard's "Use existing documentation" choice.
 */
export function ImportExistingPanel({ initialPath = '', initialInspection, onImported, onCancel }: {
  initialPath?: string
  initialInspection?: ProjectInspection | undefined
  onImported: () => Promise<void>
  onCancel?: (() => void) | undefined
}) {
  const [path, setPath] = useState(initialPath)
  const [inspection, setInspection] = useState<ProjectInspection | undefined>(initialInspection)
  const [generators, setGenerators] = useState<GeneratorEntry[]>([])
  const [generator, setGenerator] = useState(initialInspection?.generator ?? '')
  const [contentDir, setContentDir] = useState(initialInspection?.contentDir ?? '')
  const [title, setTitle] = useState(initialInspection?.title ?? '')
  const [installGenerator, setInstallGenerator] = useState(true)
  const [inspecting, setInspecting] = useState(false)
  const [browsing, setBrowsing] = useState(false)
  const [importingNow, setImportingNow] = useState(false)
  const [error, setError] = useState('')
  const inspectedFor = useRef(initialInspection ? `${initialPath}|${initialInspection.generator ?? ''}|${initialInspection.contentDir ?? ''}` : '')

  useEffect(() => {
    void api<Partial<ProjectsResponse>>('/api/projects').then((result) => setGenerators(result.generators ?? [])).catch(() => undefined)
  }, [])

  const inspect = async (overrides: { generator?: string; contentDir?: string } = {}) => {
    const target = path.trim()
    if (!target) return
    const key = `${target}|${overrides.generator ?? ''}|${overrides.contentDir ?? ''}`
    if (inspectedFor.current === key) return
    inspectedFor.current = key
    setInspecting(true)
    setError('')
    try {
      const result = await post<ProjectInspection>('/api/projects/inspect', { path: target, ...overrides })
      setInspection(result)
      setGenerator(result.generator ?? overrides.generator ?? '')
      setContentDir(result.contentDir ?? overrides.contentDir ?? '')
      setTitle((current) => current.trim() ? current : result.title)
    } catch (cause) {
      setInspection(undefined)
      setError(message(cause))
    } finally {
      setInspecting(false)
    }
  }
  const browse = async () => {
    setBrowsing(true)
    setError('')
    try {
      const chosen = await post<{ path: string | null }>('/api/projects/browse', {}, NO_TIMEOUT)
      if (chosen.path) {
        setPath(chosen.path)
        inspectedFor.current = ''
        setTitle('')
        // The picked path is not in state yet; inspect it directly.
        const result = await post<ProjectInspection>('/api/projects/inspect', { path: chosen.path })
        inspectedFor.current = `${chosen.path}|${result.generator ?? ''}|${result.contentDir ?? ''}`
        setInspection(result)
        setGenerator(result.generator ?? '')
        setContentDir(result.contentDir ?? '')
        setTitle(result.title)
      }
    } catch (cause) {
      setError(message(cause))
    } finally {
      setBrowsing(false)
    }
  }
  const chooseGenerator = (value: string) => {
    setGenerator(value)
    if (value) void inspect({ generator: value, ...(contentDir ? { contentDir } : {}) })
  }
  const recheck = () => void inspect({ ...(generator ? { generator } : {}), contentDir })
  const importFolder = async () => {
    setImportingNow(true)
    setError('')
    try {
      await post('/api/projects/import', {
        path: path.trim(),
        ...(generator ? { generator } : {}),
        contentDir,
        ...(title.trim() ? { title: title.trim() } : {}),
        installGenerator: installGenerator && inspection ? !inspection.generatorInstalled : false,
      }, NO_TIMEOUT)
      await onImported()
    } catch (cause) {
      setError(message(cause))
    } finally {
      setImportingNow(false)
    }
  }

  const summary = inspection ? inspectionSummary(inspection, generators) : undefined
  const canImport = Boolean(inspection && summary?.canImport && generator && path.trim()) && !inspecting && !importingNow
  return <div class="import-existing-panel">
    <Field label="Documentation folder" hint="The folder that holds the site's configuration, for example where mkdocs.yml or docusaurus.config.js lives.">
      <div class="source-folder-input">
        <Input value={path} placeholder="/path/to/your/docs-site" onInput={(event) => { setPath(event.currentTarget.value); setInspection(undefined) }} onBlur={() => void inspect()} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void inspect() } }} />
        <Button icon="folder" busy={browsing} onClick={() => void browse()}>Browse</Button>
        <Button busy={inspecting} disabled={!path.trim()} onClick={() => void inspect()}>Check</Button>
      </div>
    </Field>
    {summary && <div class={`import-inspection ${summary.tone}`}><span><Icon name={summary.tone === 'ok' ? 'check' : 'alert'} size={16} /></span><div><strong>{summary.headline}</strong><small>{summary.detail}</small></div></div>}
    {inspection && !inspection.alreadyProject && <>
      <div class="import-existing-grid">
        <Field label="Generator" hint={inspection.generator ? `Detected ${generatorLabel(inspection.generator, generators)}.` : 'Not detected. Choose the site generator.'}>
          <Select value={generator} onChange={(event) => chooseGenerator(event.currentTarget.value)}>
            <option value="">Choose a generator</option>
            {(generators.length ? generators : inspection.detection.candidates.map((candidate) => ({ id: candidate.generator, displayName: candidate.generator, installed: true }))).map((entry) => <option key={entry.id} value={entry.id}>{entry.displayName}{inspection.detection.candidates.some((candidate) => candidate.generator === entry.id) ? ' · detected' : ''}</option>)}
          </Select>
        </Field>
        <Field label="Content directory" hint={generator === 'doxbrix' ? 'Leave empty when the pages are in the folder itself.' : 'The folder inside the site that holds the pages.'}>
          <div class="source-folder-input"><Input value={contentDir} placeholder={generator === 'doxbrix' ? '(folder itself)' : 'docs'} onInput={(event) => setContentDir(event.currentTarget.value)} onBlur={recheck} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); recheck() } }} /><Button busy={inspecting} onClick={recheck}>Re-check</Button></div>
        </Field>
      </div>
      <Field label="Documentation title"><Input value={title} onInput={(event) => setTitle(event.currentTarget.value)} /></Field>
      {inspection.pages.length > 0 && <div class="import-page-sample"><small>{inspection.pageCount > inspection.pages.length ? `First ${inspection.pages.length} of ${inspection.pageCount} pages` : `${inspection.pageCount} ${inspection.pageCount === 1 ? 'page' : 'pages'}`}</small><ul>{inspection.pages.map((page) => <li key={page}><code>{page}</code></li>)}</ul></div>}
      {generator && !inspection.generatorInstalled && inspection.generatorPackage && <label class="import-install-choice"><input type="checkbox" checked={installGenerator} onChange={(event) => setInstallGenerator(event.currentTarget.checked)} /><span><strong>Install {inspection.generatorPackage} into this folder</strong><small>Adds a development dependency to the folder's package.json so Doxloop can read and validate the site. Uncheck to install it yourself first.</small></span></label>}
    </>}
    {error && <Note tone="bad">{error}</Note>}
    <footer class="import-existing-actions">
      {onCancel && <Button onClick={onCancel} disabled={importingNow}>Cancel</Button>}
      <Button tone="primary" icon="check" busy={importingNow} disabled={!canImport} onClick={() => void importFolder()}>Import and open</Button>
    </footer>
  </div>
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
