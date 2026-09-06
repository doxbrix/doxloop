import { describe, expect, test } from 'vitest'
import { applyWorkflowStageLine, finishWorkflowStages, formatStageProgress, jobOutcomeLine, parseJobOutcome, parseJobOutcomeLine, parseWorkflowStage, workflowStageLine, type WorkflowStage } from './job-events.js'

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

describe('stage progress and pending stages', () => {
  test('announces pending stages, keeps their order, and never moves a started stage back', () => {
    const stages: WorkflowStage[] = []
    applyWorkflowStageLine(stages, 'DOXLOOP_EVENT {"schemaVersion":1,"type":"stage","id":"authoring-pages","label":"Authoring approved pages","status":"pending","progress":{"done":0,"total":4},"at":"2026-09-04T00:00:00.000Z"}')
    applyWorkflowStageLine(stages, 'DOXLOOP_EVENT {"schemaVersion":1,"type":"stage","id":"validating","label":"Validating","status":"pending","at":"2026-09-04T00:00:00.000Z"}')
    applyWorkflowStageLine(stages, 'DOXLOOP_EVENT {"schemaVersion":1,"type":"stage","id":"authoring-pages","label":"Authoring approved pages","status":"running","progress":{"done":2,"total":4},"at":"2026-09-04T00:00:01.000Z"}')
    applyWorkflowStageLine(stages, 'DOXLOOP_EVENT {"schemaVersion":1,"type":"stage","id":"authoring-pages","label":"Authoring approved pages","status":"pending","at":"2026-09-04T00:00:02.000Z"}')
    expect(stages).toEqual([
      { id: 'authoring-pages', label: 'Authoring approved pages', status: 'running', startedAt: '2026-09-04T00:00:01.000Z', progress: { done: 2, total: 4 } },
      { id: 'validating', label: 'Validating', status: 'pending' },
    ])
    // Pending stages are untouched when the job ends; only running ones settle.
    finishWorkflowStages(stages, 'completed', '2026-09-04T00:00:03.000Z')
    expect(stages.map((stage) => stage.status)).toEqual(['completed', 'pending'])
  })

  test('drops malformed progress and round-trips persisted progress', () => {
    const stages: WorkflowStage[] = []
    applyWorkflowStageLine(stages, 'DOXLOOP_EVENT {"schemaVersion":1,"type":"stage","id":"a","label":"A","status":"running","progress":{"done":-1},"at":"2026-09-04T00:00:00.000Z"}')
    expect(stages[0]?.progress).toBeUndefined()
    expect(parseWorkflowStage({ id: 'a', label: 'A', status: 'pending', progress: { done: 3, total: 9 } })).toEqual({ id: 'a', label: 'A', status: 'pending', progress: { done: 3, total: 9 } })
    expect(parseWorkflowStage({ id: 'a', label: 'A', status: 'running', progress: { done: 'x' } })?.progress).toBeUndefined()
  })

  test('serializes the event line the UI server reads', () => {
    const line = workflowStageLine('authoring-pages', 'Authoring approved pages', 'running', { done: 1, total: 3 }, '2026-09-04T00:00:00.000Z')
    expect(line).toBe('DOXLOOP_EVENT {"schemaVersion":1,"type":"stage","id":"authoring-pages","label":"Authoring approved pages","status":"running","progress":{"done":1,"total":3},"at":"2026-09-04T00:00:00.000Z"}')
    expect(formatStageProgress({ done: 2, total: 5 })).toBe(' (2 of 5)')
    expect(formatStageProgress({ done: 2 })).toBe(' (2)')
    expect(formatStageProgress(undefined)).toBe('')
  })
})

describe('job outcomes', () => {
  test('round-trips a source check outcome and ignores stage lines and malformed values', () => {
    const outcome = { kind: 'sync' as const, status: 'proposal' as const, message: '2 stale pages · proposal run-1 is ready for review.', pages: 2, proposalId: 'run-1' }
    const line = jobOutcomeLine(outcome, '2026-09-04T00:00:00.000Z')
    expect(line).toBe('DOXLOOP_EVENT {"schemaVersion":1,"type":"outcome","kind":"sync","status":"proposal","message":"2 stale pages · proposal run-1 is ready for review.","pages":2,"proposalId":"run-1","at":"2026-09-04T00:00:00.000Z"}')
    expect(parseJobOutcomeLine(line)).toEqual(outcome)
    expect(parseJobOutcomeLine(workflowStageLine('a', 'A', 'running'))).toBeUndefined()
    expect(parseJobOutcomeLine('plain output')).toBeUndefined()
    expect(parseJobOutcome({ kind: 'sync', status: 'current', message: 'ok', pages: -1 })).toEqual({ kind: 'sync', status: 'current', message: 'ok' })
    expect(parseJobOutcome({ kind: 'deploy', status: 'current', message: 'ok' })).toBeUndefined()
    expect(parseJobOutcome({ kind: 'sync', status: 'later', message: 'ok' })).toBeUndefined()
  })
})
