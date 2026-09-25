import { useEffect, useRef, useState } from 'preact/hooks'
import { api, post } from './api'
import { Button, Field, Input } from './components'
import { Icon } from './icons'

/** Server state of one crawl of an existing documentation site. */
export type DocsSiteInspection = {
  id: string
  url: string
  status: 'running' | 'completed' | 'failed'
  progress: { fetched: number; discovered: number }
  error?: string
  summary?: {
    url: string
    pages: number
    words: number
    images: number
    discovered: number
    generator?: string
    discovery: string[]
    truncated: boolean
    pageLimit: number
    skipped: number
    brokenLinks: number
    warnings: string[]
    samplePages: Array<{ path: string; title: string; words: number }>
  }
}

export function describeInspection(inspection: DocsSiteInspection | undefined): string {
  const summary = inspection?.summary
  if (!summary) return 'Existing documentation'
  return `${summary.pages} page${summary.pages === 1 ? '' : 's'}${summary.generator ? ` · ${summary.generator}` : ''}`
}

/**
 * URL field plus a crawl button for an existing documentation site. The crawl
 * runs on the server; this component polls it and shows what was read so the
 * person can judge the snapshot before adding it as a source.
 */
export function DocsSiteSourceFields({ url, onUrl, inspection, onInspection, error, onError }: {
  url: string
  onUrl: (value: string) => void
  inspection: DocsSiteInspection | undefined
  onInspection: (value: DocsSiteInspection | undefined) => void
  error?: string
  onError?: (message: string) => void
}) {
  const [starting, setStarting] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout>>()
  const running = inspection?.status === 'running'
  useEffect(() => {
    if (!inspection || inspection.status !== 'running') return
    let active = true
    const poll = async () => {
      try {
        const next = await api<DocsSiteInspection>(`/api/docs-site/inspect/${encodeURIComponent(inspection.id)}`)
        if (!active) return
        onInspection(next)
        if (next.status === 'running') timer.current = setTimeout(() => void poll(), 1500)
      } catch (cause) {
        if (!active) return
        onInspection({ ...inspection, status: 'failed', error: cause instanceof Error ? cause.message : String(cause) })
      }
    }
    timer.current = setTimeout(() => void poll(), 1200)
    return () => { active = false; if (timer.current) clearTimeout(timer.current) }
  }, [inspection?.id, inspection?.status])
  const start = async () => {
    if (!url.trim() || starting) return
    setStarting(true)
    onError?.('')
    try {
      onInspection(await post<DocsSiteInspection>('/api/docs-site/inspect', { url: url.trim() }))
    } catch (cause) {
      onError?.(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setStarting(false)
    }
  }
  const summary = inspection?.summary
  // Fewer than ~20 words a page means the crawler read empty shells.
  const thinText = Boolean(summary && summary.pages > 0 && summary.words / summary.pages < 20)
  return <div class="docs-site-fields">
    <Field label="Documentation site address" hint="The public address of the documentation you want rewritten, for example https://docs.example.com or a section such as https://example.com/docs/. Doxloop reads its pages into a read-only snapshot; the site itself is never changed.">
      <div class="docs-site-url-input">
        <Icon name="globe" size={18} />
        <Input value={url} placeholder="https://docs.example.com" aria-invalid={Boolean(error)} disabled={running} onInput={(event) => { onUrl(event.currentTarget.value); if (inspection && inspection.url !== event.currentTarget.value.trim()) onInspection(undefined) }} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void start() } }} />
        <Button tone={summary ? 'secondary' : 'primary'} icon={summary ? 'refresh' : 'search'} busy={starting || running} disabled={!url.trim()} onClick={() => void start()}>{summary ? 'Crawl again' : 'Crawl site'}</Button>
      </div>
    </Field>
    {error && <p class="field-error" role="alert">{error}</p>}
    {running && <div class="docs-site-progress" role="status"><span class="spinner" /><div><strong>Reading the documentation site…</strong><small>{inspection.progress.fetched} page{inspection.progress.fetched === 1 ? '' : 's'} read · {inspection.progress.discovered} discovered</small></div></div>}
    {inspection?.status === 'failed' && <p class="field-error" role="alert">{inspection.error ?? 'The documentation site could not be read.'}</p>}
    {summary && <div class={`docs-site-summary ${thinText ? 'thin' : ''}`} role="status">
      <header><span class="docs-site-summary-icon"><Icon name={thinText ? 'alert' : 'check'} size={16} /></span><div><strong>{thinText ? `${summary.pages} page${summary.pages === 1 ? '' : 's'} found, but almost no text could be read` : `${summary.pages} page${summary.pages === 1 ? '' : 's'} ready to rewrite`}</strong><small>{summary.words.toLocaleString()} words · {summary.images} images{summary.generator ? ` · built with ${summary.generator}` : ''} · found through {summary.discovery.length ? summary.discovery.join(', ') : 'the entry page'}</small></div></header>
      {summary.samplePages.length > 0 && <ul class="docs-site-sample-pages">{summary.samplePages.map((page) => <li key={page.path}><span>{page.title}</span><small>{page.path || '/'} · {page.words} words</small></li>)}{summary.pages > summary.samplePages.length && <li class="docs-site-more">and {summary.pages - summary.samplePages.length} more</li>}</ul>}
      {thinText && <p class="docs-site-thin-note">This site builds its pages in the browser, so the crawler saw empty shells. Adding it would give the writers nothing to work from. Try the address of a page that shows text without JavaScript, or leave this source out.</p>}
      {(summary.truncated || summary.brokenLinks > 0 || summary.skipped > 0 || summary.warnings.length > 0) && <ul class="docs-site-notes">
        {summary.truncated && <li>The crawl stopped at {summary.pageLimit} pages; {summary.discovered - summary.pages} discovered pages were not read.</li>}
        {summary.brokenLinks > 0 && <li>{summary.brokenLinks} internal link{summary.brokenLinks === 1 ? '' : 's'} on the site point at pages that failed to load. The rewrite will not repeat them.</li>}
        {summary.skipped > 0 && <li>{summary.skipped} URL{summary.skipped === 1 ? '' : 's'} were skipped (non-HTML content or errors).</li>}
        {summary.warnings.filter((warning) => !summary.truncated || !warning.startsWith('Crawl stopped')).map((warning) => <li key={warning}>{warning}</li>)}
      </ul>}
    </div>}
  </div>
}
