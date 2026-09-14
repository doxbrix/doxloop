import { useEffect, useRef, useState } from 'preact/hooks'
import type { JSX } from 'preact'
import { Icon } from './icons'
import { dissolveGroup, findItem, indentItem, itemLabel, moveItem, nextNavItemId, outdentItem, removeItem, shiftItem, updateItem, type NavItem } from './navigation-tree'
import type { NavigationEditorProps } from './NavigationEditor'

/** Compact, direct manipulation of the site's navigation. Source writes stay in NavigationView. */
export function NavigationExplorer({ items, onChange, supports, icons, editable, requiresEveryPage, orphans, onSelectPage, activePath, selectedPaths = [], onTogglePage }: NavigationEditorProps & { selectedPaths?: string[]; onTogglePage?: (path: string) => void }) {
  const [collapsed, setCollapsed] = useState(new Set<string>())
  const [focused, setFocused] = useState<string>()
  const [rename, setRename] = useState<{ id: string; text: string; address?: boolean }>()
  const [popover, setPopover] = useState<{ id: string; kind: 'icon' | 'menu' }>()
  const [iconQuery, setIconQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [dragging, setDragging] = useState<string>()
  const [drop, setDrop] = useState<{ id: string; position: 'before' | 'after' | 'into' }>()
  const host = useRef<HTMLDivElement>(null)
  const renameCompleted = useRef(false)
  const visible = (list: NavItem[]): NavItem[] => list.flatMap(item => [item, ...(!collapsed.has(item.id) && item.children ? visible(item.children) : [])])
  const rows = visible(items)
  const focus = (id: string) => { setFocused(id); host.current?.querySelector<HTMLElement>(`[data-nav-item="${id}"]`)?.focus() }
  const change = (next: NavItem[]) => { if (editable && next !== items) onChange(next) }
  const patch = (id: string, value: Record<string, unknown>) => change(updateItem(items, id, item => ({ ...item, node: { ...item.node, ...value } as NavItem['node'] })))
  const toggle = (id: string) => setCollapsed(previous => { const next = new Set(previous); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const open = (item: NavItem, multiple = false) => {
    setFocused(item.id)
    if (item.node.type === 'page' && item.node.path) {
      if (multiple && onTogglePage) onTogglePage(item.node.path)
      else if (item.node.path !== activePath) onSelectPage?.(item.node.path)
    } else if (item.node.type === 'group') toggle(item.id)
  }
  const startRename = (item: NavItem, address = false) => {
    if (!editable || item.node.type === 'divider') return
    renameCompleted.current = false
    setPopover(undefined); setRename({ id: item.id, text: address && item.node.type === 'link' ? item.node.href : itemLabel(item), ...(address ? { address } : {}) })
  }
  const finishRename = () => {
    if (!rename || renameCompleted.current) return
    renameCompleted.current = true
    const item = findItem(items, rename.id)?.item
    const value = rename.text.trim()
    if (item && (value || item.node.type === 'page')) patch(item.id, rename.address ? { href: value } : item.node.type === 'group' ? { label: value } : item.node.type === 'label' ? { text: value } : { title: value || undefined })
    setRename(undefined)
  }
  const showIcons = (id: string) => { setIconQuery(''); setPopover({ id, kind: 'icon' }) }
  useEffect(() => {
    if (!popover && !adding) return
    host.current?.querySelector<HTMLElement>('.explorer-popover input, .explorer-popover button')?.focus()
    const close = (event: PointerEvent) => { if (!(event.target instanceof Element) || !event.target.closest('.explorer-popover, .explorer-icon, .explorer-more, .explorer-add')) { setPopover(undefined); setAdding(false) } }
    document.addEventListener('pointerdown', close)
    return () => document.removeEventListener('pointerdown', close)
  }, [popover, adding])
  useEffect(() => { if (!editable) { setPopover(undefined); setAdding(false) } }, [editable])
  const keyboard = (event: KeyboardEvent, item: NavItem) => {
    if (event.target !== event.currentTarget) return
    const index = rows.findIndex(row => row.id === item.id)
    if (event.key === 'F2') { event.preventDefault(); startRename(item) }
    else if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) { event.preventDefault(); setPopover({ id: item.id, kind: 'menu' }) }
    else if (event.altKey && event.key.startsWith('Arrow')) {
      event.preventDefault()
      if (event.key === 'ArrowDown') change(shiftItem(items, item.id, 1))
      if (event.key === 'ArrowUp') change(shiftItem(items, item.id, -1))
      if (event.key === 'ArrowRight') change(indentItem(items, item.id))
      if (event.key === 'ArrowLeft') change(outdentItem(items, item.id))
      focus(item.id)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); const next = rows[index + (event.key === 'ArrowDown' ? 1 : -1)]; if (next) focus(next.id) }
    else if (event.key === 'ArrowRight' && item.node.type === 'group') { event.preventDefault(); if (collapsed.has(item.id)) toggle(item.id); else if (item.children?.[0]) focus(item.children[0].id) }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); if (item.node.type === 'group' && !collapsed.has(item.id)) toggle(item.id); else { const parent = findItem(items, item.id)?.parentId; if (parent) focus(parent) } }
    else if (event.key === 'Enter') { event.preventDefault(); open(item) }
    else if (event.key === ' ' && item.node.type === 'page') { event.preventDefault(); if (item.node.path) onTogglePage?.(item.node.path) }
  }
  const add = (type: 'group' | 'label' | 'divider' | 'link') => {
    const item: NavItem = { id: nextNavItemId(), node: type === 'group' ? { type, label: 'New section' } : type === 'label' ? { type, text: 'New label' } : type === 'link' ? { type, title: 'New link', href: 'https://' } : { type }, ...(type === 'group' ? { children: [] } : {}) }
    change([...items, item]); setAdding(false); if (type !== 'divider') startRename(item)
  }
  const remove = (item: NavItem) => { change(item.node.type === 'group' ? dissolveGroup(items, item.id) : removeItem(items, item.id)); setPopover(undefined) }
  const position = (event: DragEvent, item: NavItem) => {
    const bounds = (event.currentTarget as HTMLElement).getBoundingClientRect()
    const fraction = (event.clientY - bounds.top) / bounds.height
    return item.node.type === 'group' && fraction > .25 && fraction < .75 ? 'into' as const : fraction < .5 ? 'before' as const : 'after' as const
  }
  const renderRows = (list: NavItem[], depth = 0): JSX.Element[] => list.map(item => {
    const node = item.node
    const name = itemLabel(item)
    const current = node.type === 'page' && node.path === activePath
    const editing = rename?.id === item.id
    const icon = 'icon' in node && node.icon ? node.icon : node.type === 'group' ? 'folder' : node.type === 'link' ? 'link' : node.type === 'divider' ? 'minus' : 'file'
    const iconEditable = editable && supports.icons && ['page', 'group', 'link', 'api'].includes(node.type)
    const hidden = 'hidden' in node && node.hidden
    return <div key={item.id} class="explorer-branch">
      <div role="treeitem" aria-level={depth + 1} aria-expanded={node.type === 'group' ? !collapsed.has(item.id) : undefined} aria-selected={node.type === 'page' ? selectedPaths.includes(node.path ?? '') : focused === item.id} aria-current={current ? 'page' : undefined} tabIndex={focused === item.id || (!focused && (current || item === rows[0])) ? 0 : -1}
        data-nav-item={item.id} class={`explorer-row ${current ? 'current' : ''} ${hidden ? 'is-hidden' : ''} ${drop?.id === item.id ? `drop-${drop.position}` : ''}`} style={{ paddingLeft: `${8 + depth * 14}px` }} title={node.type === 'page' ? node.path ?? node.file : name}
        draggable={editable && !editing} onClick={event => { if (!editing) open(item, event.metaKey || event.ctrlKey) }} onDblClick={event => { event.preventDefault(); startRename(item) }} onKeyDown={event => keyboard(event, item)} onFocus={() => setFocused(item.id)}
        onContextMenu={event => { if (!editable) return; event.preventDefault(); setPopover({ id: item.id, kind: 'menu' }); setFocused(item.id) }}
        onDragStart={event => { setDragging(item.id); setPopover(undefined); event.dataTransfer?.setData('text/plain', item.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move' }}
        onDragEnd={() => { setDragging(undefined); setDrop(undefined) }}
        onDragOver={event => { if (!editable || !dragging || dragging === item.id) return; event.preventDefault(); setDrop({ id: item.id, position: position(event, item) }) }}
        onDragLeave={() => setDrop(undefined)}
        onDrop={event => { event.preventDefault(); if (editable && dragging && dragging !== item.id) { const target = findItem(items, item.id)!; const where = position(event, item); change(moveItem(items, dragging, where === 'into' ? item.id : target.parentId, where === 'into' ? item.children?.length ?? 0 : target.index + (where === 'after' ? 1 : 0))); if (where === 'into') setCollapsed(previous => { const next = new Set(previous); next.delete(item.id); return next }) } setDragging(undefined); setDrop(undefined) }}>
        {node.type === 'group' ? <button class="explorer-chevron" aria-label={`${collapsed.has(item.id) ? 'Expand' : 'Collapse'} ${name}`} onClick={event => { event.stopPropagation(); toggle(item.id) }} onDblClick={event => event.stopPropagation()}><Icon name={collapsed.has(item.id) ? 'chevronRight' : 'chevronDown'} size={12} /></button> : <span class="explorer-chevron" />}
        {iconEditable ? <button class="explorer-icon" aria-label={`Change icon for ${name}`} title="Change icon" aria-expanded={popover?.id === item.id && popover.kind === 'icon'} onClick={event => { event.stopPropagation(); showIcons(item.id) }} onDblClick={event => event.stopPropagation()}><NavigationGlyph name={icon} /></button> : <span class="explorer-icon"><NavigationGlyph name={icon} /></span>}
        {editing ? <input class="explorer-rename" aria-label={rename.address ? 'Link address' : `Rename ${name}`} ref={input => { if (input && document.activeElement !== input) { input.focus(); input.select() } }} value={rename.text} maxLength={rename.address ? 2000 : 120} onClick={event => event.stopPropagation()} onDblClick={event => event.stopPropagation()} onInput={event => setRename({ ...rename, text: event.currentTarget.value })} onBlur={finishRename} onKeyDown={event => { event.stopPropagation(); if (event.key === 'Enter') { event.preventDefault(); finishRename(); focus(item.id) } if (event.key === 'Escape') { event.preventDefault(); renameCompleted.current = true; setRename(undefined); focus(item.id) } }} /> : <span class="explorer-label">{name}</span>}
        {hidden && <span title="Hidden from navigation"><Icon name="eyeOff" size={13} /></span>}
        {node.type === 'page' && onTogglePage && <input class="explorer-select" type="checkbox" checked={selectedPaths.includes(node.path ?? '')} aria-label={`Select ${node.pageTitle ?? name}`} onClick={event => event.stopPropagation()} onChange={() => node.path && onTogglePage(node.path)} />}
        {editable && <button class="explorer-more" aria-label={`Actions for ${name}`} title="More actions" aria-expanded={popover?.id === item.id && popover.kind === 'menu'} onClick={event => { event.stopPropagation(); setPopover({ id: item.id, kind: 'menu' }) }} onDblClick={event => event.stopPropagation()}>⋯</button>}
      </div>
      {popover?.id === item.id && <div class="explorer-popover" role={popover.kind === 'icon' ? 'dialog' : 'menu'} aria-label={popover.kind === 'icon' ? `Choose icon for ${name}` : `Actions for ${name}`} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); setPopover(undefined); focus(item.id) } }}>
        {popover.kind === 'icon' ? <><input autoFocus aria-label="Search icons" placeholder="Search icons…" value={iconQuery} onInput={event => setIconQuery(event.currentTarget.value)} /><div class="explorer-icon-grid">{icons.filter(value => value.includes(iconQuery.toLowerCase())).map(value => <button title={value} aria-label={`Use ${value} icon`} aria-pressed={icon === value} onClick={() => { patch(item.id, { icon: value }); setPopover(undefined); focus(item.id) }}><NavigationGlyph name={value} /></button>)}</div><button onClick={() => { patch(item.id, { icon: undefined }); setPopover(undefined); focus(item.id) }}>Use default icon</button></> : <>
          {node.type !== 'divider' && <button role="menuitem" onClick={() => startRename(item)}>Rename<span>F2</span></button>}
          {node.type === 'link' && <button role="menuitem" onClick={() => startRename(item, true)}>Edit link address</button>}
          <button role="menuitem" onClick={() => { change(shiftItem(items, item.id, -1)); setPopover(undefined) }}>Move up<span>Alt ↑</span></button>
          <button role="menuitem" onClick={() => { change(shiftItem(items, item.id, 1)); setPopover(undefined) }}>Move down<span>Alt ↓</span></button>
          <button role="menuitem" onClick={() => { change(indentItem(items, item.id)); setPopover(undefined) }}>Indent<span>Alt →</span></button>
          <button role="menuitem" onClick={() => { change(outdentItem(items, item.id)); setPopover(undefined) }}>Outdent<span>Alt ←</span></button>
          {supports.hidden && ['page', 'group'].includes(node.type) && <button role="menuitem" onClick={() => { patch(item.id, { hidden: !hidden || undefined }); setPopover(undefined) }}>{hidden ? 'Show in navigation' : 'Hide from navigation'}</button>}
          {(node.type !== 'page' || !requiresEveryPage) && <button role="menuitem" onClick={() => remove(item)}>{node.type === 'group' ? 'Ungroup section' : 'Remove from navigation'}</button>}
        </>}
      </div>}
      {node.type === 'group' && !collapsed.has(item.id) && <div role="group">{renderRows(item.children ?? [], depth + 1)}</div>}
    </div>
  })
  return <div class="navigation-explorer" ref={host}>
    <div class="explorer-tools"><span>Click to open · F2 to rename</span>{editable && <button class="explorer-add" title="Add navigation item" aria-label="Add navigation item" aria-expanded={adding} onClick={() => setAdding(!adding)}><Icon name="plus" size={15} /></button>}</div>
    {adding && <div class="explorer-popover explorer-add-menu" role="menu" aria-label="Add navigation item"><button role="menuitem" onClick={() => add('group')}>New section</button>{supports.links && <button role="menuitem" onClick={() => add('link')}>New link</button>}{supports.labels && <button role="menuitem" onClick={() => add('label')}>New label</button>}{supports.dividers && <button role="menuitem" onClick={() => add('divider')}>New divider</button>}{orphans.map(orphan => <button role="menuitem" onClick={() => { change([...items, { id: nextNavItemId(), node: { type: 'page', file: orphan.file, path: orphan.path, pageTitle: orphan.title } }]); setAdding(false) }}>Add {orphan.title}</button>)}</div>}
    <div role="tree" aria-label="Navigation" aria-multiselectable="true">{renderRows(items)}{!items.length && <p class="explorer-empty">Add a section or page with +.</p>}</div>
    {orphans.length > 0 && <div class="explorer-unlisted"><span>Not in navigation</span>{orphans.map(orphan => <button onClick={() => onSelectPage?.(orphan.path)}><Icon name="file" size={15} />{orphan.title}</button>)}</div>}
  </div>
}

function NavigationGlyph({ name }: { name: string }) {
  return /[^\w-]/.test(name) ? <span class="navigation-emoji" aria-hidden="true">{name}</span> : <Icon name={name} size={16} />
}
