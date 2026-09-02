import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { listReviewReports, parseReviewReport, persistReviewReport } from './review-report.js'

describe('structured documentation review reports', () => {
  it('parses the bounded machine-readable result emitted by an agent', () => {
    const report = parseReviewReport(`Narrative is not persisted.\n<doxloop-review>{"score":92,"hardGates":"pass","summary":"The documentation is ready with one small navigation improvement.","findings":[{"id":"nav-1","severity":"minor","title":"Clarify the API navigation label","description":"The label is broader than its contents.","pages":["docs/api/index.mdx"],"evidence":["openapi.yaml"],"recommendation":"Rename it to API reference."}]}</doxloop-review>`)
    expect(report).toEqual(expect.objectContaining({ score: 92, hardGates: 'pass' }))
    expect(report.findings[0]).toEqual(expect.objectContaining({ id: 'nav-1', severity: 'minor', pages: ['docs/api/index.mdx'] }))
  })

  it('stores only the structured report and lists newest reports first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-review-'))
    const output = `PRIVATE TRANSCRIPT THAT MUST NOT BE STORED\n<doxloop-review>{"score":75,"hardGates":"fail","summary":"Two release issues remain.","findings":[]}</doxloop-review>`
    const saved = await persistReviewReport(root, output, { agent: 'codex', model: 'gpt-test', reasoning: 'low' })
    const raw = await readFile(join(root, '.doxloop', 'reviews', `${saved.id}.json`), 'utf8')
    expect(raw).not.toContain('PRIVATE TRANSCRIPT')
    expect(await listReviewReports(root)).toEqual([saved])
  })

  it('falls back safely when an agent omits the structured block', () => {
    const report = parseReviewReport('Quality score: 66/100\nHard gates: fail\n- Major: Missing setup details in docs/setup.mdx')
    expect(report.score).toBe(66)
    expect(report.hardGates).toBe('fail')
    expect(report.findings[0]?.severity).toBe('major')
  })
})
