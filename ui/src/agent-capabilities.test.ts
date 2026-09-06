import { describe, expect, test } from 'vitest'
import { AGENT_CAPABILITIES, AGENT_CAPABILITY_AGENTS, agentParityLabel } from './agent-capabilities'

describe('agent capability matrix', () => {
  test('rates every assistant on every capability with a reason', () => {
    for (const row of AGENT_CAPABILITIES) {
      for (const [agent] of AGENT_CAPABILITY_AGENTS) {
        const support = row.support[agent]
        expect(['full', 'limited', 'none']).toContain(support.level)
        expect(support.note.length, `${row.id}/${agent}`).toBeGreaterThan(10)
      }
    }
    expect(AGENT_CAPABILITIES.map((row) => row.id)).toEqual(['screenshots', 'sources', 'cost-cap', 'live-log', 'sign-in', 'validation'])
  })

  test('labels Gemini as limited and the others as full', () => {
    expect(agentParityLabel('gemini')).toBe('Limited')
    expect(agentParityLabel('claude')).toBe('Full')
    // Codex has no spending cap, but nobody except Claude does; that is a missing feature, not a limitation.
    expect(agentParityLabel('codex')).toBe('Full')
    expect(AGENT_CAPABILITIES.find((row) => row.id === 'cost-cap')?.support.codex.level).toBe('none')
  })
})
