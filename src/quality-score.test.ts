import { describe, expect, test } from 'vitest'
import { band, scoreFindings } from './quality-score.js'

const page = (path: string, overrides: Partial<{ procedural: boolean; hasEvidence: boolean; hasExamples: boolean }> = {}) => ({ path, procedural: false, hasEvidence: true, hasExamples: false, ...overrides })

describe('quality score', () => {
  test('a clean project scores 100', () => {
    const result = scoreFindings({ pages: [page('a.mdx'), page('guides/b.mdx', { procedural: true, hasExamples: true })], findings: [] })
    expect(result.score).toBe(100)
    expect(result.band).toBe('release-ready')
    expect(result.categories.map((category) => category.max).reduce((sum, value) => sum + value, 0)).toBe(100)
  })

  test('each finding costs its category the share of pages it affects, and names the page', () => {
    const result = scoreFindings({
      pages: [page('a.mdx'), page('b.mdx', { hasEvidence: false }), page('guides/c.mdx', { procedural: true, hasExamples: true }), page('d.mdx')],
      findings: [
        { file: 'a.mdx', code: 'hedged-wording', message: 'm' },
        { file: 'guides/c.mdx', code: 'example-unknown-endpoint', message: 'm' },
        { file: 'd.mdx', code: 'heading-case', message: 'm' },
        { file: 'd.mdx', code: 'unrelated-code', message: 'm' },
      ],
    })
    const by = Object.fromEntries(result.categories.map((category) => [category.id, category]))
    // a.mdx hedges and b.mdx has no evidence: 2 of 4 pages pass accuracy.
    expect(by.accuracy).toMatchObject({ score: 15, passing: 2, total: 4 })
    expect(by.accuracy!.findings.map((finding) => finding.file)).toEqual(['b.mdx', 'a.mdx'])
    expect(by.examples).toMatchObject({ score: 0, passing: 0, total: 1 })
    expect(by.clarity).toMatchObject({ score: 7.5, passing: 3 })
    expect(result.worstPages[0]!.file).toBe('a.mdx')
  })

  test('a walkthrough scales the page\'s task score, and stale pages cost freshness', () => {
    const result = scoreFindings({
      pages: [page('guides/start.mdx', { procedural: true }), page('guides/other.mdx', { procedural: true })],
      findings: [],
      walkthroughs: new Map([['guides/start.mdx', 60]]),
      stalePages: new Set(['guides/other.mdx']),
    })
    const by = Object.fromEntries(result.categories.map((category) => [category.id, category]))
    expect(by.tasks).toMatchObject({ score: 16, passing: 1, total: 2 })
    expect(by.tasks!.findings[0]).toMatchObject({ code: 'walkthrough', file: 'guides/start.mdx' })
    expect(by.freshness).toMatchObject({ score: 2.5 })
  })

  test('site-wide navigation findings cost structure points', () => {
    const result = scoreFindings({ pages: [page('a.mdx')], findings: [{ code: 'navigation-group', message: 'm' }, { code: 'navigation-page', message: 'm' }] })
    expect(result.categories.find((category) => category.id === 'structure')!.score).toBe(13)
  })

  test('bands follow the rubric', () => {
    expect([band(95), band(85), band(70)]).toEqual(['release-ready', 'usable', 'revise'])
  })
})
