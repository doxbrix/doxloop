import { useEffect, useState } from 'preact/hooks'
import { api, post, put } from './api'
import { AssetPicker } from './AssetLibrary'
import { Button, Combo, Field, Input, Note, Panel, Select, Textarea } from './components'
import { Icon } from './icons'
import type { GlossaryState, GlossaryTerm, PageMetadata, PageMetadataField, SourceRefs } from './types'

type Action = <T>(run: () => Promise<T>, success?: string, reload?: boolean) => Promise<T | undefined>

/**
 * Title, description, sidebar icon, and the SEO fields the Doxbrix preview
 * and static build render. Written straight to the page's frontmatter with
 * validation and rollback; no agent run.
 */
export function PageMetadataForm({ path, act, onError, onSaved }: { path: string; act: Action; onError: (error: string) => void; onSaved: () => void }) {
  const [metadata, setMetadata] = useState<PageMetadata>()
  const [form, setForm] = useState<Record<PageMetadataField, string>>({ title: '', description: '', canonical: '', socialImage: '', icon: '' })
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [picker, setPicker] = useState(false)
  const load = async () => {
    try {
      const raw = await api<PageMetadata>(`/api/pages/metadata?path=${encodeURIComponent(path)}`)
      const next: PageMetadata = { ...raw, fields: raw.fields ?? {}, otherKeys: raw.otherKeys ?? [] }
      setMetadata(next)
      setForm({ title: next.fields.title ?? '', description: next.fields.description ?? '', canonical: next.fields.canonical ?? '', socialImage: next.fields.socialImage ?? '', icon: next.fields.icon ?? '' })
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => { setMetadata(undefined); if (open) void load() }, [path, open])
  const saved = metadata ? { title: metadata.fields.title ?? '', description: metadata.fields.description ?? '', canonical: metadata.fields.canonical ?? '', socialImage: metadata.fields.socialImage ?? '', icon: metadata.fields.icon ?? '' } : form
  const changed = (Object.keys(form) as PageMetadataField[]).filter((field) => form[field] !== saved[field])
  const save = async () => {
    if (!metadata || changed.length === 0) return
    setSaving(true)
    try {
      const fields: Partial<Record<PageMetadataField, string | null>> = {}
      for (const field of changed) fields[field] = form[field] || null
      const next = await act(() => put<PageMetadata>('/api/pages/metadata', { path, fingerprint: metadata.fingerprint, fields }), 'Page metadata saved', false)
      if (next) { setMetadata(next); onSaved() }
    } finally { setSaving(false) }
  }
  return <section class="page-metadata">
    {picker && <AssetPicker act={act} title="Choose the social image" onClose={() => setPicker(false)} onPick={(asset) => { setForm({ ...form, socialImage: asset.publicPath }); setPicker(false) }} />}
    <button type="button" class="page-metadata-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
      <Icon name="braces" size={15} /><span>Page metadata</span><small>Title, description, icon, canonical URL, social image</small><Icon name={open ? 'chevronUp' : 'chevronDown'} size={15} />
    </button>
    {open && (!metadata ? <div class="page-list-empty"><span class="spinner" />Loading metadata…</div> : !metadata.editable ? <Note>{metadata.reason}</Note> : <div class="page-metadata-body">
      <div class="form-grid">
        <Field label="Title"><Input value={form.title} maxlength={160} onInput={(event) => setForm({ ...form, title: event.currentTarget.value })} /></Field>
        <Field label="Sidebar icon" hint="An icon name or a single emoji"><Input value={form.icon} placeholder="compass" onInput={(event) => setForm({ ...form, icon: event.currentTarget.value })} /></Field>
        <Field label="Description" hint="One outcome-focused sentence; shown in search results and page cards" wide><Textarea rows={2} maxlength={320} value={form.description} onInput={(event) => setForm({ ...form, description: event.currentTarget.value })} /></Field>
        <Field label="Canonical URL" hint="Only when this page is also published elsewhere"><Input value={form.canonical} placeholder="https://docs.example.com/guides/install" onInput={(event) => setForm({ ...form, canonical: event.currentTarget.value })} /></Field>
        <Field label="Social image" hint="Shown when the page is shared. PNG or JPEG, 1200×630 works best."><span class="asset-field"><Input aria-label="Social image" value={form.socialImage} placeholder="/assets/social.png" onInput={(event) => setForm({ ...form, socialImage: event.currentTarget.value })} /><Button size="sm" onClick={() => setPicker(true)}>Choose…</Button></span></Field>
      </div>
      {metadata.otherKeys.length > 0 && <small class="page-metadata-other">Other frontmatter kept as is: {metadata.otherKeys.join(', ')}.</small>}
      <div class="form-actions"><Button size="sm" tone="ghost" disabled={changed.length === 0} onClick={() => setForm(saved)}>Discard</Button><Button size="sm" tone="primary" busy={saving} disabled={changed.length === 0} onClick={() => void save()}>Save metadata</Button></div>
    </div>)}
  </section>
}

/** Rows of term and definition; the structured form behind the brief's terminology map. */
export function TermsEditor({ value, onChange, disabled }: { value: GlossaryTerm[]; onChange: (terms: GlossaryTerm[]) => void; disabled?: boolean }) {
  const update = (index: number, patch: Partial<GlossaryTerm>) => onChange(value.map((entry, item) => (item === index ? { ...entry, ...patch } : entry)))
  return <div class="terms-editor">
    {value.length === 0 && <p class="terms-empty">No terms yet. Add the product vocabulary readers must recognise, with the meaning or preferred wording.</p>}
    {value.map((entry, index) => <div class="terms-row" key={index}>
      <Input aria-label={`Term ${index + 1}`} value={entry.term} placeholder="Workspace" disabled={disabled} onInput={(event) => update(index, { term: event.currentTarget.value })} />
      <Input aria-label={`Definition for term ${index + 1}`} value={entry.definition} placeholder="A shared container for projects, members, and billing." disabled={disabled} onInput={(event) => update(index, { definition: event.currentTarget.value })} />
      <button type="button" aria-label={`Remove term ${index + 1}`} disabled={disabled} onClick={() => onChange(value.filter((_, item) => item !== index))}><Icon name="close" size={14} /></button>
    </div>)}
    <Button size="sm" icon="plus" disabled={disabled} onClick={() => onChange([...value, { term: '', definition: '' }])}>Add term</Button>
  </div>
}

export function termsFromRecord(record: Record<string, string>): GlossaryTerm[] {
  return Object.entries(record).map(([term, definition]) => ({ term, definition }))
}

export function recordFromTerms(terms: GlossaryTerm[]): Record<string, string> {
  const output: Record<string, string> = {}
  for (const entry of terms) {
    const term = entry.term.trim()
    if (term && entry.definition.trim()) output[term] = entry.definition.trim()
  }
  return output
}

/** Generate or regenerate the glossary page from the saved terminology. */
export function GlossaryPanel({ act, onError, onOpenPage, unsavedTerms }: { act: Action; onError: (error: string) => void; onOpenPage: (path: string) => void; unsavedTerms: boolean }) {
  const [glossary, setGlossary] = useState<GlossaryState>()
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try { setGlossary(await api<GlossaryState>('/api/glossary')) }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => { void load() }, [])
  const generate = async (replace = false) => {
    setBusy(true)
    try {
      const next = await act(() => post<GlossaryState>('/api/glossary/generate', { replace }), 'Glossary page generated', false)
      if (next) setGlossary(next)
    } finally { setBusy(false) }
  }
  const terms = glossary?.terms?.length ?? 0
  return <Panel title="Glossary page" description="A reader-facing glossary generated from the terminology above, added to the navigation and kept out of the agent's way.">
    {!glossary ? <div class="page-list-empty"><span class="spinner" />Checking the glossary…</div> : <div class="glossary-panel">
      <div class="glossary-status">
        <span class={`glossary-mark ${glossary.page ? 'ready' : ''}`}><Icon name="book" size={18} /></span>
        <div>
          <strong>{glossary.page ? (glossary.generated ? 'Glossary page is generated' : 'A hand-written glossary exists') : 'No glossary page yet'}</strong>
          <small>{terms} term{terms === 1 ? '' : 's'} available{glossary.fromPlan ? ` (${glossary.fromPlan} from the current plan)` : ''}{glossary.page ? ` · ${glossary.page}` : ''}</small>
        </div>
      </div>
      {unsavedTerms && <Note tone="warn">Save the terminology above first so the page reflects your latest edits.</Note>}
      {glossary.page && !glossary.generated && <Note tone="warn">{glossary.page} was not generated by Doxloop. Regenerating replaces it with the terminology map.</Note>}
      <div class="form-actions">
        {glossary.page && <Button size="sm" icon="file" onClick={() => onOpenPage(glossary.page!)}>Open page</Button>}
        <Button size="sm" tone="primary" icon="sparkles" busy={busy} disabled={terms === 0 || unsavedTerms} onClick={() => void generate(Boolean(glossary.page && !glossary.generated))}>{glossary.page ? 'Regenerate glossary' : 'Generate glossary page'}</Button>
      </div>
    </div>}
  </Panel>
}

export interface ReleaseTemplateForm {
  source: string
  version: string
  from: string
  to: string
}

/** Version and Git ref inputs for a release-notes plan, fed by the source's tags. */
export function ReleaseTemplateFields({ sources, value, onChange, disabled }: {
  sources: string[]
  value: ReleaseTemplateForm
  onChange: (value: ReleaseTemplateForm) => void
  disabled?: boolean
}) {
  const [refs, setRefs] = useState<SourceRefs>()
  const [error, setError] = useState('')
  const source = value.source || sources[0] || ''
  useEffect(() => {
    if (!source) return
    let active = true
    setError('')
    void api<SourceRefs>(`/api/sources/refs?source=${encodeURIComponent(source)}`).then((result) => {
      if (!active) return
      setRefs(result)
      if (!value.from && !value.to && result.suggested) {
        onChange({ source, version: value.version || result.suggested.version.replace(/ \(unreleased changes\)$/, ''), from: result.suggested.from, to: result.suggested.to })
      } else if (value.source !== source) {
        onChange({ ...value, source })
      }
    }).catch((cause: Error) => { if (active) setError(cause.message) })
    return () => { active = false }
  }, [source])
  const options = [...(refs?.tags ?? []), ...(refs?.branches ?? []), 'HEAD'].map((ref) => [ref, ref] as const)
  return <section class="release-template" aria-label="Release notes inputs">
    <header><span><Icon name="calendar" size={17} /></span><div><h2>Which release?</h2><p>Doxloop reads the commits and changed files between two refs of the product repository, plus its changelog, and hands them to the planner as the only evidence for the release page.</p></div></header>
    <div class="form-grid">
      {sources.length > 1 && <Field label="Repository"><Select value={source} disabled={disabled} onChange={(event) => onChange({ source: event.currentTarget.value, version: value.version, from: '', to: '' })}>{sources.map((name) => <option key={name} value={name}>{name}</option>)}</Select></Field>}
      <Field label="Version" hint="The label readers see, such as v0.2.0"><Input value={value.version} disabled={disabled} placeholder={refs?.suggested?.version ?? 'v1.2.0'} onInput={(event) => onChange({ ...value, source, version: event.currentTarget.value })} /></Field>
      <Field label="From" hint="The previous release tag or commit"><Combo value={value.from} options={options} disabled={disabled ?? false} placeholder={refs?.tags[1] ?? 'Previous tag'} onValueChange={(from) => onChange({ ...value, source, from })} /></Field>
      <Field label="To" hint="The release tag, branch, or HEAD"><Combo value={value.to} options={options} disabled={disabled ?? false} placeholder={refs?.tags[0] ?? 'HEAD'} onValueChange={(to) => onChange({ ...value, source, to })} /></Field>
    </div>
    {error && <Note tone="bad">{error}</Note>}
    {refs && refs.tags.length === 0 && <Note>The repository has no tags, so use commit hashes or branch names for the range.</Note>}
    {refs && <small class="release-refs-hint">{refs.tags.length} tag{refs.tags.length === 1 ? '' : 's'} · HEAD {refs.head}</small>}
  </section>
}
