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
