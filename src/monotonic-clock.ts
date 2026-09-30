/**
 * Time that stops while the computer sleeps. Wall-clock deadlines and idle
 * checks counted a closed laptop lid as agent time: a run woke up past its
 * budget, and every session's idle watchdog fired at the same second after a
 * sleep longer than its limit (the uptime-kuma run lost 18 of 34 pages that
 * way). Node's `performance.now()` follows the monotonic clock, which does not
 * advance during system sleep on macOS or Linux, so budgets measured with it
 * cover only the time the agent could actually work.
 */
import { performance } from 'node:perf_hooks'

/** Milliseconds of awake time since an arbitrary origin. */
export function monotonicNow(): number {
  return performance.now()
}

export interface SleepGap {
  /** Wall-clock time that passed with the process suspended, in milliseconds. */
  sleptMs: number
}

/**
 * Notices system sleep by comparing wall-clock and monotonic progress between
 * checks. A gap only counts when the wall clock ran ahead by more than the
 * threshold, so ordinary timer jitter and small NTP adjustments are ignored.
 */
export class SleepDetector {
  private lastWall: number
  private lastMono: number

  constructor(
    private readonly thresholdMs = 60_000,
    private readonly wall: () => number = Date.now,
    private readonly mono: () => number = monotonicNow,
  ) {
    this.lastWall = wall()
    this.lastMono = mono()
  }

  /** The sleep since the previous check, if there was one. */
  check(): SleepGap | undefined {
    const wall = this.wall()
    const mono = this.mono()
    const sleptMs = (wall - this.lastWall) - (mono - this.lastMono)
    this.lastWall = wall
    this.lastMono = mono
    return sleptMs >= this.thresholdMs ? { sleptMs } : undefined
  }
}

/** "about 12 minutes" for a log line. */
export function formatSleep(ms: number): string {
  const minutes = Math.round(ms / 60_000)
  if (minutes < 1) return 'less than a minute'
  if (minutes < 90) return `about ${minutes} minute${minutes === 1 ? '' : 's'}`
  const hours = Math.round(minutes / 6) / 10
  return `about ${hours} hour${hours === 1 ? '' : 's'}`
}
