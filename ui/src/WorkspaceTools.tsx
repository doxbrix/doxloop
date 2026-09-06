import { useEffect, useState } from 'preact/hooks'
import { api, post, put } from './api'
import type { ProposalChange } from './types'

type Comment = { id: string; path: string; text: string; createdAt: string; proposalId?: string; changeId?: string; hunkId?: string; resolvedAt?: string }
export function Comments({ path, proposal, onRequest }: { path: string; proposal?: { id: string; change: ProposalChange }; onRequest: (text: string, hunkId?: string) => Promise<void> }) {
  const [comments, setComments] = useState<Comment[]>([])
  const [text, setText] = useState('')
  const [hunkId, setHunkId] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => { let current = true; api<Comment[]>('/api/comments').then((items) => { if (current) { if (!Array.isArray(items)) throw new Error('Comments could not be loaded. Reload to try again.'); setComments(items) } }).catch((cause) => { if (current) setError(cause.message) }); return () => { current = false } }, [path, proposal?.id])
  const work = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn() } catch (cause) { setError(String(cause)) } finally { setBusy(false) } }
  return <details class="text-editor"><summary>Comments and agent requests</summary><div class="text-editor-body">
    {error && <p role="alert">{error}</p>}
    {comments.filter((item) => item.path === path && item.proposalId === proposal?.id).map((item) => <article key={item.id}>
      <small>{new Date(item.createdAt).toLocaleString()}{item.hunkId ? ` · Hunk ${item.hunkId.slice(0, 8)}` : ''}{item.resolvedAt ? ' · Resolved' : ''}</small><p style={{ whiteSpace: 'pre-wrap' }}>{item.text}</p>
      {!item.resolvedAt && <div class="text-editor-actions"><button disabled={busy} onClick={() => void work(() => onRequest(item.text, item.hunkId))}>Ask agent to address</button><button disabled={busy} onClick={() => void work(async () => setComments(await post<Comment[]>('/api/comments', { resolveId: item.id })))}>Resolve comment</button></div>}
    </article>)}
    {proposal && <label>Comment scope<select value={hunkId} onChange={(event) => setHunkId(event.currentTarget.value)}><option value="">Whole file</option>{proposal.change.hunks.map((hunk, index) => <option value={hunk.id}>Hunk {index + 1}</option>)}</select></label>}
    <label>Comment<textarea aria-label="Comment" maxLength={8000} value={text} onInput={(event) => setText(event.currentTarget.value)} /></label>
    <button disabled={busy || !text.trim()} onClick={() => void work(async () => { setComments(await post<Comment[]>('/api/comments', { path, text, ...(proposal ? { proposalId: proposal.id, changeId: proposal.change.id } : {}), ...(hunkId ? { hunkId } : {}) })); setText('') })}>Save comment</button>
  </div></details>
}

export function BulkMetadata({ paths, onChanged }: { paths: string[]; onChanged: () => Promise<void> }) {
  const [field, setField] = useState('description')
  const [value, setValue] = useState('')
  const [prepared, setPrepared] = useState<Array<{ path: string; fingerprint: string; fields: Record<string, string | null> }>>()
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => setPrepared(undefined), [paths.join('|'), field, value])
  const work = async (fn: () => Promise<void>) => { setBusy(true); try { await fn() } catch (cause) { setMessage(String(cause)) } finally { setBusy(false) } }
  return <details class="text-editor"><summary>Bulk metadata · {paths.length} selected pages</summary><div class="text-editor-body">
    <label>Field<select value={field} onChange={(event) => setField(event.currentTarget.value)}>{['description', 'icon', 'socialImage', 'canonical'].map((item) => <option>{item}</option>)}</select></label>
    <label>Value<input value={value} onInput={(event) => setValue(event.currentTarget.value)} /></label><p>Review the selected paths before saving. Empty optional fields are cleared. All pages save together; any conflict stops the entire batch.</p>
    {prepared && <ul>{prepared.map((item) => <li>{item.path}: {field} → {value || '(clear)'}</li>)}</ul>}
    <p role="status">{message}</p><button disabled={busy || !paths.length} onClick={() => void work(async () => { const writes = await Promise.all(paths.map(async (path) => { const metadata = await api<{ editable: boolean; reason?: string; fingerprint: string }>(`/api/pages/metadata?path=${encodeURIComponent(path)}`); if (!metadata.editable) throw new Error(metadata.reason); return { path, fingerprint: metadata.fingerprint, fields: { [field]: value || null } } })); setPrepared(writes); setMessage('Review this batch, then save.') })}>Preview batch</button>
    {prepared && <button disabled={busy} onClick={() => void work(async () => { await put('/api/pages/bulk-metadata', { writes: prepared }); setPrepared(undefined); setMessage('Batch saved. Use Recent direct edits to undo it.'); await onChanged() })}>Save metadata batch</button>}
  </div></details>
}

export function AuditTools({ onChanged }: { onChanged: () => Promise<void> }) {
  const [audit, setAudit] = useState<{ generator: string; contentDir: string; pages: Array<{ path: string; route: string }>; unmapped: string[]; unverified: string[]; drift: { status: string; pages: unknown[]; notes: string[] }; message: string }>()
  const [enabled, setEnabled] = useState(false)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const work = async (fn: () => Promise<void>) => { setBusy(true); try { await fn() } catch (cause) { setMessage(String(cause)) } finally { setBusy(false) } }
  return <details class="text-editor"><summary>Audit existing documentation and reader verification</summary><div class="text-editor-body">
    <button disabled={busy} onClick={() => void work(async () => { setAudit(await api('/api/audit')); setEnabled((await api<{ enabled: boolean }>('/api/reader-verification')).enabled) })}>Run read-only audit</button>
    {audit && <><p>{audit.generator} · {audit.contentDir || 'project root'} · {audit.pages.length} pages · {audit.drift.pages.length} stale · {audit.unverified.length} unverified · {audit.unmapped.length} unmapped</p><p>{audit.message}</p>{audit.drift.notes.map((note) => <p>{note}</p>)}<details><summary>Recognized page routes</summary><ul>{audit.pages.map((page) => <li>{page.path} → {page.route}</li>)}</ul></details>
      <button disabled={busy || !audit.unmapped.length} onClick={() => void work(async () => { await post('/api/audit/backfill'); setAudit(await api('/api/audit')); await onChanged() })}>Backfill missing evidence entries only</button>
      <label><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => { const next = event.currentTarget.checked; void work(async () => { await put('/api/reader-verification', { enabled: next }); setEnabled(next); await onChanged() }) }} /> Show reader verification labels in the Doxbrix reader</label><p>Labels report evidence state and recorded revisions. Native generators retain their own reader templates.</p>
    </>}<p role="status">{message}</p>
  </div></details>
}

export function Estimate({ pages, agent, model }: { pages: number; agent?: string | undefined; model?: string | undefined }) {
  const [estimate, setEstimate] = useState<{ samples: number; range?: { minimumMinutes: number; maximumMinutes: number }; message: string; cost: string }>()
  useEffect(() => { let current = true; api<typeof estimate>(`/api/authoring-estimate?pages=${pages}&agent=${encodeURIComponent(agent ?? '')}&model=${encodeURIComponent(model ?? '')}`).then((value) => { if (current) setEstimate(value) }).catch(() => {}); return () => { current = false } }, [pages, agent, model])
  return estimate ? <p class="text-editor-hint">{estimate.range ? `Observed range: ${estimate.range.minimumMinutes}–${estimate.range.maximumMinutes} minutes (${estimate.samples} runs). ` : ''}{estimate.message} {estimate.cost}</p> : null
}

export function Collections({ onChanged, onTranslate }: { onChanged: () => Promise<void>; onTranslate: (paths: string[], locale: string) => Promise<void> }) {
  const [items, setItems] = useState<Array<{ directory: string; version: string; locale: string }>>([])
  const [source, setSource] = useState('')
  const [version, setVersion] = useState('')
  const [locale, setLocale] = useState('default')
  const [created, setCreated] = useState<string[]>([])
  const [targetLocale, setTargetLocale] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const work = async (fn: () => Promise<void>) => { setBusy(true); try { await fn() } catch (cause) { setMessage(String(cause)) } finally { setBusy(false) } }
  return <details class="text-editor" onToggle={(event) => { if (event.currentTarget.open) void work(async () => { const result = await api<typeof items>('/api/collections'); setItems(result); setSource(result[0]?.directory ?? '') }) }}><summary>Versions and languages</summary><div class="text-editor-body">
    <p>Create a separate documentation snapshot or translation draft. Copied pages retain source associations and require fresh verification. Docusaurus uses native version and locale directories; Doxbrix and MkDocs expose named collections in navigation.</p>
    <ul>{items.map((item) => <li>{item.version} · {item.locale} · {item.directory || 'project root'}</li>)}</ul>
    <label>Copy from<select value={source} onChange={(event) => setSource(event.currentTarget.value)}>{items.map((item) => <option value={item.directory}>{item.version} · {item.locale}</option>)}</select></label>
    <label>Version<input value={version} placeholder="1.0 or current" onInput={(event) => setVersion(event.currentTarget.value)} /></label>
    <label>Locale<input value={locale} placeholder="default or fr" onInput={(event) => setLocale(event.currentTarget.value)} /></label>
    <button disabled={busy || !version || !locale} onClick={() => void work(async () => { const result = await post<{ pages: string[]; message: string }>('/api/collections', { sourceDirectory: source, version, locale }); setCreated(result.pages); setTargetLocale(locale); setMessage(result.message); setItems(await api('/api/collections')); await onChanged() })}>Create collection</button>
    {created.length > 0 && targetLocale !== 'default' && <button disabled={busy} onClick={() => void work(async () => { await onTranslate(created, targetLocale); setMessage('Translation proposal started. Review it before accepting.') })}>Ask agent to translate copied pages</button>}
    <p role="status">{message}</p><p>Use Pages to edit and review each collection. Recent direct edits can undo collection creation while its files remain unchanged.</p>
  </div></details>
}
