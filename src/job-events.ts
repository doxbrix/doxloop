export interface WorkflowStage {
  id: string
  label: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  startedAt?: string
  finishedAt?: string
}

export function applyWorkflowStageLine(stages: WorkflowStage[], line: string): void {
  if (!line.startsWith('DOXLOOP_EVENT ')) return
  let raw: Record<string, unknown>
  try {
    const parsed = JSON.parse(line.slice('DOXLOOP_EVENT '.length)) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return
    raw = parsed as Record<string, unknown>
  } catch { return }
  if (raw.schemaVersion !== 1 || raw.type !== 'stage' || typeof raw.id !== 'string' || typeof raw.label !== 'string' || typeof raw.at !== 'string') return
  if (!['running', 'completed', 'failed'].includes(String(raw.status))) return
  const status = raw.status as 'running' | 'completed' | 'failed'
  const existing = stages.find((stage) => stage.id === raw.id)
  if (existing) {
    existing.label = raw.label
    existing.status = status
    if (status === 'running') existing.startedAt ??= raw.at
    else existing.finishedAt = raw.at
  } else {
    stages.push({ id: raw.id, label: raw.label, status, ...(status === 'running' ? { startedAt: raw.at } : { finishedAt: raw.at }) })
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
  return {
    id: stage.id,
    label: stage.label,
    status: stage.status as WorkflowStage['status'],
    ...(typeof stage.startedAt === 'string' ? { startedAt: stage.startedAt } : {}),
    ...(typeof stage.finishedAt === 'string' ? { finishedAt: stage.finishedAt } : {}),
  }
}
