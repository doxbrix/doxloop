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
