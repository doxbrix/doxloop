import { describe, expect, it } from 'vitest'
import { isInvalidLocalUiSession } from './api'

describe('local UI session recovery', () => {
  it('recognizes the stale-session response', () => {
    expect(isInvalidLocalUiSession(409, 'Invalid local UI session. Reload the Doxloop UI.')).toBe(true)
  })

  it('does not reload for unrelated conflicts or errors', () => {
    expect(isInvalidLocalUiSession(409, 'Configured source evidence changed.')).toBe(false)
    expect(isInvalidLocalUiSession(500, 'Invalid local UI session. Reload the Doxloop UI.')).toBe(false)
  })
})
