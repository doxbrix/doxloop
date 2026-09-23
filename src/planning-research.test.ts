import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { docsSiteBinding, materializeDocsSiteSnapshot } from './docs-site.js'
import {
  EXISTING_DOCS_SHARD_PAGES,
  formatResearchBriefs,
  planningParallelism,
  readBriefOutput,
  readResearchCheckpoint,
  researchCheckpointKey,
  researchCheckpointKeys,
  researchPrompt,
  researchTasks,
  runResearch,
  savedResearchBriefs,
  stagedPlanningEnabled,
  type ResearchPromptContext,
  type ResearchTask,
} from './planning-research.js'
import { loadProject, saveProjectSettings, scaffoldProject } from './project.js'
import type { DocsSiteSnapshot } from './docs-crawl.js'
import type { DocumentationDiscoveryInventory } from './source-discovery.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function snapshot(pages: number): DocsSiteSnapshot {
  return {
    schemaVersion: 1, url: 'https://docs.example.com/', origin: 'https://docs.example.com', scope: '/', crawledAt: '2026-09-14T00:00:00.000Z', generator: 'docusaurus', discovery: ['sitemap'], pageLimit: 150, truncated: false,
    pages: Array.from({ length: pages }, (_, index) => ({
      url: `https://docs.example.com/page-${index}`, path: index === 0 ? '' : `page-${index}`, title: `Page ${index}`, headings: [], words: 10 + index, internalLinks: [], externalLinks: [], images: [], markdown: `# Page ${index}`, hash: `h${index}`, fetchedAt: '2026-09-14T00:00:00.000Z',
    })),
    skipped: [], brokenLinks: [], warnings: [], totals: { pages, words: 10 * pages, images: 0, discovered: pages }, hash: 'abcdef1234567890',
  }
}

const inventory: DocumentationDiscoveryInventory = {
  schemaVersion: 1, cacheKey: 'cache', generatedAt: '2026-09-16T00:00:00.000Z',
  sources: [{ name: 'app', kind: 'directory', location: '../app', revision: null, filesScanned: 1, filesAvailable: 1, truncated: false, languages: ['TypeScript'], packageNames: ['app'], evidence: [{ source: 'app', path: 'src/index.ts', kind: 'export', label: 'createClient', line: 3 }], uiLabelCatalogs: [], warnings: [] }],
  existingPages: [], navigationFiles: [], totals: { sources: 1, filesScanned: 1, publicSignals: 1, existingPages: 0 }, suggestedPages: { starter: 3, standard: 8, comprehensive: 12 },
}

async function fixture(pages = 2): Promise<{ root: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-research-'))
  roots.push(parent)
  const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [{ name: 'app', path: '../app' }] })
  const materialized = await materializeDocsSiteSnapshot(root, 'legacy', snapshot(pages))
  const project = await loadProject(root)
  await saveProjectSettings(root, { sources: [...project.sources, docsSiteBinding(root, 'legacy', materialized)] })
  return { root }
}

describe('planning research tasks', () => {
  test('one product audit, one application exploration when screenshots are wanted, and one docs audit per shard', async () => {
    const { root } = await fixture(EXISTING_DOCS_SHARD_PAGES * 2 + 5)
    const project = await loadProject(root)
    const withoutApp = await researchTasks(root, project, { execution: { screenshots: 'enabled' } })
    expect(withoutApp.map((task) => task.id)).toEqual(['product', 'existing-docs-legacy-1', 'existing-docs-legacy-2', 'existing-docs-legacy-3'])
    expect(withoutApp[1]!.shard).toMatchObject({ source: 'legacy', index: 1, total: 3 })
    expect(withoutApp[1]!.shard!.pages).toHaveLength(EXISTING_DOCS_SHARD_PAGES)
    expect(withoutApp[3]!.shard!.pages).toHaveLength(5)
    expect(withoutApp.every((task) => !task.browser)).toBe(true)

    const withApp = { ...project, application: { baseUrl: 'http://localhost:3000' } }
    const tasks = await researchTasks(root, withApp, { execution: { screenshots: 'auto' } })
    expect(tasks.map((task) => task.id)).toContain('application')
    expect(tasks.find((task) => task.id === 'application')!.browser).toBe(true)
    // Disabled screenshots never open a browser session.
    const disabled = await researchTasks(root, withApp, { execution: { screenshots: 'disabled' } })
    expect(disabled.map((task) => task.id)).not.toContain('application')
    // A single crawled shard keeps a stable id.
    const { root: small } = await fixture(2)
    const single = await researchTasks(small, await loadProject(small), { execution: { screenshots: 'disabled' } })
    expect(single.map((task) => task.id)).toEqual(['product', 'existing-docs-legacy'])
    // No sources at all means nothing to research.
    expect(await researchTasks(root, { sources: [] }, { execution: { screenshots: 'disabled' } })).toEqual([])
  })

  test('the research scope narrows the sessions: none for navigation, a focused product audit for pages', async () => {
    const { root } = await fixture(3)
    const project = await loadProject(root)
    const withApp = { ...project, application: { baseUrl: 'http://localhost:3000' } }
    const navigation = { scope: 'navigation' as const, reason: 'icons', pages: [], decidedBy: 'rules' as const }
    expect(await researchTasks(root, withApp, { execution: { screenshots: 'enabled' }, research: navigation })).toEqual([])
    const pages = { scope: 'pages' as const, reason: 'named', pages: ['docs/guides/reverse-proxy.md'], decidedBy: 'rules' as const }
    const focused = await researchTasks(root, withApp, { execution: { screenshots: 'auto' }, research: pages })
    // No docs-site audit, no application exploration unless screenshots are required.
    expect(focused.map((task) => task.id)).toEqual(['product'])
    expect(focused[0]).toMatchObject({ focus: ['docs/guides/reverse-proxy.md'], label: 'Auditing the product surface behind 1 page' })
    const required = await researchTasks(root, withApp, { execution: { screenshots: 'enabled' }, research: pages })
    expect(required.map((task) => task.id)).toEqual(['product', 'application'])
    const context: ResearchPromptContext = {
      project, current: { request: 'Fix the reverse proxy page.', mode: 'update', scope: 'custom', execution: { screenshots: 'auto' }, research: pages },
      discovery: inventory, changes: 'No changes.', captureAuth: 'none',
    }
    const prompt = researchPrompt(focused[0]!, context)
    expect(prompt).toContain('This update concerns only these existing documentation pages:\n- docs/guides/reverse-proxy.md')
    expect(prompt).toContain('Do not audit the rest of the product')
    expect(prompt).not.toContain('Audit the complete public product surface')
    // A product scope runs everything, as before.
    const full = await researchTasks(root, withApp, { execution: { screenshots: 'auto' }, research: { scope: 'product', reason: '', pages: [], decidedBy: 'mode' } })
    expect(full.map((task) => task.id)).toEqual(['product', 'application', 'existing-docs-legacy'])
  })

  test('prompts carry the task contract, the inventory, and the shard page list', async () => {
    const { root } = await fixture(3)
    const project = await loadProject(root)
    const context: ResearchPromptContext = {
      project: { ...project, application: { baseUrl: 'http://localhost:3000', screenshots: { startPath: '/home' } } },
      current: { request: 'Document everything.', mode: 'create', scope: 'standard', execution: { screenshots: 'enabled' } },
      discovery: inventory, changes: 'No changes.', captureAuth: 'none',
    }
    const tasks = await researchTasks(root, context.project, context.current)
    const product = researchPrompt(tasks.find((task) => task.id === 'product')!, context)
    expect(product).toContain('Research task "product"')
    expect(product).toContain('src/index.ts: createClient @3')
    expect(product).toContain('<doxloop-brief>')
    expect(product).toContain('Do not read the skill files')
    expect(product).not.toContain('doxloop_capture')
    const application = researchPrompt(tasks.find((task) => task.id === 'application')!, context)
    expect(application).toContain('doxloop_capture')
    expect(application).toContain('http://localhost:3000')
    expect(application).toContain('/home')
    expect(application).toContain('Never create, change, or delete data')
    expect(application).toContain('at most 30 navigation/interaction/snapshot calls and 30 screenshot calls in total')
    const docs = researchPrompt(tasks.find((task) => task.kind === 'existing-docs')!, context)
    expect(docs).toContain('- pages/page-1.md — "Page 1" (11 words)')
    expect(docs).toContain('Product sources ("app") are the truth for facts')
    expect(docs).toContain('"suspectClaims"')
  })

  test('briefs are read from the agreed block, repaired when a closer is lost, and refused when absent', () => {
    const task: ResearchTask = { id: 'product', kind: 'product', label: 'Auditing the product surface', browser: false }
    const brief = { productProfile: 'SDK', capabilities: [{ id: 'send', title: 'Send events', kind: 'api', evidence: [] }], unknowns: [] }
    const stream = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `Done.\n<doxloop-brief>\n${JSON.stringify(brief)}\n</doxloop-brief>` } })
    expect(readBriefOutput(stream, 'codex', task)).toEqual({ content: brief, repairs: [] })
    const short = readBriefOutput(`<doxloop-brief>${JSON.stringify(brief).slice(0, -1)}</doxloop-brief>`, 'codex', task)
    expect(short.content).toEqual(brief)
    expect(short.repairs).toEqual([expect.stringMatching(/"product" research reply stopped 1 closing bracket short/)])
    // Two Codex product briefs in a row ended their top-level `unknowns`
    // string array with `"}]}` instead of `"]}`: brace-balanced, so no closer
    // is missing, but the wrong one closes the array. The tail is rewritten.
    const swapped = { ...brief, unknowns: ['Plugin isolation was not confirmed.', 'Support commitments were not confirmed.'] }
    const swappedText = JSON.stringify(swapped)
    expect(swappedText.endsWith('"]}')).toBe(true)
    const rewritten = readBriefOutput(`<doxloop-brief>${swappedText.slice(0, -2)}}]}</doxloop-brief>`, 'codex', task)
    expect(rewritten.content).toEqual(swapped)
    expect(rewritten.repairs).toEqual([expect.stringMatching(/"product" research reply ended with the wrong closing brackets \("\}\]\}" where "\]\}" closes the JSON object\)/)])
    // A wrong closer with more content after it is real corruption, not a swapped tail.
    expect(() => readBriefOutput(`<doxloop-brief>${swappedText.slice(0, -2)}},"more":1]}</doxloop-brief>`, 'codex', task)).toThrow(/malformed research brief/)
    // A plan-shaped reply is not a product brief; the wrong kind of brief is refused too.
    expect(() => readBriefOutput('I could not finish.', 'codex', task)).toThrow(/did not return a research-brief JSON object/)
    const docsTask: ResearchTask = { id: 'existing-docs-legacy', kind: 'existing-docs', label: 'Auditing', browser: false }
    expect(() => readBriefOutput(`<doxloop-brief>${JSON.stringify(brief)}</doxloop-brief>`, 'codex', docsTask)).toThrow(/did not return a research-brief/)
    expect(formatResearchBriefs([{ task: 'product', kind: 'product', label: 'Auditing the product surface', content: brief }])).toContain('### Brief "product": Auditing the product surface\n{"productProfile":"SDK"')
  })

  test('sessions run in parallel, briefs are checkpointed and reused, and a failed session is retried once', async () => {
    const { root } = await fixture(2)
    const project = await loadProject(root)
    const context: ResearchPromptContext = { project, current: { request: '', mode: 'create', scope: 'standard', execution: { screenshots: 'disabled' } }, discovery: inventory, changes: '', captureAuth: 'none' }
    const tasks = await researchTasks(root, project, context.current)
    expect(tasks).toHaveLength(2)
    const key = researchCheckpointKey({ id: 'plan-1', execution: context.current.execution }, 'snapshot-a')
    const calls: string[] = []
    let inFlight = 0
    let peak = 0
    const runSession = async (task: ResearchTask, prompt: string): Promise<string> => {
      calls.push(task.id)
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 20))
      inFlight -= 1
      expect(prompt).toContain(`Research task "${task.id}"`)
      // The docs audit fails once, then answers.
      if (task.kind === 'existing-docs' && calls.filter((id) => id === task.id).length === 1) return 'the sandbox stopped me'
      const content = task.kind === 'product' ? { capabilities: [{ id: 'x' }] } : { source: 'legacy', pages: [{ path: 'pages/index.md', quality: 'keep' }] }
      return `<doxloop-brief>${JSON.stringify(content)}</doxloop-brief>`
    }
    const progress: string[] = []
    const first = await runResearch(tasks, { root, planId: 'plan-1', key, agent: 'codex', concurrency: 2, context, runSession, onProgress: (done, total, task, outcome) => progress.push(`${done}/${total} ${task.id} ${outcome}`) })
    expect(peak).toBe(2)
    expect(calls).toEqual(['product', 'existing-docs-legacy', 'existing-docs-legacy'])
    expect(first.briefs.map((brief) => brief.task)).toEqual(['product', 'existing-docs-legacy'])
    expect(progress).toEqual(['1/2 product completed', '2/2 existing-docs-legacy completed'])
    expect(await readResearchCheckpoint(root, 'plan-1', tasks[0]!, key)).toMatchObject({ task: 'product', content: { capabilities: [{ id: 'x' }] } })
    expect(JSON.parse(await readFile(join(root, '.doxloop', 'plans', 'plan-1', 'research', 'product.json'), 'utf8'))).toMatchObject({ key })

    // A second run under the same key starts no session.
    const again = await runResearch(tasks, { root, planId: 'plan-1', key, agent: 'codex', concurrency: 2, context, runSession: async () => { throw new Error('must not run') } })
    expect(again.briefs).toEqual(first.briefs)
    expect(await savedResearchBriefs(root, 'plan-1', tasks, key)).toEqual(first.briefs)
    // A different source snapshot invalidates the briefs.
    const other = researchCheckpointKey({ execution: context.current.execution }, 'snapshot-b')
    expect(await savedResearchBriefs(root, 'plan-1', tasks, other)).toEqual([])
    expect(researchCheckpointKey({ execution: { screenshots: 'enabled' } }, 'snapshot-a')).not.toBe(key)

    // A later plan on unchanged sources reuses the briefs another plan saved,
    // copies them under its own directory, and says where they came from.
    const lines: string[] = []
    const later = await runResearch(tasks, { root, planId: 'plan-9', key, agent: 'codex', concurrency: 2, context, runSession: async () => { throw new Error('must not run') }, log: (line) => lines.push(line) })
    expect(later.briefs).toEqual(first.briefs)
    expect(lines).toEqual([expect.stringMatching(/Reusing the "product" research brief plan plan-1 saved at .*sources have not changed/), expect.stringMatching(/"existing-docs-legacy" research brief plan plan-1/)])
    expect(JSON.parse(await readFile(join(root, '.doxloop', 'plans', 'plan-9', 'research', 'product.json'), 'utf8'))).toMatchObject({ key, task: 'product' })
    // The application brief names captures under its own plan, so it is never borrowed.
    const application: ResearchTask = { id: 'application', kind: 'application', label: 'Exploring', browser: true }
    const appContext: ResearchPromptContext = { ...context, project: { ...project, application: { baseUrl: 'http://localhost:3000' } } }
    await runResearch([application], { root, planId: 'plan-1', key, agent: 'codex', concurrency: 1, context: appContext, runSession: async () => '<doxloop-brief>{"screens":[]}</doxloop-brief>' })
    expect(await readResearchCheckpoint(root, 'plan-9', application, key)).toBeUndefined()
    expect(await readResearchCheckpoint(root, 'plan-1', application, key)).toMatchObject({ planId: 'plan-1' })

    // A page-scoped plan is keyed by its pages and also accepts a full audit on the same sources.
    const focused = { execution: context.current.execution, research: { scope: 'pages' as const, reason: '', pages: ['docs/b.md', 'docs/a.md'], decidedBy: 'rules' as const } }
    const focusedKey = researchCheckpointKey(focused, 'snapshot-a')
    expect(focusedKey).not.toBe(key)
    expect(researchCheckpointKeys(focused, 'snapshot-a')).toEqual([focusedKey, key])
    expect(researchCheckpointKeys({ execution: context.current.execution }, 'snapshot-a')).toEqual([key])
    expect(await savedResearchBriefs(root, 'plan-1', [tasks[0]!], researchCheckpointKeys(focused, 'snapshot-a'))).toEqual([first.briefs[0]])

    // A session that fails twice fails the research, after the others were saved
    // (a fresh snapshot, so nothing is borrowed from plan-1).
    const fresh = researchCheckpointKey({ execution: context.current.execution }, 'snapshot-c')
    await expect(runResearch(tasks, { root, planId: 'plan-2', key: fresh, agent: 'codex', concurrency: 1, context, runSession: async (task) => (task.kind === 'product' ? '<doxloop-brief>{"capabilities":[]}</doxloop-brief>' : 'no') }))
      .rejects.toThrow(/A research session did not finish \("existing-docs-legacy": .*retry the plan to run only the missing one/)
    expect(await readResearchCheckpoint(root, 'plan-2', tasks[0]!, fresh)).toBeDefined()
  })

  test('environment switches', () => {
    expect(stagedPlanningEnabled({})).toBe(true)
    expect(stagedPlanningEnabled({ DOXLOOP_PLANNING_STAGED: '0' })).toBe(false)
    expect(stagedPlanningEnabled({ DOXLOOP_PLANNING_STAGED: 'off' })).toBe(false)
    expect(stagedPlanningEnabled({ DOXLOOP_PLANNING_STAGED: '1' })).toBe(true)
    expect(planningParallelism({})).toBe(2)
    expect(planningParallelism({ DOXLOOP_PLANNING_PARALLEL: '5' })).toBe(5)
    expect(planningParallelism({ DOXLOOP_PLANNING_PARALLEL: '0' })).toBe(2)
    expect(planningParallelism({ DOXLOOP_PLANNING_PARALLEL: 'lots' })).toBe(2)
  })
})
