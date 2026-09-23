/**
 * Background polls fail for reasons that fix themselves: the server is busy
 * with an agent, the laptop woke up, a request timed out once. A banner is
 * warranted only when the failures keep coming.
 */
export const QUIET_POLL_FAILURES = 3

export class PollFailureTracker {
  private consecutive = 0

  constructor(private readonly threshold = QUIET_POLL_FAILURES) {}

  /** Record a failure. Returns true when the reader should now be told. */
  failed(): boolean {
    this.consecutive += 1
    return this.consecutive === this.threshold
  }

  succeeded(): void {
    this.consecutive = 0
  }
}

/** How often the jobs list is asked for while the server is working and the live stream is up. */
export const RUNNING_POLL_MS = 2_000
/** A safety net while the live stream delivers updates, or when nothing is running. */
export const IDLE_POLL_MS = 60_000
export const STREAMED_POLL_MS = 15_000

/**
 * The delay before the next background jobs poll, or `null` for no poll. A
 * hidden tab never polls (it refreshes as soon as it is shown again); a live
 * job stream makes polling a slow safety net; only a running job without the
 * stream is worth asking about every couple of seconds.
 */
export function jobPollDelay({ running, streamConnected, hidden }: { running: boolean; streamConnected: boolean; hidden: boolean }): number | null {
  if (hidden) return null
  if (!running) return IDLE_POLL_MS
  return streamConnected ? STREAMED_POLL_MS : RUNNING_POLL_MS
}
