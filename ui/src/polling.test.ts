import { describe, expect, test } from 'vitest'
import { PollFailureTracker } from './polling'

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
