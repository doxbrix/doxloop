import { expect, test } from 'vitest'
import { applyBlockEdits } from './page-content-edits'

test('multiple visual edits preserve frontmatter, untouched MDX, and original offsets', () => {
  const content = '---\ntitle: Guide\n---\n\nFirst paragraph.\n\n<Tabs>Keep **markup**.</Tabs>\n\nLast paragraph.\n'
  const blocks = ['First paragraph.', 'Last paragraph.'].map(text => ({ start: content.indexOf(text), end: content.indexOf(text) + text.length, text }))
  const edits = new Map([[blocks[0]!.start, 'A much longer first paragraph.'], [blocks[1]!.start, 'Last.']])
  expect(applyBlockEdits(content, blocks, edits)).toBe(content.replace('First paragraph.', 'A much longer first paragraph.').replace('Last paragraph.', 'Last.'))
  expect(applyBlockEdits(content, blocks, new Map())).toBe(content)
})

test('stale and overlapping mappings cannot replace unrelated source', () => {
  expect(() => applyBlockEdits('Original', [{ start: 0, end: 4, text: 'Nope' }], new Map([[0, 'Bad']]))).toThrow('out of date')
  expect(() => applyBlockEdits('Original', [{ start: 0, end: 8, text: 'Original' }, { start: 4, end: 8, text: 'inal' }], new Map())).toThrow('out of date')
})
