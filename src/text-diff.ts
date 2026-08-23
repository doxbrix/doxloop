import type { SyncChangeHunk } from './types.js'

/**
 * Line diffing shared by the proposal pipeline and the history index. It lives
 * on its own so history can measure an agent's edits without importing the
 * synchronization module that already records into history.
 */

export function textLines(text: string): string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n')
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n')
}

export function lineHunks(before: string, after: string, prefix: string): SyncChangeHunk[] {
  if (before === after) return []
  const oldLines = textLines(before)
  const newLines = textLines(after)
  if (oldLines.length * newLines.length > 2_000_000) {
    return [{ id: `${prefix}-1`, oldStart: 0, oldLines, newStart: 0, newLines }]
  }
  const table = Array.from({ length: oldLines.length + 1 }, () =>
    new Uint32Array(newLines.length + 1),
  )
  for (let old = oldLines.length - 1; old >= 0; old -= 1) {
    for (let next = newLines.length - 1; next >= 0; next -= 1) {
      table[old]![next] = oldLines[old] === newLines[next]
        ? table[old + 1]![next + 1]! + 1
        : Math.max(table[old + 1]![next]!, table[old]![next + 1]!)
    }
  }
  const hunks: SyncChangeHunk[] = []
  let old = 0
  let next = 0
  let current: SyncChangeHunk | undefined
  const flush = (): void => {
    if (!current) return
    current.id = `${prefix}-${hunks.length + 1}`
    hunks.push(current)
    current = undefined
  }
  while (old < oldLines.length || next < newLines.length) {
    if (old < oldLines.length && next < newLines.length && oldLines[old] === newLines[next]) {
      flush()
      old += 1
      next += 1
      continue
    }
    current ??= { id: '', oldStart: old, oldLines: [], newStart: next, newLines: [] }
    if (next < newLines.length && (old >= oldLines.length || table[old]![next + 1]! >= table[old + 1]![next]!)) {
      current.newLines.push(newLines[next]!)
      next += 1
    } else if (old < oldLines.length) {
      current.oldLines.push(oldLines[old]!)
      old += 1
    }
  }
  flush()
  return hunks
}
