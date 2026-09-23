import { describe, expect, test } from 'vitest'
import { applyWorkflowStageLine, cleanJobOutputLine, cleanJobOutputLines, finishWorkflowStages, JobLogDisplayFilter, formatStageProgress, jobOutcomeLine, parseJobOutcome, parseJobOutcomeLine, parseWorkflowStage, stampJobLine, stripJobLineStamp, workflowStageLine, type WorkflowStage } from './job-events.js'

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

describe('job line timestamps', () => {
  const at = new Date(2026, 8, 16, 15, 29, 41)

  test('stamps a line with the local arrival time', () => {
    expect(stampJobLine('→ Reading docs/index.mdx', at)).toBe('15:29:41 → Reading docs/index.mdx')
    expect(stampJobLine('doxloop: The plan is empty.', at)).toBe('15:29:41 doxloop: The plan is empty.')
  })

  test('leaves event lines and already stamped lines alone', () => {
    const event = 'DOXLOOP_EVENT {"schemaVersion":1,"type":"stage","id":"inspect","label":"Inspecting","status":"running","at":"2026-09-16T09:59:41.000Z"}'
    expect(stampJobLine(event, at)).toBe(event)
    expect(stampJobLine('09:00:00 already stamped', at)).toBe('09:00:00 already stamped')
    const stages: WorkflowStage[] = []
    applyWorkflowStageLine(stages, stampJobLine(event, at))
    expect(stages).toEqual([{ id: 'inspect', label: 'Inspecting', status: 'running', startedAt: '2026-09-16T09:59:41.000Z' }])
  })

  test('strips a stamp so line prefixes can still be matched', () => {
    expect(stripJobLineStamp('15:29:41 doxloop: The plan is empty.')).toBe('doxloop: The plan is empty.')
    expect(stripJobLineStamp('no stamp here')).toBe('no stamp here')
  })
})

describe('job log hygiene', () => {
  const routerError = '\u001b[2m2026-09-23T07:45:07.654063Z\u001b[0m \u001b[31mERROR\u001b[0m \u001b[2mcodex_core::tools::router\u001b[0m\u001b[2m:\u001b[0m \u001b[3merror\u001b[0m\u001b[2m=\u001b[0mapply_patch verification failed: invalid patch: multiple operations target /tmp/x.md'

  test('strips colour codes and condenses Codex tool-router errors', () => {
    expect(cleanJobOutputLine(routerError)).toBe('Codex edit retried (patch did not apply)')
    expect(cleanJobOutputLine('2026-09-23T08:02:05.997575Z ERROR codex_core::tools::router: error=patch rejected: writing outside of the project; rejected by user approval settings'))
      .toBe('Codex edit rejected (writing outside of the project; rejected by user approval settings)')
    expect(cleanJobOutputLine('2026-09-23T07:47:30.487234Z ERROR codex_core::tools::router: error=exec_command failed for `/bin/zsh -lc "rg -n foo"`: CreateProcess { message: "Rejected" }'))
      .toBe('Codex command could not run ("rg -n foo")')
    expect(cleanJobOutputLine('2026-09-23T07:47:30Z INFO codex_core::session: started')).toBeUndefined()
    expect(cleanJobOutputLine('\u001b[32m✓ Running tests\u001b[0m')).toBe('✓ Running tests')
  })

  test('drops the stdin notice and keeps event lines untouched', () => {
    expect(cleanJobOutputLines(['Reading additional input from stdin...', '[product] Reading additional input from stdin...', 'kept'])).toEqual(['kept'])
    const event = workflowStageLine('a', 'A', 'running', undefined, '2026-01-01T00:00:00.000Z')
    expect(cleanJobOutputLine(event)).toBe(event)
  })

  test('summarizes a plan reply instead of echoing its JSON', () => {
    const filter = new JobLogDisplayFilter()
    const reply = ['<doxloop-plan>', '{', '  "pages": [', '    { "id": "a", "kind": "error" },', '    { "id": "b" }', '  ]', '}', '</doxloop-plan>']
    const shown = filter.push(['13:09:04 … waiting for Codex\'s next step · 10m 33s', ...reply.map((line) => `13:09:13 ${line}`), '13:09:13 Codex finished · 1 turn'])
    expect(shown).toEqual([
      '13:09:04 … waiting for Codex\'s next step · 10m 33s',
      '13:09:13 Plan reply received: 2 pages',
      '13:09:13 Codex finished · 1 turn',
    ])
  })

  test('keeps parallel research sessions apart and handles one-line briefs', () => {
    const filter = new JobLogDisplayFilter()
    expect(filter.push([
      '12:58:03 [product] <doxloop-brief>',
      '12:58:03 [product] {',
      '12:58:04 [application] <doxloop-brief>{"signIn":{"required":true}}</doxloop-brief>',
      '12:58:04 [application] → Using doxloop_capture navigate',
      '12:58:05 [product]   "capabilities": []',
      '12:58:05 [product] }',
      '12:58:05 [product] </doxloop-brief>',
    ])).toEqual([
      '12:58:04 [application] Research brief received (1 line in the full log)',
      '12:58:04 [application] → Using doxloop_capture navigate',
      '12:58:05 [product] Research brief received (3 lines in the full log)',
    ])
  })

  test('hides bare pretty-printed JSON but keeps short objects and stops at a session end', () => {
    const filter = new JobLogDisplayFilter()
    expect(filter.push(['{', '  "a": 1', '}'])).toEqual(['{', '  "a": 1', '}'])
    expect(filter.push(['{', '  "a": [', '    1,', '    2', '  ]', '}'])).toEqual(['Structured reply hidden (6 lines in the full log)'])
    // A truncated reply must not swallow what follows it.
    expect(filter.push(['<doxloop-plan>', '{', '  "pages": [', 'Codex finished · 1 turn'])).toEqual([
      'Plan reply received (2 lines in the full log, incomplete)',
      'Codex finished · 1 turn',
    ])
    expect(filter.push(['<doxloop-plan>', '{'])).toEqual([])
    expect(filter.finish()).toEqual(['Plan reply received (1 line in the full log, incomplete)'])
  })
})
