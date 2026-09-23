import { describe, expect, test } from 'vitest'
import { citedPages, describeResearchScope, fullResearch, readTriageOutput, triageByRules, triagePrompt } from './planning-triage.js'

const pages = ['docs/index.md', 'docs/overview.md', 'docs/guides/reverse-proxy.md', 'docs/self-hosting/docker.mdx', 'docs/api/webhooks.mdx', 'docs/reference/task-fields.mdx']

describe('planning triage', () => {
  test('a navigation, icon, or branding request researches nothing', () => {
    // The 17 Sept 2026 request that ran five minutes of research before failing.
    const icons = triageByRules('for all the pages icons are missing in the left nav items... can you please add relevant icons to left nav items', pages)
    expect(icons).toMatchObject({ scope: 'navigation', decidedBy: 'rules', pages: [] })
    expect(triageByRules('Rename the "Self-hosting" group to "Operations" and move it above Guides in the sidebar', pages)?.scope).toBe('navigation')
    expect(triageByRules('Change the logo and the primary colour to match our brand', pages)?.scope).toBe('navigation')
    // Navigation vocabulary with a content change is ambiguous.
    expect(triageByRules('Add a new page about backups under the Self-hosting group in the sidebar', pages)).toBeUndefined()
  })

  test('a request that names existing pages is page-scoped', () => {
    expect(citedPages('The reverse proxy page is missing the nginx example', pages)).toEqual(['docs/guides/reverse-proxy.md'])
    expect(citedPages('Fix docs/api/webhooks.mdx and the task fields reference', pages)).toEqual(['docs/api/webhooks.mdx', 'docs/reference/task-fields.mdx'])
    // Generic file names are never page references.
    expect(citedPages('Give me an overview of the product and an index of everything', pages)).toEqual([])
    const decided = triageByRules('The reverse proxy page is missing the nginx example; add the steps', pages)
    expect(decided).toMatchObject({ scope: 'pages', pages: ['docs/guides/reverse-proxy.md'], decidedBy: 'rules' })
    expect(decided?.reason).toContain('names one existing page (docs/guides/reverse-proxy.md)')
  })

  test('product-wide requests and empty requests run the full research; mixed requests are left to the agent', () => {
    expect(triageByRules('Refresh everything for the new release', pages)?.scope).toBe('product')
    expect(triageByRules('', pages)).toMatchObject({ scope: 'product', decidedBy: 'rules' })
    expect(triageByRules('Make the docs better', pages)).toBeUndefined()
    expect(triageByRules('Document the new export feature', pages)).toBeUndefined()
    expect(fullResearch('why')).toEqual({ scope: 'product', reason: 'why', pages: [], decidedBy: 'mode' })
  })

  test('the triage prompt and reply contract', () => {
    const prompt = triagePrompt({ request: 'Make the docs better' }, pages)
    expect(prompt).toContain('Do not read any file')
    expect(prompt).toContain('- docs/guides/reverse-proxy.md')
    expect(prompt).toContain('<doxloop-triage>')
    const reply = (value: unknown): string => JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `Decided.\n<doxloop-triage>${JSON.stringify(value)}</doxloop-triage>` } })
    expect(readTriageOutput(reply({ scope: 'pages', pages: ['docs/api/webhooks.mdx', 'docs/nope.md'], reason: 'It names webhooks.' }), 'codex', pages, prompt))
      .toEqual({ scope: 'pages', pages: ['docs/api/webhooks.mdx'], reason: 'It names webhooks.', decidedBy: 'agent' })
    // A page scope naming no real page has nothing to focus on.
    expect(readTriageOutput(reply({ scope: 'pages', pages: ['docs/nope.md'], reason: 'Guess.' }), 'codex', pages)).toMatchObject({ scope: 'product', decidedBy: 'agent' })
    expect(readTriageOutput(reply({ scope: 'navigation', pages: ['docs/index.md'], reason: 'Icons.' }), 'codex', pages)).toEqual({ scope: 'navigation', pages: [], reason: 'Icons.', decidedBy: 'agent' })
    // The template echoed back, a bad scope, or prose is no decision.
    expect(readTriageOutput(prompt, 'codex', pages, prompt)).toBeUndefined()
    expect(readTriageOutput(reply({ scope: 'everything' }), 'codex', pages)).toBeUndefined()
    expect(readTriageOutput('I am not sure.', 'codex', pages)).toBeUndefined()
  })

  test('the scope is described for the log and the review', () => {
    expect(describeResearchScope({ scope: 'navigation', reason: 'Icons only.', pages: [], decidedBy: 'rules' })).toBe('Research scope: no research: navigation, icons, branding, or metadata only (decided from the request). Icons only.')
    expect(describeResearchScope({ scope: 'pages', reason: 'Named.', pages: ['a', 'b'], decidedBy: 'agent' })).toContain('product research focused on 2 pages (decided by a triage session)')
    expect(describeResearchScope(fullResearch('Create.'))).toBe('Research scope: full research (as every create run does). Create.')
  })
})
