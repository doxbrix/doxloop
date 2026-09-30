import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import type { PageSummary } from './pages.js'
import { scaffoldProject } from './project.js'
import { defaultWalkthroughPages, normalizeWalkthrough, runReaderWalkthrough, walkthroughFixRequest, walkthroughForPage, walkthroughPrompt } from './reader-walkthrough.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const page = (path: string, title: string, inNavigation = true): PageSummary => ({ path, title, route: `/${path}`, wordCount: 400, evidence: 'none', inNavigation })

describe('choosing pages', () => {
  test('starts with the guides a new reader opens first', () => {
    const pages = [page('concepts/model.mdx', 'Data model'), page('quickstart.mdx', 'Quickstart'), page('guides/install.mdx', 'Install the CLI'), page('reference/api.mdx', 'API')]
    expect(defaultWalkthroughPages(pages).map((item) => item.path)).toEqual(['quickstart.mdx', 'guides/install.mdx'])
    expect(defaultWalkthroughPages([page('a.mdx', 'Overview', false), page('b.mdx', 'Projects')]).map((item) => item.path)).toEqual(['b.mdx'])
  })

  test('the prompt keeps the reader honest and asks for a tagged report', () => {
    const prompt = walkthroughPrompt({ pages: [page('quickstart.mdx', 'Quickstart')], application: 'http://localhost:5230', productName: 'Memos', signIn: 'fill DOXLOOP_APP_USERNAME and DOXLOOP_APP_PASSWORD.' })
    expect(prompt).toContain('first-time reader of Memos')
    expect(prompt).toContain('http://localhost:5230')
    expect(prompt).toContain('do not run anything')
    expect(prompt).toContain('use the saved test account: fill DOXLOOP_APP_USERNAME')
    expect(prompt).toContain('Never create accounts')
    expect(prompt).toContain('<doxloop-walkthrough>')
  })
})

describe('reports', () => {
  test('drop malformed steps and clamp the score', () => {
    const report = normalizeWalkthrough({ completed: true, score: 140, summary: 'Fine.', steps: [{ step: 'Open Settings', outcome: 'done', observation: 'ok', fix: 'none' }, { step: 'x', outcome: 'maybe' }, { outcome: 'stuck' }], missingPrerequisites: ['An account', 3] }, ['quickstart.mdx'], 'claude')
    expect(report).toMatchObject({ completed: true, score: 100, missingPrerequisites: ['An account'], steps: [{ page: 'quickstart.mdx', step: 'Open Settings', outcome: 'done', observation: 'ok' }] })
    expect(report.steps[0]).not.toHaveProperty('fix')
  })

  test('turn what the reader hit into one page edit', () => {
    const report = normalizeWalkthrough({ completed: false, score: 55, summary: 's', missingPrerequisites: ['Docker installed'], steps: [
      { page: 'quickstart.mdx', step: 'Run memos --port 5230', outcome: 'stuck', observation: 'The flag is --addr in the source.', fix: 'Use --addr.' },
      { page: 'quickstart.mdx', step: 'Open the app', outcome: 'done', observation: 'ok' },
      { page: 'other.mdx', step: 'Click Save', outcome: 'unclear', observation: 'Two Save buttons.' },
    ] }, ['quickstart.mdx', 'other.mdx'], 'codex')
    const request = walkthroughFixRequest(report, 'quickstart.mdx')!
    expect(request).toContain('stuck: "Run memos --port 5230" — The flag is --addr in the source. Suggested fix: Use --addr.')
    expect(request).toContain('Docker installed')
    expect(request).not.toContain('Click Save')
    expect(walkthroughFixRequest(normalizeWalkthrough({ completed: true, score: 95, steps: [] }, ['a.mdx'], 'claude'), 'a.mdx')).toBeUndefined()
  })

  test('a run stores its report for each page it covered', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-walkthrough-'))
    roots.push(parent)
    await mkdir(join(parent, 'product'), { recursive: true })
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [{ name: 'product', path: '../product' }] })
    await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: Quickstart\ndescription: Start here.\n---\n\n1. Install it.\n')
    let seenPrompt = ''
    // Any runnable file stands in for the agent CLI; the session itself is replaced.
    const previous = process.env.DOXLOOP_AGENT_EXECUTABLE_CLAUDE
    process.env.DOXLOOP_AGENT_EXECUTABLE_CLAUDE = process.execPath
    const report = await runReaderWalkthrough(root, {
      pages: ['quickstart.mdx'],
      agent: 'claude',
      runSession: async (prompt) => {
        seenPrompt = prompt
        return 'Working…\n<doxloop-walkthrough>{"completed": false, "score": 60, "summary": "Install needs Go.", "missingPrerequisites": ["Go 1.22"], "usedApplication": false, "steps": [{"page": "quickstart.mdx", "step": "Install it", "outcome": "stuck", "observation": "No command given."}]}</doxloop-walkthrough>'
      },
    }).finally(() => {
      if (previous === undefined) delete process.env.DOXLOOP_AGENT_EXECUTABLE_CLAUDE
      else process.env.DOXLOOP_AGENT_EXECUTABLE_CLAUDE = previous
    })
    expect(seenPrompt).toContain('quickstart.mdx — Quickstart')
    expect(report).toMatchObject({ completed: false, score: 60, steps: [{ outcome: 'stuck' }] })
    expect(await walkthroughForPage(root, 'quickstart.mdx')).toMatchObject({ score: 60 })
    await expect(runReaderWalkthrough(root, { pages: ['missing.mdx'], agent: 'claude', runSession: async () => '' })).rejects.toThrow(/not a documentation page/)
  })
})
