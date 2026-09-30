import { useEffect, useState } from 'preact/hooks'
import { api, post, put } from './api'
import type { ProposalChange, UiJob } from './types'
import { waitForJob } from './ScreenshotDrift'
import { timeText } from './components'

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
      <small>{timeText(item.createdAt)}{item.hunkId ? ` · Hunk ${item.hunkId.slice(0, 8)}` : ''}{item.resolvedAt ? ' · Resolved' : ''}</small><p style={{ whiteSpace: 'pre-wrap' }}>{item.text}</p>
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

type ClaimLocation = { source: string; path: string; line?: number; excerpt?: string; cited: boolean }
type ClaimEvidence = { claim: string; state: 'verified' | 'inferred' | 'contradicted' | 'needs-human'; locations: ClaimLocation[]; missingFacts?: string[]; evidenceFacts?: string[] }
type PageClaimEvidence = { page: string; confidence?: 'verified' | 'inferred' | 'needs-human'; verifiedOn?: string; sources: Array<{ source: string; paths?: string[]; operations?: string[] }>; claims: ClaimEvidence[] }

const CLAIM_STATES: Record<ClaimEvidence['state'], { label: string; tone: string }> = {
  verified: { label: 'Verified', tone: 'good' },
  inferred: { label: 'Inferred', tone: 'info' },
  'needs-human': { label: 'Needs review', tone: 'warn' },
  contradicted: { label: 'Contradicted', tone: 'bad' },
}

/**
 * The claims a page makes and the source lines behind each one, so a
 * reviewer who doubts a sentence reads the lines instead of every cited file.
 */
export function PageEvidence({ path, onRequest }: { path: string; onRequest?: (text: string) => Promise<void> }) {
  const [evidence, setEvidence] = useState<PageClaimEvidence>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let current = true
    setEvidence(undefined)
    setError('')
    api<PageClaimEvidence>(`/api/pages/evidence?path=${encodeURIComponent(path)}`)
      .then((value) => { if (current) setEvidence(value) })
      .catch((cause) => { if (current) setError(cause.message) })
    return () => { current = false }
  }, [path])
  const doubtful = evidence?.claims.filter((claim) => claim.state === 'contradicted' || claim.state === 'needs-human') ?? []
  const sourceSummary = evidence?.sources.map((source) => [source.source, ...(source.paths ?? []).slice(0, 4), ...(source.operations ?? []).slice(0, 4)].join(' · ')).join('; ')
  return <details class="text-editor page-evidence" open><summary>Claims and source evidence{evidence ? ` · ${evidence.claims.length} claim${evidence.claims.length === 1 ? '' : 's'}` : ''}</summary><div class="text-editor-body">
    {error && <p role="alert">{error}</p>}
    {!evidence && !error && <p>Loading evidence…</p>}
    {evidence && evidence.claims.length === 0 && <p>{evidence.sources.length > 0 ? `This page records its sources (${sourceSummary}) but no individual claims. The next agent edit of this page records them.` : 'This page has no evidence record yet. An agent edit or a documentation run records which sources and lines it was written from.'}</p>}
    {evidence && evidence.claims.length > 0 && <>
      <p>{evidence.verifiedOn ? `Checked against the sources ${timeText(evidence.verifiedOn)}. ` : ''}Each claim below links to the lines it rests on; values are re-checked against those lines whenever you open this page.</p>
      <ul class="page-claims">{evidence.claims.map((claim) => <li key={claim.claim} class={`page-claim ${claim.state}`}>
        <div class="page-claim-head"><span class={`badge ${CLAIM_STATES[claim.state].tone}`}>{CLAIM_STATES[claim.state].label}</span><span>{claim.claim}</span></div>
        {claim.state === 'contradicted' && <small>The cited evidence has {claim.evidenceFacts?.join(', ') ?? 'a different value'}, not {claim.missingFacts?.join(', ') ?? 'the value on the page'}.</small>}
        {claim.locations.length === 0 && <small>No supporting line was found in the files this page cites.</small>}
        {claim.locations.map((location) => <details key={`${location.source}:${location.path}:${location.line ?? ''}`} class="page-claim-location">
          <summary><code>{location.source}: {location.path}{location.line ? `:${location.line}` : ''}</code>{location.cited ? '' : ' · found by Doxloop'}</summary>
          {location.excerpt && <pre>{location.excerpt}</pre>}
        </details>)}
      </li>)}</ul>
      {doubtful.length > 0 && onRequest && <div class="text-editor-actions"><button disabled={busy} onClick={() => { setBusy(true); void onRequest(`Check these claims against the source and correct the page or cite the supporting lines: ${doubtful.map((claim) => `"${claim.claim}"`).join('; ')}`).finally(() => setBusy(false)) }}>Ask the agent to check {doubtful.length} claim{doubtful.length === 1 ? '' : 's'}</button></div>}
    </>}
  </div></details>
}

type ExampleResult = { line: number; method: string; url: string; outcome: 'passed' | 'failed' | 'needs-sign-in' | 'unreachable' | 'skipped'; status?: number; expected?: string; detail?: string }
type ExampleReport = { path: string; checkedAt: string; contracts: string[]; suggestedBaseUrl?: string; baseUrl?: string; issues: Array<{ code: string; message: string }>; results: ExampleResult[] }

const EXAMPLE_OUTCOMES: Record<ExampleResult['outcome'], { label: string; tone: string }> = {
  passed: { label: 'Passed', tone: 'good' },
  failed: { label: 'Failed', tone: 'bad' },
  'needs-sign-in': { label: 'Needs sign-in', tone: 'warn' },
  unreachable: { label: 'Unreachable', tone: 'warn' },
  skipped: { label: 'Not sent', tone: 'neutral' },
}

/**
 * Check a page's examples the way a reader would use them: JSON and YAML
 * must parse, API requests must match the contract, and read-only requests
 * can be sent to a test server.
 */
export function PageExamples({ path, onRequest }: { path: string; onRequest?: (text: string) => Promise<void> }) {
  const [report, setReport] = useState<ExampleReport>()
  const [baseUrl, setBaseUrl] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const run = async (live: boolean) => {
    setBusy(true)
    setError('')
    try {
      const next = await post<ExampleReport>('/api/pages/examples', { path, ...(live && baseUrl.trim() ? { baseUrl: baseUrl.trim() } : {}) })
      setReport(next)
      if (!baseUrl && next.suggestedBaseUrl) setBaseUrl(next.suggestedBaseUrl)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  useEffect(() => { setReport(undefined); setError(''); void run(false) }, [path])
  const failing = [...(report?.issues ?? []).map((item) => item.message), ...(report?.results ?? []).filter((result) => result.outcome === 'failed').map((result) => `${result.method} ${result.url} returned ${result.status}, expected ${result.expected}`)]
  return <details class="text-editor page-examples"><summary>Examples{report ? ` · ${report.issues.length === 0 ? 'no problems found' : `${report.issues.length} problem${report.issues.length === 1 ? '' : 's'}`}` : ''}</summary><div class="text-editor-body">
    {error && <p role="alert">{error}</p>}
    <p>{report?.contracts.length ? `Requests are checked against ${report.contracts.join(', ')}.` : 'No API contract was found in the sources, so only JSON and YAML syntax is checked.'} Read-only requests (GET and HEAD) can also be sent to a test server; requests that change data are never sent.</p>
    {report && report.issues.length > 0 && <ul class="page-claims">{report.issues.map((item) => <li key={item.message} class="page-claim contradicted"><div class="page-claim-head"><span class="badge bad">{item.code.replace(/^example-/, '').replace(/-/g, ' ')}</span><span>{item.message}</span></div></li>)}</ul>}
    <label>Test server<input value={baseUrl} placeholder="http://localhost:3000" onInput={(event) => setBaseUrl(event.currentTarget.value)} /></label>
    <div class="text-editor-actions">
      <button disabled={busy || !baseUrl.trim()} onClick={() => void run(true)}>{busy ? 'Testing…' : 'Send read-only requests'}</button>
      {failing.length > 0 && onRequest && <button disabled={busy} onClick={() => { setBusy(true); void onRequest(`Fix these examples so a reader can run them as shown, taking methods, paths, and bodies from the API contract: ${failing.join(' | ')}`).finally(() => setBusy(false)) }}>Ask the agent to fix {failing.length} example{failing.length === 1 ? '' : 's'}</button>}
    </div>
    {report && report.baseUrl && (report.results.length === 0
      ? <p>This page has no requests aimed at the API.</p>
      : <ul class="page-claims">{report.results.map((result) => <li key={`${result.line}:${result.url}`} class={`page-claim ${result.outcome === 'failed' ? 'contradicted' : ''}`}>
        <div class="page-claim-head"><span class={`badge ${EXAMPLE_OUTCOMES[result.outcome].tone}`}>{EXAMPLE_OUTCOMES[result.outcome].label}</span><code>{result.method} {result.url}</code></div>
        <small>Line {result.line}{result.status ? ` · HTTP ${result.status}` : ''}{result.expected && result.outcome === 'failed' ? ` · expected ${result.expected}` : ''}{result.detail ? ` · ${result.detail}` : ''}</small>
      </li>)}</ul>)}
  </div></details>
}

type WalkthroughStep = { page: string; step: string; outcome: 'done' | 'stuck' | 'unclear' | 'different' | 'not-tried'; observation: string; fix?: string }
type WalkthroughReport = { pages: string[]; checkedAt: string; agent: string; completed: boolean; score: number; summary: string; missingPrerequisites: string[]; steps: WalkthroughStep[]; usedApplication: boolean }

const WALKTHROUGH_OUTCOMES: Record<WalkthroughStep['outcome'], { label: string; tone: string }> = {
  done: { label: 'Worked', tone: 'good' },
  stuck: { label: 'Stuck', tone: 'bad' },
  unclear: { label: 'Had to guess', tone: 'warn' },
  different: { label: 'Looked different', tone: 'warn' },
  'not-tried': { label: 'Not tried', tone: 'neutral' },
}

/**
 * Have an agent follow this page as a first-time reader and show where it
 * got stuck, had to guess, or saw something the page does not describe.
 */
export function ReaderWalkthrough({ path, onRequest }: { path: string; onRequest?: (text: string) => Promise<void> }) {
  const [report, setReport] = useState<WalkthroughReport | null>()
  const [fix, setFix] = useState<string | null>(null)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const load = async () => {
    const value = await api<{ report: WalkthroughReport | null; fix: string | null }>(`/api/walkthrough?page=${encodeURIComponent(path)}`)
    setReport(value.report)
    setFix(value.fix)
  }
  useEffect(() => { setReport(undefined); setError(''); void load().catch((cause) => setError(cause.message)) }, [path])
  const run = async () => {
    setRunning(true)
    setError('')
    setProgress('Starting the reader…')
    try {
      const job = await post<UiJob>('/api/walkthrough', { pages: [path] })
      const finished = await waitForJob(job.id, setProgress)
      if (finished?.status === 'failed') setError([...finished.lines].reverse().find((line) => line.trim()) ?? 'The walkthrough did not finish.')
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setRunning(false)
      setProgress('')
    }
  }
  const steps = report?.steps.filter((step) => step.page === path) ?? []
  return <details class="text-editor page-walkthrough"><summary>Reader walkthrough{report ? ` · ${report.score}/100${report.completed ? '' : ', did not finish'}` : ''}</summary><div class="text-editor-body">
    <p>An agent follows this page as a first-time reader{report?.usedApplication === false ? '' : ', in the test application when one is set up,'} and checks each command and setting against the source. It changes nothing; it reports where a reader would get stuck, guess, or see something different.</p>
    {error && <p role="alert">{error}</p>}
    {running && progress && <p class="screenshot-drift-progress" role="status">{progress}</p>}
    {report && <>
      <p><strong>{report.completed ? 'The reader finished.' : 'The reader did not finish.'}</strong> {report.summary} <small>Checked {timeText(report.checkedAt)} with {report.agent}.</small></p>
      {report.missingPrerequisites.length > 0 && <p>Assumed but never stated: {report.missingPrerequisites.join('; ')}.</p>}
      <ul class="page-claims">{steps.map((step, index) => <li key={`${index}:${step.step}`} class={`page-claim ${step.outcome === 'stuck' ? 'contradicted' : ''}`}>
        <div class="page-claim-head"><span class={`badge ${WALKTHROUGH_OUTCOMES[step.outcome].tone}`}>{WALKTHROUGH_OUTCOMES[step.outcome].label}</span><span>{step.step}</span></div>
        {step.outcome !== 'done' && step.observation && <small>{step.observation}{step.fix ? ` Fix: ${step.fix}` : ''}</small>}
      </li>)}</ul>
    </>}
    <div class="text-editor-actions">
      <button disabled={running} onClick={() => void run()}>{running ? 'Following the page…' : report ? 'Walk through again' : 'Walk through as a new reader'}</button>
      {fix && onRequest && <button disabled={running} onClick={() => { setRunning(true); void onRequest(fix).finally(() => setRunning(false)) }}>Ask the agent to fix what the reader hit</button>}
    </div>
  </div></details>
}
