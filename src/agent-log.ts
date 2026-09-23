/**
 * Agent output formatters. Every unattended agent streams machine-readable
 * events on stdout; each formatter turns its agent's stream into the same
 * concise one-line activity summaries so the control center's live log reads
 * the same whichever agent is running, and reports tool calls so stage
 * progress can be derived from what the agent does.
 */
import type { AgentName, AgentUsage } from './types.js'

export interface AgentLogFormatter {
  /** Why the agent stopped without a successful result, once it reported one. */
  stopReason: string | undefined
  /**
   * True when the agent stopped because of a transient failure outside the
   * task, such as an API server error mid-response, so the same session can
   * be resumed instead of the run failing.
   */
  transientFailure?: boolean
  /** The agent's own session id, when it reported one, so the session can be resumed. */
  sessionId?: string | undefined
  /**
   * Token usage this agent session has reported so far, or undefined until the
   * stream carries any. One formatter is one process launch, so `sessions` is
   * always 1 here; callers merge resumed sessions with `mergeAgentUsage`.
   */
  readonly usage: AgentUsage | undefined
  /**
   * Called for every tool call the agent makes. Tool names and inputs are
   * normalized to Claude's vocabulary (`Bash` with `command`, `Write` with
   * `file_path`, `mcp__<server>__<tool>`) so one classifier serves every agent.
   */
  onToolCall: ((tool: string, input: JsonRecord) => void) | undefined
  push(chunk: Buffer | string): string[]
  finish(): string[]
  /**
   * What the agent is doing while its stream is quiet. Once nothing has been
   * written for the heartbeat interval this returns one progress line naming
   * the current phase and how long it has lasted — thinking, writing a long
   * reply, or waiting for a tool call — so a silent stretch reads as
   * progress instead of a hang. Callers poll it on a timer; `push` also
   * checks it, so a stream that is busy but prints nothing reports too.
   */
  heartbeat(now?: number): string[]
}

export interface AgentLogFormatterOptions {
  /** Clock override for tests. */
  now?: () => number
  /** Quiet time before a heartbeat line is written. */
  heartbeatMs?: number
}

/** Quiet time before a formatter names what the agent is doing. */
export const AGENT_LOG_HEARTBEAT_MS = 30_000
/** Tool calls faster than this get no duration suffix; the log's timestamps already cover them. */
const TOOL_DURATION_THRESHOLD_MS = 1_000

/**
 * Tracks the phase an agent session is in — waiting for a response, thinking,
 * writing, running a tool — so a quiet stretch can be named. Every line the
 * formatter writes resets the quiet timer; a phase that outlasts the interval
 * produces one heartbeat line per interval.
 */
class ActivityPulse {
  private phase: { description: string; detail: (() => string | undefined) | undefined; startedAt: number } | undefined
  private lastLineAt: number

  constructor(private readonly now: () => number, private readonly intervalMs: number) {
    this.lastLineAt = now()
  }

  begin(description: string, options: { detail?: () => string | undefined; startedAt?: number } = {}): void {
    this.phase = { description, detail: options.detail, startedAt: options.startedAt ?? this.now() }
  }

  end(): void {
    this.phase = undefined
  }

  /** Emitted lines reset the quiet timer; passes them through for chaining. */
  mark(lines: string[]): string[] {
    if (lines.length > 0) this.lastLineAt = this.now()
    return lines
  }

  lines(now: number = this.now()): string[] {
    if (!this.phase || now - this.lastLineAt < this.intervalMs) return []
    this.lastLineAt = now
    const detail = this.phase.detail?.()
    return [`… ${this.phase.description}${detail ? ` (${detail})` : ''} · ${formatLogDuration(now - this.phase.startedAt)}`]
  }
}

/** A finished tool call's duration, shown only once it is long enough to matter. */
function toolDurationSuffix(startedAt: number | undefined, now: number): string {
  if (startedAt === undefined) return ''
  const elapsed = now - startedAt
  return elapsed >= TOOL_DURATION_THRESHOLD_MS ? ` · ${formatLogDuration(elapsed)}` : ''
}

function charactersSoFar(count: number): string | undefined {
  return count > 0 ? `${formatTokenCount(count)} characters so far` : undefined
}

export function createAgentLogFormatter(agent: AgentName, options: AgentLogFormatterOptions = {}): AgentLogFormatter {
  if (agent === 'codex') return new CodexStreamLogFormatter(options)
  if (agent === 'gemini') return new GeminiStreamLogFormatter(options)
  return new ClaudeStreamLogFormatter(options)
}

/** Split a chunked stream into complete lines, keeping a partial tail. */
class LineBuffer {
  private buffer = ''

  push(chunk: Buffer | string): string[] {
    this.buffer += chunk.toString()
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    return lines
  }

  finish(): string[] {
    const remaining = this.buffer
    this.buffer = ''
    return remaining ? [remaining] : []
  }
}

export type JsonRecord = Record<string, unknown>

/** The four token counters every agent's usage is normalized to. */
interface TokenCounts {
  input: number
  output: number
  cacheRead: number
  cacheCreation: number
}

const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 }

function addTokens(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheCreation: a.cacheCreation + b.cacheCreation,
  }
}

/** Input + cache read + cache creation: the context one request was served with. */
function contextTokens(counts: TokenCounts): number {
  return counts.input + counts.cacheRead + counts.cacheCreation
}

/**
 * Claude's usage shape (`input_tokens`, `output_tokens`,
 * `cache_read_input_tokens`, `cache_creation_input_tokens`), shared by
 * assistant messages and the result event's cumulative `usage`.
 */
function claudeTokens(usage: JsonRecord | undefined): TokenCounts | undefined {
  if (!usage) return undefined
  const input = numberField(usage, 'input_tokens')
  const output = numberField(usage, 'output_tokens')
  if (input === undefined && output === undefined) return undefined
  return {
    input: input ?? 0,
    output: output ?? 0,
    cacheRead: numberField(usage, 'cache_read_input_tokens') ?? 0,
    cacheCreation: numberField(usage, 'cache_creation_input_tokens') ?? 0,
  }
}

/**
 * Tracks the wall-clock span of a stream so a session that never reports a
 * duration (a crash, a kill) still contributes elapsed time to the usage.
 */
class StreamClock {
  private startedAt: number | undefined
  private lastAt = 0

  touch(): void {
    const now = Date.now()
    this.startedAt ??= now
    this.lastAt = now
  }

  elapsedMs(): number {
    return this.startedAt === undefined ? 0 : Math.max(0, this.lastAt - this.startedAt)
  }
}

function buildUsage(
  tokens: TokenCounts,
  fields: { turns: number; maxContextTokens: number; durationMs: number; costUsd?: number | undefined },
): AgentUsage {
  return {
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheCreationTokens: tokens.cacheCreation,
    totalTokens: tokens.input + tokens.output + tokens.cacheRead + tokens.cacheCreation,
    ...(fields.costUsd !== undefined ? { costUsd: fields.costUsd } : {}),
    turns: fields.turns,
    sessions: 1,
    maxContextTokens: fields.maxContextTokens,
    durationMs: fields.durationMs,
  }
}

/**
 * Combine the usage of several agent sessions (a run that resumed, or the
 * plan and authoring phases of one request) into one total. Counters,
 * sessions, turns, and durations add up; the context high-water mark is the
 * largest seen; cost is present when any part reported one.
 */
export function mergeAgentUsage(...parts: Array<AgentUsage | undefined>): AgentUsage | undefined {
  const present = parts.filter((part): part is AgentUsage => part !== undefined)
  if (present.length === 0) return undefined
  const merged: AgentUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    totalTokens: 0,
    turns: 0,
    sessions: 0,
    maxContextTokens: 0,
    durationMs: 0,
  }
  let cost: number | undefined
  for (const part of present) {
    merged.inputTokens += part.inputTokens
    merged.outputTokens += part.outputTokens
    merged.cacheReadTokens += part.cacheReadTokens
    merged.cacheCreationTokens += part.cacheCreationTokens
    merged.totalTokens += part.totalTokens
    merged.turns += part.turns
    merged.sessions += part.sessions
    merged.maxContextTokens = Math.max(merged.maxContextTokens, part.maxContextTokens)
    merged.durationMs += part.durationMs
    if (part.costUsd !== undefined) cost = (cost ?? 0) + part.costUsd
  }
  if (cost !== undefined) merged.costUsd = cost
  return merged
}

/** `1234` → `1.2k`, `1_234_567` → `1.2M`; whole thousands drop the `.0`. */
export function formatTokenCount(count: number): string {
  const scaled = (value: number, suffix: string): string => {
    const text = value.toFixed(1)
    return `${text.endsWith('.0') ? text.slice(0, -2) : text}${suffix}`
  }
  if (count >= 1_000_000) return scaled(count / 1_000_000, 'M')
  if (count >= 1_000) return scaled(count / 1_000, 'k')
  return String(Math.round(count))
}

/** Share of the context the model read from cache, as a whole percentage, or undefined when nothing was cached. */
function cachedPercent(usage: AgentUsage): number | undefined {
  if (usage.cacheReadTokens === 0 && usage.cacheCreationTokens === 0) return undefined
  const context = usage.inputTokens + usage.cacheReadTokens + usage.cacheCreationTokens
  return context > 0 ? Math.round((usage.cacheReadTokens / context) * 100) : undefined
}

function formatUsageCost(cost: number): string {
  return cost > 0 && cost < 0.01 ? '<$0.01' : `$${cost.toFixed(2)}`
}

/**
 * One line for the UI: `1.2M tokens · 98% cached · $1.42 · 3 sessions`. Cost
 * is omitted when the agent never reported one; sessions when there was one.
 */
export function formatAgentUsage(usage: AgentUsage): string {
  const parts = [`${formatTokenCount(usage.totalTokens)} tokens`]
  const cached = cachedPercent(usage)
  if (cached !== undefined) parts.push(`${cached}% cached`)
  if (usage.costUsd !== undefined) parts.push(formatUsageCost(usage.costUsd))
  if (usage.sessions !== 1) parts.push(`${usage.sessions} sessions`)
  return parts.join(' · ')
}

/** The usage tail of a finished/stopped summary line: `1.2M tokens (98% cached) · $1.42`. */
function usageSummary(usage: AgentUsage | undefined): string {
  if (!usage || usage.totalTokens === 0) return ''
  const cached = cachedPercent(usage)
  const cost = usage.costUsd !== undefined ? ` · ${formatUsageCost(usage.costUsd)}` : ''
  return ` · ${formatTokenCount(usage.totalTokens)} tokens${cached !== undefined ? ` (${cached}% cached)` : ''}${cost}`
}

type ClaudeStreamBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; characters: number }
  | { type: 'tool'; id?: string; name: string; json: string; input?: JsonRecord }

/** A tool call the agent has made whose result has not arrived yet. */
interface PendingToolCall {
  activity: string
  startedAt: number
}

/** Convert Claude Code's JSONL stream into concise, durable UI log lines. */
export class ClaudeStreamLogFormatter implements AgentLogFormatter {
  private buffer = ''
  private readonly blocks = new Map<number, ClaudeStreamBlock>()
  private readonly tools = new Map<string, PendingToolCall>()
  private readonly now: () => number
  private readonly pulse: ActivityPulse
  private streamedContent = false
  private lastText = ''
  /** Why Claude stopped without a successful result, once its result event arrives. */
  stopReason: string | undefined
  /** True when the stop was a transient API failure rather than a task outcome. */
  transientFailure = false
  /** Claude's session id from its init event, so a cut-off session can be resumed. */
  sessionId: string | undefined
  /** Called for every tool call Claude makes, with the parsed input when it is readable. */
  onToolCall: ((tool: string, input: JsonRecord) => void) | undefined
  /**
   * Usage per assistant message id. With `--include-partial-messages` the same
   * assistant message is emitted once per content block, each carrying that
   * message's usage, so the last report per id wins instead of adding up.
   */
  private readonly messageUsage = new Map<string, TokenCounts>()
  /** Assistant messages that carried usage but no id; nothing to de-duplicate on. */
  private anonymousUsage: TokenCounts = ZERO_TOKENS
  private maxContextTokens = 0
  /** The result event's cumulative usage, preferred over the running sum once it arrives. */
  private resultTokens: TokenCounts | undefined
  private resultTurns: number | undefined
  private resultDurationMs: number | undefined
  private resultCostUsd: number | undefined
  private readonly clock = new StreamClock()

  constructor(options: AgentLogFormatterOptions = {}) {
    this.now = options.now ?? Date.now
    this.pulse = new ActivityPulse(this.now, options.heartbeatMs ?? AGENT_LOG_HEARTBEAT_MS)
  }

  heartbeat(now: number = this.now()): string[] {
    return this.pulse.lines(now)
  }

  get usage(): AgentUsage | undefined {
    const seen = this.messageUsage.size > 0 || contextTokens(this.anonymousUsage) + this.anonymousUsage.output > 0
    if (!seen && !this.resultTokens && this.resultTurns === undefined) return undefined
    let running = this.anonymousUsage
    for (const counts of this.messageUsage.values()) running = addTokens(running, counts)
    return buildUsage(this.resultTokens ?? running, {
      turns: this.resultTurns ?? this.messageUsage.size,
      maxContextTokens: this.maxContextTokens,
      durationMs: this.resultDurationMs ?? this.clock.elapsedMs(),
      costUsd: this.resultCostUsd,
    })
  }

  push(chunk: Buffer | string): string[] {
    this.buffer += chunk.toString()
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    const written = this.pulse.mark(lines.flatMap((line) => this.formatLine(line)))
    // A stream busy with thinking or a long reply prints nothing for minutes;
    // the deltas still arrive, so the heartbeat is checked here as well.
    return [...written, ...this.pulse.lines()]
  }

  finish(): string[] {
    const remaining = this.buffer
    this.buffer = ''
    return this.pulse.mark(remaining ? this.formatLine(remaining) : [])
  }

  private formatLine(line: string): string[] {
    if (!line.trim()) return []
    let message: JsonRecord
    try {
      const parsed = JSON.parse(line) as unknown
      const record = jsonRecord(parsed)
      if (!record) return [line]
      message = record
    } catch {
      return [line]
    }

    const type = stringField(message, 'type')
    this.clock.touch()
    if (type === 'stream_event') return this.formatStreamEvent(jsonRecord(message.event))
    if (type === 'assistant') this.recordAssistantUsage(jsonRecord(message.message))
    if (type === 'assistant' && !this.streamedContent) {
      return this.formatAssistantMessage(jsonRecord(message.message))
    }
    if (type === 'user') return this.formatToolResults(jsonRecord(message.message))
    if (type === 'result') return this.formatResult(message)
    if (type === 'system') return this.formatSystem(message)
    return []
  }

  private formatStreamEvent(event: JsonRecord | undefined): string[] {
    if (!event) return []
    const eventType = stringField(event, 'type')
    if (eventType === 'message_start') {
      this.blocks.clear()
      return []
    }
    const index = numberField(event, 'index')
    if (index === undefined) return []

    if (eventType === 'content_block_start') {
      const content = jsonRecord(event.content_block)
      if (!content) return []
      const contentType = stringField(content, 'type')
      if (contentType === 'text') {
        const block: ClaudeStreamBlock = { type: 'text', text: stringField(content, 'text') ?? '' }
        this.blocks.set(index, block)
        this.streamedContent = true
        this.pulse.begin('Claude is writing its reply', { detail: () => charactersSoFar(block.text.length) })
      } else if (contentType === 'tool_use') {
        const name = stringField(content, 'name') ?? 'tool'
        const block: ClaudeStreamBlock = {
          type: 'tool',
          ...(stringField(content, 'id') ? { id: stringField(content, 'id')! } : {}),
          name,
          json: '',
          ...(jsonRecord(content.input) ? { input: jsonRecord(content.input)! } : {}),
        }
        this.blocks.set(index, block)
        this.streamedContent = true
        this.pulse.begin(`Claude is preparing a ${name} call`, { detail: () => charactersSoFar(block.json.length) })
      } else if (contentType === 'thinking' || contentType === 'redacted_thinking') {
        const block: ClaudeStreamBlock = { type: 'thinking', characters: 0 }
        this.blocks.set(index, block)
        this.pulse.begin('Claude is thinking', { detail: () => charactersSoFar(block.characters) })
      }
      return []
    }

    if (eventType === 'content_block_delta') {
      const block = this.blocks.get(index)
      const delta = jsonRecord(event.delta)
      if (!block || !delta) return []
      if (block.type === 'text' && stringField(delta, 'type') === 'text_delta') {
        block.text += stringField(delta, 'text') ?? ''
      } else if (block.type === 'tool' && stringField(delta, 'type') === 'input_json_delta') {
        block.json += stringField(delta, 'partial_json') ?? ''
      } else if (block.type === 'thinking' && stringField(delta, 'type') === 'thinking_delta') {
        block.characters += (stringField(delta, 'thinking') ?? '').length
      }
      return []
    }

    if (eventType !== 'content_block_stop') return []
    const block = this.blocks.get(index)
    this.blocks.delete(index)
    if (!block) return []
    if (block.type === 'thinking') {
      this.awaitNextStep()
      return []
    }
    if (block.type === 'text') {
      this.awaitNextStep()
      return this.textLines(block.text)
    }

    let input = block.input ?? {}
    if (block.json) {
      try {
        input = jsonRecord(JSON.parse(block.json) as unknown) ?? input
      } catch {
        // A malformed partial tool input still has a useful tool name.
      }
    }
    const activity = formatClaudeToolActivity(block.name, input)
    this.beginToolCall(block.id, activity)
    this.onToolCall?.(block.name, input)
    return [`→ ${activity}`]
  }

  /** Claude Code runs the tool as soon as its call is complete; the result arrives as a user message. */
  private beginToolCall(id: string | undefined, activity: string): void {
    const startedAt = this.now()
    if (id) this.tools.set(id, { activity, startedAt })
    this.pulse.begin(`waiting for ${activity} to finish`, { startedAt })
  }

  /** A block or tool result just ended: the next event is either another tool result or Claude's own. */
  private awaitNextStep(): void {
    const pending = [...this.tools.values()].at(-1)
    if (pending) this.pulse.begin(`waiting for ${pending.activity} to finish`, { startedAt: pending.startedAt })
    else this.pulse.begin("waiting for Claude's next step")
  }

  private recordAssistantUsage(message: JsonRecord | undefined): void {
    const counts = message ? claudeTokens(jsonRecord(message.usage)) : undefined
    if (!counts) return
    this.maxContextTokens = Math.max(this.maxContextTokens, contextTokens(counts))
    const id = message ? stringField(message, 'id') : undefined
    if (id) this.messageUsage.set(id, counts)
    else this.anonymousUsage = addTokens(this.anonymousUsage, counts)
  }

  /**
   * The result event's totals: its `usage` object when present, else the sum
   * of its per-model `modelUsage` map, else nothing (the running sum stands).
   */
  private recordResultUsage(message: JsonRecord): void {
    this.resultTurns = numberField(message, 'num_turns') ?? this.resultTurns
    this.resultDurationMs = numberField(message, 'duration_ms') ?? this.resultDurationMs
    this.resultCostUsd = numberField(message, 'total_cost_usd') ?? this.resultCostUsd
    const totals = claudeTokens(jsonRecord(message.usage))
    if (totals) {
      this.resultTokens = totals
      return
    }
    const perModel = jsonRecord(message.modelUsage)
    if (!perModel) return
    let summed: TokenCounts | undefined
    let cost: number | undefined
    for (const entry of Object.values(perModel)) {
      const record = jsonRecord(entry)
      if (!record) continue
      summed = addTokens(summed ?? ZERO_TOKENS, {
        input: numberField(record, 'inputTokens') ?? 0,
        output: numberField(record, 'outputTokens') ?? 0,
        cacheRead: numberField(record, 'cacheReadInputTokens') ?? 0,
        cacheCreation: numberField(record, 'cacheCreationInputTokens') ?? 0,
      })
      const modelCost = numberField(record, 'costUSD')
      if (modelCost !== undefined) cost = (cost ?? 0) + modelCost
    }
    if (summed) this.resultTokens = summed
    if (this.resultCostUsd === undefined && cost !== undefined) this.resultCostUsd = cost
  }

  private formatAssistantMessage(message: JsonRecord | undefined): string[] {
    const content = message?.content
    if (!Array.isArray(content)) return []
    const lines: string[] = []
    for (const rawBlock of content) {
      const block = jsonRecord(rawBlock)
      if (!block) continue
      const type = stringField(block, 'type')
      if (type === 'text') {
        lines.push(...this.textLines(stringField(block, 'text') ?? ''))
      } else if (type === 'tool_use') {
        const name = stringField(block, 'name') ?? 'tool'
        const input = jsonRecord(block.input) ?? {}
        const activity = formatClaudeToolActivity(name, input)
        this.beginToolCall(stringField(block, 'id'), activity)
        this.onToolCall?.(name, input)
        lines.push(`→ ${activity}`)
      }
    }
    return lines
  }

  private formatToolResults(message: JsonRecord | undefined): string[] {
    const content = message?.content
    if (!Array.isArray(content)) return []
    const lines: string[] = []
    for (const rawBlock of content) {
      const block = jsonRecord(rawBlock)
      if (!block || stringField(block, 'type') !== 'tool_result') continue
      const id = stringField(block, 'tool_use_id')
      const pending = id ? this.tools.get(id) : undefined
      if (id) this.tools.delete(id)
      const activity = pending?.activity ?? 'Tool action'
      const duration = toolDurationSuffix(pending?.startedAt, this.now())
      if (block.is_error === true) {
        const detail = compactClaudeValue(block.content)
        lines.push(`✗ ${activity} failed${detail ? `: ${detail}` : ''}${duration}`)
      } else {
        lines.push(`✓ ${activity}${duration}`)
      }
    }
    this.awaitNextStep()
    return lines
  }

  private formatSystem(message: JsonRecord): string[] {
    const subtype = stringField(message, 'subtype')
    if (subtype === 'init') {
      const model = stringField(message, 'model')
      this.sessionId = stringField(message, 'session_id') ?? this.sessionId
      this.pulse.begin("waiting for Claude's first response")
      return [`Claude session started${model ? ` · ${model}` : ''}`]
    }
    if (subtype === 'api_retry') {
      const attempt = numberField(message, 'attempt')
      const maximum = numberField(message, 'max_retries')
      const delay = numberField(message, 'retry_delay_ms')
      return [
        `Claude API retry${attempt ? ` ${attempt}${maximum ? `/${maximum}` : ''}` : ''}${delay ? ` in ${Math.ceil(delay / 1000)}s` : ''}`,
      ]
    }
    if (subtype === 'compact_boundary') return ['Claude compacted its working context.']
    return []
  }

  private formatResult(message: JsonRecord): string[] {
    const subtype = stringField(message, 'subtype')
    const success = subtype === 'success' && message.is_error !== true
    const turns = numberField(message, 'num_turns')
    const duration = numberField(message, 'duration_ms')
    const result = stringField(message, 'result')
    this.recordResultUsage(message)
    this.pulse.end()
    // A result event that is an error but has no `errors` list carries the
    // failure in its text (or in the last assistant text), such as
    // "API Error: Server error mid-response".
    if (success) { this.stopReason = undefined; this.transientFailure = false }
    const stop = success ? undefined : claudeStopReason(subtype, turns, message, result ?? this.lastText)
    if (stop) {
      this.stopReason = stop.reason
      this.transientFailure = stop.transient
    }
    const reason = stop?.reason
    const summary = `Claude ${success ? 'finished' : 'stopped'}${turns !== undefined ? ` · ${turns} turns` : ''}${duration !== undefined ? ` · ${formatLogDuration(duration)}` : ''}${usageSummary(this.usage)}${reason ? ` · ${reason}` : ''}`
    return [...(result ? this.textLines(result) : []), summary]
  }

  private textLines(text: string): string[] {
    const normalized = text.trim()
    if (!normalized || normalized === this.lastText) return []
    this.lastText = normalized
    return normalized.split(/\r?\n/).filter(Boolean)
  }
}

/**
 * A bare "exited with status 1" hides why a run ended. Claude's result event
 * names the cause, and the turn limit in particular needs to be visible: it
 * looks like an agent failure but is a Doxloop budget. A transient API
 * failure is flagged so the runner can resume the session rather than fail.
 */
function claudeStopReason(
  subtype: string | undefined,
  turns: number | undefined,
  message: JsonRecord,
  errorText: string | undefined,
): { reason: string; transient: boolean } {
  const reported = Array.isArray(message.errors)
    ? message.errors
      .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      .map((item) => compactLogText(item))
    : []
  if (subtype === 'error_max_turns') {
    return {
      reason: `reached its ${turns !== undefined ? `${turns}-turn` : 'turn'} limit before finishing; retry the stage to continue from the preserved workspace`,
      transient: false,
    }
  }
  if (subtype === 'error_max_budget_usd') {
    return {
      reason: 'reached the configured spending cap before finishing; raise "Maximum Claude spend" under Monitoring → Advanced watch scope and budgets, or retry the stage to continue from the preserved workspace',
      transient: false,
    }
  }
  const detail = reported.length > 0 ? reported.join('; ') : errorText?.trim() ? compactLogText(errorText) : ''
  if (detail && isTransientClaudeApiFailure(detail)) {
    return { reason: `stopped because its API request failed: ${detail}`, transient: true }
  }
  if (detail) return { reason: `stopped with an error: ${detail}`, transient: false }
  if (subtype === 'error_during_execution') return { reason: 'stopped with an error during execution', transient: false }
  return { reason: subtype ? `stopped with result "${subtype}"` : 'stopped without a result', transient: false }
}

/**
 * Failures that come from the Claude API or the network rather than from the
 * task: the session is intact and continues where it stopped when resumed.
 */
export function isTransientClaudeApiFailure(text: string): boolean {
  return /\bAPI Error\b|server error|mid-response|overloaded|internal server error|rate limit|too many requests|\b(?:429|500|502|503|504|529)\b|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed|network error|stream (?:closed|ended|error)|connection (?:error|reset|closed)/i.test(text)
}

function writeClaudeLogLines(lines: string[]): void {
  for (const line of lines) process.stdout.write(`${line}\n`)
}

function formatClaudeToolActivity(name: string, input: JsonRecord): string {
  const path = stringField(input, 'file_path') ?? stringField(input, 'path')
  const pattern = stringField(input, 'pattern')
  const description = stringField(input, 'description')
  const command = stringField(input, 'command')
  const query = stringField(input, 'query')
  const url = stringField(input, 'url')
  const prompt = stringField(input, 'prompt')

  if (name === 'Read') return `Reading ${compactLogText(path ?? 'a file')}`
  if (name === 'Write') return `Writing ${compactLogText(path ?? 'a file')}`
  if (name === 'Edit' || name === 'MultiEdit') return `Editing ${compactLogText(path ?? 'a file')}`
  if (name === 'Glob') return `Finding files matching ${compactLogText(pattern ?? '*')}`
  if (name === 'Grep') return `Searching${pattern ? ` for ${compactLogText(pattern)}` : ''}${path ? ` in ${compactLogText(path)}` : ''}`
  if (name === 'Bash') return `Running ${compactLogText(description ?? command ?? 'a command')}`
  if (name === 'WebFetch') return `Fetching ${compactLogText(url ?? 'a web page')}`
  if (name === 'WebSearch') return `Searching the web${query ? ` for ${compactLogText(query)}` : ''}`
  if (name === 'Skill') return `Loading skill ${compactLogText(stringField(input, 'skill') ?? 'instructions')}`
  if (name === 'ToolSearch') return `Looking up tools${query ? ` matching ${compactLogText(query)}` : ''}`
  if (name === 'Agent' || name === 'Task') return `Starting subtask${description || prompt ? `: ${compactLogText(description ?? prompt ?? '')}` : ''}`
  return `Using ${compactLogText(name)}`
}

function compactClaudeValue(value: unknown): string {
  if (typeof value === 'string') return compactLogText(value)
  if (!Array.isArray(value)) return ''
  return compactLogText(
    value
      .map((item) => stringField(jsonRecord(item) ?? {}, 'text') ?? '')
      .filter(Boolean)
      .join(' '),
  )
}

/**
 * Codex `exec --json` emits one JSON object per line: thread and turn
 * lifecycle events plus `item.started` / `item.completed` for each message,
 * command, file change, and MCP call.
 */
export class CodexStreamLogFormatter implements AgentLogFormatter {
  private readonly lines = new LineBuffer()
  /** Items Codex has started, by id, with the time they started. */
  private readonly startedItems = new Map<string, number>()
  private readonly now: () => number
  private readonly pulse: ActivityPulse
  private lastText = ''
  stopReason: string | undefined
  onToolCall: ((tool: string, input: JsonRecord) => void) | undefined
  /** Sum of every `turn.completed` usage, or the last cumulative `token_count` total when the stream carries one. */
  private tokens: TokenCounts | undefined
  private turns = 0
  private maxContextTokens = 0
  private readonly clock = new StreamClock()

  constructor(options: AgentLogFormatterOptions = {}) {
    this.now = options.now ?? Date.now
    this.pulse = new ActivityPulse(this.now, options.heartbeatMs ?? AGENT_LOG_HEARTBEAT_MS)
  }

  heartbeat(now: number = this.now()): string[] {
    return this.pulse.lines(now)
  }

  get usage(): AgentUsage | undefined {
    if (!this.tokens) return undefined
    return buildUsage(this.tokens, {
      turns: this.turns,
      maxContextTokens: this.maxContextTokens,
      durationMs: this.clock.elapsedMs(),
    })
  }

  /**
   * Codex counts cached prompt tokens inside `input_tokens`; Claude reports
   * them separately. Split them out so "input" means uncached input for every
   * agent and the four counters add up to the total either way.
   */
  private static tokensOf(usage: JsonRecord | undefined): TokenCounts | undefined {
    if (!usage) return undefined
    const input = numberField(usage, 'input_tokens')
    const output = numberField(usage, 'output_tokens')
    if (input === undefined && output === undefined) return undefined
    const cached = Math.min(numberField(usage, 'cached_input_tokens') ?? 0, input ?? 0)
    return { input: (input ?? 0) - cached, output: output ?? 0, cacheRead: cached, cacheCreation: 0 }
  }

  push(chunk: Buffer | string): string[] {
    const written = this.pulse.mark(this.lines.push(chunk).flatMap((line) => this.formatLine(line)))
    return [...written, ...this.pulse.lines()]
  }

  finish(): string[] {
    return this.pulse.mark(this.lines.finish().flatMap((line) => this.formatLine(line)))
  }

  private formatLine(line: string): string[] {
    if (!line.trim()) return []
    let message: JsonRecord
    try {
      const record = jsonRecord(JSON.parse(line) as unknown)
      if (!record) return [line]
      message = record
    } catch {
      return [line]
    }
    const type = stringField(message, 'type')
    this.clock.touch()
    if (type === 'thread.started') {
      this.pulse.begin("waiting for Codex's first response")
      return ['Codex session started']
    }
    if (type === 'turn.failed') {
      const error = jsonRecord(message.error)
      const detail = error ? stringField(error, 'message') : undefined
      this.stopReason = `stopped with an error${detail ? `: ${compactLogText(detail)}` : ''}`
      return [`Codex ${this.stopReason}`]
    }
    if (type === 'error') {
      const detail = stringField(message, 'message')
      this.stopReason = `stopped with an error${detail ? `: ${compactLogText(detail)}` : ''}`
      return [`Codex ${this.stopReason}`]
    }
    if (type === 'turn.completed') {
      const counts = CodexStreamLogFormatter.tokensOf(jsonRecord(message.usage))
      this.turns += 1
      // A turn's usage is the sum over every request in the turn, not one
      // request's context, so it says nothing about context size; only a
      // token_count event's last_token_usage does.
      if (counts) this.tokens = addTokens(this.tokens ?? ZERO_TOKENS, counts)
      this.pulse.end()
      return [`Codex finished · ${this.turns} turn${this.turns === 1 ? '' : 's'}${usageSummary(this.usage)}`]
    }
    if (type === 'token_count' || type === 'thread.token_usage') {
      // Codex core's cumulative counter: `info.total_token_usage` is the
      // session total so far and `info.last_token_usage` the latest request.
      const info = jsonRecord(message.info) ?? jsonRecord(message.usage) ?? message
      const total = CodexStreamLogFormatter.tokensOf(jsonRecord(info.total_token_usage) ?? jsonRecord(info.total))
      const last = CodexStreamLogFormatter.tokensOf(jsonRecord(info.last_token_usage) ?? jsonRecord(info.last))
      if (total) this.tokens = total
      if (last) this.maxContextTokens = Math.max(this.maxContextTokens, contextTokens(last))
      return []
    }
    if (type !== 'item.started' && type !== 'item.completed') return []
    const item = jsonRecord(message.item)
    if (!item) return []
    return type === 'item.started' ? this.itemStarted(item) : this.itemCompleted(item)
  }

  private itemStarted(item: JsonRecord): string[] {
    const id = stringField(item, 'id')
    const startedAt = this.now()
    if (id) this.startedItems.set(id, startedAt)
    const activity = this.activity(item)
    if (!activity) return []
    this.reportTool(item)
    this.pulse.begin(`waiting for ${activity} to finish`, { startedAt })
    return [`→ ${activity}`]
  }

  private itemCompleted(item: JsonRecord): string[] {
    const kind = stringField(item, 'type')
    const id = stringField(item, 'id')
    const startedAt = id !== undefined ? this.startedItems.get(id) : undefined
    const started = startedAt !== undefined
    if (id) this.startedItems.delete(id)
    this.pulse.begin("waiting for Codex's next step")
    if (kind === 'agent_message') return this.textLines(stringField(item, 'text') ?? '')
    if (kind === 'reasoning') return []
    if (kind === 'error') return [`✗ ${compactLogText(stringField(item, 'message') ?? 'Codex reported an error')}`]
    if (kind === 'todo_list') {
      const items = Array.isArray(item.items) ? item.items : []
      const done = items.filter((entry) => jsonRecord(entry)?.completed === true).length
      return [`Plan: ${done} of ${items.length} steps done`]
    }
    const activity = this.activity(item)
    if (!activity) return []
    if (!started) this.reportTool(item)
    const status = stringField(item, 'status')
    const exitCode = numberField(item, 'exit_code')
    const failed = status === 'failed' || status === 'declined' || (exitCode !== undefined && exitCode !== 0)
    const duration = toolDurationSuffix(startedAt, this.now())
    return [failed ? `✗ ${activity} failed${exitCode !== undefined && exitCode !== 0 ? ` (exit ${exitCode})` : ''}${duration}` : `✓ ${activity}${duration}`]
  }

  private activity(item: JsonRecord): string | undefined {
    const kind = stringField(item, 'type')
    if (kind === 'command_execution') return `Running ${compactLogText(stringField(item, 'command') ?? 'a command')}`
    if (kind === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes.flatMap((change) => {
        const record = jsonRecord(change)
        return record && stringField(record, 'path') ? [stringField(record, 'path')!] : []
      }) : []
      return changes.length > 0 ? `Editing ${compactLogText(changes.join(', '))}` : 'Editing files'
    }
    if (kind === 'mcp_tool_call') {
      return `Using ${compactLogText(`${stringField(item, 'server') ?? 'mcp'} ${stringField(item, 'tool') ?? 'tool'}`)}`
    }
    if (kind === 'web_search') return `Searching the web${stringField(item, 'query') ? ` for ${compactLogText(stringField(item, 'query')!)}` : ''}`
    return undefined
  }

  /** Report the call in Claude's tool vocabulary so one classifier fits all agents. */
  private reportTool(item: JsonRecord): void {
    if (!this.onToolCall) return
    const kind = stringField(item, 'type')
    if (kind === 'command_execution') {
      this.onToolCall('Bash', { command: stringField(item, 'command') ?? '' })
    } else if (kind === 'mcp_tool_call') {
      const server = stringField(item, 'server') ?? 'mcp'
      const tool = stringField(item, 'tool') ?? 'tool'
      this.onToolCall(`mcp__${server}__${tool}`, jsonRecord(item.arguments) ?? {})
    } else if (kind === 'file_change') {
      const changes = Array.isArray(item.changes) ? item.changes : []
      for (const change of changes) {
        const record = jsonRecord(change)
        const path = record ? stringField(record, 'path') : undefined
        if (path) this.onToolCall('Write', { file_path: path })
      }
    }
  }

  private textLines(text: string): string[] {
    const normalized = text.trim()
    if (!normalized || normalized === this.lastText) return []
    this.lastText = normalized
    return normalized.split(/\r?\n/).filter(Boolean)
  }
}

/**
 * Gemini CLI `--output-format stream-json` emits init, message, tool_use,
 * tool_result, error, and result events. Assistant text arrives as deltas
 * that are joined until the next event of another kind.
 */
export class GeminiStreamLogFormatter implements AgentLogFormatter {
  private readonly lines = new LineBuffer()
  private readonly tools = new Map<string, PendingToolCall>()
  private readonly now: () => number
  private readonly pulse: ActivityPulse
  private assistantText = ''
  private lastText = ''
  stopReason: string | undefined
  onToolCall: ((tool: string, input: JsonRecord) => void) | undefined
  /** Set from the result event's `stats` when it carries token counts; Gemini reports nothing per message. */
  usage: AgentUsage | undefined
  private readonly clock = new StreamClock()

  constructor(options: AgentLogFormatterOptions = {}) {
    this.now = options.now ?? Date.now
    this.pulse = new ActivityPulse(this.now, options.heartbeatMs ?? AGENT_LOG_HEARTBEAT_MS)
  }

  heartbeat(now: number = this.now()): string[] {
    return this.pulse.lines(now)
  }

  push(chunk: Buffer | string): string[] {
    const written = this.pulse.mark(this.lines.push(chunk).flatMap((line) => this.formatLine(line)))
    return [...written, ...this.pulse.lines()]
  }

  finish(): string[] {
    return this.pulse.mark([...this.lines.finish().flatMap((line) => this.formatLine(line)), ...this.flushText()])
  }

  private formatLine(line: string): string[] {
    if (!line.trim()) return []
    let message: JsonRecord
    try {
      const record = jsonRecord(JSON.parse(line) as unknown)
      if (!record) return [line]
      message = record
    } catch {
      return [line]
    }
    const type = stringField(message, 'type')
    this.clock.touch()
    if (type === 'message') {
      if (stringField(message, 'role') !== 'assistant') return []
      const content = stringField(message, 'content') ?? ''
      if (message.delta === true) {
        this.assistantText += content
        return []
      }
      return [...this.flushText(), ...this.textLines(content)]
    }
    const pending = this.flushText()
    if (type === 'init') {
      const model = stringField(message, 'model')
      this.pulse.begin("waiting for Gemini's first response")
      return [...pending, `Gemini session started${model ? ` · ${model}` : ''}`]
    }
    if (type === 'tool_use') {
      const name = stringField(message, 'tool_name') ?? 'tool'
      const parameters = jsonRecord(message.parameters) ?? {}
      const activity = formatGeminiToolActivity(name, parameters)
      const id = stringField(message, 'tool_id')
      const startedAt = this.now()
      if (id) this.tools.set(id, { activity, startedAt })
      this.reportTool(name, parameters)
      this.pulse.begin(`waiting for ${activity} to finish`, { startedAt })
      return [...pending, `→ ${activity}`]
    }
    if (type === 'tool_result') {
      const id = stringField(message, 'tool_id')
      const call = id ? this.tools.get(id) : undefined
      const activity = call?.activity ?? 'Tool action'
      if (id) this.tools.delete(id)
      const duration = toolDurationSuffix(call?.startedAt, this.now())
      this.pulse.begin("waiting for Gemini's next step")
      if (stringField(message, 'status') === 'error') {
        const detail = stringField(message, 'output') ?? stringField(message, 'error')
        return [...pending, `✗ ${activity} failed${detail ? `: ${compactLogText(detail)}` : ''}${duration}`]
      }
      return [...pending, `✓ ${activity}${duration}`]
    }
    if (type === 'error') {
      const detail = stringField(message, 'message')
      const fatal = stringField(message, 'severity') !== 'warning'
      if (fatal) this.stopReason = `stopped with an error${detail ? `: ${compactLogText(detail)}` : ''}`
      return [...pending, `${fatal ? '✗' : '!'} ${compactLogText(detail ?? 'Gemini reported an error')}`]
    }
    if (type === 'result') {
      const success = stringField(message, 'status') === 'success'
      const stats = jsonRecord(message.stats)
      const duration = stats ? numberField(stats, 'duration_ms') : undefined
      const calls = stats ? numberField(stats, 'tool_calls') : undefined
      this.usage = geminiUsage(stats, duration ?? this.clock.elapsedMs()) ?? this.usage
      this.pulse.end()
      if (!success && !this.stopReason) {
        const detail = jsonRecord(message.error)
        const reason = detail ? stringField(detail, 'message') : stringField(message, 'error')
        this.stopReason = reason ? `stopped with an error: ${compactLogText(reason)}` : 'stopped without a successful result'
      }
      return [
        ...pending,
        `Gemini ${success ? 'finished' : 'stopped'}${calls !== undefined ? ` · ${calls} tool calls` : ''}${duration !== undefined ? ` · ${formatLogDuration(duration)}` : ''}${usageSummary(this.usage)}${!success && this.stopReason ? ` · ${this.stopReason}` : ''}`,
      ]
    }
    return pending
  }

  private reportTool(name: string, parameters: JsonRecord): void {
    if (!this.onToolCall) return
    if (name === 'run_shell_command' || name === 'ShellTool') {
      this.onToolCall('Bash', { command: stringField(parameters, 'command') ?? '' })
      return
    }
    if (name === 'write_file' || name === 'WriteFile' || name === 'replace' || name === 'Edit') {
      this.onToolCall(name === 'write_file' || name === 'WriteFile' ? 'Write' : 'Edit', { file_path: stringField(parameters, 'file_path') ?? stringField(parameters, 'path') ?? '' })
      return
    }
    this.onToolCall(name, parameters)
  }

  private flushText(): string[] {
    const text = this.assistantText
    this.assistantText = ''
    return this.textLines(text)
  }

  private textLines(text: string): string[] {
    const normalized = text.trim()
    if (!normalized || normalized === this.lastText) return []
    this.lastText = normalized
    return normalized.split(/\r?\n/).filter(Boolean)
  }
}

/**
 * Gemini's result `stats` either carry flat token counts (`input_tokens`,
 * `output_tokens`, `cached_tokens`) or a per-model map whose `tokens` object
 * has `prompt`, `candidates`, and `cached`. Anything else leaves usage unset.
 */
function geminiUsage(stats: JsonRecord | undefined, durationMs: number): AgentUsage | undefined {
  if (!stats) return undefined
  let counts: TokenCounts | undefined
  const input = numberField(stats, 'input_tokens') ?? numberField(stats, 'prompt_tokens')
  const output = numberField(stats, 'output_tokens') ?? numberField(stats, 'candidates_tokens')
  if (input !== undefined || output !== undefined) {
    const cached = Math.min(numberField(stats, 'cached_tokens') ?? numberField(stats, 'cached_content_tokens') ?? 0, input ?? 0)
    counts = { input: (input ?? 0) - cached, output: output ?? 0, cacheRead: cached, cacheCreation: 0 }
  } else {
    const models = jsonRecord(stats.models)
    for (const entry of Object.values(models ?? {})) {
      const tokens = jsonRecord(jsonRecord(entry)?.tokens)
      if (!tokens) continue
      const prompt = numberField(tokens, 'prompt') ?? 0
      const cached = Math.min(numberField(tokens, 'cached') ?? 0, prompt)
      counts = addTokens(counts ?? ZERO_TOKENS, {
        input: prompt - cached,
        output: (numberField(tokens, 'candidates') ?? 0) + (numberField(tokens, 'thoughts') ?? 0),
        cacheRead: cached,
        cacheCreation: 0,
      })
    }
  }
  if (!counts) return undefined
  return buildUsage(counts, {
    turns: numberField(stats, 'turns') ?? numberField(stats, 'tool_calls') ?? 0,
    // Gemini reports session totals only, so the largest context is unknown; the total input is an upper bound.
    maxContextTokens: contextTokens(counts),
    durationMs,
  })
}

function formatGeminiToolActivity(name: string, parameters: JsonRecord): string {
  const path = stringField(parameters, 'file_path') ?? stringField(parameters, 'path') ?? stringField(parameters, 'absolute_path')
  const command = stringField(parameters, 'command')
  const pattern = stringField(parameters, 'pattern')
  const query = stringField(parameters, 'query')
  const url = stringField(parameters, 'url') ?? stringField(parameters, 'prompt')
  if (name === 'read_file' || name === 'ReadFile') return `Reading ${compactLogText(path ?? 'a file')}`
  if (name === 'read_many_files' || name === 'ReadManyFiles') return 'Reading several files'
  if (name === 'write_file' || name === 'WriteFile') return `Writing ${compactLogText(path ?? 'a file')}`
  if (name === 'replace' || name === 'Edit') return `Editing ${compactLogText(path ?? 'a file')}`
  if (name === 'run_shell_command' || name === 'ShellTool') return `Running ${compactLogText(stringField(parameters, 'description') ?? command ?? 'a command')}`
  if (name === 'glob' || name === 'FindFiles') return `Finding files matching ${compactLogText(pattern ?? '*')}`
  if (name === 'search_file_content' || name === 'grep_search' || name === 'SearchText') return `Searching${pattern ? ` for ${compactLogText(pattern)}` : ''}${path ? ` in ${compactLogText(path)}` : ''}`
  if (name === 'list_directory' || name === 'ReadFolder') return `Listing ${compactLogText(path ?? 'a folder')}`
  if (name === 'web_fetch' || name === 'WebFetch') return `Fetching ${compactLogText(url ?? 'a web page')}`
  if (name === 'google_web_search' || name === 'GoogleSearch') return `Searching the web${query ? ` for ${compactLogText(query)}` : ''}`
  if (name === 'save_memory') return 'Saving a note to memory'
  return `Using ${compactLogText(name)}`
}

export function compactLogText(value: string, maximum = 240): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact
}

export function formatLogDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.round(milliseconds / 1000))
  const minutes = Math.floor(seconds / 60)
  const remaining = seconds % 60
  return minutes > 0 ? `${minutes}m ${remaining}s` : `${remaining}s`
}

export function jsonRecord(value: unknown): JsonRecord | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonRecord)
    : undefined
}

export function stringField(record: JsonRecord, key: string): string | undefined {
  return typeof record[key] === 'string' ? record[key] : undefined
}

export function numberField(record: JsonRecord, key: string): number | undefined {
  return typeof record[key] === 'number' ? record[key] : undefined
}
