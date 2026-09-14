export interface EditableBlock { start: number; end: number; text: string }

/** Apply from the end so edits never shift the offsets of another block. */
export function applyBlockEdits(content: string, blocks: EditableBlock[], edits: ReadonlyMap<number, string>): string {
  let result = content
  let boundary = content.length
  for (const block of [...blocks].sort((a, b) => b.start - a.start)) {
    if (block.start < 0 || block.end > boundary || content.slice(block.start, block.end) !== block.text) throw new Error('The editable preview is out of date. Reopen Content to refresh it.')
    boundary = block.start
    const replacement = edits.get(block.start)
    if (replacement !== undefined) result = result.slice(0, block.start) + replacement + result.slice(block.end)
  }
  return result
}
