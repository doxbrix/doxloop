import { describe, expect, it } from 'vitest'
import { formatSleep, monotonicNow, SleepDetector } from './monotonic-clock.js'

describe('monotonic clock', () => {
  it('advances', () => {
    const start = monotonicNow()
    expect(monotonicNow()).toBeGreaterThanOrEqual(start)
  })

  it('reports a sleep when the wall clock runs ahead of awake time', () => {
    let wall = 1_000_000
    let mono = 50
    const detector = new SleepDetector(60_000, () => wall, () => mono)
    wall += 15_000
    mono += 15_000
    expect(detector.check()).toBeUndefined()
    // Twenty minutes of lid-closed time: the wall clock jumps, awake time barely moves.
    wall += 20 * 60_000 + 15_000
    mono += 15_000
    expect(detector.check()).toEqual({ sleptMs: 20 * 60_000 })
    wall += 15_000
    mono += 15_000
    expect(detector.check()).toBeUndefined()
  })

  it('ignores gaps under the threshold', () => {
    let wall = 0
    let mono = 0
    const detector = new SleepDetector(60_000, () => wall, () => mono)
    wall += 45_000
    mono += 15_000
    expect(detector.check()).toBeUndefined()
  })

  it('formats sleep durations for the log', () => {
    expect(formatSleep(20_000)).toBe('less than a minute')
    expect(formatSleep(60_000)).toBe('about 1 minute')
    expect(formatSleep(25 * 60_000)).toBe('about 25 minutes')
    expect(formatSleep(3 * 60 * 60_000)).toBe('about 3 hours')
  })
})
