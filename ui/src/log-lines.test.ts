import { describe, expect, test } from 'vitest'
import { displayLogLines, isMachineLogLine, stripAnsi } from './log-lines'

describe('live log lines', () => {
  test('strips colour codes, cursor moves, and terminal titles', () => {
    expect(stripAnsi('\u001b[32m✓\u001b[0m Built \u001b[1mdocs\u001b[22m')).toBe('✓ Built docs')
    expect(stripAnsi('\u001b[2K\u001b[1GProgress')).toBe('Progress')
    expect(stripAnsi('\u001b]0;title\u0007done')).toBe('done')
  })
  test('hides machine events and raw agent JSON but keeps readable lines', () => {
    expect(isMachineLogLine('DOXLOOP_EVENT {"stage":"plan"}')).toBe(true)
    expect(isMachineLogLine('12:01:02 DOXLOOP_EVENT {"stage":"plan"}')).toBe(true)
    expect(isMachineLogLine('{"type":"assistant","message":{}}')).toBe(true)
    expect(isMachineLogLine('{ not json }')).toBe(false)
    expect(isMachineLogLine('{"count":3}')).toBe(false)
    expect(displayLogLines(['12:00:00 \u001b[33mResearching\u001b[0m sources', 'DOXLOOP_EVENT {"x":1}', '{"type":"tool_use"}', '12:00:05 Done'])).toEqual(['12:00:00 Researching sources', '12:00:05 Done'])
  })
})
