/**
 * Agent output formatters. Every unattended agent streams machine-readable
 * events on stdout; each formatter turns its agent's stream into the same
 * concise one-line activity summaries so the control center's live log reads
 * the same whichever agent is running, and reports tool calls so stage
 * progress can be derived from what the agent does.
 */
import type { AgentName } from './types.js'

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
   * Called for every tool call the agent makes. Tool names and inputs are
   * normalized to Claude's vocabulary (`Bash` with `command`, `Write` with
   * `file_path`, `mcp__<server>__<tool>`) so one classifier serves every agent.
   */
  onToolCall: ((tool: string, input: JsonRecord) => void) | undefined
  push(chunk: Buffer | string): string[]
  finish(): string[]
}

export function createAgentLogFormatter(agent: AgentName): AgentLogFormatter {
  if (agent === 'codex') return new CodexStreamLogFormatter()
  if (agent === 'gemini') return new GeminiStreamLogFormatter()
  return new ClaudeStreamLogFormatter()
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
type ClaudeStreamBlock =
  | { type: 'text'; text: string }
  | { type: 'tool'; id?: string; name: string; json: string; input?: JsonRecord }

/** Convert Claude Code's JSONL stream into concise, durable UI log lines. */
export class ClaudeStreamLogFormatter implements AgentLogFormatter {
  private buffer = ''
  private readonly blocks = new Map<number, ClaudeStreamBlock>()
  private readonly tools = new Map<string, string>()
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

  push(chunk: Buffer | string): string[] {
    this.buffer += chunk.toString()
    const lines = this.buffer.split(/\r?\n/)
    this.buffer = lines.pop() ?? ''
    return lines.flatMap((line) => this.formatLine(line))
  }

  finish(): string[] {
    const remaining = this.buffer
    this.buffer = ''
    return remaining ? this.formatLine(remaining) : []
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
    if (type === 'stream_event') return this.formatStreamEvent(jsonRecord(message.event))
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
        this.blocks.set(index, { type: 'text', text: stringField(content, 'text') ?? '' })
        this.streamedContent = true
      } else if (contentType === 'tool_use') {
        const name = stringField(content, 'name') ?? 'tool'
        this.blocks.set(index, {
          type: 'tool',
          ...(stringField(content, 'id') ? { id: stringField(content, 'id')! } : {}),
          name,
          json: '',
          ...(jsonRecord(content.input) ? { input: jsonRecord(content.input)! } : {}),
        })
        this.streamedContent = true
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
      }
      return []
    }

    if (eventType !== 'content_block_stop') return []
    const block = this.blocks.get(index)
    this.blocks.delete(index)
    if (!block) return []
    if (block.type === 'text') return this.textLines(block.text)

    let input = block.input ?? {}
    if (block.json) {
      try {
        input = jsonRecord(JSON.parse(block.json) as unknown) ?? input
      } catch {
        // A malformed partial tool input still has a useful tool name.
      }
    }
    const activity = formatClaudeToolActivity(block.name, input)
    if (block.id) this.tools.set(block.id, activity)
    this.onToolCall?.(block.name, input)
    return [`→ ${activity}`]
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
        const id = stringField(block, 'id')
        if (id) this.tools.set(id, activity)
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
      const activity = (id && this.tools.get(id)) || 'Tool action'
      if (block.is_error === true) {
        const detail = compactClaudeValue(block.content)
        lines.push(`✗ ${activity} failed${detail ? `: ${detail}` : ''}`)
      } else {
        lines.push(`✓ ${activity}`)
      }
    }
    return lines
  }

  private formatSystem(message: JsonRecord): string[] {
    const subtype = stringField(message, 'subtype')
    if (subtype === 'init') {
      const model = stringField(message, 'model')
      this.sessionId = stringField(message, 'session_id') ?? this.sessionId
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
    const summary = `Claude ${success ? 'finished' : 'stopped'}${turns !== undefined ? ` · ${turns} turns` : ''}${duration !== undefined ? ` · ${formatLogDuration(duration)}` : ''}${reason ? ` · ${reason}` : ''}`
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
  private readonly startedItems = new Set<string>()
  private lastText = ''
  stopReason: string | undefined
  onToolCall: ((tool: string, input: JsonRecord) => void) | undefined

  push(chunk: Buffer | string): string[] {
    return this.lines.push(chunk).flatMap((line) => this.formatLine(line))
  }

  finish(): string[] {
    return this.lines.finish().flatMap((line) => this.formatLine(line))
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
    if (type === 'thread.started') return ['Codex session started']
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
      const usage = jsonRecord(message.usage)
      const output = usage ? numberField(usage, 'output_tokens') : undefined
      return [`Codex finished${output !== undefined ? ` · ${output} output tokens` : ''}`]
    }
    if (type !== 'item.started' && type !== 'item.completed') return []
    const item = jsonRecord(message.item)
    if (!item) return []
    return type === 'item.started' ? this.itemStarted(item) : this.itemCompleted(item)
  }

  private itemStarted(item: JsonRecord): string[] {
    const id = stringField(item, 'id')
    if (id) this.startedItems.add(id)
    const activity = this.activity(item)
    if (!activity) return []
    this.reportTool(item)
    return [`→ ${activity}`]
  }

  private itemCompleted(item: JsonRecord): string[] {
    const kind = stringField(item, 'type')
    const id = stringField(item, 'id')
    const started = id !== undefined && this.startedItems.delete(id)
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
    return [failed ? `✗ ${activity} failed${exitCode !== undefined && exitCode !== 0 ? ` (exit ${exitCode})` : ''}` : `✓ ${activity}`]
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
  private readonly tools = new Map<string, string>()
  private assistantText = ''
  private lastText = ''
  stopReason: string | undefined
  onToolCall: ((tool: string, input: JsonRecord) => void) | undefined

  push(chunk: Buffer | string): string[] {
    return this.lines.push(chunk).flatMap((line) => this.formatLine(line))
  }

  finish(): string[] {
    return [...this.lines.finish().flatMap((line) => this.formatLine(line)), ...this.flushText()]
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
      return [...pending, `Gemini session started${model ? ` · ${model}` : ''}`]
    }
    if (type === 'tool_use') {
      const name = stringField(message, 'tool_name') ?? 'tool'
      const parameters = jsonRecord(message.parameters) ?? {}
      const activity = formatGeminiToolActivity(name, parameters)
      const id = stringField(message, 'tool_id')
      if (id) this.tools.set(id, activity)
      this.reportTool(name, parameters)
      return [...pending, `→ ${activity}`]
    }
    if (type === 'tool_result') {
      const id = stringField(message, 'tool_id')
      const activity = (id && this.tools.get(id)) || 'Tool action'
      if (id) this.tools.delete(id)
      if (stringField(message, 'status') === 'error') {
        const detail = stringField(message, 'output') ?? stringField(message, 'error')
        return [...pending, `✗ ${activity} failed${detail ? `: ${compactLogText(detail)}` : ''}`]
      }
      return [...pending, `✓ ${activity}`]
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
      if (!success && !this.stopReason) {
        const detail = jsonRecord(message.error)
        const reason = detail ? stringField(detail, 'message') : stringField(message, 'error')
        this.stopReason = reason ? `stopped with an error: ${compactLogText(reason)}` : 'stopped without a successful result'
      }
      return [
        ...pending,
        `Gemini ${success ? 'finished' : 'stopped'}${calls !== undefined ? ` · ${calls} tool calls` : ''}${duration !== undefined ? ` · ${formatLogDuration(duration)}` : ''}${!success && this.stopReason ? ` · ${this.stopReason}` : ''}`,
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
