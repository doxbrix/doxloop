import { describe, expect, test } from 'vitest'
import { applyWorkflowStageLine, finishWorkflowStages, parseWorkflowStage, type WorkflowStage } from './job-events.js'

describe('structured workflow stages', () => {
  test('updates one durable stage from running to completed', () => {
    const stages: WorkflowStage[] = []
    applyWorkflowStageLine(stages, 'DOXLOOP_EVENT {"schemaVersion":1,"type":"stage","id":"inspect","label":"Inspecting sources","status":"running","at":"2026-08-26T00:00:00.000Z"}')
    applyWorkflowStageLine(stages, 'DOXLOOP_EVENT {"schemaVersion":1,"type":"stage","id":"inspect","label":"Inspecting sources","status":"completed","at":"2026-08-26T00:00:01.000Z"}')
    expect(stages).toEqual([{ id: 'inspect', label: 'Inspecting sources', status: 'completed', startedAt: '2026-08-26T00:00:00.000Z', finishedAt: '2026-08-26T00:00:01.000Z' }])
  })

  test('fails unfinished stages when a job exits and rejects malformed persisted stages', () => {
    const stages: WorkflowStage[] = [{ id: 'write', label: 'Writing', status: 'running' }]
    finishWorkflowStages(stages, 'failed', '2026-08-26T00:00:02.000Z')
    expect(stages[0]).toMatchObject({ status: 'failed', finishedAt: '2026-08-26T00:00:02.000Z' })
    expect(parseWorkflowStage({ id: 'bad' })).toBeUndefined()
  })
})
