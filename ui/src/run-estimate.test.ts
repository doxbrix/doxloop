import { describe, expect, test } from 'vitest'
import { durationLabel, roughRunEstimate, runEstimateText, tokenLabel } from './run-estimate'

describe('run estimate', () => {
  test('gives a plain rough figure from the page count when no history exists', () => {
    expect(roughRunEstimate(62)).toEqual({ minutes: 80, millionTokens: 62 * 0.55 })
    expect(runEstimateText(62)).toBe('Rough estimate: about 1h 20m and ~35M tokens for 62 pages (based on typical runs). Your agent provider bills the tokens.')
    expect(runEstimateText(1)).toBe('Rough estimate: about 5 min and ~600k tokens for 1 page (based on typical runs). Your agent provider bills the tokens.')
  })
  test('prefers the observed range when history exists', () => {
    expect(runEstimateText(10, { samples: 4, range: { minimumMinutes: 12, maximumMinutes: 75 } })).toBe('Estimate: 12 min–1h 15m and ~5.5M tokens for 10 pages, based on 4 of your past runs. Your agent provider bills the tokens.')
    expect(runEstimateText(10, { samples: 2 })).toMatch(/^Rough estimate: about 15 min/)
  })
  test('formats durations and tokens compactly', () => {
    expect(durationLabel(45)).toBe('45 min')
    expect(durationLabel(120)).toBe('2h')
    expect(tokenLabel(2.75)).toBe('~2.8M')
    expect(tokenLabel(0.25)).toBe('~300k')
  })
})
