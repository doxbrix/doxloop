import { describe, expect, it } from 'vitest'
import { historyRuntimeStatus } from './db.js'

describe('history runtime contract', () => {
  it('requires the first unflagged node:sqlite release', () => {
    expect(historyRuntimeStatus('20.12.0').available).toBe(false)
    expect(historyRuntimeStatus('22.12.0').available).toBe(false)
    expect(historyRuntimeStatus('22.13.0').available).toBe(true)
    expect(historyRuntimeStatus('24.0.0').available).toBe(true)
  })
})
