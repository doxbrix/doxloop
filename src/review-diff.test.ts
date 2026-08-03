import { describe, expect, test } from 'vitest'
import {
  alignBlocks,
  diffKeys,
  htmlText,
  markHtmlWordDiff,
  splitHtmlBlocks,
  unifiedRows,
  wordDiffText,
} from './review-diff.js'
import { renderedDiff } from './review-render.js'
import type { SyncChangeHunk } from './types.js'

function hunk(partial: Partial<SyncChangeHunk> & { id: string }): SyncChangeHunk {
  return { oldStart: 0, oldLines: [], newStart: 0, newLines: [], ...partial }
}

describe('diffKeys', () => {
  test('reports a replaced element as a delete followed by an insert', () => {
    const spans = diffKeys(['a', 'b', 'c'], ['a', 'x', 'c'])
    expect(spans.map((span) => span.type)).toEqual(['equal', 'delete', 'insert', 'equal'])
    expect(spans[1]).toMatchObject({ beforeStart: 1, beforeEnd: 2 })
    expect(spans[2]).toMatchObject({ afterStart: 1, afterEnd: 2 })
  })

  test('handles an empty side', () => {
    expect(diffKeys([], ['a']).map((span) => span.type)).toEqual(['insert'])
    expect(diffKeys(['a'], []).map((span) => span.type)).toEqual(['delete'])
    expect(diffKeys([], [])).toEqual([])
  })
})

describe('unifiedRows', () => {
  const before = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight'].join('\n')

  test('surrounds a change with context and numbers both sides', () => {
    const diff = unifiedRows(
      before,
      [hunk({ id: 'h1', oldStart: 4, oldLines: ['five'], newStart: 4, newLines: ['FIVE'] })],
      { context: 2 },
    )
    expect(diff.added).toBe(1)
    expect(diff.removed).toBe(1)
    const changed = diff.rows.filter((row) => row.type !== 'context' && row.type !== 'gap')
    expect(changed).toHaveLength(2)
    expect(changed[0]).toMatchObject({ type: 'delete', oldNumber: 5, hunkId: 'h1' })
    expect(changed[1]).toMatchObject({ type: 'insert', newNumber: 5, hunkId: 'h1' })
    // Two lines of context on each side of the change stay visible.
    expect(diff.rows.filter((row) => row.type === 'context').map((row) => row.oldNumber))
      .toEqual([3, 4, 6, 7])
  })

  test('folds long unchanged stretches into a gap row', () => {
    const diff = unifiedRows(
      before,
      [hunk({ id: 'h1', oldStart: 7, oldLines: ['eight'], newStart: 7, newLines: ['EIGHT'] })],
      { context: 1 },
    )
    const gap = diff.rows.find((row) => row.type === 'gap')
    expect(gap?.hidden).toBe(6)
  })

  test('marks only the words that differ on a paired line', () => {
    const diff = unifiedRows(
      'limit is 100 tasks',
      [hunk({ id: 'h1', oldLines: ['limit is 100 tasks'], newLines: ['limit is 125 tasks'] })],
    )
    const removed = diff.rows.find((row) => row.type === 'delete')
    const added = diff.rows.find((row) => row.type === 'insert')
    expect(removed?.html).toBe('limit is <mark class="rv-word rv-word--del">100</mark> tasks')
    expect(added?.html).toBe('limit is <mark class="rv-word rv-word--ins">125</mark> tasks')
  })

  test('leaves unrelated replacement lines whole', () => {
    const diff = unifiedRows(
      'alpha',
      [hunk({ id: 'h1', oldLines: ['alpha'], newLines: ['completely different sentence'] })],
    )
    expect(diff.rows.find((row) => row.type === 'insert')?.html).toBe('completely different sentence')
  })

  test('escapes markup in the diffed content', () => {
    const diff = unifiedRows('', [hunk({ id: 'h1', newLines: ['<script>alert(1)</script>'] })])
    expect(diff.rows[0]?.html).toBe('&lt;script&gt;alert(1)&lt;/script&gt;')
  })
})

describe('wordDiffText', () => {
  test('does not highlight pure whitespace runs', () => {
    const marked = wordDiffText('a b', 'a  b')
    expect(marked.after).not.toContain('<mark')
  })
})

describe('splitHtmlBlocks', () => {
  test('splits top-level elements and keeps nested markup intact', () => {
    const blocks = splitHtmlBlocks('<h2 id="a">Title</h2><div class="x"><p>One</p><p>Two</p></div>')
    expect(blocks).toEqual(['<h2 id="a">Title</h2>', '<div class="x"><p>One</p><p>Two</p></div>'])
  })

  test('treats void and self-closing elements as their own blocks', () => {
    expect(splitHtmlBlocks('<hr><img src="a.png"><p>Text</p>')).toEqual([
      '<hr>',
      '<img src="a.png">',
      '<p>Text</p>',
    ])
  })

  test('is not confused by angle brackets inside attributes', () => {
    expect(splitHtmlBlocks('<p title="a > b">One</p>')).toEqual(['<p title="a > b">One</p>'])
  })
})

describe('htmlText', () => {
  test('returns the visible text with entities decoded', () => {
    expect(htmlText('<p>Set <code>PORT=4100</code> &amp; restart</p>')).toBe('Set PORT=4100 & restart')
  })
})

describe('alignBlocks', () => {
  test('pairs a replaced block into a single changed row', () => {
    const rows = alignBlocks(
      ['<p>Keep</p>', '<p>Old value 100</p>', '<p>Tail</p>'],
      ['<p>Keep</p>', '<p>New value 125</p>', '<p>Tail</p>'],
    )
    expect(rows.map((row) => row.status)).toEqual(['equal', 'changed', 'equal'])
    expect(rows[1]).toMatchObject({ before: '<p>Old value 100</p>', after: '<p>New value 125</p>' })
  })

  test('reports pure additions and removals separately', () => {
    const rows = alignBlocks(['<p>A</p>'], ['<p>A</p>', '<p>B</p>'])
    expect(rows.map((row) => row.status)).toEqual(['equal', 'added'])
    expect(alignBlocks(['<p>A</p>', '<p>B</p>'], ['<p>A</p>']).map((row) => row.status))
      .toEqual(['equal', 'removed'])
  })

  test('treats the same text in a different element as a change, not a match', () => {
    const rows = alignBlocks(['<p>Limits</p>'], ['<h2>Limits</h2>'])
    expect(rows.map((row) => row.status)).toEqual(['changed'])
  })
})

describe('markHtmlWordDiff', () => {
  test('highlights changed words without breaking tags', () => {
    const marked = markHtmlWordDiff(
      '<p>Pending tasks: <code>100</code> by default.</p>',
      '<p>Pending tasks: <code>125</code> by default.</p>',
    )
    expect(marked.before).toContain('<code><mark class="rv-word rv-word--del">100</mark></code>')
    expect(marked.after).toContain('<code><mark class="rv-word rv-word--ins">125</mark></code>')
    expect(marked.after).toContain('by default.')
  })
})

describe('renderedDiff', () => {
  const side = (title: string, body: string): Parameters<typeof renderedDiff>[0]['before'] => ({
    title,
    description: '',
    body,
    exists: true,
  })

  test('produces aligned before/after cells for a changed paragraph', () => {
    const diff = renderedDiff({
      before: side('Limits', 'Pending tasks: `100` by default.'),
      after: side('Limits', 'Pending tasks: `125` by default.'),
    })
    expect(diff.changed).toBe(1)
    expect(diff.html).toContain('rd-cell--before')
    expect(diff.html).toContain('rd-cell--after')
    expect(diff.html).toContain('rv-word--ins')
  })

  test('treats a new page as fully added', () => {
    const diff = renderedDiff({
      before: { title: 'New', description: '', body: '', exists: false },
      after: side('New', 'First paragraph.'),
    })
    expect(diff.removed).toBe(0)
    expect(diff.added).toBeGreaterThan(0)
    expect(diff.html).toContain('Not in the current page')
  })

  test('folds long unchanged stretches away from the change', () => {
    const filler = Array.from({ length: 8 }, (_, index) => `Paragraph ${index}.`).join('\n\n')
    const diff = renderedDiff({
      before: side('Page', `${filler}\n\nTail 100.`),
      after: side('Page', `${filler}\n\nTail 125.`),
    })
    expect(diff.html).toContain('unchanged block')
  })
})
