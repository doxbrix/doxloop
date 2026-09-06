import { useEffect, useState } from 'preact/hooks'
import { api, post } from './api'
import { Badge, Button, Empty } from './components'
import { Icon } from './icons'
import { hunkStateKey } from './review-presentation'
import type { DiffRow, ProposalChange, SourceDiff } from './types'

type Action = <T>(run: () => Promise<T>, success?: string, refresh?: boolean) => Promise<T | undefined>

export function ProposalRenderedDiff({ runId, change, layout = 'split', onlyChanges = true }: {
  runId: string
  change: ProposalChange
  layout?: 'split' | 'unified'
  onlyChanges?: boolean
}) {
  return <div class="review-device"><iframe class="review-frame" title={`Review ${change.title}`} src={`/review-preview/${runId}/${change.id}?layout=${layout}${onlyChanges ? '&only=1' : ''}`} /></div>
}

export function ProposalSourceDiff({ runId, change, act, onReviseHunk = () => undefined, partialActions = true, beforeAccept = () => true }: {
  runId: string
  change: ProposalChange
  act: Action
  onReviseHunk?: (hunkId: string) => void
  partialActions?: boolean
  /** Runs before a hunk is accepted; returning false cancels. */
  beforeAccept?: () => boolean
}) {
  const [diff, setDiff] = useState<SourceDiff | null>(null)
  const [error, setError] = useState('')
  // Hunk badges come from the diff rows, so the diff reloads as soon as a
  // decision on this file lands rather than waiting for a file switch.
  const decisions = hunkStateKey(change)
  useEffect(() => {
    setError('')
    void api<SourceDiff>(`/api/proposals/${runId}/changes/${change.id}/diff`).then(setDiff).catch((cause) => setError(cause instanceof Error ? cause.message : String(cause)))
  }, [runId, change.id, decisions])
  useEffect(() => setDiff(null), [runId, change.id])
  if (error) return <div class="diff-message error">{error}</div>
  if (!diff) return <div class="diff-message">Loading source diff…</div>
  if (diff.binary) return <Empty title="Binary asset" detail="This file has no line-by-line source diff. Accept the page to apply it." />
  const groups = diffGroups(diff.rows)
  return <div class="source-diff">
    <div class="diff-summary"><span class="added">+{diff.added}</span><span class="removed">−{diff.removed}</span><small>{partialActions ? 'Accept one change at a time, or accept the complete page.' : 'Review the source changes before accepting the complete edit.'}</small></div>
    {groups.map((group, index) => <section class={`hunk ${group.state ?? ''}`} key={group.hunkId ?? index}>
      <header>
        <strong>{group.hunkId ? `Change ${index + 1}` : 'Context'}</strong>
        {partialActions && group.hunkId && group.state === 'pending' && <span class="hunk-actions"><Button size="sm" onClick={() => onReviseHunk(group.hunkId!)}>Revise</Button><Button size="sm" tone="danger" onClick={() => { const reason = prompt('Why reject this change? (optional)', ''); if (reason !== null) void act(() => post(`/api/proposals/${runId}/reject-changes`, { changeId: change.id, hunkIds: [group.hunkId], reason }), 'Change rejected') }}>Reject change</Button><Button size="sm" tone="primary" onClick={() => beforeAccept() && void act(() => post(`/api/proposals/${runId}/accept`, { scope: 'hunk', changeId: change.id, hunkId: group.hunkId, ...(change.changedDuringRun ? { confirmChangedDuringRun: true } : {}) }), 'Change accepted')}>Accept change</Button></span>}
        {group.hunkId && change.hunks.find((hunk) => hunk.id === group.hunkId)?.rejectionReason && <small>{change.hunks.find((hunk) => hunk.id === group.hunkId)?.rejectionReason}</small>}
        {group.hunkId && group.state !== 'pending' && <Badge tone={statusTone(group.state ?? '')}>{group.state ?? 'resolved'}</Badge>}
      </header>
      <div class="diff-lines">{group.rows.map((row, rowIndex) => <DiffLine key={rowIndex} row={row} />)}</div>
    </section>)}
  </div>
}

export function ProposalRationaleDrawer({ change, onClose }: { change: ProposalChange; onClose: () => void }) {
  const rationale = change.rationale
  const claims = [...rationale.claims.added, ...rationale.claims.changed, ...rationale.claims.removed]
  return <div class="proposal-drawer-scrim" role="presentation" onClick={(event) => event.target === event.currentTarget && onClose()}>
    <aside class="proposal-rationale-drawer" role="dialog" aria-modal="true" aria-labelledby="proposal-rationale-title">
      <header><span><small>Why this change</small><h2 id="proposal-rationale-title">{change.title}</h2><code>{change.path}</code></span><button type="button" aria-label="Close rationale" onClick={onClose}><Icon name="close" size={17} /></button></header>
      <div class="proposal-drawer-body">
        <section class="rationale-lead"><Badge tone={statusTone(rationale.confidence)}>{rationale.confidence.replace('-', ' ')}</Badge><p>{rationale.reason}</p></section>
        <section><h3>Supporting evidence</h3>{rationale.evidence.length > 0 ? <div class="rationale-evidence-list">{rationale.evidence.map((item, index) => <article key={index} class={!item.available ? 'unavailable' : ''}><Icon name="link" size={14} /><span><strong>{item.source}</strong><code>{item.path ?? item.operation ?? 'Configured source'}</code>{item.revision && <small>Revision {item.revision.slice(0, 12)}</small>}{!item.available && <small>Unavailable in this environment</small>}</span></article>)}</div> : <p class="muted-copy">No precise source reference was recorded. Review this change manually before acceptance.</p>}</section>
        {claims.length > 0 && <section><h3>Reader-facing claims</h3><ul>{claims.map((claim) => <li key={claim}>{claim}</li>)}</ul></section>}
        {rationale.affectedInterfaces.length > 0 && <section><h3>Public interfaces affected</h3><div class="rationale-tags">{rationale.affectedInterfaces.map((item) => <span key={item}>{item}</span>)}</div></section>}
        <section class="rationale-validation"><h3>Checks</h3><p><Icon name="check" size={14} /> {rationale.validation.errors} errors · {rationale.validation.warnings} warnings</p><small>{rationale.authorship === 'human' ? 'Edited by a reviewer' : rationale.planId ? `From approved plan ${rationale.planId}` : 'Generated from the review request'}</small></section>
        {rationale.assumptions.length > 0 && <details><summary>Assumptions to verify</summary><ul>{rationale.assumptions.map((item) => <li key={item}>{item}</li>)}</ul></details>}
      </div>
    </aside>
  </div>
}

function DiffLine({ row }: { row: DiffRow }) {
  if (row.type === 'gap') return <div class="diff-line gap"><span /><span /><b /><code>{row.hidden} unchanged lines</code></div>
  const sign = row.type === 'insert' ? '+' : row.type === 'delete' ? '−' : ' '
  return <div class={`diff-line ${row.type}`}><span>{row.oldNumber ?? ''}</span><span>{row.newNumber ?? ''}</span><b>{sign}</b><code dangerouslySetInnerHTML={{ __html: row.html || ' ' }} /></div>
}

function diffGroups(rows: DiffRow[]): Array<{ hunkId?: string; state?: string; rows: DiffRow[] }> {
  const groups: Array<{ hunkId?: string; state?: string; rows: DiffRow[] }> = []
  for (const row of rows) {
    const last = groups.at(-1)
    if (last && last.hunkId === row.hunkId) last.rows.push(row)
    else groups.push({ ...(row.hunkId ? { hunkId: row.hunkId } : {}), ...(row.hunkState ? { state: row.hunkState } : {}), rows: [row] })
  }
  return groups
}

function statusTone(status: string): string {
  if (['verified', 'accepted', 'added'].includes(status)) return 'good'
  if (['pending', 'modified', 'inferred'].includes(status)) return 'info'
  if (status === 'needs-human') return 'warn'
  if (['rejected', 'deleted'].includes(status)) return 'bad'
  return 'neutral'
}
