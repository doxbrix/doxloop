import { Button } from './components'
import { Icon } from './icons'
import type { GeneratorEntry, GeneratorPreflight, GeneratorTier } from './types'

const TIER_ORDER: GeneratorTier[] = ['full', 'supported', 'basic']
const STATUS_ICON = { pass: 'check', warning: 'alert', fail: 'close' } as const

export function generatorTierLabel(entry: GeneratorEntry | undefined): string {
  return entry?.tierLabel ?? (entry?.tier ? entry.tier[0]!.toUpperCase() + entry.tier.slice(1) : '')
}

/** Tier and toolchain in one line under the generator select. */
export function GeneratorTierBadge({ entry }: { entry: GeneratorEntry | undefined }) {
  if (!entry?.tier) return null
  const toolchain = entry.toolchainLabels?.length ? entry.toolchainLabels.join(', ') : 'No extra toolchain'
  return <small class={`generator-tier-label tier-${entry.tier}`} title={entry.tierDescription}>
    <Icon name={entry.tier === 'full' ? 'check' : 'info'} size={12} />{generatorTierLabel(entry)} tier · {toolchain}
  </small>
}

/** Every generator in the catalog with its tier and toolchain, so the choice is informed. */
export function GeneratorTierMatrix({ generators, selected }: { generators: GeneratorEntry[]; selected?: string | undefined }) {
  const rows = [...generators].filter((entry) => entry.tier).sort((left, right) => TIER_ORDER.indexOf(left.tier!) - TIER_ORDER.indexOf(right.tier!))
  if (rows.length === 0) return null
  return <div class="generator-tiers" role="table" aria-label="Generator support tiers">
    <div class="generator-tiers-head" role="row"><span role="columnheader">Generator</span><span role="columnheader">Tier</span><span role="columnheader">Needs</span></div>
    {rows.map((entry) => <div class={`generator-tiers-row${selected === entry.id ? ' selected' : ''}`} role="row" key={entry.id}>
      <span role="rowheader"><strong>{entry.displayName}</strong></span>
      <span role="cell" class={`tier-${entry.tier}`} title={entry.tierDescription}>{generatorTierLabel(entry)}</span>
      <span role="cell">{entry.toolchainLabels?.length ? entry.toolchainLabels.join(', ') : 'Nothing extra'}</span>
    </div>)}
    <p class="generator-tiers-legend">
      <strong>Full</strong> generators have validated navigation, documented components, and diagrams, and are built in CI.
      <strong>Supported</strong> generators validate nested navigation where the configuration is readable and say so when it is not.
      <strong>Basic</strong> generators scaffold, preview, and build, with navigation checks limited to what the scaffold owns.
    </p>
  </div>
}

/** Result of the toolchain check for the selected generator. */
export function GeneratorPreflightPanel({ entry, result, busy, onRetry }: { entry: GeneratorEntry | undefined; result: GeneratorPreflight | undefined; busy: boolean; onRetry: () => void }) {
  if (!entry || entry.id === 'doxbrix') return null
  const tone = !result ? 'pending' : result.ready ? (result.checks.some((check) => check.status === 'warning') ? 'warning' : 'ready') : 'missing'
  return <section class={`setup-generator-preflight ${tone}`} aria-live="polite">
    <header>
      <span class="setup-generator-preflight-icon"><Icon name={tone === 'ready' ? 'check' : tone === 'pending' ? 'settings' : 'alert'} size={17} /></span>
      <div>
        <strong>{busy ? `Checking tools for ${entry.displayName}…` : !result ? `Tools for ${entry.displayName}` : result.ready ? `${entry.displayName} tools are ready` : `${entry.displayName} needs tools that are not installed`}</strong>
        <small>{entry.toolchainLabels?.length ? `Preview and the strict build need ${entry.toolchainLabels.join(' and ')}.` : 'No extra toolchain is needed.'}{!result?.ready && result ? ' You can still create the project; install the missing tools before previewing or publishing.' : ''}</small>
      </div>
      <Button size="sm" busy={busy} onClick={onRetry}>Check again</Button>
    </header>
    {result && <ul class="setup-generator-preflight-checks">
      {result.checks.map((check, index) => <li key={index} class={check.status}><Icon name={STATUS_ICON[check.status]} size={13} /><span><strong>{check.label}</strong>{check.detail && <small>{check.detail}</small>}</span></li>)}
    </ul>}
  </section>
}
