import { useEffect, useMemo, useState } from 'preact/hooks'
import { api, post, put } from './api'
import { Button, Note } from './components'
import { Icon } from './icons'
import { NavigationEditor } from './NavigationEditor'
import { fromItems, itemsToPlanNavigation, planNavigationToItems, toItems, type NavItem } from './navigation-tree'
import type { DocumentationPlan, DocumentationPlanNavigation, NavigationTree } from './types'

type Action = <T>(run: () => Promise<T>, success?: string, reload?: boolean) => Promise<T | undefined>

/**
 * Pages → Navigation. Loads the generator's navigation as a tree, lets the
 * person reorder, group, relabel, hide, and add pages, and writes it back
 * through the navigation service with the fingerprint it was loaded with.
 * The preview frame beside it reloads after every save.
 */
export function NavigationView({ act, onError, previewUrl }: { act: Action; onError: (error: string) => void; previewUrl?: string }) {
  const [tree, setTree] = useState<NavigationTree>()
  const [spaces, setSpaces] = useState<Array<{ name: string; items: NavItem[] }>>([])
  const [spaceIndex, setSpaceIndex] = useState(0)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState('')
  const [frameUrl, setFrameUrl] = useState(previewUrl)
  const [frameNonce, setFrameNonce] = useState(0)

  const load = async () => {
    try {
      const raw = await api<NavigationTree>('/api/navigation')
      const next: NavigationTree = { ...raw, spaces: raw.spaces ?? [], orphans: raw.orphans ?? [], icons: raw.icons ?? [], supports: raw.supports ?? { icons: false, hidden: false, labels: false, links: false, dividers: false, spaces: false } }
      setTree(next)
      setSpaces(next.spaces.map((space) => ({ name: space.name, items: toItems(space.nav) })))
      setConflict('')
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (frameUrl || !tree?.editable) return
    void post<{ url: string }>('/api/preview/start', { open: false }).then((result) => setFrameUrl(result.url)).catch(() => undefined)
  }, [tree?.editable, frameUrl])

  const saved = useMemo(() => JSON.stringify(tree?.spaces.map((space) => ({ name: space.name, nav: space.nav.map(stripDerived) })) ?? []), [tree])
  const current = JSON.stringify(spaces.map((space) => ({ name: space.name, nav: fromItems(space.items) })))
  const dirty = Boolean(tree) && current !== saved
  const space = spaces[spaceIndex] ?? spaces[0]
  const orphans = useMemo(() => {
    if (!tree) return []
    const placed = new Set(spaces.flatMap((entry) => fromItems(entry.items)).flatMap(collectFiles))
    return tree.orphans.filter((orphan) => !placed.has(orphan.file))
  }, [tree, current])

  const save = async () => {
    if (!tree || !dirty) return
    setSaving(true)
    try {
      const next = await act(() => put<NavigationTree>('/api/navigation', {
        fingerprint: tree.fingerprint,
        spaces: spaces.map((entry) => ({ name: entry.name, nav: fromItems(entry.items) })),
      }).catch((error: Error) => {
        if (/changed on disk/.test(error.message)) setConflict(error.message)
        throw error
      }), 'Navigation saved', false)
      if (next) {
        setTree(next)
        setSpaces(next.spaces.map((entry) => ({ name: entry.name, items: toItems(entry.nav) })))
        setFrameNonce((value) => value + 1)
      }
    } finally { setSaving(false) }
  }
  const discard = () => { if (tree) setSpaces(tree.spaces.map((entry) => ({ name: entry.name, items: toItems(entry.nav) }))) }

  if (!tree) return <div class="page-list-empty"><span class="spinner" />Loading navigation…</div>
  if (!tree.editable) {
    return <div class="navigation-view">
      <section class="navigation-editor-pane">
        <Note>{tree.reason}</Note>
        {tree.configFile && <p class="branding-config-hint">Navigation file: <code>{tree.configFile}</code></p>}
      </section>
    </div>
  }
  return <div class="navigation-view">
    <section class="navigation-editor-pane">
      <header class="navigation-editor-head">
        <div>
          <h2>Sidebar navigation</h2>
          <p>Reorder pages, group them into sections, rename labels{tree.supports.icons ? ', set icons' : ''}{tree.supports.hidden ? ', or hide pages' : ''}. Saved to <code>{tree.configFile}</code>.</p>
        </div>
        <div class="navigation-editor-actions">
          <Button size="sm" tone="ghost" disabled={!dirty || saving} onClick={discard}>Discard</Button>
          <Button size="sm" tone="primary" busy={saving} disabled={!dirty} onClick={() => void save()}>Save navigation</Button>
        </div>
      </header>
      {conflict && <Note tone="bad"><span class="note-body">{conflict}<span class="note-actions"><Button size="sm" onClick={() => void load()}>Reload navigation</Button></span></span></Note>}
      {spaces.length > 1 && <div class="navigation-spaces" role="tablist" aria-label="Spaces">{spaces.map((entry, index) => <button type="button" role="tab" key={entry.name} aria-selected={index === spaceIndex} class={index === spaceIndex ? 'active' : ''} onClick={() => setSpaceIndex(index)}>{entry.name}</button>)}</div>}
      {orphans.length > 0 && <Note tone={tree.requiresEveryPage ? 'warn' : 'info'}>{orphans.length} page{orphans.length === 1 ? ' is' : 's are'} not in the navigation{tree.requiresEveryPage ? ', which validation reports as an error' : ''}. Use “Add page” to place {orphans.length === 1 ? 'it' : 'them'}.</Note>}
      {space && <NavigationEditor
        items={space.items}
        onChange={(items) => setSpaces(spaces.map((entry, index) => (index === spaceIndex ? { ...entry, items } : entry)))}
        supports={tree.supports}
        icons={tree.icons}
        editable
        requiresEveryPage={tree.requiresEveryPage}
        orphans={orphans}
      />}
    </section>
    <aside class="navigation-preview-pane" aria-label="Navigation preview">
      <div class="preview-chrome" aria-hidden="true"><span class="preview-dots"><i /><i /><i /></span><code>/</code></div>
      {frameUrl
        ? <iframe key={`${frameUrl}:${frameNonce}`} title="Navigation preview" src={`${frameUrl}/`} />
        : <div class="preview-placeholder"><span class="spinner" /><strong>Preview is starting…</strong></div>}
      {dirty && <div class="navigation-preview-note"><Icon name="info" size={13} />The preview shows the saved navigation. Save to see your changes.</div>}
    </aside>
  </div>
}

/** The same editor over a plan's navigation block, used in plan review. */
export function PlanNavigationEditor({ plan, editable, onChange }: {
  plan: Pick<DocumentationPlan, 'navigation' | 'pages'>
  editable: boolean
  onChange: (navigation: DocumentationPlanNavigation) => void
}) {
  const pages = plan.pages.filter((page) => page.priority !== 'later' && page.action !== 'remove')
  const key = JSON.stringify([plan.navigation, pages.map((page) => [page.id, page.title, page.path])])
  const [state, setState] = useState(() => ({ key, ...planNavigationToItems(plan.navigation, pages) }))
  useEffect(() => {
    if (state.key !== key) setState({ key, ...planNavigationToItems(plan.navigation, pages) })
  }, [key])
  const items = state.key === key ? state.items : planNavigationToItems(plan.navigation, pages).items
  const unsectioned = state.key === key ? state.unsectioned : []
  return <NavigationEditor
    items={items}
    onChange={(next) => {
      const navigation = itemsToPlanNavigation(next, plan.navigation.top)
      setState({ key: JSON.stringify([navigation, pages.map((page) => [page.id, page.title, page.path])]), items: next, unsectioned: pages.filter((page) => !navigation.sections.some((section) => section.pageIds.includes(page.id))) })
      onChange(navigation)
    }}
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
