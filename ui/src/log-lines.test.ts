import { describe, expect, it, test } from 'vitest'
import { displayLogLines, isMachineLogLine, stripAnsi, summarizeRunActivity } from './log-lines'

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

describe('summarizeRunActivity', () => {
  it('turns tool-call lines into counts and keeps the latest plain-language note', () => {
    const activity = summarizeRunActivity([
      '18:59:47 [product] Codex session started',
      "18:59:53 [application] I'll inspect the live Hoppscotch surface read-only and capture distinct useful states.",
      '18:59:58 [application] → Using doxloop_capture browser_take_screenshot',
      '18:59:58 [application] ✓ Using doxloop_capture browser_take_screenshot',
      '19:00:00 [product] ✓ Running /bin/zsh -lc "sed -n 1,80p package.json"',
      '19:00:02 [existing-docs-hoppscotch-io-1] Reading the CLI troubleshooting pages for recurring errors and their fixes.',
      'DOXLOOP_EVENT {"type":"stage"}',
    ])
    expect(activity).toEqual({
      screenshots: 1,
      sourceReads: 1,
      sessions: ['Product research', 'App exploration', 'Existing docs review'],
      latestNote: { session: 'Existing docs review', text: 'Reading the CLI troubleshooting pages for recurring errors and their fixes.' },
    })
  })
})
