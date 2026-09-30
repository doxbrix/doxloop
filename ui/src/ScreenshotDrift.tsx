import { useEffect, useState } from 'preact/hooks'
import { api, post } from './api'
import { Button, Note, timeText } from './components'
import type { UiJob } from './types'

type Action = <T>(run: () => Promise<T>, success?: string, reload?: boolean) => Promise<T | undefined>
type DriftOutcome = 'unchanged' | 'changed' | 'sign-in' | 'unreachable' | 'no-route' | 'missing' | 'error'
type DriftResult = { file: string; page: string; step: string; expectedState: string; route?: string; outcome: DriftOutcome; difference?: number; detail?: string }
type ScreenshotState = { recorded: number; recapturable: number; application: string | null; report: { checkedAt: string; recorded: number; results: DriftResult[] } | null }

const OUTCOMES: Record<DriftOutcome, string> = {
  unchanged: 'unchanged',
  changed: 'changed',
  'sign-in': 'behind sign-in',
  unreachable: 'unreachable',
  'no-route': 'without a route',
  missing: 'missing',
  error: 'could not be checked',
}

/** Page the running job until it finishes; the check can take a few minutes for a large set. */
export async function waitForJob(id: string, onLine: (line: string) => void): Promise<UiJob | undefined> {
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const job = (await api<UiJob[]>('/api/jobs')).find((item) => item.id === id)
    if (!job) return undefined
    const last = [...job.lines].reverse().find((line) => line.trim())
    if (last) onLine(last)
    if (job.status !== 'running') return job
  }
}

/**
 * Screenshots against the running application: re-capture each recorded
 * screenshot at its route, list the ones whose screen changed, and replace
 * them with the fresh capture as one undoable edit.
 */
export function ScreenshotDrift({ act, onChanged }: { act: Action; onChanged?: () => void }) {
  const [state, setState] = useState<ScreenshotState>()
  const [checking, setChecking] = useState(false)
  const [progress, setProgress] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const load = async () => {
    try { setState(await api<ScreenshotState>('/api/screenshots')) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => { void load() }, [])
  if (!state || state.recorded === 0) return null
  const results = state.report?.results ?? []
  const changed = results.filter((result) => result.outcome === 'changed')
  const counts = Object.entries(results.reduce<Record<string, number>>((all, result) => ({ ...all, [result.outcome]: (all[result.outcome] ?? 0) + 1 }), {}))
    .filter(([outcome]) => outcome !== 'changed')
    .map(([outcome, count]) => `${count} ${OUTCOMES[outcome as DriftOutcome]}`)
  const check = async () => {
    setChecking(true)
    setError('')
    setProgress('Starting the browser…')
    try {
      const job = await post<UiJob>('/api/screenshots/check', {})
      const finished = await waitForJob(job.id, setProgress)
      if (finished?.status === 'failed') setError([...finished.lines].reverse().find((line) => line.trim()) ?? 'The screenshot check failed.')
      await load()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setChecking(false)
      setProgress('')
    }
  }
  const replace = async (files: string[]) => {
    setBusy(true)
    try {
      const result = await act(() => post<{ replaced: string[] }>('/api/screenshots/refresh', { files }), `Replaced ${files.length} screenshot${files.length === 1 ? '' : 's'}`, false)
      if (result) { await load(); onChanged?.() }
    } finally { setBusy(false) }
  }
  const capture = (file: string, kind: 'candidate' | 'diff') => `/api/screenshots/capture?file=${encodeURIComponent(file)}&kind=${kind}&v=${encodeURIComponent(state.report?.checkedAt ?? '')}`
  return <section class="screenshot-drift" aria-label="Screenshots against the application">
    <header>
      <div>
        <h3>Screenshots against the application</h3>
        <p>{state.recorded} product screenshot{state.recorded === 1 ? '' : 's'} recorded, {state.recapturable} with a route Doxloop can revisit{state.application ? <> at <code>{state.application}</code></> : ''}. {state.report ? `Last checked ${timeText(state.report.checkedAt)}: ${changed.length} changed${counts.length ? `, ${counts.join(', ')}` : ''}.` : 'Check them to find screens that changed since they were captured.'}</p>
      </div>
      <div class="screenshot-drift-actions">
        {changed.length > 1 && <Button size="sm" busy={busy} disabled={checking} onClick={() => void replace(changed.map((result) => result.file))}>Replace all {changed.length}</Button>}
        <Button size="sm" tone="primary" icon="refresh" busy={checking} disabled={!state.application || state.recapturable === 0} onClick={() => void check()}>Check against the app</Button>
      </div>
    </header>
    {!state.application && <Note tone="warn">Set the application URL under Settings → Visual evidence to check screenshots.</Note>}
    {checking && progress && <p class="screenshot-drift-progress" role="status">{progress}</p>}
    {error && <Note tone="bad">{error}</Note>}
    {changed.length > 0 && <ul class="screenshot-drift-list">{changed.map((result) => <li key={result.file}>
      <div class="screenshot-drift-copy"><strong>{result.expectedState || result.step}</strong><small><code>{result.file}</code>{result.route ? <> · <code>{result.route}</code></> : ''} · {Math.round((result.difference ?? 0) * 1000) / 10}% of the screen differs</small></div>
      <div class="screenshot-drift-images">
        <figure><img src={`/api/assets/file?path=${encodeURIComponent(result.file)}&v=${encodeURIComponent(state.report?.checkedAt ?? '')}`} alt={`Current screenshot: ${result.expectedState}`} loading="lazy" /><figcaption>In the documentation</figcaption></figure>
        <figure><img src={capture(result.file, 'candidate')} alt={`Fresh capture: ${result.expectedState}`} loading="lazy" /><figcaption>In the application now</figcaption></figure>
      </div>
      <div class="screenshot-drift-item-actions">
        <a href={capture(result.file, 'diff')} target="_blank" rel="noreferrer">Show differences</a>
        <Button size="sm" busy={busy} disabled={checking} onClick={() => void replace([result.file])}>Replace screenshot</Button>
      </div>
    </li>)}</ul>}
    {results.some((result) => result.outcome === 'sign-in') && <Note>Some screens showed the sign-in page. Record a signed-in session or save test credentials under Settings → Visual evidence, then check again.</Note>}
  </section>
}
