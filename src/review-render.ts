/**
 * Builds the rendered before/after comparison shown inside the review center.
 *
 * Both versions of a page are rendered with the same engine the published site
 * uses, then lined up block by block so a writer can read the proposal as a
 * finished page instead of as a patch.
 */

import { renderMarkdown } from './doxbrix-markdown.js'
import {
  alignBlocks,
  escapeHtml,
  markHtmlWordDiff,
  splitHtmlBlocks,
  type RenderedRow,
} from './review-diff.js'

export interface RenderedSide {
  title: string
  description: string
  body: string
  exists: boolean
}

export interface RenderedDiffOptions {
  before: RenderedSide
  after: RenderedSide
}

export interface RenderedDiff {
  html: string
  added: number
  removed: number
  changed: number
}

/** Number of unchanged blocks kept visible on each side of a change. */
const CONTEXT_BLOCKS = 1

export function renderedDiff(options: RenderedDiffOptions): RenderedDiff {
  const before = safeRender(options.before)
  const after = safeRender(options.after)
  const rows: RenderedRow[] = []

  const headerBefore = pageHeader(options.before)
  const headerAfter = pageHeader(options.after)
  if (headerBefore !== '' || headerAfter !== '') {
    rows.push({
      status: !options.before.exists
        ? 'added'
        : !options.after.exists
          ? 'removed'
          : headerBefore === headerAfter
            ? 'equal'
            : 'changed',
      ...(options.before.exists ? { before: headerBefore } : {}),
      ...(options.after.exists ? { after: headerAfter } : {}),
    })
  }
  rows.push(...alignBlocks(splitHtmlBlocks(before), splitHtmlBlocks(after)))

  const added = rows.filter((row) => row.status === 'added').length
  const removed = rows.filter((row) => row.status === 'removed').length
  const changed = rows.filter((row) => row.status === 'changed').length
  const hasChanges = added + removed + changed > 0

  return {
    html: rowGroups(rows, hasChanges).map(groupHtml).join(''),
    added,
    removed,
    changed,
  }
}

function safeRender(side: RenderedSide): string {
  if (!side.exists) return ''
  try {
    return renderMarkdown(side.body).html
  } catch (error) {
    return `<div class="dp-p rd-render-error">This version could not be rendered: ${escapeHtml(
      error instanceof Error ? error.message : String(error),
    )}</div>`
  }
}

function pageHeader(side: RenderedSide): string {
  if (!side.exists) return ''
  const description = side.description
    ? `<p class="dp-page-description">${escapeHtml(side.description)}</p>`
    : ''
  return `<h1 class="dp-page-title">${escapeHtml(side.title)}</h1>${description}`
}

interface RowGroup {
  folded: boolean
  rows: RenderedRow[]
}

/**
 * Group the aligned rows so long stretches of untouched content collapse into a
 * single expandable strip, keeping the changes close together on screen.
 */
function rowGroups(rows: readonly RenderedRow[], hasChanges: boolean): RowGroup[] {
  if (!hasChanges) return [{ folded: false, rows: [...rows] }]
  const visible = rows.map((row, index) => {
    // The page title always stays on screen so the reader keeps their bearings.
    if (row.status !== 'equal' || index === 0) return true
    return rows.some(
      (other, otherIndex) =>
        other.status !== 'equal' && Math.abs(otherIndex - index) <= CONTEXT_BLOCKS,
    )
  })
  const groups: RowGroup[] = []
  for (const [index, row] of rows.entries()) {
    const folded = !visible[index]
    const last = groups.at(-1)
    if (last && last.folded === folded) last.rows.push(row)
    else groups.push({ folded, rows: [row] })
  }
  // A one-block fold costs more attention than it saves.
  return groups.map((group) => (group.folded && group.rows.length < 2 ? { ...group, folded: false } : group))
}

function groupHtml(group: RowGroup): string {
  const rows = group.rows.map(rowHtml).join('')
  if (!group.folded) return rows
  const count = group.rows.length
  return `<details class="rd-fold"><summary class="rd-fold-summary"><span class="rd-fold-line"></span><span class="rd-fold-label">${count} unchanged block${count === 1 ? '' : 's'}</span><span class="rd-fold-line"></span></summary><div class="rd-fold-body">${rows}</div></details>`
}

function rowHtml(row: RenderedRow): string {
  let before = row.before ?? ''
  let after = row.after ?? ''
  if (row.status === 'changed' && before !== '' && after !== '') {
    const marked = markHtmlWordDiff(before, after)
    before = marked.before
    after = marked.after
  }
  return `<div class="rd-row" data-status="${row.status}">${cell('before', before, row.status)}${cell('after', after, row.status)}</div>`
}

function cell(side: 'before' | 'after', html: string, status: RenderedRow['status']): string {
  const empty =
    html === ''
      ? `<div class="rd-empty">${side === 'before' ? 'Not in the current page' : 'Removed from the page'}</div>`
      : ''
  // The tag names the side whenever the two columns are stacked and the sticky
  // column headers no longer apply.
  const tag = `<span class="rd-cell-tag">${side === 'before' ? 'Current' : 'Proposed'}</span>`
  return `<div class="rd-cell rd-cell--${side}" data-status="${status}"><div class="rd-gutter" aria-hidden="true"></div><div class="dp-blocks rd-content">${tag}${html}${empty}</div></div>`
}

export interface ComparisonDocument {
  diff: RenderedDiff
  /** Layout and density are owned by the surrounding screen, not by this frame. */
  layout: 'split' | 'unified'
  onlyChanges: boolean
  notice?: string
}

/**
 * Document for the comparison frame. It carries no controls of its own — the
 * review screen owns every choice — so the whole frame is documentation.
 */
export function renderedDiffDocument(input: ComparisonDocument): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Rendered comparison</title>
  <link rel="stylesheet" href="/reader.css">
  <style>${renderedDiffCss()}</style>
</head>
<body class="rd-body${input.onlyChanges ? ' rd-only-changes' : ''}" data-mode="${input.layout}">
  ${input.notice ? `<div class="rd-notice">${escapeHtml(input.notice)}</div>` : ''}
  <div class="rd-scroll">
    <div class="rd-heads">
      <div class="rd-head rd-head--before"><span class="rd-dot rd-dot--before"></span>Current documentation</div>
      <div class="rd-head rd-head--after"><span class="rd-dot rd-dot--after"></span>Proposed update</div>
    </div>
    <div class="dp-root rd-root" data-color-theme="light" data-code-theme="auto">${input.diff.html}</div>
    ${input.diff.added + input.diff.removed + input.diff.changed === 0
      ? '<div class="rd-none">Nothing in the rendered page changed. The difference is in the file itself — open the source diff to see it.</div>'
      : ''}
  </div>
</body>
</html>`
}

function renderedDiffCss(): string {
  return `
:root{--rv-accent:#0B7F7B;--rv-border:#E1E5ED;--rv-text:#193B73;--rv-heading:#032F7B;--rv-muted:#647392;--rv-added:#16794B;--rv-added-soft:#F0FAF4;--rv-added-line:#C7EAD5;--rv-removed:#B4233F;--rv-removed-soft:#FFF5F6;--rv-removed-line:#F3CDD4;--rv-changed:#865A00;--rv-changed-line:#EEDCA9;--rv-page:#F7F8FB;color-scheme:light}
*{box-sizing:border-box}
html{scroll-behavior:smooth}
body.rd-body{margin:0;background:var(--rv-page);font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:var(--rv-text);-webkit-font-smoothing:antialiased}
.rd-notice{margin:16px 18px 0;padding:10px 14px;border-radius:7px;background:#FFFAEB;border:1px solid var(--rv-changed-line);color:var(--rv-changed);font-size:12.5px;font-weight:600}
.rd-none{margin:18px auto;max-width:560px;padding:22px;text-align:center;border:1px solid var(--rv-border);border-radius:8px;color:var(--rv-muted);font-size:13px;background:#fff}

.rd-scroll{padding:14px 16px 64px}
.rd-heads{position:sticky;top:0;z-index:15;display:grid;grid-template-columns:1fr 1fr;gap:10px;padding:6px 0 10px;background:linear-gradient(180deg,var(--rv-page) 70%,rgba(247,248,246,0))}
body.rd-body[data-mode='unified'] .rd-heads{display:none}
.rd-head{display:flex;align-items:center;gap:7px;font-size:12px;font-weight:600;color:var(--rv-muted)}
.rd-dot{width:8px;height:8px;border-radius:50%}
.rd-dot--before{background:#B3BAC5}
.rd-dot--after{background:var(--rv-accent)}

/* The reader stylesheet paints its own page background; the comparison supplies
   the surface instead, so it is cleared for both themes. */
.rd-root,.rd-root[data-color-theme='light'],.rd-root[data-color-theme='dark']{min-height:0;background:transparent;background-image:none;display:flex;flex-direction:column;gap:2px}
.rd-row{display:grid;grid-template-columns:1fr 1fr;gap:10px;align-items:stretch}
body.rd-body[data-mode='unified'] .rd-row{grid-template-columns:1fr;gap:0}
body.rd-body[data-mode='unified'] .rd-row[data-status='equal'] .rd-cell--before{display:none}
body.rd-body[data-mode='unified'] .rd-row[data-status='changed'] .rd-cell--before{margin-bottom:2px}
body.rd-body.rd-only-changes .rd-row[data-status='equal']{display:none}
body.rd-body.rd-only-changes .rd-fold{display:none}

.rd-cell{position:relative;display:flex;gap:10px;padding:6px 14px 6px 0;border-radius:7px;background:#fff;border:1px solid transparent;min-width:0}
.rd-gutter{width:4px;flex:none;border-radius:4px;background:transparent;margin:6px 0 6px 6px}
.rd-content{margin-top:0;padding:8px 0;min-width:0;flex:1;overflow-x:auto}
.rd-content>*:first-child{margin-top:0}
.rd-content>*:last-child{margin-bottom:0}
/* Wide blocks scroll inside their own cell instead of being clipped by the
   column, and identifiers stay whole rather than breaking mid-token. */
.rd-content{overflow-wrap:normal}
.rd-content table{min-width:min-content}
.rd-content code,.rd-content kbd,.rd-content samp{overflow-wrap:normal;word-break:keep-all}
.rd-content pre{max-width:100%;overflow-x:auto}

.rd-cell[data-status='equal']{background:#fff;border-color:#ECEFEB}
.rd-cell--before[data-status='changed']{background:var(--rv-removed-soft);border-color:var(--rv-removed-line)}
.rd-cell--before[data-status='changed'] .rd-gutter{background:var(--rv-removed)}
.rd-cell--after[data-status='changed']{background:var(--rv-added-soft);border-color:var(--rv-added-line)}
.rd-cell--after[data-status='changed'] .rd-gutter{background:var(--rv-added)}
.rd-cell--after[data-status='added']{background:var(--rv-added-soft);border-color:var(--rv-added-line)}
.rd-cell--after[data-status='added'] .rd-gutter{background:var(--rv-added)}
.rd-cell--before[data-status='removed']{background:var(--rv-removed-soft);border-color:var(--rv-removed-line)}
.rd-cell--before[data-status='removed'] .rd-gutter{background:var(--rv-removed)}
.rd-cell--before[data-status='added'],.rd-cell--after[data-status='removed']{background:repeating-linear-gradient(45deg,#FBFCFD,#FBFCFD 8px,#F2F5F8 8px,#F2F5F8 16px);border-color:#EEF1F5}
.rd-empty{padding:14px 2px;font-size:12px;font-style:italic;color:#8B94A5}

.rd-word{border-radius:3px;padding:0 2px;background:transparent;color:inherit;font-weight:inherit}
.rd-cell--after .rv-word--ins,.rv-word--ins{background:#CBF4C9;color:var(--rv-added);border-radius:3px;padding:0 2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}
.rd-cell--before .rv-word--del,.rv-word--del{background:#FDE2DD;color:var(--rv-removed);border-radius:3px;padding:0 2px;box-decoration-break:clone;-webkit-box-decoration-break:clone}

.rd-fold{margin:2px 0}
.rd-fold-summary{list-style:none;display:flex;align-items:center;gap:12px;cursor:pointer;padding:6px 4px;user-select:none}
.rd-fold-summary::-webkit-details-marker{display:none}
.rd-fold-line{flex:1;height:1px;background:linear-gradient(90deg,transparent,var(--rv-border) 20%,var(--rv-border) 80%,transparent)}
.rd-fold-label{font-size:11.5px;font-weight:600;color:#8B94A5;white-space:nowrap;padding:3px 10px;border:1px solid var(--rv-border);border-radius:100px;background:#fff}
.rd-fold[open] .rd-fold-label{color:var(--rv-muted)}
.rd-fold-body{display:flex;flex-direction:column;gap:2px;margin-top:2px}
.rd-render-error{color:#B91C1C}

.rd-cell-tag{display:none;margin-bottom:8px;padding:2px 8px;border-radius:5px;font-size:11px;font-weight:600;border:1px solid var(--rv-border);color:var(--rv-muted);background:#fff}
.rd-cell--before .rd-cell-tag{border-color:var(--rv-removed-line);color:var(--rv-removed)}
.rd-cell--after .rd-cell-tag{border-color:var(--rv-added-line);color:var(--rv-added)}
body.rd-body[data-mode='unified'] .rd-cell-tag{display:inline-block}
body.rd-body[data-mode='unified'] .rd-row[data-status='equal'] .rd-cell-tag{display:none}

/* Below this width the two columns cannot sit side by side, so the comparison
   stacks and every cell names the side it belongs to. */
@media(max-width:640px){
  .rd-row{grid-template-columns:1fr;gap:2px}
  .rd-heads{display:none}
  .rd-cell-tag{display:inline-block}
  .rd-row[data-status='equal'] .rd-cell--before{display:none}
  .rd-row[data-status='equal'] .rd-cell-tag{display:none}
}
  `
}
