import type { JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'
import { Button, Input, Select, Toggle } from './components'
import { Icon } from './icons'
import {
  dissolveGroup,
  findItem,
  flattenItems,
  indentItem,
  itemDepth,
  itemLabel,
  moveItem,
  nextNavItemId,
  outdentItem,
  removeItem,
  shiftItem,
  updateItem,
  type NavItem,
} from './navigation-tree'
import type { NavigationSupport } from './types'

export interface NavigationOrphan {
  file: string
  path: string
  title: string
}

export interface NavigationEditorProps {
  items: NavItem[]
  onChange: (items: NavItem[]) => void
  supports: NavigationSupport
  icons: string[]
  editable: boolean
  /** Doxbrix keeps every page in navigation, so pages can be hidden but not removed. */
  requiresEveryPage: boolean
  orphans: NavigationOrphan[]
  /** The plan review allows one level of groups over pages. */
  maxDepth?: number
  emptyLabel?: string
}

type DropPosition = 'before' | 'after' | 'into'

/**
 * A drag-and-drop tree over navigation items. Every mouse action has a
 * keyboard route: arrows move focus, Alt+arrows move the focused item, and
 * the row's buttons expose the same moves for screen readers.
 */
export function NavigationEditor({ items, onChange, supports, icons, editable, requiresEveryPage, orphans, maxDepth, emptyLabel }: NavigationEditorProps) {
  const [selectedId, setSelectedId] = useState<string>()
  const [dragging, setDragging] = useState<string>()
  const [drop, setDrop] = useState<{ id: string; position: DropPosition }>()
  const [addingPage, setAddingPage] = useState(false)
  const tree = useRef<HTMLDivElement>(null)
  const flat = flattenItems(items)
  const selected = selectedId ? findItem(items, selectedId) : undefined
  const depthLimit = maxDepth ?? Number.POSITIVE_INFINITY

  useEffect(() => {
    if (selectedId && !findItem(items, selectedId)) setSelectedId(undefined)
  }, [items, selectedId])

  const change = (next: NavItem[]) => { if (next !== items) onChange(next) }
  const focusRow = (id: string) => tree.current?.querySelector<HTMLElement>(`[data-nav-item="${id}"]`)?.focus()
  // An item fits under a parent when its own subtree stays within the depth limit.
  const fitsUnder = (moving: NavItem, parentDepth: number) => parentDepth + itemDepth([moving]) <= depthLimit
  const canIndent = (id: string) => {
    const location = findItem(items, id)
    const previous = location?.siblings[location.index - 1]
    return Boolean(location && previous && previous.node.type === 'group' && fitsUnder(location.item, location.depth))
  }
  const canOutdent = (id: string) => (findItem(items, id)?.parentId ?? null) !== null
  const canRemove = (item: NavItem) => item.node.type !== 'page' || !requiresEveryPage
  const addGroup = () => {
    const entry: NavItem = { id: nextNavItemId('group'), node: { type: 'group', label: 'New section' }, children: [] }
    change([...items, entry])
    setSelectedId(entry.id)
  }
  const addNode = (node: NavItem['node']) => {
    const entry: NavItem = { id: nextNavItemId(), node }
    change([...items, entry])
    setSelectedId(entry.id)
  }
  const addOrphan = (orphan: NavigationOrphan) => {
    const entry: NavItem = { id: nextNavItemId('page'), node: { type: 'page', file: orphan.file, path: orphan.path, pageTitle: orphan.title } }
    const target = selected && selected.item.node.type === 'group' ? selected.item.id : null
    const next = target ? updateItem(items, target, (item) => ({ ...item, children: [...(item.children ?? []), entry] })) : [...items, entry]
    change(next)
    setAddingPage(false)
  }
  const remove = (id: string) => {
    const location = findItem(items, id)
    if (!location) return
    if (location.item.node.type === 'group' && (location.item.children?.length ?? 0) > 0) {
      change(dissolveGroup(items, id))
    } else {
      change(removeItem(items, id))
    }
    if (selectedId === id) setSelectedId(undefined)
  }
  const onKey = (event: KeyboardEvent, id: string) => {
    if (event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement) return
    const index = flat.findIndex((entry) => entry.item.id === id)
    if (event.key === 'ArrowDown' && !event.altKey) { event.preventDefault(); const next = flat[index + 1]; if (next) focusRow(next.item.id) }
    else if (event.key === 'ArrowUp' && !event.altKey) { event.preventDefault(); const next = flat[index - 1]; if (next) focusRow(next.item.id) }
    else if (!editable) return
    else if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); change(shiftItem(items, id, 1)); requestAnimationFrame(() => focusRow(id)) }
    else if (event.altKey && event.key === 'ArrowUp') { event.preventDefault(); change(shiftItem(items, id, -1)); requestAnimationFrame(() => focusRow(id)) }
    else if (event.altKey && event.key === 'ArrowRight') { event.preventDefault(); if (canIndent(id)) change(indentItem(items, id)); requestAnimationFrame(() => focusRow(id)) }
    else if (event.altKey && event.key === 'ArrowLeft') { event.preventDefault(); change(outdentItem(items, id)); requestAnimationFrame(() => focusRow(id)) }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(selectedId === id ? undefined : id) }
    else if (event.key === 'Delete' || event.key === 'Backspace') { const item = findItem(items, id)?.item; if (item && canRemove(item)) { event.preventDefault(); remove(id) } }
  }
  const dropTarget = (event: DragEvent, id: string, isGroup: boolean): DropPosition => {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const ratio = (event.clientY - rect.top) / Math.max(rect.height, 1)
    if (isGroup && ratio > 0.3 && ratio < 0.7) return 'into'
    return ratio < 0.5 ? 'before' : 'after'
  }
  const finishDrop = (targetId: string, position: DropPosition) => {
    if (!dragging || dragging === targetId) return
    const location = findItem(items, targetId)
    if (!location) return
    const moving = findItem(items, dragging)
    if (!moving) return
    if (position === 'into' && fitsUnder(moving.item, location.depth)) {
      change(moveItem(items, dragging, targetId, location.item.children?.length ?? 0))
      return
    }
    if (!fitsUnder(moving.item, location.depth - 1)) return
    change(moveItem(items, dragging, location.parentId, location.index + (position === 'after' || position === 'into' ? 1 : 0)))
  }

  const renderRows = (list: NavItem[], depth: number): JSX.Element[] => list.map((item) => {
    const node = item.node
    const isGroup = node.type === 'group'
    const active = selectedId === item.id
    const dropHere = drop?.id === item.id ? drop.position : undefined
    return <div key={item.id} class={`nav-tree-branch depth-${Math.min(depth, 3)}`}>
      <div
        class={`nav-tree-row ${active ? 'active' : ''} ${dragging === item.id ? 'dragging' : ''} ${dropHere ? `drop-${dropHere}` : ''} type-${node.type}`}
        data-nav-item={item.id}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={active}
        aria-expanded={isGroup ? true : undefined}
        tabIndex={0}
        draggable={editable}
        onClick={() => setSelectedId(active ? undefined : item.id)}
        onKeyDown={(event) => onKey(event, item.id)}
        onDragStart={(event) => { if (!editable) return; setDragging(item.id); event.dataTransfer?.setData('text/plain', item.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' }}
        onDragEnd={() => { setDragging(undefined); setDrop(undefined) }}
        onDragOver={(event) => { if (!dragging || dragging === item.id) return; event.preventDefault(); const position = dropTarget(event, item.id, isGroup); if (drop?.id !== item.id || drop.position !== position) setDrop({ id: item.id, position }) }}
        onDragLeave={() => { if (drop?.id === item.id) setDrop(undefined) }}
        onDrop={(event) => { event.preventDefault(); const position = drop?.id === item.id ? drop.position : dropTarget(event, item.id, isGroup); finishDrop(item.id, position); setDragging(undefined); setDrop(undefined) }}
      >
        <span class="nav-tree-handle" aria-hidden="true"><Icon name="menu" size={14} /></span>
        <span class="nav-tree-icon"><Icon name={rowIcon(item)} size={15} /></span>
        <span class="nav-tree-label">
          <strong>{itemLabel(item)}</strong>
          {node.type === 'page' && <code>{node.path ?? node.file}</code>}
          {node.type === 'link' && <code>{node.href}</code>}
          {node.type === 'api' && <code>{node.spec}</code>}
          {node.type === 'group' && <small>{item.children?.length ?? 0} item{(item.children?.length ?? 0) === 1 ? '' : 's'}</small>}
        </span>
        {'hidden' in node && node.hidden && <span class="nav-tree-flag">Hidden</span>}
        {editable && <span class="nav-tree-actions" onClick={(event) => event.stopPropagation()}>
          <button type="button" aria-label={`Move ${itemLabel(item)} up`} title="Move up (Alt+↑)" onClick={() => change(shiftItem(items, item.id, -1))}><Icon name="chevronUp" size={14} /></button>
          <button type="button" aria-label={`Move ${itemLabel(item)} down`} title="Move down (Alt+↓)" onClick={() => change(shiftItem(items, item.id, 1))}><Icon name="chevronDown" size={14} /></button>
          <button type="button" aria-label={`Move ${itemLabel(item)} into the section above`} title="Move into the section above (Alt+→)" disabled={!canIndent(item.id)} onClick={() => change(indentItem(items, item.id))}><Icon name="chevronRight" size={14} /></button>
          <button type="button" aria-label={`Move ${itemLabel(item)} out of its section`} title="Move out of the section (Alt+←)" disabled={!canOutdent(item.id)} onClick={() => change(outdentItem(items, item.id))}><Icon name="chevronLeft" size={14} /></button>
          <button type="button" class="danger" aria-label={isGroup ? `Ungroup ${itemLabel(item)}` : `Remove ${itemLabel(item)} from navigation`} title={isGroup ? 'Ungroup' : 'Remove from navigation'} disabled={!canRemove(item)} onClick={() => remove(item.id)}><Icon name={isGroup ? 'columns' : 'close'} size={14} /></button>
        </span>}
      </div>
      {active && editable && <NavigationItemDetails item={item} supports={supports} icons={icons} requiresEveryPage={requiresEveryPage} onChange={(patch) => change(updateItem(items, item.id, (current) => ({ ...current, node: { ...current.node, ...patch } as NavItem['node'] })))} />}
      {isGroup && <div class="nav-tree-children" role="group">{renderRows(item.children ?? [], depth + 1)}</div>}
    </div>
  })

  return <div class="nav-tree-editor">
    {editable && <div class="nav-tree-toolbar" role="toolbar" aria-label="Add navigation items">
      <Button size="sm" icon="folder" onClick={addGroup}>Add section</Button>
      {orphans.length > 0 && <Button size="sm" icon="plus" class={addingPage ? 'active-filter' : ''} aria-expanded={addingPage} onClick={() => setAddingPage(!addingPage)}>Add page{selected?.item.node.type === 'group' ? ` to ${itemLabel(selected.item)}` : ''}</Button>}
      {supports.labels && <Button size="sm" onClick={() => addNode({ type: 'label', text: 'Section label' })}>Add label</Button>}
      {supports.dividers && <Button size="sm" onClick={() => addNode({ type: 'divider' })}>Add divider</Button>}
      {supports.links && <Button size="sm" icon="link" onClick={() => addNode({ type: 'link', title: 'External link', href: 'https://' })}>Add link</Button>}
      <small>Drag rows to reorder, or focus a row and use Alt with the arrow keys.</small>
    </div>}
    {addingPage && orphans.length > 0 && <div class="nav-tree-orphans" aria-label="Pages not in navigation">
      {orphans.map((orphan) => <button type="button" key={orphan.path} onClick={() => addOrphan(orphan)}><Icon name="file" size={14} /><span><strong>{orphan.title}</strong><code>{orphan.path}</code></span><b>Add</b></button>)}
    </div>}
    <div ref={tree} class="nav-tree" role="tree" aria-label="Navigation" onDragOver={(event) => { if (dragging && event.target === tree.current) event.preventDefault() }} onDrop={(event) => { if (dragging && event.target === tree.current) { event.preventDefault(); change(moveItem(items, dragging, null, items.length)); setDragging(undefined); setDrop(undefined) } }}>
      {items.length === 0 ? <div class="nav-tree-empty">{emptyLabel ?? 'No navigation items yet. Add a section, then add pages to it.'}</div> : renderRows(items, 0)}
    </div>
  </div>
}

function NavigationItemDetails({ item, supports, icons, requiresEveryPage, onChange }: {
  item: NavItem
  supports: NavigationSupport
  icons: string[]
  requiresEveryPage: boolean
  onChange: (patch: Record<string, unknown>) => void
}) {
  const node = item.node
  const showIcon = supports.icons && (node.type === 'page' || node.type === 'group' || node.type === 'link' || node.type === 'api')
  const showHidden = supports.hidden && (node.type === 'page' || node.type === 'group')
  return <div class="nav-tree-details" onClick={(event) => event.stopPropagation()}>
    {node.type === 'page' && <label class="field"><span class="field-label">Label in navigation</span><Input value={node.title ?? ''} placeholder={node.pageTitle ?? 'Page title'} onInput={(event) => onChange({ title: event.currentTarget.value || undefined })} /><small>Leave empty to use the page title{node.pageTitle ? ` “${node.pageTitle}”` : ''}.</small></label>}
    {node.type === 'group' && <label class="field"><span class="field-label">Section name</span><Input value={node.label} onInput={(event) => onChange({ label: event.currentTarget.value })} /></label>}
    {node.type === 'label' && <label class="field"><span class="field-label">Label text</span><Input value={node.text} onInput={(event) => onChange({ text: event.currentTarget.value })} /></label>}
    {(node.type === 'link' || node.type === 'api') && <label class="field"><span class="field-label">Title</span><Input value={node.title} onInput={(event) => onChange({ title: event.currentTarget.value })} /></label>}
    {node.type === 'link' && <label class="field"><span class="field-label">Address</span><Input value={node.href} placeholder="https://" onInput={(event) => onChange({ href: event.currentTarget.value })} /></label>}
    {showIcon && <label class="field"><span class="field-label">Icon</span><Select value={('icon' in node && node.icon) || ''} onChange={(event) => onChange({ icon: event.currentTarget.value || undefined })}><option value="">None</option>{icons.map((icon) => <option key={icon} value={icon}>{icon}</option>)}</Select></label>}
    {showHidden && <div class="nav-tree-hidden"><Toggle checked={Boolean('hidden' in node && node.hidden)} onChange={(hidden) => onChange({ hidden: hidden || undefined })} label="Hidden from the sidebar" /><small>{requiresEveryPage && node.type === 'page' ? 'The page stays reachable by link and in search.' : 'Hidden items are kept but not shown.'}</small></div>}
  </div>
}

function rowIcon(item: NavItem): string {
  switch (item.node.type) {
    case 'group': return 'folder'
    case 'page': return 'file'
    case 'link': return 'link'
    case 'api': return 'api'
    case 'label': return 'list'
    case 'divider': return 'minus'
  }
}
