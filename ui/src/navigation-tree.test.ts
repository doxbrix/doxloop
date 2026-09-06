import { describe, expect, it } from 'vitest'
import {
  dissolveGroup,
  fromItems,
  indentItem,
  itemsToPlanNavigation,
  moveItem,
  outdentItem,
  pageFiles,
  planNavigationToItems,
  shiftItem,
  toItems,
  updateItem,
} from './navigation-tree'
import type { DocumentationPlanPage, NavigationNode } from './types'

const nodes: NavigationNode[] = [
  { type: 'group', label: 'Get started', icon: 'rocket', items: [
    { type: 'page', file: 'index', title: 'Overview', path: 'index.mdx' },
    { type: 'page', file: 'quickstart', path: 'quickstart.mdx' },
  ] },
  { type: 'divider' },
  { type: 'page', file: 'reference/events', path: 'reference/events.mdx' },
]

describe('navigation tree items', () => {
  it('round-trips server nodes without the derived page fields', () => {
    expect(fromItems(toItems(nodes))).toEqual([
      { type: 'group', label: 'Get started', icon: 'rocket', items: [
        { type: 'page', file: 'index', title: 'Overview' },
        { type: 'page', file: 'quickstart' },
      ] },
      { type: 'divider' },
      { type: 'page', file: 'reference/events' },
    ])
  })

  it('moves a page into a group, refuses moving a group into itself, and reorders siblings', () => {
    const items = toItems(nodes)
    const group = items[0]!
    const events = items[2]!
    const moved = moveItem(items, events.id, group.id, 0)
    expect(pageFiles(moved)).toEqual(['reference/events', 'index', 'quickstart'])
    expect(moveItem(moved, group.id, group.id, 0)).toBe(moved)
    const shifted = shiftItem(moved, moved[0]!.children![0]!.id, 1)
    expect(pageFiles(shifted)).toEqual(['index', 'reference/events', 'quickstart'])
    expect(shiftItem(shifted, shifted[0]!.children![0]!.id, -1)).toBe(shifted)
  })

  it('indents into the preceding group and outdents to after the parent', () => {
    const items = toItems([
      { type: 'group', label: 'A', items: [{ type: 'page', file: 'a' }] },
      { type: 'page', file: 'b' },
    ])
    const indented = indentItem(items, items[1]!.id)
    expect(fromItems(indented)).toEqual([{ type: 'group', label: 'A', items: [{ type: 'page', file: 'a' }, { type: 'page', file: 'b' }] }])
    const outdented = outdentItem(indented, indented[0]!.children![0]!.id)
    expect(fromItems(outdented)).toEqual([{ type: 'group', label: 'A', items: [{ type: 'page', file: 'b' }] }, { type: 'page', file: 'a' }])
  })

  it('dissolves a group in place and applies patches by id', () => {
    const items = toItems(nodes)
    const flat = dissolveGroup(items, items[0]!.id)
    expect(fromItems(flat).map((node) => node.type)).toEqual(['page', 'page', 'divider', 'page'])
    const renamed = updateItem(items, items[0]!.id, (item) => ({ ...item, node: { ...item.node, label: 'Start here' } as typeof item.node }))
    expect((fromItems(renamed)[0] as { label: string }).label).toBe('Start here')
  })

  it('maps plan sections to groups and back, keeping section ids and loose pages', () => {
    const pages = [
      { id: 'quickstart', title: 'Quickstart', path: 'quickstart' },
      { id: 'events', title: 'Events API', path: 'reference/events' },
      { id: 'faq', title: 'FAQ', path: 'faq' },
    ] as DocumentationPlanPage[]
    const navigation = { top: ['Documentation'], sections: [
      { id: 'getting-started', title: 'Getting started', pageIds: ['quickstart', 'missing'] },
      { id: 'reference', title: 'Reference', pageIds: ['events'] },
    ] }
    const { items, unsectioned } = planNavigationToItems(navigation, pages)
    expect(unsectioned.map((page) => page.id)).toEqual(['faq'])
    expect(items.map((item) => item.sectionId)).toEqual(['getting-started', 'reference'])
    const moved = moveItem(items, items[1]!.children![0]!.id, items[0]!.id, 0)
    const back = itemsToPlanNavigation(moved, navigation.top)
    expect(back).toEqual({ top: ['Documentation'], sections: [{ id: 'getting-started', title: 'Getting started', pageIds: ['events', 'quickstart'] }] })
  })
})
