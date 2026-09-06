import { describe, expect, test } from 'vitest'
import { defaultReviewChange, hunkStateKey, isSupportingChange, reviewFileGroups } from './review-presentation'

const changes = [
  { id: 'change-1', path: '.doxloop/evidence-map.json', category: 'evidence' },
  { id: 'change-2', path: '.claude/skills/doxloop-authoring/SKILL.md', category: 'configuration' },
  { id: 'change-3', path: 'docs.json', category: 'navigation' },
  { id: 'change-4', path: 'reference/events.mdx', category: 'page' },
  { id: 'change-5', path: 'assets/events.png', category: 'asset' },
  { id: 'change-6', path: 'quickstart.mdx', category: 'page', changedDuringRun: true },
]

describe('review presentation', () => {
  test('opens on the first documentation page instead of the evidence map', () => {
    expect(defaultReviewChange(changes)?.id).toBe('change-4')
    expect(defaultReviewChange(changes.filter((change) => change.category !== 'page'))?.id).toBe('change-3')
    expect(defaultReviewChange(changes.slice(0, 2))?.id).toBe('change-1')
    expect(defaultReviewChange([])).toBeUndefined()
  })

  test('separates concurrent edits, documentation, and supporting files', () => {
    const groups = reviewFileGroups(changes)
    expect(groups.concurrent.map((change) => change.id)).toEqual(['change-6'])
    expect(groups.documentation.map((change) => change.id)).toEqual(['change-3', 'change-4', 'change-5'])
    expect(groups.supporting.map((change) => change.id)).toEqual(['change-1', 'change-2'])
    expect(isSupportingChange({ category: 'evidence' })).toBe(true)
    expect(isSupportingChange({ category: 'page' })).toBe(false)
  })

  test('changes the hunk key as decisions land so the diff reloads', () => {
    const pending = { hunks: [{ id: 'h1' }, { id: 'h2' }] }
    const accepted = { hunks: [{ id: 'h1', acceptedAt: 'now' }, { id: 'h2' }] }
    expect(hunkStateKey(pending)).not.toBe(hunkStateKey(accepted))
    expect(hunkStateKey(accepted)).toBe('h1:a,h2:p')
  })
})
