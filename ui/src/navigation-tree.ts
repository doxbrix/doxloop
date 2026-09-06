import type { DocumentationPlanNavigation, DocumentationPlanPage, NavigationNode } from './types'

/**
 * The navigation editor works on a tree of items with stable client ids, so
 * drag and drop, keyboard moves, and inline renames can address a node
 * without relying on its position. `toItems` and `fromItems` convert to and
 * from the server's node shape; the plan review uses the same editor over a
 * plan's `navigation` block through `planNavigationToItems`.
 */
export type NavItemNode = Exclude<NavigationNode, { type: 'group' }> | { type: 'group'; label: string; icon?: string; hidden?: boolean }

export interface NavItem {
  id: string
  node: NavItemNode
  /** Present only for groups. */
  children?: NavItem[]
  /** The plan section id a group came from, kept so revisions stay stable. */
  sectionId?: string
}

export interface NavItemLocation {
  item: NavItem
  siblings: NavItem[]
  index: number
  parentId: string | null
  depth: number
}

let counter = 0
export function nextNavItemId(prefix = 'nav'): string {
  counter += 1
  return `${prefix}-${counter}`
}

export function toItems(nodes: NavigationNode[]): NavItem[] {
  return nodes.map((node) => {
    if (node.type === 'group') {
      const { items, ...rest } = node
      return { id: nextNavItemId(), node: rest, children: toItems(items ?? []) }
    }
    return { id: nextNavItemId(), node }
  })
}

export function fromItems(items: NavItem[]): NavigationNode[] {
  return items.map((item) => {
    if (item.node.type === 'group') return { ...item.node, items: fromItems(item.children ?? []) }
    if (item.node.type === 'page') {
      const { path: _path, pageTitle: _pageTitle, ...node } = item.node
      return node
    }
    return item.node
  })
}

export function findItem(items: NavItem[], id: string, parentId: string | null = null, depth = 0): NavItemLocation | undefined {
  for (const [index, item] of items.entries()) {
    if (item.id === id) return { item, siblings: items, index, parentId, depth }
    if (item.children) {
      const found = findItem(item.children, id, item.id, depth + 1)
      if (found) return found
    }
  }
  return undefined
}

export function flattenItems(items: NavItem[], depth = 0, parentId: string | null = null): Array<{ item: NavItem; depth: number; parentId: string | null }> {
  const output: Array<{ item: NavItem; depth: number; parentId: string | null }> = []
  for (const item of items) {
    output.push({ item, depth, parentId })
    if (item.children) output.push(...flattenItems(item.children, depth + 1, item.id))
  }
  return output
}

export function containsItem(item: NavItem, id: string): boolean {
  return item.id === id || (item.children?.some((child) => containsItem(child, id)) ?? false)
}

export function removeItem(items: NavItem[], id: string): NavItem[] {
  return items.filter((item) => item.id !== id).map((item) => (item.children ? { ...item, children: removeItem(item.children, id) } : item))
}

export function insertItem(items: NavItem[], entry: NavItem, parentId: string | null, index: number): NavItem[] {
  if (parentId === null) {
    const next = [...items]
    next.splice(clamp(index, 0, next.length), 0, entry)
    return next
  }
  return items.map((item) => {
    if (item.id === parentId) {
      const children = [...(item.children ?? [])]
      children.splice(clamp(index, 0, children.length), 0, entry)
      return { ...item, children }
    }
    return item.children ? { ...item, children: insertItem(item.children, entry, parentId, index) } : item
  })
}

export function updateItem(items: NavItem[], id: string, patch: (item: NavItem) => NavItem): NavItem[] {
  return items.map((item) => {
    if (item.id === id) return patch(item)
    return item.children ? { ...item, children: updateItem(item.children, id, patch) } : item
  })
}

/**
 * Move an item to `index` under `parentId`. Moving into itself or one of its
 * own descendants is refused, and the index is corrected when the item leaves
 * an earlier slot in the same list.
 */
export function moveItem(items: NavItem[], id: string, parentId: string | null, index: number): NavItem[] {
  const location = findItem(items, id)
  if (!location) return items
  if (parentId !== null && containsItem(location.item, parentId)) return items
  if (parentId !== null && findItem(items, parentId)?.item.node.type !== 'group') return items
  let target = index
  if (location.parentId === parentId && location.index < index) target -= 1
  return insertItem(removeItem(items, id), location.item, parentId, target)
}

export function shiftItem(items: NavItem[], id: string, delta: -1 | 1): NavItem[] {
  const location = findItem(items, id)
  if (!location) return items
  const next = location.index + delta
  if (next < 0 || next >= location.siblings.length) return items
  return moveItem(items, id, location.parentId, delta > 0 ? next + 1 : next)
}

/** Move the item into the group that precedes it. */
export function indentItem(items: NavItem[], id: string): NavItem[] {
  const location = findItem(items, id)
  if (!location) return items
  const previous = location.siblings[location.index - 1]
  if (!previous || previous.node.type !== 'group') return items
  return moveItem(items, id, previous.id, previous.children?.length ?? 0)
}

/** Move the item out of its group, to just after that group. */
export function outdentItem(items: NavItem[], id: string): NavItem[] {
  const location = findItem(items, id)
  if (!location || location.parentId === null) return items
  const parent = findItem(items, location.parentId)
  if (!parent) return items
  return moveItem(items, id, parent.parentId, parent.index + 1)
}

/** Replace a group with its children. */
export function dissolveGroup(items: NavItem[], id: string): NavItem[] {
  const location = findItem(items, id)
  if (!location || location.item.node.type !== 'group') return items
  const children = location.item.children ?? []
  let next = removeItem(items, id)
  children.forEach((child, offset) => { next = insertItem(next, child, location.parentId, location.index + offset) })
  return next
}

export function pageFiles(items: NavItem[]): string[] {
  const output: string[] = []
  for (const { item } of flattenItems(items)) if (item.node.type === 'page') output.push(item.node.file)
  return output
}

export function itemDepth(items: NavItem[]): number {
  return flattenItems(items).reduce((deepest, entry) => Math.max(deepest, entry.depth + 1), 0)
}

export function itemLabel(item: NavItem): string {
  const node = item.node
  switch (node.type) {
    case 'page': return node.title || node.pageTitle || labelFromFile(node.file)
    case 'group': return node.label
    case 'label': return node.text
    case 'divider': return 'Divider'
    case 'link': return node.title
    case 'api': return node.title
  }
}

export function labelFromFile(file: string): string {
  return file.split('/').at(-1)!.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ').replace(/\b\w/g, (letter) => letter.toUpperCase())
}

/** A plan's sections as groups of page items; pages in no section are returned separately. */
export function planNavigationToItems(navigation: DocumentationPlanNavigation, pages: DocumentationPlanPage[]): { items: NavItem[]; unsectioned: DocumentationPlanPage[] } {
  const byId = new Map(pages.map((page) => [page.id, page]))
  const placed = new Set<string>()
  const items: NavItem[] = navigation.sections.map((section) => ({
    id: nextNavItemId('section'),
    node: { type: 'group', label: section.title },
    sectionId: section.id,
    children: section.pageIds.flatMap((pageId) => {
      const page = byId.get(pageId)
      if (!page || placed.has(pageId)) return []
      placed.add(pageId)
      return [{ id: nextNavItemId('plan'), node: { type: 'page', file: page.id, title: page.title, path: page.path } }]
    }),
  }))
  return { items, unsectioned: pages.filter((page) => !placed.has(page.id)) }
}

export function itemsToPlanNavigation(items: NavItem[], top: string[]): DocumentationPlanNavigation {
  const sections: DocumentationPlanNavigation['sections'] = []
  const loose: string[] = []
  const used = new Set<string>()
  for (const item of items) {
    if (item.node.type === 'group') {
      const base = item.sectionId ?? slugify(item.node.label)
      let id = base
      for (let attempt = 2; used.has(id); attempt += 1) id = `${base}-${attempt}`
      used.add(id)
      sections.push({ id, title: item.node.label, pageIds: pageFiles(item.children ?? []) })
    } else if (item.node.type === 'page') {
      loose.push(item.node.file)
    }
  }
  if (loose.length > 0) sections.push({ id: used.has('documentation') ? 'documentation-pages' : 'documentation', title: 'Documentation', pageIds: loose })
  return { top, sections: sections.filter((section) => section.pageIds.length > 0) }
}

export function planPageItem(page: DocumentationPlanPage): NavItem {
  return { id: nextNavItemId('plan'), node: { type: 'page', file: page.id, title: page.title, path: page.path } }
}

function slugify(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'section'
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
