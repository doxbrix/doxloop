import { describe, expect, test } from 'vitest'
import { IDLE_POLL_MS, PollFailureTracker, RUNNING_POLL_MS, STREAMED_POLL_MS, jobPollDelay } from './polling'

describe('quiet poll retries', () => {
  test('reports only after three failures in a row and resets on success', () => {
    const tracker = new PollFailureTracker()
    expect(tracker.failed()).toBe(false)
    expect(tracker.failed()).toBe(false)
    expect(tracker.failed()).toBe(true)
    expect(tracker.failed()).toBe(false)
    tracker.succeeded()
    expect(tracker.failed()).toBe(false)
    expect(tracker.failed()).toBe(false)
    expect(tracker.failed()).toBe(true)
  })
})

describe('job poll cadence', () => {
  test('pauses while hidden, backs off when idle or streamed, and polls fast only without the stream', () => {
    expect(jobPollDelay({ running: true, streamConnected: false, hidden: true })).toBeNull()
    expect(jobPollDelay({ running: false, streamConnected: false, hidden: false })).toBe(IDLE_POLL_MS)
    expect(jobPollDelay({ running: true, streamConnected: true, hidden: false })).toBe(STREAMED_POLL_MS)
    expect(jobPollDelay({ running: true, streamConnected: false, hidden: false })).toBe(RUNNING_POLL_MS)
    // Two hours of an idle, visible tab: about 120 requests instead of thousands.
    expect((2 * 60 * 60 * 1000) / IDLE_POLL_MS).toBe(120)
  })
})
