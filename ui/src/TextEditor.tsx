import { useEffect, useState, useRef } from 'preact/hooks'
import { api, patch, post, put } from './api'
import './TextEditor.css'

interface Content { path: string; content: string; fingerprint: string }
interface Draft { content: string; fingerprint: string }
export function TextEditor({ root, path, proposal, refreshToken, focusLine, onChanged }: { root: string; path: string; refreshToken?: number; focusLine?: number; proposal?: { id: string; changeId: string }; onChanged: () => Promise<void> }) {
  const textarea = useRef<HTMLTextAreaElement>(null)
  const details = useRef<HTMLDetailsElement>(null)
  const endpoint = proposal ? `/api/proposals/${proposal.id}/changes/${proposal.changeId}/content` : `/api/pages/content?path=${encodeURIComponent(path)}`
  const key = `doxloop:text-draft:${root}:${proposal?.id ?? 'live'}:${path}`
  const [saved, setSaved] = useState<Content>()
  const [draft, setDraft] = useState<Draft>()
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [html, setHtml] = useState('')
  const [busy, setBusy] = useState(false)
  const [compare, setCompare] = useState(false)
  const [preserveEvidence, setPreserveEvidence] = useState(false)
  const [undoId, setUndoId] = useState('')
  const [proposalBefore, setProposalBefore] = useState<Content>()
  useEffect(() => {
    let active = true
    void api<Content>(endpoint).then((value) => {
      if (!active) return
      setSaved(value)
      let restored: Draft | undefined
      try { restored = JSON.parse(sessionStorage.getItem(key) ?? 'null') as Draft | undefined } catch { /* Storage may be unavailable. */ }
      setDraft(restored?.content !== undefined && restored.fingerprint ? restored : value)
      if (restored) setNotice('Your unsaved draft was restored.')
      if (restored && restored.fingerprint !== value.fingerprint) { setCompare(true); setError('The saved page changed since this draft. Compare both versions before saving.') }
    }).catch((cause: Error) => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [endpoint, key, refreshToken])
  useEffect(() => {
    if (!focusLine || !draft || !textarea.current || !details.current) return
    details.current.open = true
    const lines = draft.content.split('\n')
    const offset = lines.slice(0, Math.max(0, focusLine - 1)).reduce((sum, line) => sum + line.length + 1, 0)
    textarea.current.focus(); textarea.current.setSelectionRange(offset, offset + (lines[focusLine - 1]?.length ?? 0)); textarea.current.scrollTop = Math.max(0, focusLine - 4) * 20
  }, [focusLine, saved?.fingerprint])
  const dirty = Boolean(draft && saved && draft.content !== saved.content)
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (dirty) { event.preventDefault(); event.returnValue = '' } }
    addEventListener('beforeunload', guard)
    return () => removeEventListener('beforeunload', guard)
  }, [dirty])
  const remember = (next: Draft) => { setDraft(next); setHtml(''); try { sessionStorage.setItem(key, JSON.stringify(next)) } catch { setNotice('Browser draft storage is unavailable; keep this tab open until you save.') } }
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  const save = () => run(async () => {
    if (!draft) return
    const body = { path, ...draft, evidenceDisposition: preserveEvidence ? 'preserved' : 'needs-review' }
    if (proposal) setProposalBefore(saved)
    const result = proposal ? await patch<{ editId?: string }>(endpoint, body) : await put<{ editId?: string }>('/api/pages/content', body)
    const current = await api<Content>(endpoint)
    setSaved(current); setDraft(current); setCompare(false); setUndoId(result.editId ?? '')
    try { sessionStorage.removeItem(key) } catch { /* Saved successfully. */ }
    setNotice(proposal ? 'Proposed text saved. Review the updated diff before accepting.' : 'Page saved. The preview and evidence status have been updated.')
    await onChanged()
  })
  return <details ref={details} class="text-editor">
    <summary>Edit text directly <small>Save without running an agent</small></summary>
    <div class="text-editor-body">
      {error && <p role="alert" class="text-editor-error">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {draft && <>
        <label class="text-editor-label">Page source<textarea ref={textarea} disabled={busy} aria-label="Page source" spellcheck={false} value={draft.content} onInput={(event) => remember({ ...draft, content: event.currentTarget.value })} onKeyDown={(event) => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); if (!busy) void save() } }} /></label>
        <label><input type="checkbox" checked={preserveEvidence} onChange={(event) => setPreserveEvidence(event.currentTarget.checked)} /> This only changes wording; the recorded evidence is still valid.</label>
        <p class="text-editor-hint">Otherwise the page is marked for evidence review. Markdown preview approximates native components; use the site preview for final checks.</p>
        <div class="text-editor-actions">
          <button type="button" class="button" disabled={busy || !dirty} onClick={() => void save()}>{busy ? 'Working…' : proposal ? 'Save proposed text' : 'Save page'}</button>
          <button type="button" class="button" disabled={busy} onClick={() => void run(async () => setHtml((await post<{ html: string }>('/api/pages/preview', { content: draft.content })).html))}>Preview draft</button>
          <button type="button" class="button" disabled={busy} onClick={() => void run(async () => { setSaved(await api<Content>(endpoint)); setCompare(true) })}>Compare saved version</button>
          {proposal && proposalBefore && saved && <button type="button" class="button" disabled={busy || dirty} onClick={() => void run(async () => { await patch(endpoint, { content: proposalBefore.content, fingerprint: saved.fingerprint, evidenceDisposition: 'needs-review' }); const current = await api<Content>(endpoint); setSaved(current); setDraft(current); setProposalBefore(undefined); setNotice('Proposed text edit undone. Evidence still requires review.'); await onChanged() })}>Undo proposed text edit</button>}
          {undoId && <button type="button" class="button" disabled={busy} onClick={() => void run(async () => { await post(`/api/direct-edits/${undoId}/undo`); const current = await api<Content>(endpoint); setSaved(current); setDraft(current); setUndoId(''); setNotice('Saved edit undone.'); await onChanged() })}>Undo saved edit</button>}
        </div>
        {compare && saved && <section class="text-editor-compare"><h3>Latest saved version</h3><pre>{saved.content}</pre><button type="button" class="button" onClick={() => { remember(saved); setError(''); setCompare(false) }}>Discard draft and use saved version</button>{draft.fingerprint !== saved.fingerprint && <button type="button" class="button" onClick={() => { remember({ ...draft, fingerprint: saved.fingerprint }); setError(''); setNotice('Your draft now replaces the compared version when you save. Check the full text first.') }}>Use my draft to replace this version</button>}</section>}
        {html && <iframe title="Unsaved text preview" sandbox="" srcDoc={html} />}
      </>}
    </div>
  </details>
}

export function PageTools({ root, path, contentDir, onChanged }: { root: string; path?: string; contentDir: string; onChanged: (path?: string) => Promise<void> }) {
  const [action, setAction] = useState<'create' | 'rename' | 'delete'>('create')
  const [destination, setDestination] = useState('')
  const [title, setTitle] = useState('')
  const [replacement, setReplacement] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [edits, setEdits] = useState<Array<{ id: string; requestText: string; status: string }>>([])
  const [notice, setNotice] = useState('')
  const [undoId, setUndoId] = useState('')
  const [loaded, setLoaded] = useState<Content>()
  useEffect(() => { setLoaded(undefined); if (path) void api<Content>(`/api/pages/content?path=${encodeURIComponent(path)}`).then(setLoaded).catch((cause: Error) => setError(cause.message)) }, [root, path])
  const run = async (work: () => Promise<void>) => { setBusy(true); setError(''); try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) } finally { setBusy(false) } }
  return <details class="text-editor page-tools" onToggle={(event) => { if (event.currentTarget.open && path) void api<Content>(`/api/pages/content?path=${encodeURIComponent(path)}`).then(setLoaded).catch((cause: Error) => setError(cause.message)) }}><summary>Manage pages <small>Create, move, delete, or undo changes</small></summary><div class="text-editor-body">
    {error && <p role="alert" class="text-editor-error">{error}</p>}{notice && <p role="status">{notice}</p>}
    <label>Page operation<select aria-label="Page operation" value={action} onChange={(event) => setAction(event.currentTarget.value as typeof action)}><option value="create">Create page</option><option value="rename" disabled={!path}>Rename / move selected page</option><option value="delete" disabled={!path}>Delete selected page</option></select></label>
    {action !== 'create' && <p>Selected page: <code>{path}</code></p>}
    {action !== 'delete' && <label>New page path<input aria-label="New page path" placeholder={`${contentDir ? `${contentDir}/` : ''}guides/new-page.md`} value={destination} onInput={(event) => setDestination(event.currentTarget.value)} /></label>}
    {action === 'create' && <label>New page title<input aria-label="New page title" value={title} onInput={(event) => setTitle(event.currentTarget.value)} /></label>}
    {action === 'delete' && <label>Replacement page (required when other pages link here)<input aria-label="Replacement page" value={replacement} onInput={(event) => setReplacement(event.currentTarget.value)} /></label>}
    <p class="text-editor-hint">Moves update links, navigation, and evidence together. Existing public URLs are preserved or redirected. Custom navigation that cannot be changed safely is left for an agent proposal.</p>
    <div class="text-editor-actions"><button type="button" class="button" disabled={busy || (action !== 'delete' && !destination.trim()) || (action !== 'create' && !loaded)} onClick={() => void run(async () => {
      const result = await post<{ path?: string; editId: string }>('/api/pages/lifecycle', { action, path: action === 'create' ? destination.trim() : path, fingerprint: loaded?.fingerprint, to: destination.trim(), title, replacement: replacement.trim() })
      setUndoId(result.editId); setNotice('Page operation saved. Undo is available.'); setDestination(''); setEdits([]); await onChanged(result.path)
    })}>{busy ? 'Working…' : action === 'create' ? 'Create page' : action === 'rename' ? 'Move page' : 'Delete page'}</button>
    {undoId && <button type="button" class="button" disabled={busy} onClick={() => void run(async () => { await post(`/api/direct-edits/${undoId}/undo`); setUndoId(''); setNotice('Page operation undone.'); await onChanged() })}>Undo page operation</button>}
    <button type="button" class="button" onClick={() => void run(async () => setEdits(await api('/api/direct-edits')))}>Recent direct edits</button></div>
    {edits.length > 0 && <ul>{edits.slice(0, 20).map((edit) => <li key={edit.id}>{edit.requestText} · {edit.status} {edit.status === 'completed' && <button type="button" disabled={busy} onClick={() => void run(async () => { await post(`/api/direct-edits/${edit.id}/undo`); setEdits(await api('/api/direct-edits')); await onChanged() })}>Undo</button>}</li>)}</ul>}
  </div></details>
}
