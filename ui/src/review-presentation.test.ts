import { describe, expect, test } from 'vitest'
import { defaultReviewChange, hunkStateKey, isSupportingChange, proposalDecisionCounts, reviewFileGroups, screenshotCoverageText } from './review-presentation'

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

describe('review progress and screenshot coverage', () => {
  test('counts files, not hunks, so the totals match the file heading', () => {
    const decided = [
      { hunks: [{ id: 'a', acceptedAt: 't' }, { id: 'b', acceptedAt: 't' }] },
      { hunks: [{ id: 'c', rejectedAt: 't' }] },
      { hunks: [{ id: 'd' }, { id: 'e' }, { id: 'f', acceptedAt: 't' }] },
      { hunks: [{ id: 'g', acceptedAt: 't' }, { id: 'h', rejectedAt: 't' }] },
      { hunks: [] },
    ]
    expect(proposalDecisionCounts(decided)).toEqual({ accepted: 2, rejected: 1, remaining: 2 })
    expect(proposalDecisionCounts(decided, true)).toEqual({ accepted: 3, rejected: 1, remaining: 1 })
    const counts = proposalDecisionCounts(decided)
    expect(counts.accepted + counts.rejected + counts.remaining).toBe(decided.length)
  })
  test('frames screenshots as guide coverage', () => {
    expect(screenshotCoverageText({ captured: 2, guides: 2 }, 41)).toBe('Screenshots in 2 of 41 guides · 2 screenshots verified')
    expect(screenshotCoverageText({ captured: 1, guides: 1 })).toBe('Screenshots in 1 guide · 1 screenshot verified')
    expect(screenshotCoverageText({ captured: 5, guides: 3 }, 2)).toBe('Screenshots in 3 guides · 5 screenshots verified')
  })
})
