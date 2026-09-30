import { describe, expect, it } from 'vitest'
import { findHedges, validateHedging } from './hedging.js'

const filler = (words: number) => Array.from({ length: words }, (_, index) => `word${index}`).join(' ')

describe('hedged wording', () => {
  it('finds the writer\'s guesses and the sentences they sit in', () => {
    const findings = findHedges('The server probably stores the token in Redis. It appears to refresh every hour.\n\nYou can change the port.')
    expect(findings.map((finding) => finding.label)).toEqual(['probably', 'appears to'])
    expect(findings[0]!.sentence).toBe('The server probably stores the token in Redis.')
  })

  it('ignores code, inline code, and component attributes', () => {
    const body = 'Run the command.\n\n```bash\n# this probably works\necho likely\n```\n\nSet `mightFail` to true. <Note title="Probably">Read this.</Note>'
    expect(findHedges(body)).toEqual([])
  })

  it('does not flag ordinary instructions', () => {
    expect(findHedges('You may close the dialog. You can also press Escape. You should see the dashboard.')).toEqual([])
  })

  it('warns when hedges are frequent for the page length', () => {
    const guessy = `${filler(100)}. The token is probably cached. Exports might not include archived items. The setting may be available depending on your configuration.`
    const issues = validateHedging(guessy, 'guides/export.mdx')
    expect(issues).toHaveLength(1)
    expect(issues[0]).toMatchObject({ severity: 'warning', code: 'hedged-wording', file: 'guides/export.mdx' })
    expect(issues[0]!.message).toContain('"The token is probably cached."')
  })

  it('tolerates a single hedge in a long page', () => {
    expect(validateHedging(`${filler(600)}. Imports typically finish in a minute.`, 'guides/import.mdx')).toEqual([])
  })

  it('skips the generated glossary', () => {
    expect(validateHedging('<!-- doxloop:glossary --> probably likely possibly might', 'glossary.mdx')).toEqual([])
  })
})
