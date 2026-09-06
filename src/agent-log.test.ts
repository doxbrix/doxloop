import { describe, expect, test } from 'vitest'
import {
  ClaudeStreamLogFormatter,
  CodexStreamLogFormatter,
  GeminiStreamLogFormatter,
  createAgentLogFormatter,
} from './agent-log.js'

const jsonl = (events: unknown[]): string => `${events.map((event) => JSON.stringify(event)).join('\n')}\n`

describe('agent log formatters', () => {
  test('picks the formatter for each agent', () => {
    expect(createAgentLogFormatter('claude')).toBeInstanceOf(ClaudeStreamLogFormatter)
    expect(createAgentLogFormatter('codex')).toBeInstanceOf(CodexStreamLogFormatter)
    expect(createAgentLogFormatter('gemini')).toBeInstanceOf(GeminiStreamLogFormatter)
  })

  test('turns Codex exec events into the same activity lines Claude gets', () => {
    const formatter = new CodexStreamLogFormatter()
    const calls: Array<[string, Record<string, unknown>]> = []
    formatter.onToolCall = (tool, input) => calls.push([tool, input])
    const stream = jsonl([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.started' },
      { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'doxloop test --cwd .', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'doxloop test --cwd .', exit_code: 0, status: 'completed' } },
      { type: 'item.completed', item: { id: 'i2', type: 'reasoning', text: 'thinking' } },
      { type: 'item.completed', item: { id: 'i3', type: 'file_change', status: 'completed', changes: [{ path: 'guides/setup.mdx', kind: 'add' }] } },
      { type: 'item.started', item: { id: 'i4', type: 'mcp_tool_call', server: 'doxloop_capture', tool: 'browser_take_screenshot', arguments: { filename: 'a.png' } } },
      { type: 'item.completed', item: { id: 'i4', type: 'mcp_tool_call', server: 'doxloop_capture', tool: 'browser_take_screenshot', status: 'failed' } },
      { type: 'item.completed', item: { id: 'i5', type: 'todo_list', items: [{ text: 'a', completed: true }, { text: 'b', completed: false }] } },
      { type: 'item.completed', item: { id: 'i6', type: 'agent_message', text: 'Documentation written.' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 42 } },
    ])
    const midpoint = Math.floor(stream.length / 2)
    const lines = [...formatter.push(stream.slice(0, midpoint)), ...formatter.push(stream.slice(midpoint)), ...formatter.finish()]

    expect(lines).toEqual([
      'Codex session started',
      '→ Running doxloop test --cwd .',
      '✓ Running doxloop test --cwd .',
      '✓ Editing guides/setup.mdx',
      '→ Using doxloop_capture browser_take_screenshot',
      '✗ Using doxloop_capture browser_take_screenshot failed',
      'Plan: 1 of 2 steps done',
      'Documentation written.',
      'Codex finished · 42 output tokens',
    ])
    expect(calls).toEqual([
      ['Bash', { command: 'doxloop test --cwd .' }],
      ['Write', { file_path: 'guides/setup.mdx' }],
      ['mcp__doxloop_capture__browser_take_screenshot', { filename: 'a.png' }],
    ])
    expect(formatter.stopReason).toBeUndefined()
  })

  test('keeps the reason a Codex turn failed and passes plain text through', () => {
    const formatter = new CodexStreamLogFormatter()
    const lines = formatter.push(`not json at all\n${JSON.stringify({ type: 'turn.failed', error: { message: 'rate limited' } })}\n`)
    expect(lines).toEqual(['not json at all', 'Codex stopped with an error: rate limited'])
    expect(formatter.stopReason).toBe('stopped with an error: rate limited')
  })

  test('turns Gemini stream-json events into activity lines and joins streamed replies', () => {
    const formatter = new GeminiStreamLogFormatter()
    const calls: Array<[string, Record<string, unknown>]> = []
    formatter.onToolCall = (tool, input) => calls.push([tool, input])
    const lines = [
      ...formatter.push(jsonl([
        { type: 'init', session_id: 's1', model: 'gemini-3.5-flash' },
        { type: 'message', role: 'user', content: 'ignored' },
        { type: 'tool_use', tool_name: 'read_file', tool_id: 'c1', parameters: { file_path: 'docs/index.mdx' } },
        { type: 'tool_result', tool_id: 'c1', status: 'success', output: 'contents' },
        { type: 'tool_use', tool_name: 'run_shell_command', tool_id: 'c2', parameters: { command: 'doxloop test' } },
        { type: 'tool_result', tool_id: 'c2', status: 'error', output: 'exit 1' },
        { type: 'tool_use', tool_name: 'write_file', tool_id: 'c3', parameters: { file_path: 'guides/setup.mdx', content: '...' } },
        { type: 'tool_use', tool_name: 'browser_take_screenshot', tool_id: 'c4', parameters: {} },
        { type: 'message', role: 'assistant', content: 'Documentation ', delta: true },
        { type: 'message', role: 'assistant', content: 'written.', delta: true },
        { type: 'error', severity: 'warning', message: 'slow network' },
        { type: 'result', status: 'success', stats: { duration_ms: 125_000, tool_calls: 4 } },
      ])),
      ...formatter.finish(),
    ]

    expect(lines).toEqual([
      'Gemini session started · gemini-3.5-flash',
      '→ Reading docs/index.mdx',
      '✓ Reading docs/index.mdx',
      '→ Running doxloop test',
      '✗ Running doxloop test failed: exit 1',
      '→ Writing guides/setup.mdx',
      '→ Using browser_take_screenshot',
      'Documentation written.',
      '! slow network',
      'Gemini finished · 4 tool calls · 2m 5s',
    ])
    expect(calls).toEqual([
      ['read_file', { file_path: 'docs/index.mdx' }],
      ['Bash', { command: 'doxloop test' }],
      ['Write', { file_path: 'guides/setup.mdx' }],
      ['browser_take_screenshot', {}],
    ])
    expect(formatter.stopReason).toBeUndefined()
  })

  test('names why Gemini stopped', () => {
    const formatter = new GeminiStreamLogFormatter()
    const lines = formatter.push(jsonl([
      { type: 'error', severity: 'error', message: 'Quota exceeded' },
      { type: 'result', status: 'error' },
    ]))
    expect(lines).toEqual(['✗ Quota exceeded', 'Gemini stopped · stopped with an error: Quota exceeded'])
    expect(formatter.stopReason).toBe('stopped with an error: Quota exceeded')
  })
})
