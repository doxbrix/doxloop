import { describe, expect, it } from 'vitest'
import { sourceHealth } from './source-connectors.js'

describe('source health reporting', () => {
  it('returns actionable, redacted failures for an unavailable local source', async () => {
    const [health] = await sourceHealth('/private/workspace/docs', [{ name: 'product', path: '../missing?token=super-secret' }])
    expect(health).toMatchObject({ name: 'product', status: 'error', provider: 'directory', monitored: false })
    expect(health?.summary).not.toContain('super-secret')
    expect(health?.summary).not.toContain('/private/workspace')
    expect(health?.details.join(' ')).toContain('read-only credentials')
  })
})
