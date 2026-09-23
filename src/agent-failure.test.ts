import { describe, expect, test } from 'vitest'
import { AgentSessionError, agentFailureDetail, agentFailureKind, agentSignedOutMessage, describeAgentFailure } from './agent-failure.js'

describe('agent failure reasons', () => {
  test('turns an expired Claude sign-in into an actionable sentence', () => {
    const detail = agentFailureDetail('stopped with an error: Failed to authenticate: OAuth session expired and could not be refreshed')
    expect(detail).toBe('Failed to authenticate: OAuth session expired and could not be refreshed')
    expect(describeAgentFailure('claude', detail!)).toEqual({
      kind: 'sign-in',
      message: 'Claude Code could not sign in (OAuth session expired and could not be refreshed). Run `claude auth login` or switch assistant, then retry.',
    })
    const error = new AgentSessionError('claude', 'research "application"', 1, detail!)
    expect(error.kind).toBe('sign-in')
    expect(error.message).not.toContain('exited with status')
  })

  test('recognizes sign-in, account, and ordinary failures', () => {
    expect(agentFailureKind('Not logged in · Please run /login')).toBe('sign-in')
    expect(agentFailureKind('401 Unauthorized')).toBe('sign-in')
    expect(agentFailureKind('Credit balance is too low')).toBe('account')
    expect(agentFailureKind("You've hit your usage limit")).toBe('account')
    expect(agentFailureKind('reached its 100-turn limit')).toBe('other')
    expect(new AgentSessionError('codex', 'planning', 2, 'model not found').message).toBe('codex planning exited with status 2: model not found')
  })

  test('falls back to the last error line on stderr, without colour codes or stdin notices', () => {
    const stderr = 'Reading additional input from stdin...\n\u001b[31mERROR\u001b[0m: unexpected status 401 Unauthorized\n'
    expect(agentFailureDetail(undefined, stderr)).toBe('ERROR: unexpected status 401 Unauthorized')
    expect(agentFailureDetail(undefined, '')).toBeUndefined()
    expect(describeAgentFailure('codex', 'ERROR: unexpected status 401 Unauthorized').message).toContain('Run `codex login`')
  })

  test('names the sign-in command for each assistant', () => {
    expect(agentSignedOutMessage('claude')).toContain('`claude auth login`')
    expect(agentSignedOutMessage('codex')).toContain('`codex login`')
    expect(agentSignedOutMessage('gemini')).toContain('GEMINI_API_KEY')
  })
})
