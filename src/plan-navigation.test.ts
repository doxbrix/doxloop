import { describe, expect, test } from 'vitest'
import { capPlanSpaces, spaceLimitPlanIssue } from './documentation-plan.js'
import { capNavigationSpaces, DEFAULT_SPACE_LIMIT, planSpaceLimit, requestedSpaceCount } from './plan-navigation.js'

// The Doxbrix plan that prompted the limit: six spaces, "Get started" with six pages.
const top = ['Get started', 'Write & review', 'Sites & readers', 'Insights', 'Admin & security', 'Developers']
const sections = [
  { id: 'getting-started', title: 'Getting started', space: 'Get started', pageIds: ['index', 'concepts', 'quickstart'] },
  { id: 'account', title: 'Account', space: 'Get started', pageIds: ['create-account', 'sign-in', 'dashboard'] },
  { id: 'editor', title: 'Editor', space: 'Write & review', pageIds: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'] },
  { id: 'sites', title: 'Sites', space: 'Sites & readers', pageIds: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'] },
  { id: 'insights', title: 'Insights', space: 'Insights', pageIds: ['i1', 'i2'] },
  { id: 'admin', title: 'Administration', space: 'Admin & security', pageIds: ['m1', 'm2', 'm3'] },
  { id: 'cli', title: 'dxb CLI', space: 'developers', pageIds: ['d1', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'] },
]

describe('space limit', () => {
  test('reads a requested number of spaces or tabs', () => {
    expect(requestedSpaceCount('Use 5 spaces for the docs')).toBe(5)
    expect(requestedSpaceCount('split it into four top-level tabs')).toBe(4)
    expect(requestedSpaceCount('keep one space')).toBe(1)
    expect(requestedSpaceCount('Add a space between words')).toBeUndefined()
    expect(requestedSpaceCount(undefined)).toBeUndefined()
  })

  test('defaults new documentation to three spaces and leaves updates alone unless asked', () => {
    expect(planSpaceLimit({ mode: 'create', request: 'Document the product' })).toEqual({ limit: DEFAULT_SPACE_LIMIT, requested: false })
    expect(planSpaceLimit({ mode: 'update', request: 'Refresh the billing page' })).toEqual({ requested: false })
    expect(planSpaceLimit({ mode: 'update', request: 'Reorganize into 3 spaces' })).toEqual({ limit: 3, requested: true })
    expect(planSpaceLimit({ mode: 'create', instructions: 'Use six spaces, one per audience.' })).toEqual({ limit: 6, requested: true })
    // The newest instruction wins over the original request.
    expect(planSpaceLimit({ mode: 'create', request: 'use 5 spaces' }, 'go back to 2 spaces')).toEqual({ limit: 2, requested: true })
  })

  test('keeps the landing space and the largest others, folding the rest into the kept space before them', () => {
    const capped = capNavigationSpaces(top, sections, 3)
    expect(capped.top).toEqual(['Get started', 'Write & review', 'Developers'])
    expect(capped.merged).toEqual([
      { from: 'Sites & readers', into: 'Write & review' },
      { from: 'Insights', into: 'Write & review' },
      { from: 'Admin & security', into: 'Write & review' },
    ])
    expect(capped.sections.map((section) => section.space)).toEqual(['Get started', 'Get started', 'Write & review', 'Write & review', 'Write & review', 'Write & review', 'developers'])
    // No page leaves the navigation.
    expect(capped.sections.flatMap((section) => section.pageIds)).toEqual(sections.flatMap((section) => section.pageIds))
  })

  test('leaves navigation within the limit unchanged', () => {
    expect(capNavigationSpaces(top.slice(0, 3), sections.slice(0, 4), 3).merged).toEqual([])
  })

  test('flags an over-limit plan for the planner and caps the raw proposal as a backstop', () => {
    expect(spaceLimitPlanIssue({ navigation: { top, sections } }, 3)).toContain('uses 6 top-level spaces')
    expect(spaceLimitPlanIssue({ navigation: { top, sections } }, undefined)).toBeUndefined()
    expect(spaceLimitPlanIssue({ navigation: { top: top.slice(0, 3), sections } }, 3)).toBeUndefined()

    const result = capPlanSpaces({ pages: [], navigation: { top, sections } }, 3)
    expect((result.raw as { navigation: { top: string[] } }).navigation.top).toHaveLength(3)
    expect(result.repair).toContain('"Insights" into "Write & review"')
    expect(capPlanSpaces({ pages: [], navigation: { top, sections } }, undefined).repair).toBeUndefined()
  })
})
