import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useMemo, useState } from 'preact/hooks'
import { api, post, put } from './api'
import { Button, Note } from './components'
import { Icon } from './icons'
import { NavigationEditor } from './NavigationEditor'
import { NavigationExplorer } from './NavigationExplorer'
import { flattenItems, fromItems, itemsToPlanNavigation, planNavigationToItems, planPageItem, toItems, updateItem, type NavItem } from './navigation-tree'
import type { DocumentationPlan, DocumentationPlanNavigation, DocumentationPlanPage, NavigationTree } from './types'

type Action = <T>(run: () => Promise<T>, success?: string, reload?: boolean) => Promise<T | undefined>

/**
 * Loads the generator's navigation as a tree, lets the
 * person reorder, group, relabel, hide, and add pages, and writes it back
 * through the navigation service with the fingerprint it was loaded with.
 * The preview frame beside it reloads after every save.
 */
export function NavigationView({ act, onError, previewUrl, embedded = false, onStatus, onSaved, onSelectPage, activePath, selectedPaths, onTogglePage, pages = [], refreshToken }: {
  act: Action; onError: (error: string) => void; previewUrl?: string; embedded?: boolean
  onStatus?: (dirty: boolean, saving: boolean) => void
  onSaved?: () => Promise<void>
  onSelectPage?: (path: string) => void
  activePath?: string
  pages?: Array<{ path: string; title: string }>
  refreshToken?: number
  selectedPaths?: string[]
  onTogglePage?: (path: string) => void
}) {
  const [tree, setTree] = useState<NavigationTree>()
  const [spaces, setSpaces] = useState<Array<{ name: string; version?: string; items: NavItem[] }>>([])
  const [spaceIndex, setSpaceIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState('')
  const [loadError, setLoadError] = useState('')
  const [frameUrl, setFrameUrl] = useState(previewUrl)
  const [frameNonce, setFrameNonce] = useState(0)

  const [slow, setSlow] = useState(false)
  const load = async (attempt = 0): Promise<void> => {
    setLoadError('')
    const slowTimer = setTimeout(() => setSlow(true), 6000)
    try {
      // A stalled request is retried once and then reported, never left spinning.
      const raw = await api<NavigationTree>('/api/navigation', { signal: AbortSignal.timeout(20_000) })
      const next: NavigationTree = { ...raw, spaces: raw.spaces ?? [], orphans: raw.orphans ?? [], icons: raw.icons ?? [], supports: raw.supports ?? { icons: false, hidden: false, labels: false, links: false, dividers: false, spaces: false } }
      setTree(next)
      setSpaces(next.spaces.map((space) => ({ name: space.name, ...(space.version ? { version: space.version } : {}), items: toItems(space.nav) })))
      setConflict('')
    } catch (cause) {
      if (attempt === 0) { clearTimeout(slowTimer); await new Promise((resolve) => setTimeout(resolve, 1500)); return await load(1) }
      setLoadError(cause instanceof Error ? cause.message : String(cause))
    } finally { clearTimeout(slowTimer); setSlow(false) }
  }

  useEffect(() => {
    if (embedded || frameUrl || !tree?.editable) return
    void post<{ url: string }>('/api/preview/start', { open: false }).then((result) => setFrameUrl(result.url)).catch(() => undefined)
  }, [tree?.editable, frameUrl])

  const saved = useMemo(() => JSON.stringify(tree?.spaces.map((space) => ({ name: space.name, ...(space.version ? { version: space.version } : {}), nav: space.nav.map(stripDerived) })) ?? []), [tree])
  const current = JSON.stringify(spaces.map((space) => ({ name: space.name, ...(space.version ? { version: space.version } : {}), nav: fromItems(space.items) })))
  const dirty = Boolean(tree) && current !== saved
  useEffect(() => { if (!dirty && !saving) void load() }, [refreshToken])
  useEffect(() => { const matches = (space: typeof spaces[number]) => flattenItems(space.items).some(({ item }) => item.node.type === 'page' && item.node.path === activePath); if (spaces[spaceIndex] && matches(spaces[spaceIndex]!)) return; const index = spaces.findIndex(matches); if (index >= 0) setSpaceIndex(index) }, [activePath, spaces.length])
  useLayoutEffect(() => { onStatus?.(dirty, saving) }, [dirty, saving])
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty || saving) { event.preventDefault(); event.returnValue = '' } }
    addEventListener('beforeunload', guard)
    return () => removeEventListener('beforeunload', guard)
  }, [dirty, saving])
  const space = spaces[spaceIndex] ?? spaces[0]
  const orphans = useMemo(() => {
    if (!tree) return []
    const placed = new Set(spaces.flatMap((entry) => fromItems(entry.items)).flatMap(collectFiles))
    return tree.orphans.filter((orphan) => !placed.has(orphan.file))
  }, [tree, current])

  const save = async () => {
    if (!tree || !dirty || saving) return
    setSaving(true)
    try {
      const next = await act(() => put<NavigationTree>('/api/navigation', {
        fingerprint: tree.fingerprint,
        spaces: spaces.map((entry) => ({ name: entry.name, ...(entry.version ? { version: entry.version } : {}), nav: fromItems(entry.items) })),
      }).catch((error: Error) => {
        if (/changed on disk/.test(error.message)) setConflict(error.message)
        throw error
      }), 'Navigation saved', false)
      if (next) {
        setTree(next)
        setSpaces(next.spaces.map((entry, index) => ({ name: entry.name, ...(entry.version ? { version: entry.version } : {}), items: retainItemIds(toItems(entry.nav), spaces[index]?.items ?? []) })))
        setFrameNonce((value) => value + 1)
        await onSaved?.()
      }
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setSaving(false) }
  }
  const discard = () => { if (tree) setSpaces(tree.spaces.map((entry) => ({ name: entry.name, ...(entry.version ? { version: entry.version } : {}), items: toItems(entry.nav) }))) }

  if (!tree && loadError) return <Note tone="bad"><span>{loadError}</span><Button size="sm" onClick={() => void load()}>Retry navigation</Button></Note>
  if (!tree) return <div class="page-list-empty"><span class="spinner" />{slow ? <>Still loading navigation…<Button size="sm" tone="link" onClick={() => void load(1)}>Retry</Button></> : 'Loading navigation…'}</div>
  if (!tree.editable && embedded) return <NavigationExplorer items={pages.map(page => ({ id: page.path, node: { type: 'page', file: page.path, path: page.path, pageTitle: page.title } }))} onChange={() => undefined} supports={tree.supports} icons={[]} editable={false} requiresEveryPage={false} orphans={[]} {...(onSelectPage ? { onSelectPage } : {})} {...(onTogglePage ? { onTogglePage } : {})} {...(selectedPaths ? { selectedPaths } : {})} {...(activePath ? { activePath } : {})} />
  if (!tree.editable) {
    return <div class={`navigation-view ${embedded ? 'navigation-view-embedded' : ''}`}>
      <section class="navigation-editor-pane">
        <Note>{tree.reason}</Note>
        {tree.configFile && <p class="branding-config-hint">Navigation file: <code>{tree.configFile}</code></p>}
      </section>
    </div>
  }
  const versions = [...new Set(spaces.map(entry => entry.version).filter((version): version is string => Boolean(version)))];
  const Editor = embedded ? NavigationExplorer : NavigationEditor
  return <div class={`navigation-view ${embedded ? 'navigation-view-embedded' : ''}`}>
    <section class="navigation-editor-pane">
      {embedded ? <header class="explorer-header"><h2>Explorer</h2><span class="explorer-save-state" role="status">{saving ? 'Saving…' : dirty ? 'Unsaved' : 'Saved'}</span><Button size="sm" tone="ghost" aria-label="Discard navigation" title="Discard navigation changes" disabled={!dirty || saving} onClick={discard}><Icon name="undo" size={14} /></Button><Button size="sm" tone="ghost" aria-label="Save navigation" title="Save navigation" disabled={!dirty} busy={saving} onClick={() => void save()}><Icon name="check" size={15} /></Button></header> : <header class="navigation-editor-head"><h2>Sidebar navigation</h2><div class="navigation-editor-actions"><Button size="sm" disabled={!dirty || saving} onClick={discard}>Discard</Button><Button size="sm" busy={saving} disabled={!dirty} onClick={() => void save()}>Save navigation</Button></div></header>}
      {conflict && <Note tone="bad"><span class="note-body">{conflict}<span class="note-actions"><Button size="sm" onClick={() => void load()}>Reload navigation</Button></span></span></Note>}
      {versions.length > 1 && <label class="navigation-editor-head">Version<select aria-label="Documentation version" value={spaces[spaceIndex]?.version} onChange={(event) => setSpaceIndex(spaces.findIndex(entry => entry.version === event.currentTarget.value))}>{versions.map(version => <option key={version} value={version}>{version}</option>)}</select></label>}
      {spaces.length > 1 && <div class="navigation-spaces" role="tablist" aria-label="Spaces">{spaces.map((entry, index) => (versions.length < 2 || entry.version === spaces[spaceIndex]?.version) && <button type="button" role="tab" key={index} aria-selected={index === spaceIndex} class={index === spaceIndex ? 'active' : ''} onClick={() => setSpaceIndex(index)}>{entry.name}</button>)}</div>}
      {!embedded && orphans.length > 0 && <Note tone={tree.requiresEveryPage ? 'warn' : 'info'}>{orphans.length} page{orphans.length === 1 ? ' is' : 's are'} not in the navigation{tree.requiresEveryPage ? ', which validation reports as an error' : ''}. Use “Add page” to place {orphans.length === 1 ? 'it' : 'them'}.</Note>}
      {space && <Editor
        items={space.items}
        onChange={(items) => setSpaces(spaces.map((entry, index) => (index === spaceIndex ? { ...entry, items } : entry)))}
        supports={tree.supports}
        icons={tree.icons}
        editable={!saving}
        {...(selectedPaths ? { selectedPaths } : {})}
        {...(onTogglePage ? { onTogglePage } : {})}
        {...(onSelectPage ? { onSelectPage } : {})}
        {...(activePath ? { activePath } : {})}
        requiresEveryPage={tree.requiresEveryPage}
        orphans={orphans}
      />}
    </section>
    {!embedded && <aside class="navigation-preview-pane" aria-label="Navigation preview">
      <div class="preview-chrome" aria-hidden="true"><span class="preview-dots"><i /><i /><i /></span><code>/</code></div>
      {frameUrl
        ? <iframe key={`${frameUrl}:${frameNonce}`} title="Navigation preview" src={`${frameUrl}/`} />
        : <div class="preview-placeholder"><span class="spinner" /><strong>Preview is starting…</strong></div>}
      {dirty && <div class="navigation-preview-note"><Icon name="info" size={13} />The preview shows the saved navigation. Save to see your changes.</div>}
    </aside>}
  </div>
}

/**
 * The same editor over a plan's navigation block, used in plan review. The
 * optional page hooks let the review show each page's purpose, badges and
 * menu inside the row, open the page drawer from the row, and create a page
 * straight into a section.
 */
export function PlanNavigationEditor({ plan, editable, onChange, renderPage, pageClass, onOpenPage, onCreatePage }: {
  plan: Pick<DocumentationPlan, 'navigation' | 'pages'>
  editable: boolean
  onChange: (navigation: DocumentationPlanNavigation) => void
  renderPage?: (page: DocumentationPlanPage) => ComponentChildren
  pageClass?: (page: DocumentationPlanPage) => string
  onOpenPage?: (page: DocumentationPlanPage) => void
  /** Adds a page to the plan and returns it; the editor places it in the chosen section. */
  onCreatePage?: () => DocumentationPlanPage
}) {
  const pages = plan.pages.filter((page) => page.priority !== 'later' && page.action !== 'remove')
  const key = JSON.stringify([plan.navigation, pages.map((page) => [page.id, page.title, page.path])])
  const [state, setState] = useState(() => ({ key, ...planNavigationToItems(plan.navigation, pages) }))
  useEffect(() => {
    if (state.key !== key) setState({ key, ...planNavigationToItems(plan.navigation, pages) })
  }, [key])
  const items = state.key === key ? state.items : planNavigationToItems(plan.navigation, pages).items
  const unsectioned = state.key === key ? state.unsectioned : []
  const pageById = new Map(pages.map((page) => [page.id, page]))
  const pageOf = (item: NavItem) => item.node.type === 'page' ? pageById.get(item.node.file) : undefined
  const change = (next: NavItem[], extraPages: DocumentationPlanPage[] = []) => {
    const navigation = itemsToPlanNavigation(next, plan.navigation.top)
    const known = [...pages, ...extraPages]
    setState({ key: JSON.stringify([navigation, known.map((page) => [page.id, page.title, page.path])]), items: next, unsectioned: known.filter((page) => !navigation.sections.some((section) => section.pageIds.includes(page.id))) })
    onChange(navigation)
  }
  return <NavigationEditor
    items={items}
    onChange={(next) => change(next)}
    childNoun="page"
    {...(pageClass ? { rowClass: (item: NavItem) => { const page = pageOf(item); return page ? pageClass(page) : '' } } : {})}
    {...(renderPage || (editable && onCreatePage) ? { rowMeta: (item: NavItem) => {
      const page = pageOf(item)
      if (page) return renderPage?.(page)
      if (item.node.type === 'group' && editable && onCreatePage) return <button type="button" class="btn link sm nav-tree-add-page" onClick={(event) => { event.stopPropagation(); const created = onCreatePage(); change(updateItem(items, item.id, (group) => ({ ...group, children: [...(group.children ?? []), planPageItem(created)] })), [created]) }}>Add page</button>
      return null
    } } : {})}
    {...(onOpenPage ? { onOpenItem: (item: NavItem) => { const page = pageOf(item); if (page) onOpenPage(page) } } : {})}
    supports={{ icons: false, hidden: false, labels: false, links: false, dividers: false, spaces: false }}
    icons={[]}
    editable={editable}
    requiresEveryPage={false}
    orphans={unsectioned.map((page) => ({ file: page.id, path: page.path, title: page.title }))}
    maxDepth={1}
    emptyLabel="No sections yet. Add a section, then add the planned pages to it."
  />
}

function stripDerived(node: NavigationTree['spaces'][number]['nav'][number]): unknown {
  if (node.type === 'group') return { ...node, items: node.items.map(stripDerived) }
  if (node.type === 'page') {
    const { path: _path, pageTitle: _pageTitle, ...rest } = node
    return rest
  }
  return node
}

function collectFiles(node: NavigationTree['spaces'][number]['nav'][number]): string[] {
  if (node.type === 'page') return [node.file]
  if (node.type === 'group') return node.items.flatMap(collectFiles)
  return []
}

function retainItemIds(next: NavItem[], previous: NavItem[]): NavItem[] {
  return next.map((item, index) => ({ ...item, id: previous[index]?.id ?? item.id, ...(item.children ? { children: retainItemIds(item.children, previous[index]?.children ?? []) } : {}) }))
}
