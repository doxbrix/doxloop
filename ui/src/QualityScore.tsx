import { useEffect, useState } from 'preact/hooks'
import { api } from './api'
import { Button } from './components'

type Category = { id: string; label: string; measures: string; max: number; score: number; total: number; passing: number; findings: Array<{ file?: string; code: string; message: string }> }
type Quality = { measuredAt: string; pages: number; score: number; band: 'release-ready' | 'usable' | 'revise'; blocking: number; categories: Category[]; worstPages: Array<{ file: string; findings: number; categories: string[] }> }

const BANDS: Record<Quality['band'], { label: string; tone: string }> = {
  'release-ready': { label: 'Release-ready', tone: 'good' },
  usable: { label: 'Usable, worth improving', tone: 'warn' },
  revise: { label: 'Revise before release', tone: 'bad' },
}

/**
 * The measured quality score on Home: seven categories out of 100, each
 * with the share of pages that pass it and the findings behind every point
 * lost. Nothing here asks an agent for its opinion of its own work.
 */
export function QualityScore({ openPage }: { openPage: (path: string) => void }) {
  const [quality, setQuality] = useState<Quality>()
  const [error, setError] = useState('')
  const [open, setOpen] = useState<string>()
  const load = async () => {
    setError('')
    try { setQuality(await api<Quality>('/api/quality')) } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => { void load() }, [])
  if (error) return <section class="panel quality-card"><p class="quality-error">Quality could not be measured: {error}</p></section>
  if (!quality) return <section class="panel quality-card quality-loading" aria-busy="true"><span class="spinner" />Measuring documentation quality…</section>
  const status = BANDS[quality.band]
  return <section class="panel quality-card" aria-label="Documentation quality">
    <header class="quality-head">
      <div class={`quality-figure ${status.tone}`}><strong>{quality.score}</strong><span>/100</span></div>
      <div class="quality-copy">
        <small>Documentation quality</small>
        <h2>{status.label}</h2>
        <p>Measured on {quality.pages} page{quality.pages === 1 ? '' : 's'} from validation, evidence and claim checks, example checks, reader walkthroughs, and source and screenshot changes.{quality.blocking > 0 ? ` ${quality.blocking} error${quality.blocking === 1 ? '' : 's'} block publishing.` : ''}</p>
      </div>
      <Button size="sm" icon="refresh" onClick={() => void load()}>Measure again</Button>
    </header>
    <ul class="quality-categories">
      {quality.categories.map((category) => {
        const share = category.max ? category.score / category.max : 1
        const tone = share >= 0.9 ? 'good' : share >= 0.7 ? 'warn' : 'bad'
        const expanded = open === category.id
        return <li key={category.id}>
          <button type="button" class="quality-row" aria-expanded={expanded} disabled={category.findings.length === 0} onClick={() => setOpen(expanded ? undefined : category.id)}>
            <span class="quality-label"><strong>{category.label}</strong><small>{category.total ? `${category.passing} of ${category.total} pages pass` : 'Nothing to check yet'}</small></span>
            <span class="quality-bar" aria-hidden="true"><i class={tone} style={{ width: `${Math.round(share * 100)}%` }} /></span>
            <span class="quality-points">{category.score}<small>/{category.max}</small></span>
          </button>
          {expanded && <div class="quality-detail">
            <p>{category.measures}</p>
            <ul>{category.findings.slice(0, 8).map((finding, index) => <li key={`${finding.code}-${index}`}>
              {finding.file ? <button type="button" class="quality-file" onClick={() => openPage(finding.file!)}>{finding.file}</button> : <code>site</code>}
              <span>{finding.message}</span>
            </li>)}</ul>
            {category.findings.length > 8 && <p class="quality-more">and {category.findings.length - 8} more</p>}
          </div>}
        </li>
      })}
    </ul>
  </section>
}
