/**
 * Diff primitives for the local review center.
 *
 * Two kinds of diff are produced here. `unifiedRows` turns the stored proposal
 * hunks back into a reviewable unified diff with surrounding context and
 * word-level emphasis, and `alignBlocks`/`markHtmlWordDiff` line up the two
 * rendered versions of a page so a reader can compare them side by side without
 * reading Markdown at all.
 */

import type { SyncChangeHunk } from './types.js'

/** Guard so a pathological file cannot allocate a huge LCS table. */
const MAX_TABLE_CELLS = 4_000_000

export type SpanType = 'equal' | 'delete' | 'insert'

export interface DiffSpan {
  type: SpanType
  beforeStart: number
  beforeEnd: number
  afterStart: number
  afterEnd: number
}

/** Longest-common-subsequence diff over pre-computed comparison keys. */
export function diffKeys(before: readonly string[], after: readonly string[]): DiffSpan[] {
  const spans: DiffSpan[] = []
  const push = (type: SpanType, bs: number, be: number, as: number, ae: number): void => {
    if (bs === be && as === ae) return
    const last = spans.at(-1)
    if (last?.type === type) {
      last.beforeEnd = be
      last.afterEnd = ae
      return
    }
    spans.push({ type, beforeStart: bs, beforeEnd: be, afterStart: as, afterEnd: ae })
  }

  // Trimming the shared head and tail keeps the table small for the common case
  // of a one-line edit inside a long file.
  let head = 0
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1
  let tail = 0
  while (
    tail < before.length - head &&
    tail < after.length - head &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1
  }
  const oldMid = before.slice(head, before.length - tail)
  const newMid = after.slice(head, after.length - tail)
  push('equal', 0, head, 0, head)

  if (oldMid.length === 0 || newMid.length === 0 ||
      (oldMid.length + 1) * (newMid.length + 1) > MAX_TABLE_CELLS) {
    push('delete', head, head + oldMid.length, head, head)
    push('insert', head + oldMid.length, head + oldMid.length, head, head + newMid.length)
  } else {
    const table = Array.from({ length: oldMid.length + 1 }, () => new Uint32Array(newMid.length + 1))
    for (let old = oldMid.length - 1; old >= 0; old -= 1) {
      for (let next = newMid.length - 1; next >= 0; next -= 1) {
        table[old]![next] = oldMid[old] === newMid[next]
          ? table[old + 1]![next + 1]! + 1
          : Math.max(table[old + 1]![next]!, table[old]![next + 1]!)
      }
    }
    let old = 0
    let next = 0
    while (old < oldMid.length || next < newMid.length) {
      if (old < oldMid.length && next < newMid.length && oldMid[old] === newMid[next]) {
        push('equal', head + old, head + old + 1, head + next, head + next + 1)
        old += 1
        next += 1
      } else if (
        old < oldMid.length &&
        (next >= newMid.length || table[old + 1]![next]! >= table[old]![next + 1]!)
      ) {
        // Removals are emitted before the additions that replace them so a
        // consumer can pair the two into a single before/after comparison.
        push('delete', head + old, head + old + 1, head + next, head + next)
        old += 1
      } else {
        push('insert', head + old, head + old, head + next, head + next + 1)
        next += 1
      }
    }
  }

  const beforeTailStart = before.length - tail
  const afterTailStart = after.length - tail
  push('equal', beforeTailStart, before.length, afterTailStart, after.length)
  return spans
}

/* ── Unified source diff ──────────────────────────────────────────────── */

export type DiffRowType = 'context' | 'delete' | 'insert' | 'gap'

export interface DiffRow {
  type: DiffRowType
  /** 1-based line number in the current file, when the row exists there. */
  oldNumber?: number
  /** 1-based line number in the proposed file, when the row exists there. */
  newNumber?: number
  /** Escaped HTML — may contain `<mark>` spans for word-level emphasis. */
  html: string
  /** Set on `gap` rows: how many unchanged lines were folded away. */
  hidden?: number
  hunkId?: string
  hunkState?: 'pending' | 'accepted' | 'rejected'
}

export interface UnifiedDiff {
  rows: DiffRow[]
  added: number
  removed: number
}

export interface UnifiedOptions {
  context?: number
}

/**
 * Rebuild a reviewable unified diff from the proposal's stored hunks. The hunks
 * only carry the changed lines, so the surrounding context comes from the
 * snapshot of the file taken when the proposal was generated.
 */
export function unifiedRows(
  beforeText: string,
  hunks: readonly SyncChangeHunk[],
  options: UnifiedOptions = {},
): UnifiedDiff {
  const context = options.context ?? 3
  const lines = textLines(beforeText)
  const rows: DiffRow[] = []
  let added = 0
  let removed = 0
  let oldCursor = 0
  let newCursor = 0

  /**
   * `leading` marks a run that follows a change (keep its first lines) and
   * `trailing` a run that precedes one (keep its last lines). A run with
   * neither — a file without changes — is shown in full.
   */
  const emitContext = (from: number, to: number, leading: boolean, trailing: boolean): void => {
    const count = to - from
    if (count <= 0) return
    const head = leading ? Math.min(context, count) : trailing ? 0 : count
    const tail = trailing ? Math.min(context, count) : 0
    if (head + tail >= count) {
      for (let index = from; index < to; index += 1) {
        rows.push({
          type: 'context',
          oldNumber: index + 1,
          newNumber: newCursor + (index - from) + 1,
          html: escapeHtml(lines[index] ?? ''),
        })
      }
      newCursor += count
      return
    }
    for (let index = from; index < from + head; index += 1) {
      rows.push({
        type: 'context',
        oldNumber: index + 1,
        newNumber: newCursor + (index - from) + 1,
        html: escapeHtml(lines[index] ?? ''),
      })
    }
    rows.push({ type: 'gap', html: '', hidden: count - head - tail })
    for (let index = to - tail; index < to; index += 1) {
      rows.push({
        type: 'context',
        oldNumber: index + 1,
        newNumber: newCursor + (index - from) + 1,
        html: escapeHtml(lines[index] ?? ''),
      })
    }
    newCursor += count
  }

  for (const [position, hunk] of hunks.entries()) {
    emitContext(oldCursor, hunk.oldStart, position > 0, true)
    oldCursor = hunk.oldStart
    newCursor = hunk.newStart
    const state = hunk.acceptedAt ? 'accepted' : hunk.rejectedAt ? 'rejected' : 'pending'
    const pairs = pairChangedLines(hunk.oldLines, hunk.newLines)
    for (const [index, line] of hunk.oldLines.entries()) {
      const partner = pairs.get(index)
      rows.push({
        type: 'delete',
        oldNumber: oldCursor + index + 1,
        html: partner === undefined ? escapeHtml(line) : wordDiffText(line, partner).before,
        hunkId: hunk.id,
        hunkState: state,
      })
      removed += 1
    }
    for (const [index, line] of hunk.newLines.entries()) {
      const partner = pairs.has(index) ? hunk.oldLines[index]! : undefined
      rows.push({
        type: 'insert',
        newNumber: newCursor + index + 1,
        html: partner === undefined ? escapeHtml(line) : wordDiffText(partner, line).after,
        hunkId: hunk.id,
        hunkState: state,
      })
      added += 1
    }
    oldCursor = hunk.oldStart + hunk.oldLines.length
    newCursor = hunk.newStart + hunk.newLines.length
  }
  emitContext(oldCursor, lines.length, hunks.length > 0, false)
  return { rows, added, removed }
}

/**
 * Pair a removed line with the added line that replaced it, so the two can be
 * shown with only the differing words highlighted. Only confident matches are
 * paired; unrelated lines stay whole-line additions and removals.
 */
function pairChangedLines(
  oldLines: readonly string[],
  newLines: readonly string[],
): Map<number, string> {
  const pairs = new Map<number, string>()
  const count = Math.min(oldLines.length, newLines.length)
  for (let index = 0; index < count; index += 1) {
    const before = oldLines[index]!
    const after = newLines[index]!
    if (before !== after && similarity(before, after) >= 0.45) pairs.set(index, after)
  }
  return pairs
}

function similarity(before: string, after: string): number {
  const left = words(before)
  const right = words(after)
  if (left.length === 0 || right.length === 0) return 0
  const shared = new Map<string, number>()
  for (const word of left) shared.set(word, (shared.get(word) ?? 0) + 1)
  let common = 0
  for (const word of right) {
    const available = shared.get(word) ?? 0
    if (available > 0) {
      shared.set(word, available - 1)
      common += 1
    }
  }
  return (2 * common) / (left.length + right.length)
}

/* ── Word-level diff ──────────────────────────────────────────────────── */

export interface WordDiff {
  before: string
  after: string
}

/** Word-level diff of two plain-text lines, returned as escaped HTML. */
export function wordDiffText(before: string, after: string): WordDiff {
  const left = tokenizeWords(before)
  const right = tokenizeWords(after)
  const spans = diffKeys(left, right)
  let beforeHtml = ''
  let afterHtml = ''
  for (const span of spans) {
    const removedText = left.slice(span.beforeStart, span.beforeEnd).join('')
    const addedText = right.slice(span.afterStart, span.afterEnd).join('')
    if (span.type === 'equal') {
      beforeHtml += escapeHtml(removedText)
      afterHtml += escapeHtml(addedText)
      continue
    }
    if (span.type === 'delete' && removedText.trim() !== '') {
      beforeHtml += `<mark class="rv-word rv-word--del">${escapeHtml(removedText)}</mark>`
    } else if (span.type === 'delete') {
      beforeHtml += escapeHtml(removedText)
    }
    if (span.type === 'insert' && addedText.trim() !== '') {
      afterHtml += `<mark class="rv-word rv-word--ins">${escapeHtml(addedText)}</mark>`
    } else if (span.type === 'insert') {
      afterHtml += escapeHtml(addedText)
    }
  }
  return { before: beforeHtml, after: afterHtml }
}

function tokenizeWords(value: string): string[] {
  return value.match(/\s+|[A-Za-z0-9_]+|[^\sA-Za-z0-9_]/g) ?? []
}

function words(value: string): string[] {
  return value.match(/[A-Za-z0-9_]+/g) ?? []
}

/* ── Rendered HTML diff ───────────────────────────────────────────────── */

const VOID_ELEMENTS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
])

/**
 * Split rendered documentation HTML into its top-level blocks (one paragraph,
 * heading, code block, callout, table … per entry) so two renderings can be
 * lined up against each other.
 */
export function splitHtmlBlocks(html: string): string[] {
  const blocks: string[] = []
  const pattern = /<!--[\s\S]*?-->|<\/?([a-zA-Z][\w-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g
  let depth = 0
  let start = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    if (match[0].startsWith('<!--')) continue
    const name = match[1]!.toLowerCase()
    const closing = match[0].startsWith('</')
    const selfClosing = match[2]?.trimEnd().endsWith('/') ?? false
    if (VOID_ELEMENTS.has(name) || selfClosing) {
      if (depth === 0) {
        blocks.push(html.slice(start, match.index + match[0].length).trim())
        start = match.index + match[0].length
      }
      continue
    }
    if (closing) {
      depth -= 1
      if (depth <= 0) {
        depth = 0
        blocks.push(html.slice(start, match.index + match[0].length).trim())
        start = match.index + match[0].length
      }
      continue
    }
    depth += 1
  }
  const rest = html.slice(start).trim()
  if (rest !== '') blocks.push(rest)
  return blocks.filter((block) => block !== '')
}

/** Visible text of an HTML fragment, used as the block comparison key. */
export function htmlText(html: string): string {
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
}

export type RenderedRowStatus = 'equal' | 'changed' | 'added' | 'removed'

export interface RenderedRow {
  status: RenderedRowStatus
  before?: string
  after?: string
}

/**
 * Align the blocks of two rendered pages. Adjacent removals and additions are
 * paired into a single "changed" row so the reader sees one before/after
 * comparison instead of two disconnected entries.
 */
export function alignBlocks(before: readonly string[], after: readonly string[]): RenderedRow[] {
  const spans = diffKeys(before.map(blockKey), after.map(blockKey))
  const rows: RenderedRow[] = []
  for (let index = 0; index < spans.length; index += 1) {
    const span = spans[index]!
    if (span.type === 'equal') {
      for (let offset = 0; offset < span.beforeEnd - span.beforeStart; offset += 1) {
        rows.push({
          status: 'equal',
          before: before[span.beforeStart + offset]!,
          after: after[span.afterStart + offset]!,
        })
      }
      continue
    }
    if (span.type === 'delete') {
      const next = spans[index + 1]
      const removed = before.slice(span.beforeStart, span.beforeEnd)
      if (next?.type === 'insert') {
        const inserted = after.slice(next.afterStart, next.afterEnd)
        const paired = Math.min(removed.length, inserted.length)
        for (let offset = 0; offset < paired; offset += 1) {
          rows.push({ status: 'changed', before: removed[offset]!, after: inserted[offset]! })
        }
        for (const block of removed.slice(paired)) rows.push({ status: 'removed', before: block })
        for (const block of inserted.slice(paired)) rows.push({ status: 'added', after: block })
        index += 1
        continue
      }
      for (const block of removed) rows.push({ status: 'removed', before: block })
      continue
    }
    for (const block of after.slice(span.afterStart, span.afterEnd)) {
      rows.push({ status: 'added', after: block })
    }
  }
  return rows
}

function blockKey(html: string): string {
  const tag = /<\s*([a-zA-Z][\w-]*)/.exec(html)?.[1]?.toLowerCase() ?? 'text'
  return `${tag} ${htmlText(html)}`
}

/**
 * Highlight the words that differ between two rendered blocks while leaving the
 * surrounding markup — links, code spans, table cells — intact.
 */
export function markHtmlWordDiff(before: string, after: string): WordDiff {
  const left = tokenizeHtml(before)
  const right = tokenizeHtml(after)
  const leftKeys = left.map((token) => (token.tag ? `${token.value}` : token.value))
  const rightKeys = right.map((token) => (token.tag ? `${token.value}` : token.value))
  const spans = diffKeys(leftKeys, rightKeys)
  let beforeHtml = ''
  let afterHtml = ''
  for (const span of spans) {
    for (let index = span.beforeStart; index < span.beforeEnd; index += 1) {
      beforeHtml += wrapToken(left[index]!, span.type === 'delete' ? 'del' : undefined)
    }
    for (let index = span.afterStart; index < span.afterEnd; index += 1) {
      afterHtml += wrapToken(right[index]!, span.type === 'insert' ? 'ins' : undefined)
    }
  }
  return { before: beforeHtml, after: afterHtml }
}

interface HtmlToken {
  value: string
  tag: boolean
}

function tokenizeHtml(html: string): HtmlToken[] {
  const tokens: HtmlToken[] = []
  const pattern = /<[^>]*>|\s+|[^\s<]+/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(html)) !== null) {
    tokens.push({ value: match[0], tag: match[0].startsWith('<') })
  }
  return tokens
}

function wrapToken(token: HtmlToken, mark: 'del' | 'ins' | undefined): string {
  if (!mark || token.tag || token.value.trim() === '') return token.value
  return `<mark class="rv-word rv-word--${mark}">${token.value}</mark>`
}

/* ── Shared helpers ───────────────────────────────────────────────────── */

export function textLines(text: string): string[] {
  if (text === '') return []
  const normalized = text.replace(/\r\n/g, '\n')
  return normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n') : normalized.split('\n')
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function decodeEntities(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
}
