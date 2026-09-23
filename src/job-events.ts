export type WorkflowStageStatus = 'pending' | 'running' | 'completed' | 'failed'

export interface WorkflowStageProgress {
  done: number
  total?: number
}

export interface WorkflowStage {
  id: string
  label: string
  status: WorkflowStageStatus
  startedAt?: string
  finishedAt?: string
  /** Work counted so far, such as pages written out of pages planned. */
  progress?: WorkflowStageProgress
}

const EVENT_PREFIX = 'DOXLOOP_EVENT '

/**
 * Every line the control center keeps for a job carries the local wall-clock
 * time it arrived, so a reader can see which step took how long. Stage and
 * outcome events already carry their own `at` and stay machine-readable.
 */
const JOB_LINE_STAMP = /^\d{2}:\d{2}:\d{2} /

export function formatJobLineStamp(at: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
}

/** Prefix a log line with the time it arrived; event lines and already stamped lines pass through. */
export function stampJobLine(line: string, at: Date = new Date()): string {
  if (line.startsWith(EVENT_PREFIX) || JOB_LINE_STAMP.test(line)) return line
  return `${formatJobLineStamp(at)} ${line}`
}

export function stripJobLineStamp(line: string): string {
  return line.replace(JOB_LINE_STAMP, '')
}

/**
 * What a job concluded, for the control center to announce once the job
 * settles: a source check reports whether anything changed and whether a
 * proposal was drafted.
 */
export interface JobOutcome {
  kind: 'sync'
  status: 'current' | 'stale' | 'proposal' | 'skipped' | 'failed' | 'unknown'
  /** Reader-facing summary, one sentence. */
  message: string
  /** Stale pages counted by the check. */
  pages?: number
  /** Proposal drafted by the check, when one was. */
  proposalId?: string
}

export function jobOutcomeLine(outcome: JobOutcome, at = new Date().toISOString()): string {
  return `${EVENT_PREFIX}${JSON.stringify({ schemaVersion: 1, type: 'outcome', ...outcome, at })}`
}

/** Report a job outcome to a control center that started this CLI; a terminal already saw the text. */
export function emitJobOutcome(outcome: JobOutcome): void {
  if (process.stdout.isTTY) return
  process.stdout.write(`${jobOutcomeLine(outcome)}\n`)
}

export function parseJobOutcomeLine(line: string): JobOutcome | undefined {
  if (!line.startsWith(EVENT_PREFIX)) return undefined
  try {
    const parsed = JSON.parse(line.slice(EVENT_PREFIX.length)) as unknown
    const raw = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
    return raw?.schemaVersion === 1 && raw.type === 'outcome' ? parseJobOutcome(raw) : undefined
  } catch {
    return undefined
  }
}

export function parseJobOutcome(raw: unknown): JobOutcome | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const outcome = raw as Record<string, unknown>
  if (outcome.kind !== 'sync' || typeof outcome.message !== 'string') return undefined
  if (!['current', 'stale', 'proposal', 'skipped', 'failed', 'unknown'].includes(String(outcome.status))) return undefined
  return {
    kind: 'sync',
    status: outcome.status as JobOutcome['status'],
    message: outcome.message,
    ...(typeof outcome.pages === 'number' && Number.isInteger(outcome.pages) && outcome.pages >= 0 ? { pages: outcome.pages } : {}),
    ...(typeof outcome.proposalId === 'string' ? { proposalId: outcome.proposalId } : {}),
  }
}

/** Serialize one stage event as the line the UI server reads from a CLI job. */
export function workflowStageLine(
  id: string,
  label: string,
  status: WorkflowStageStatus,
  progress?: WorkflowStageProgress,
  at = new Date().toISOString(),
): string {
  return `${EVENT_PREFIX}${JSON.stringify({ schemaVersion: 1, type: 'stage', id, label, status, ...(progress ? { progress } : {}), at })}`
}

/**
 * Report a workflow stage. A CLI run started by the control center streams
 * machine-readable events; a person watching a terminal gets a plain line.
 */
export function emitWorkflowStage(
  id: string,
  label: string,
  status: WorkflowStageStatus,
  progress?: WorkflowStageProgress,
): void {
  if (process.stdout.isTTY) {
    if (status === 'pending') return
    const mark = status === 'running' ? '…' : status === 'completed' ? '✓' : '✗'
    process.stdout.write(`${mark} ${label}${formatStageProgress(progress)}\n`)
    return
  }
  process.stdout.write(`${workflowStageLine(id, label, status, progress)}\n`)
}

export function formatStageProgress(progress: WorkflowStageProgress | undefined): string {
  if (!progress) return ''
  return progress.total !== undefined ? ` (${progress.done} of ${progress.total})` : ` (${progress.done})`
}

export function applyWorkflowStageLine(stages: WorkflowStage[], line: string): void {
  if (!line.startsWith(EVENT_PREFIX)) return
  let raw: Record<string, unknown>
  try {
    const parsed = JSON.parse(line.slice(EVENT_PREFIX.length)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    raw = parsed as Record<string, unknown>
  } catch { return }
  if (raw.schemaVersion !== 1 || raw.type !== 'stage' || typeof raw.id !== 'string' || typeof raw.label !== 'string' || typeof raw.at !== 'string') return
  if (!['pending', 'running', 'completed', 'failed'].includes(String(raw.status))) return
  const status = raw.status as WorkflowStageStatus
  const progress = parseStageProgress(raw.progress)
  const existing = stages.find((stage) => stage.id === raw.id)
  if (existing) {
    // A stage announced up front never moves backwards once work started on it.
    if (status === 'pending') return
    existing.label = raw.label
    existing.status = status
    if (progress) existing.progress = progress
    if (status === 'running') existing.startedAt ??= raw.at
    else existing.finishedAt = raw.at
  } else {
    stages.push({
      id: raw.id,
      label: raw.label,
      status,
      ...(progress ? { progress } : {}),
      ...(status === 'running' ? { startedAt: raw.at } : status === 'pending' ? {} : { finishedAt: raw.at }),
    })
  }
}

export function finishWorkflowStages(stages: WorkflowStage[], status: 'completed' | 'failed', at = new Date().toISOString()): void {
  for (const stage of stages) {
    if (stage.status !== 'running') continue
    stage.status = status
    stage.finishedAt = at
  }
}

export function parseWorkflowStage(raw: unknown): WorkflowStage | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const stage = raw as Record<string, unknown>
  if (typeof stage.id !== 'string' || typeof stage.label !== 'string' || !['pending', 'running', 'completed', 'failed'].includes(String(stage.status))) return undefined
  const progress = parseStageProgress(stage.progress)
  return {
    id: stage.id,
    label: stage.label,
    status: stage.status as WorkflowStage['status'],
    ...(typeof stage.startedAt === 'string' ? { startedAt: stage.startedAt } : {}),
    ...(typeof stage.finishedAt === 'string' ? { finishedAt: stage.finishedAt } : {}),
    ...(progress ? { progress } : {}),
  }
}

function parseStageProgress(raw: unknown): WorkflowStageProgress | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  const progress = raw as Record<string, unknown>
  if (typeof progress.done !== 'number' || !Number.isInteger(progress.done) || progress.done < 0) return undefined
  const total = progress.total
  if (total !== undefined && (typeof total !== 'number' || !Number.isInteger(total) || total < 0)) return undefined
  return { done: progress.done, ...(typeof total === 'number' ? { total } : {}) }
}

// ---------------------------------------------------------------------------
// Job log hygiene: what the control center shows in "Live activity".

const ANSI_ESCAPE = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[@-Z\\-_]/g
/** An optional `[task] ` prefix a parallel research session puts on its lines. */
const SESSION_PREFIX = /^(\[[^\]\s]{1,40}\] )?/
/** A Rust `tracing` line from Codex's own internals: timestamp, level, module, message. */
const CODEX_TRACE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z?\s+(ERROR|WARN|INFO|DEBUG|TRACE)\s+(codex[\w:]*)\s*:\s*(.*)$/

export function stripAnsi(value: string): string {
  return value.replace(ANSI_ESCAPE, '')
}

function compactLine(value: string, maximum: number): string {
  const single = value.replace(/\s+/g, ' ').trim()
  return single.length > maximum ? `${single.slice(0, maximum - 1)}…` : single
}

/** Condense one of Codex's internal tool-router errors, which Codex retries itself. */
function codexTraceSummary(level: string, module: string, message: string): string | undefined {
  const text = message.replace(/^error=/, '')
  if (module.includes('tools::router') || module.includes('tools')) {
    if (/apply_patch verification failed/i.test(text)) return 'Codex edit retried (patch did not apply)'
    const rejected = /^patch rejected:\s*(.*)$/i.exec(text)
    if (rejected) return `Codex edit rejected (${compactLine(rejected[1] ?? '', 120)})`
    const command = /^exec_command failed for `([^`]*)/i.exec(text)
    if (command) return `Codex command could not run (${compactLine((command[1] ?? '').replace(/^\/bin\/\w+ -lc /, ''), 100)})`
  }
  if (level === 'DEBUG' || level === 'TRACE' || level === 'INFO') return undefined
  return `Codex ${level === 'WARN' ? 'warning' : 'error'}: ${compactLine(text, 200)}`
}

/**
 * Clean one raw output line for the job log, or drop it: ANSI colour codes
 * are stripped, Codex's "Reading additional input from stdin..." notice is
 * dropped, and Codex's internal tracing lines are condensed to one readable
 * sentence. Event lines pass through untouched.
 */
export function cleanJobOutputLine(line: string): string | undefined {
  if (line.startsWith(EVENT_PREFIX)) return line
  const stripped = stripAnsi(line).replace(/\s+$/, '')
  if (!stripped.trim()) return undefined
  const prefix = SESSION_PREFIX.exec(stripped)?.[1] ?? ''
  const body = stripped.slice(prefix.length)
  if (/^Reading (?:additional )?(?:input|prompt) from stdin\.*$/i.test(body.trim())) return undefined
  const trace = CODEX_TRACE.exec(body.trim())
  if (trace) {
    const summary = codexTraceSummary(trace[1]!, trace[2]!, trace[3] ?? '')
    return summary ? `${prefix}${summary}` : undefined
  }
  return stripped
}

export function cleanJobOutputLines(lines: string[]): string[] {
  return lines.flatMap((line) => {
    const cleaned = cleanJobOutputLine(line)
    return cleaned === undefined ? [] : [cleaned]
  })
}

const REPLY_TAG = /^<(doxloop-(?:plan-patch|plan|brief|review|triage))>(.*)$/
const SESSION_END = /^(?:Claude|Codex|Gemini) (?:finished|stopped|session started)\b/
/** A line a pretty-printed JSON document can contain on its own. */
const JSON_LINE = /^\s*(?:[{}[\]],?|"(?:[^"\\]|\\.)*"\s*:.*|"(?:[^"\\]|\\.)*",?|-?\d[\d.eE+-]*,?|true,?|false,?|null,?|[{[].*)$/
/** Most lines a hidden block may hold before the filter gives up on it. */
const MAX_HIDDEN_LINES = 50_000

interface HiddenBlock {
  kind: 'tag' | 'json'
  tag?: string | undefined
  lines: string[]
  /** The hidden lines as they arrived, for a short object shown after all. */
  raw: string[]
  depth: number
  /** Non-JSON lines seen in a row while inside a bare JSON block. */
  strays: number
}

function jsonDepthChange(line: string): number {
  let depth = 0
  let inString = false
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]
    if (inString) {
      if (character === '\\') index += 1
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{' || character === '[') depth += 1
    else if (character === '}' || character === ']') depth -= 1
  }
  return depth
}

function replySummary(block: HiddenBlock, complete: boolean): string {
  const body = block.lines.join('\n')
  let parsed: unknown
  try {
    const start = body.search(/[{[]/)
    parsed = start >= 0 ? JSON.parse(body.slice(start)) : undefined
  } catch {
    parsed = undefined
  }
  const record = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined
  const count = (key: string): number | undefined => Array.isArray(record?.[key]) ? (record![key] as unknown[]).length : undefined
  const hidden = `${block.lines.length} line${block.lines.length === 1 ? '' : 's'} in the full log`
  const incomplete = complete ? '' : ', incomplete'
  if (block.tag === 'doxloop-plan') {
    const pages = count('pages')
    return pages !== undefined ? `Plan reply received: ${pages} page${pages === 1 ? '' : 's'}` : `Plan reply received (${hidden}${incomplete})`
  }
  if (block.tag === 'doxloop-plan-patch') {
    const pages = count('pages')
    return `Plan changes received${pages !== undefined ? `: ${pages} page${pages === 1 ? '' : 's'}` : ` (${hidden}${incomplete})`}`
  }
  if (block.tag === 'doxloop-brief') return `Research brief received (${hidden}${incomplete})`
  if (block.tag === 'doxloop-review') {
    const findings = count('findings')
    const score = typeof record?.score === 'number' ? record.score : undefined
    return `Review reply received${score !== undefined ? `: ${score}/100` : ''}${findings !== undefined ? `, ${findings} finding${findings === 1 ? '' : 's'}` : ''}${score === undefined && findings === undefined ? ` (${hidden}${incomplete})` : ''}`
  }
  if (block.tag === 'doxloop-triage') return 'Request triage received'
  return `Structured reply hidden (${hidden}${incomplete})`
}

/**
 * Keeps an agent's machine-readable replies out of the live activity view:
 * a `<doxloop-plan>` block or a pretty-printed JSON document becomes one
 * summary line ("Plan reply received: 62 pages") instead of hundreds of
 * lines that push the useful ones out of the window. Parallel sessions are
 * tracked by their `[task] ` prefix. The full job log keeps the raw reply.
 */
export class JobLogDisplayFilter {
  private readonly blocks = new Map<string, HiddenBlock>()

  push(lines: string[]): string[] {
    return lines.flatMap((line) => this.line(line))
  }

  /** Summaries for blocks still open when the job ends. */
  finish(): string[] {
    const output: string[] = []
    for (const [key, block] of this.blocks) output.push(`${key}${replySummary(block, false)}`)
    this.blocks.clear()
    return output
  }

  private line(raw: string): string[] {
    if (raw.startsWith(EVENT_PREFIX)) return [raw]
    const stamp = /^\d{2}:\d{2}:\d{2} /.exec(raw)?.[0] ?? ''
    const unstamped = raw.slice(stamp.length)
    const prefix = SESSION_PREFIX.exec(unstamped)?.[1] ?? ''
    const text = unstamped.slice(prefix.length)
    const block = this.blocks.get(prefix)
    if (block) return this.continueBlock(block, prefix, stamp, text, raw)

    const tag = REPLY_TAG.exec(text.trim())
    if (tag) {
      const opened: HiddenBlock = { kind: 'tag', tag: tag[1]!, lines: [], raw: [], depth: 0, strays: 0 }
      const rest = tag[2] ?? ''
      const close = rest.indexOf(`</${tag[1]}>`)
      if (close >= 0) {
        if (rest.slice(0, close).trim()) opened.lines.push(rest.slice(0, close))
        return [`${stamp}${prefix}${replySummary(opened, true)}`]
      }
      if (rest.trim()) opened.lines.push(rest)
      this.blocks.set(prefix, opened)
      return []
    }
    const trimmed = text.trim()
    if (trimmed === '{' || trimmed === '[' || /^```json\s*$/i.test(trimmed)) {
      const fenced = trimmed.startsWith('```')
      this.blocks.set(prefix, { kind: 'json', lines: fenced ? [] : [trimmed], raw: [raw], depth: fenced ? 0 : 1, strays: 0, ...(fenced ? { tag: 'fence' } : {}) })
      return []
    }
    return [raw]
  }

  private continueBlock(block: HiddenBlock, prefix: string, stamp: string, text: string, raw: string): string[] {
    const trimmed = text.trim()
    const close = block.kind === 'tag' ? `</${block.tag}>` : undefined
    if (close && trimmed.includes(close)) {
      const before = trimmed.slice(0, trimmed.indexOf(close))
      if (before.trim()) block.lines.push(before)
      this.blocks.delete(prefix)
      return [`${stamp}${prefix}${replySummary(block, true)}`]
    }
    if (block.tag === 'fence' && trimmed === '```') {
      this.blocks.delete(prefix)
      return [`${stamp}${prefix}${replySummary({ ...block, tag: undefined }, true)}`]
    }
    // A session that ended (or a truncated reply) must not swallow what follows.
    if (SESSION_END.test(trimmed) || block.lines.length >= MAX_HIDDEN_LINES) {
      this.blocks.delete(prefix)
      return [`${stamp}${prefix}${replySummary(block.tag === 'fence' ? { ...block, tag: undefined } : block, false)}`, raw]
    }
    if (block.kind === 'json' && block.tag !== 'fence') {
      if (!JSON_LINE.test(text)) {
        block.strays += 1
        if (block.strays > 3) {
          this.blocks.delete(prefix)
          return [`${stamp}${prefix}${replySummary(block, false)}`, raw]
        }
        return [raw]
      }
      block.strays = 0
      block.lines.push(trimmed)
      block.raw.push(raw)
      block.depth += jsonDepthChange(trimmed)
      if (block.depth <= 0) {
        this.blocks.delete(prefix)
        // A short object is readable as it stands.
        if (block.lines.length <= 3) return block.raw
        return [`${stamp}${prefix}${replySummary(block, true)}`]
      }
      return []
    }
    block.lines.push(trimmed)
    return []
  }
}
