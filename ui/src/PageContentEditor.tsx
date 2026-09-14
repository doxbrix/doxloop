import type { ComponentChildren } from 'preact'
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { api, post, put } from './api'
import { Button, Segmented } from './components'
import { applyBlockEdits, type EditableBlock } from './page-content-edits'

interface Content { content: string; fingerprint: string }
interface Preview { url: string; blocks: EditableBlock[] }

export function PageContentEditor({ root, path, editing, native, base, focusLine, refreshToken, onEditingChange, onStatus, onChanged, children }: {
  root: string; path: string; editing: boolean; native: boolean; base: string; focusLine: number; refreshToken: number
  onEditingChange: (editing: boolean) => void; onStatus: (dirty: boolean, busy: boolean) => void
  onChanged: () => Promise<void>; children: ComponentChildren
}) {
  const key = `doxloop:text-draft:${root}:live:${path}`
  const [saved, setSaved] = useState<Content>()
  const [draft, setDraft] = useState<Content>()
  const [mode, setMode] = useState<'visual' | 'source'>(native && !focusLine ? 'visual' : 'source')
  const [preview, setPreview] = useState<Preview>()
  const [rendering, setRendering] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [latest, setLatest] = useState<Content>()
  const [preserveEvidence, setPreserveEvidence] = useState(false)
  const [undoId, setUndoId] = useState('')
  const frame = useRef<HTMLIFrameElement>(null)
  const source = useRef<HTMLTextAreaElement>(null)
  const renderedContent = useRef('')
  const blockEdits = useRef(new Map<number, string>())
  const dirty = Boolean(draft && saved && draft.content !== saved.content)
  const locked = dirty || busy

  useEffect(() => {
    let active = true
    api<Content>(`/api/pages/content?path=${encodeURIComponent(path)}`).then(value => {
      if (!active) return
      setSaved(value)
      let restored: Content | null = null
      try { restored = JSON.parse(sessionStorage.getItem(key) ?? 'null') } catch { /* Draft storage is optional. */ }
      if (restored && typeof restored.content === 'string' && typeof restored.fingerprint === 'string') {
        setDraft(restored); onEditingChange(true); setNotice('Your unsaved draft was restored.')
        if (restored.fingerprint !== value.fingerprint) { setLatest(value); setError('The page changed since this draft. Compare before saving.') }
      } else setDraft(value)
    }).catch(cause => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [key, refreshToken])

  useLayoutEffect(() => { onStatus(dirty, busy) }, [dirty, busy])
  useEffect(() => {
    const guard = (event: BeforeUnloadEvent) => { if (locked) { event.preventDefault(); event.returnValue = '' } }
    addEventListener('beforeunload', guard)
    return () => removeEventListener('beforeunload', guard)
  }, [locked])
  useEffect(() => {
    if (!focusLine) return
    setMode('source'); onEditingChange(true)
  }, [focusLine])
  useLayoutEffect(() => {
    if (!focusLine || !draft || mode !== 'source' || !source.current) return
    const lines = draft.content.split('\n')
    const offset = lines.slice(0, Math.max(0, focusLine - 1)).reduce((sum, line) => sum + line.length + 1, 0)
    source.current.focus(); source.current.setSelectionRange(offset, offset + (lines[focusLine - 1]?.length ?? 0))
  }, [focusLine, mode, saved?.fingerprint, Boolean(draft)])

  // Render on entry to visual mode, not on each keystroke: the iframe retains caret and scroll.
  useEffect(() => {
    if (!editing || mode !== 'visual' || !draft || !base) return
    let active = true
    setRendering(true); setPreview(undefined)
    post<Preview>('/api/pages/editor-preview', { path, content: draft.content, base }).then(value => {
      if (!active) return
      renderedContent.current = draft.content; blockEdits.current.clear(); setPreview(value)
    }).catch(cause => { if (active) { setError(cause.message); setMode('source') } })
      .finally(() => { if (active) setRendering(false) })
    return () => { active = false }
  }, [editing, mode, Boolean(draft), saved?.fingerprint, base])

  useEffect(() => { frame.current?.contentWindow?.postMessage({ type: 'doxloop:editor-lock', locked: busy }, '*') }, [busy])

  const remember = (content: string) => {
    if (!draft) return
    const next = { ...draft, content }
    setDraft(next)
    try { sessionStorage.setItem(key, JSON.stringify(next)) }
    catch { setNotice('Draft storage is unavailable. Keep this page open until you save.') }
  }
  const forget = () => { try { sessionStorage.removeItem(key) } catch { /* Save does not depend on storage. */ } }
  const run = async (work: () => Promise<void>) => {
    if (busy) return
    setBusy(true); setError('')
    try { await work() } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setBusy(false) }
  }
  const save = () => run(async () => {
    if (!draft || !dirty || latest) return
    const result = await put<Content & { editId: string }>('/api/pages/content', { path, ...draft, evidenceDisposition: preserveEvidence ? 'preserved' : 'needs-review' })
    setSaved(result); setDraft(result); setUndoId(result.editId); forget(); onEditingChange(false)
    setNotice('Page saved locally. Not published.'); await onChanged()
  })
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !editing || busy || !preview) return
      if (event.data?.type === 'doxloop:save-draft') { void save(); return }
      const change = event.data
      if (change?.type !== 'doxloop:edit-block' || typeof change.text !== 'string' || change.text.length > 500_000) return
      if (!preview.blocks.some(block => block.start === change.start && block.end === change.end)) return
      blockEdits.current.set(change.start, change.text)
      try { remember(applyBlockEdits(renderedContent.current, preview.blocks, blockEdits.current)) }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
    }
    addEventListener('message', receive)
    return () => removeEventListener('message', receive)
  }, [editing, busy, preview, draft, latest])

  return <div class="page-content-editor">
    {error && <div class="page-editor-notice error" role="alert"><span>{error}</span>{draft && <Button size="sm" disabled={busy} onClick={() => void run(async () => setLatest(await api<Content>(`/api/pages/content?path=${encodeURIComponent(path)}`)))}>Compare saved version</Button>}</div>}
    {notice && <div class="page-editor-notice" role="status"><span>{notice}</span>{undoId && <Button size="sm" disabled={busy || dirty} onClick={() => void run(async () => {
      await post(`/api/direct-edits/${undoId}/undo`)
      const value = await api<Content>(`/api/pages/content?path=${encodeURIComponent(path)}`)
      setSaved(value); setDraft(value); setUndoId(''); setPreview(undefined); onEditingChange(false); setNotice('Saved edit undone.'); await onChanged()
    })}>Undo saved edit</Button>}<Button size="sm" tone="ghost" onClick={() => setNotice('')}>Dismiss</Button></div>}
    {editing && <>
      <div class="page-editor-toolbar">
        <Segmented value={mode} onChange={setMode} items={native ? [['visual', 'Content'], ['source', 'Edit source']] as const : [['source', 'Edit source']] as const} />
        <span role="status">{busy ? 'Saving…' : dirty ? 'Unsaved changes' : 'Editing content'}</span>
        <Button size="sm" disabled={busy || !saved} onClick={() => { setDraft(saved); forget(); setLatest(undefined); setError(''); onEditingChange(false) }}>Discard</Button>
        <Button size="sm" tone="primary" disabled={busy || !dirty || Boolean(latest)} onClick={() => void save()}>Save changes</Button>
      </div>
      <div class="page-editor-hint">{mode === 'visual' ? 'Click outlined text to edit, including lists, links, and tables. Use Edit source for link destinations or component settings.' : 'Edit the page in its native source format. Save to refresh the site preview.'}<details><summary>Evidence settings</summary><label><input type="checkbox" checked={preserveEvidence} onChange={event => setPreserveEvidence(event.currentTarget.checked)} /> Wording only — the recorded evidence is still valid.</label><small>Other changes are marked for evidence review.</small></details></div>
      {latest && <section class="page-editor-conflict"><h3>Latest saved version</h3><pre>{latest.content}</pre><Button disabled={busy} onClick={() => { setSaved(latest); setDraft(latest); forget(); setLatest(undefined); setError(''); setMode('source') }}>Discard draft and use saved version</Button><Button disabled={busy} onClick={() => { if (draft) { const next = { content: draft.content, fingerprint: latest.fingerprint }; setSaved(latest); setDraft(next); try { sessionStorage.setItem(key, JSON.stringify(next)) } catch { /* Optional storage. */ } setLatest(undefined); setError(''); setNotice('Compared version selected. Check your draft before saving.') } }}>Keep my draft against this version</Button></section>}
      {!draft ? <div class="preview-placeholder">Loading page source…</div> : mode === 'source'
        ? <textarea ref={source} class="page-source-editor" aria-label="Page source" spellcheck={false} disabled={busy} value={draft.content} onInput={event => remember(event.currentTarget.value)} onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key === 's') { event.preventDefault(); void save() } }} />
        : rendering || !preview ? <div class="preview-placeholder">{base ? 'Preparing editable preview…' : 'Waiting for the site preview. You can use Edit source now.'}</div>
          : <>{preview.blocks.length === 0 && <div class="page-editor-notice">This page has no editable text regions. Use Edit source to change its content.</div>}<iframe ref={frame} title="Editable page preview" sandbox="allow-scripts" src={preview.url} /></>}
    </>}
    {!editing && children}
  </div>
}
