import { describe, expect, test } from 'vitest'
import {
  ClaudeStreamLogFormatter,
  CodexStreamLogFormatter,
  GeminiStreamLogFormatter,
  createAgentLogFormatter,
  formatAgentUsage,
  formatTokenCount,
  mergeAgentUsage,
} from './agent-log.js'
import type { AgentUsage } from './types.js'

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
      'Codex finished · 1 turn · 52 tokens',
    ])
    expect(formatter.usage).toMatchObject({ inputTokens: 10, outputTokens: 42, cacheReadTokens: 0, totalTokens: 52, turns: 1, sessions: 1, maxContextTokens: 0 })
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
    expect(formatter.usage).toBeUndefined()
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

  test('splits Codex cached prompt tokens out of its input count', () => {
    const formatter = new CodexStreamLogFormatter()
    formatter.push(jsonl([
      { type: 'thread.started', thread_id: 't1' },
      { type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 800, output_tokens: 100 } },
      { type: 'turn.completed', usage: { input_tokens: 400, cached_input_tokens: 0, output_tokens: 50 } },
    ]))
    expect(formatter.usage).toMatchObject({
      inputTokens: 600,
      outputTokens: 150,
      cacheReadTokens: 800,
      cacheCreationTokens: 0,
      totalTokens: 1550,
      turns: 2,
      sessions: 1,
      maxContextTokens: 0,
    })
    expect(formatter.usage?.costUsd).toBeUndefined()
  })

  test('reads Gemini token totals from the result stats', () => {
    const formatter = new GeminiStreamLogFormatter()
    const lines = formatter.push(jsonl([
      { type: 'result', status: 'success', stats: { duration_ms: 10_000, tool_calls: 2, models: {
        'gemini-3.5-pro': { tokens: { prompt: 5000, cached: 4000, candidates: 300, thoughts: 200, total: 5500 } },
        'gemini-3.5-flash': { tokens: { prompt: 1000, cached: 0, candidates: 100, total: 1100 } },
      } } },
    ]))
    expect(lines).toEqual(['Gemini finished · 2 tool calls · 10s · 6.6k tokens (67% cached)'])
    expect(formatter.usage).toMatchObject({ inputTokens: 2000, outputTokens: 600, cacheReadTokens: 4000, totalTokens: 6600, durationMs: 10_000 })
  })
})

describe('Claude usage accounting', () => {
  const usage = (input: number, output: number, cacheRead: number, cacheCreation: number) => ({
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheCreation,
  })

  test('sums assistant messages, de-duplicating repeated message ids, and reads cost from the result', () => {
    const formatter = new ClaudeStreamLogFormatter()
    expect(formatter.usage).toBeUndefined()
    const lines = formatter.push(jsonl([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-4-5' },
      { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'Reading the sources.' }], usage: usage(100, 20, 5000, 400) } },
      // The same message again, as emitted once per content block with partial messages on: the later usage replaces the first.
      { type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'tu1', name: 'Read', input: { file_path: 'src/a.ts' } }], usage: usage(100, 50, 5000, 400) } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } },
      { type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'Done.' }], usage: usage(10, 30, 9000, 0) } },
      { type: 'result', subtype: 'success', num_turns: 4, duration_ms: 483_000, total_cost_usd: 1.42, result: 'Done.' },
    ]))
    expect(lines.at(-1)).toBe('Claude finished · 4 turns · 8m 3s · 14.6k tokens (96% cached) · $1.42')
    expect(formatter.usage).toEqual({
      inputTokens: 110,
      outputTokens: 80,
      cacheReadTokens: 14_000,
      cacheCreationTokens: 400,
      totalTokens: 14_590,
      costUsd: 1.42,
      turns: 4,
      sessions: 1,
      maxContextTokens: 9010,
      durationMs: 483_000,
    })
  })

  test('prefers the result event totals but keeps the largest context from the scan', () => {
    const formatter = new ClaudeStreamLogFormatter()
    formatter.push(jsonl([
      { type: 'assistant', message: { id: 'msg_1', content: [], usage: usage(100, 20, 50_000, 0) } },
      { type: 'stream_event', event: { type: 'message_start', message: { usage: usage(999, 0, 0, 0) } } },
      { type: 'result', subtype: 'error_max_turns', num_turns: 12, duration_ms: 60_000, total_cost_usd: 0.004, usage: usage(500, 200, 200_000, 1000) },
    ]))
    expect(formatter.usage).toMatchObject({ inputTokens: 500, outputTokens: 200, cacheReadTokens: 200_000, cacheCreationTokens: 1000, totalTokens: 201_700, turns: 12, maxContextTokens: 50_100, costUsd: 0.004 })
  })

  test('falls back to the per-model usage map when the result has no totals', () => {
    const formatter = new ClaudeStreamLogFormatter()
    formatter.push(jsonl([
      { type: 'result', subtype: 'success', num_turns: 2, duration_ms: 5000, modelUsage: {
        'claude-sonnet-4-5': { inputTokens: 300, outputTokens: 100, cacheReadInputTokens: 2000, cacheCreationInputTokens: 50, costUSD: 0.02 },
        'claude-haiku-4-5': { inputTokens: 30, outputTokens: 10, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 },
      } },
    ]))
    expect(formatter.usage).toMatchObject({ inputTokens: 330, outputTokens: 110, cacheReadTokens: 2000, cacheCreationTokens: 50, totalTokens: 2490, turns: 2, durationMs: 5000 })
    expect(formatter.usage?.costUsd).toBeCloseTo(0.021)
  })

  test('counts an assistant message without usage as no usage at all', () => {
    const formatter = new ClaudeStreamLogFormatter()
    formatter.push(jsonl([{ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'hi' }] } }]))
    expect(formatter.usage).toBeUndefined()
  })
})

describe('usage helpers', () => {
  const part = (overrides: Partial<AgentUsage>): AgentUsage => ({
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    turns: 0,
    sessions: 1,
    maxContextTokens: 0,
    durationMs: 0,
    ...overrides,
  })

  test('merges sessions by summing counters and keeping the largest context', () => {
    expect(mergeAgentUsage(undefined, undefined)).toBeUndefined()
    const merged = mergeAgentUsage(
      part({ inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, totalTokens: 1150, turns: 3, maxContextTokens: 800, durationMs: 1000, costUsd: 0.5 }),
      undefined,
      part({ inputTokens: 10, outputTokens: 5, cacheCreationTokens: 20, totalTokens: 35, turns: 1, sessions: 2, maxContextTokens: 1200, durationMs: 500 }),
    )
    expect(merged).toEqual({
      inputTokens: 110,
      outputTokens: 55,
      cacheReadTokens: 1000,
      cacheCreationTokens: 20,
      totalTokens: 1185,
      costUsd: 0.5,
      turns: 4,
      sessions: 3,
      maxContextTokens: 1200,
      durationMs: 1500,
    })
    expect(mergeAgentUsage(part({}), part({}))?.costUsd).toBeUndefined()
  })

  test('formats token counts with k and M suffixes', () => {
    expect(formatTokenCount(999)).toBe('999')
    expect(formatTokenCount(1000)).toBe('1k')
    expect(formatTokenCount(12_345)).toBe('12.3k')
    expect(formatTokenCount(1_234_567)).toBe('1.2M')
    expect(formatTokenCount(2_000_000)).toBe('2M')
  })

  test('formats a usage line, omitting unknown cost and single sessions', () => {
    expect(formatAgentUsage(part({ inputTokens: 20_000, outputTokens: 30_000, cacheReadTokens: 1_150_000, totalTokens: 1_200_000, costUsd: 1.42, sessions: 3 })))
      .toBe('1.2M tokens · 98% cached · $1.42 · 3 sessions')
    expect(formatAgentUsage(part({ inputTokens: 400, outputTokens: 100, totalTokens: 500 }))).toBe('500 tokens')
    expect(formatAgentUsage(part({ inputTokens: 400, outputTokens: 100, totalTokens: 500, costUsd: 0.001 }))).toBe('500 tokens · <$0.01')
  })
})

describe('activity heartbeats and tool durations', () => {
  const streamEvent = (event: Record<string, unknown>): Record<string, unknown> => ({ type: 'stream_event', event })

  test('names what Claude is doing while its stream is quiet and times its tool calls', () => {
    let clock = 0
    const formatter = new ClaudeStreamLogFormatter({ now: () => clock, heartbeatMs: 30_000 })
    expect(formatter.push(jsonl([{ type: 'system', subtype: 'init', session_id: 's1', model: 'claude-sonnet-5' }]))).toEqual(['Claude session started · claude-sonnet-5'])
    expect(formatter.heartbeat(10_000)).toEqual([])
    clock = 31_000
    expect(formatter.heartbeat()).toEqual(["… waiting for Claude's first response · 31s"])
    expect(formatter.heartbeat()).toEqual([])

    // A thinking block streams deltas but prints nothing; push reports the phase itself.
    expect(formatter.push(jsonl([
      streamEvent({ type: 'message_start' }),
      streamEvent({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
      streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'x'.repeat(1500) } }),
    ]))).toEqual([])
    clock = 62_000
    expect(formatter.push(jsonl([streamEvent({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'y' } })]))).toEqual(['… Claude is thinking (1.5k characters so far) · 31s'])

    // A long reply reports how much has streamed so far.
    expect(formatter.push(jsonl([
      streamEvent({ type: 'content_block_stop', index: 0 }),
      streamEvent({ type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } }),
      streamEvent({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'a'.repeat(4200) } }),
    ]))).toEqual([])
    clock = 100_000
    expect(formatter.heartbeat()).toEqual(['… Claude is writing its reply (4.2k characters so far) · 38s'])
    expect(formatter.push(jsonl([streamEvent({ type: 'content_block_stop', index: 1 })]))).toEqual(['a'.repeat(4200)])

    // A tool call is timed from the call to its result, and a slow one is named while it runs.
    expect(formatter.push(jsonl([
      streamEvent({ type: 'content_block_start', index: 2, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } }),
      streamEvent({ type: 'content_block_delta', index: 2, delta: { type: 'input_json_delta', partial_json: '{"command":"doxloop test"}' } }),
      streamEvent({ type: 'content_block_stop', index: 2 }),
    ]))).toEqual(['→ Running doxloop test'])
    clock = 140_000
    expect(formatter.heartbeat()).toEqual(['… waiting for Running doxloop test to finish · 40s'])
    clock = 141_500
    expect(formatter.push(jsonl([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] } }]))).toEqual(['✓ Running doxloop test · 42s'])
    clock = 180_000
    expect(formatter.heartbeat()).toEqual(["… waiting for Claude's next step · 39s"])

    expect(formatter.push(jsonl([{ type: 'result', subtype: 'success', num_turns: 2, duration_ms: 180_000 }]))).toEqual(['Claude finished · 2 turns · 3m 0s'])
    clock = 400_000
    expect(formatter.heartbeat()).toEqual([])
  })

  test('shows what a ToolSearch call looked up and skips durations under a second', () => {
    let clock = 0
    const formatter = new ClaudeStreamLogFormatter({ now: () => clock })
    expect(formatter.push(jsonl([
      { type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:none', max_results: 1 } }] } },
    ]))).toEqual(['→ Looking up tools matching select:none'])
    clock = 400
    expect(formatter.push(jsonl([{ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'none' }] } }]))).toEqual(['✓ Looking up tools matching select:none'])
  })

  test('times Codex commands and names a slow one', () => {
    let clock = 0
    const formatter = new CodexStreamLogFormatter({ now: () => clock, heartbeatMs: 30_000 })
    expect(formatter.push(jsonl([{ type: 'thread.started', thread_id: 't1' }]))).toEqual(['Codex session started'])
    clock = 31_000
    expect(formatter.heartbeat()).toEqual(["… waiting for Codex's first response · 31s"])
    expect(formatter.push(jsonl([{ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'doxloop test', status: 'in_progress' } }]))).toEqual(['→ Running doxloop test'])
    clock = 70_000
    expect(formatter.heartbeat()).toEqual(['… waiting for Running doxloop test to finish · 39s'])
    clock = 72_000
    expect(formatter.push(jsonl([{ type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'doxloop test', exit_code: 0, status: 'completed' } }]))).toEqual(['✓ Running doxloop test · 41s'])
    expect(formatter.push(jsonl([{ type: 'turn.completed', usage: { input_tokens: 1, output_tokens: 1 } }]))).toEqual(['Codex finished · 1 turn · 2 tokens'])
    clock = 200_000
    expect(formatter.heartbeat()).toEqual([])
  })

  test('times Gemini tool calls and names a slow one', () => {
    let clock = 0
    const formatter = new GeminiStreamLogFormatter({ now: () => clock, heartbeatMs: 30_000 })
    expect(formatter.push(jsonl([{ type: 'init', session_id: 's1', model: 'gemini-3.5-flash' }]))).toEqual(['Gemini session started · gemini-3.5-flash'])
    expect(formatter.push(jsonl([{ type: 'tool_use', tool_name: 'read_file', tool_id: 'c1', parameters: { file_path: 'docs/index.mdx' } }]))).toEqual(['→ Reading docs/index.mdx'])
    clock = 45_000
    expect(formatter.heartbeat()).toEqual(['… waiting for Reading docs/index.mdx to finish · 45s'])
    clock = 46_000
    expect(formatter.push(jsonl([{ type: 'tool_result', tool_id: 'c1', status: 'success', output: 'contents' }]))).toEqual(['✓ Reading docs/index.mdx · 46s'])
    expect(formatter.push(jsonl([{ type: 'result', status: 'success', stats: { duration_ms: 46_000, tool_calls: 1 } }]))).toEqual(['Gemini finished · 1 tool calls · 46s'])
    clock = 100_000
    expect(formatter.heartbeat()).toEqual([])
  })
})
