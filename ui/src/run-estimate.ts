/** Wall time per written page in a typical run: batches of four pages, two batches at a time. */
export const TYPICAL_MINUTES_PER_PAGE = 1.25
/** Agent tokens per written page in a typical run, including cached context. */
export const TYPICAL_MILLION_TOKENS_PER_PAGE = 0.55

export interface ServerRunEstimate {
  samples: number
  range?: { minimumMinutes: number; maximumMinutes: number }
}

/** "5 min", "45 min", "1h 20m". */
export function durationLabel(minutes: number): string {
  const rounded = Math.max(1, Math.round(minutes))
  if (rounded < 60) return `${rounded} min`
  const hours = Math.floor(rounded / 60)
  const rest = rounded % 60
  return rest ? `${hours}h ${rest}m` : `${hours}h`
}

/** "~800k", "~2.8M", "~35M" tokens. */
export function tokenLabel(millions: number): string {
  if (millions < 1) return `~${Math.max(100, Math.round(millions * 10) * 100)}k`
  if (millions < 10) return `~${Number(millions.toFixed(1))}M`
  return `~${Math.ceil(millions / 5) * 5}M`
}

/** A plain rough estimate from the page count when no comparable history exists. */
export function roughRunEstimate(pages: number): { minutes: number; millionTokens: number } {
  const count = Math.max(1, pages)
  const minutes = count * TYPICAL_MINUTES_PER_PAGE
  return { minutes: Math.max(5, Math.round(minutes / 5) * 5), millionTokens: count * TYPICAL_MILLION_TOKENS_PER_PAGE }
}

/**
 * One or two short sentences a person can plan around. Observed history wins
 * when there is enough of it; otherwise the typical-run rates give a rough
 * figure instead of a disclaimer.
 */
export function runEstimateText(pages: number, observed?: ServerRunEstimate): string {
  const count = Math.max(1, pages)
  const pageText = `${count} page${count === 1 ? '' : 's'}`
  const tokens = tokenLabel(count * TYPICAL_MILLION_TOKENS_PER_PAGE)
  if (observed?.range) {
    const { minimumMinutes, maximumMinutes } = observed.range
    const time = minimumMinutes === maximumMinutes ? `about ${durationLabel(minimumMinutes)}` : `${durationLabel(minimumMinutes)}–${durationLabel(maximumMinutes)}`
    return `Estimate: ${time} and ${tokens} tokens for ${pageText}, based on ${observed.samples} of your past runs. Your agent provider bills the tokens.`
  }
  const rough = roughRunEstimate(count)
  return `Rough estimate: about ${durationLabel(rough.minutes)} and ${tokens} tokens for ${pageText} (based on typical runs). Your agent provider bills the tokens.`
}
