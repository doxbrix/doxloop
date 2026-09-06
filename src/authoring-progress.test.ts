import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AUTHORING_STAGE,
  AuthoringProgressTracker,
  classifyAgentToolCall,
  classifyWorkspaceFile,
  plannedPageCount,
  watchWorkspaceActivity,
  type WorkspaceLayout,
} from './authoring-progress.js'
import type { WorkflowStageProgress, WorkflowStageStatus } from './job-events.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

const doxbrix: WorkspaceLayout = { contentDir: '', pageExtensions: ['.md', '.mdx'], navigationFiles: ['docs.json'] }
const docusaurus: WorkspaceLayout = { contentDir: 'docs', pageExtensions: ['.md', '.mdx'], navigationFiles: ['sidebars.js', 'docusaurus.config.js'] }

type Emitted = { id: string; label: string; status: WorkflowStageStatus; progress?: WorkflowStageProgress }

function tracker(options: { plannedPages?: number; screenshots?: boolean; pageLabel?: string } = {}): { tracker: AuthoringProgressTracker; events: Emitted[] } {
  const events: Emitted[] = []
  const instance = new AuthoringProgressTracker({
    ...(options.plannedPages !== undefined ? { plannedPages: options.plannedPages } : {}),
    screenshots: options.screenshots ?? false,
    ...(options.pageLabel ? { pageLabel: options.pageLabel } : {}),
    emit: (id, label, status, progress) => events.push({ id, label, status, ...(progress ? { progress } : {}) }),
  })
  return { tracker: instance, events }
}

describe('workspace file classification', () => {
  test('maps the files an agent writes to the stage they advance', () => {
    expect(classifyWorkspaceFile('guides/setup.mdx', doxbrix)).toEqual({ kind: 'page', path: 'guides/setup.mdx' })
    expect(classifyWorkspaceFile('docs.json', doxbrix)).toEqual({ kind: 'navigation', path: 'docs.json' })
    expect(classifyWorkspaceFile('.doxloop/evidence-map.json', doxbrix)).toEqual({ kind: 'evidence', path: '.doxloop/evidence-map.json' })
    expect(classifyWorkspaceFile('.doxloop/capture-output/login.png', doxbrix)).toEqual({ kind: 'screenshot', path: '.doxloop/capture-output/login.png' })
    expect(classifyWorkspaceFile('.doxloop/screenshot-manifest.json', doxbrix)).toEqual({ kind: 'screenshot' })
    expect(classifyWorkspaceFile('assets/guides/setup/step-1.png', doxbrix)).toEqual({ kind: 'screenshot', path: 'assets/guides/setup/step-1.png' })
  })

  test('respects the content directory and navigation files of an external generator', () => {
    expect(classifyWorkspaceFile('docs/intro.md', docusaurus)).toEqual({ kind: 'page', path: 'docs/intro.md' })
    expect(classifyWorkspaceFile('README.md', docusaurus)).toBeUndefined()
    expect(classifyWorkspaceFile('sidebars.js', docusaurus)).toEqual({ kind: 'navigation', path: 'sidebars.js' })
    expect(classifyWorkspaceFile('docusaurus.config.js', docusaurus)).toEqual({ kind: 'navigation', path: 'docusaurus.config.js' })
  })

  test('ignores bookkeeping, dependencies, and unrelated files', () => {
    expect(classifyWorkspaceFile('.doxloop/documentation-plan.json', doxbrix)).toBeUndefined()
    expect(classifyWorkspaceFile('node_modules/pkg/readme.md', doxbrix)).toBeUndefined()
    expect(classifyWorkspaceFile('.git/index', doxbrix)).toBeUndefined()
    expect(classifyWorkspaceFile('package.json', doxbrix)).toBeUndefined()
    expect(classifyWorkspaceFile('', doxbrix)).toBeUndefined()
  })

  test('recognizes capture tool calls and validation commands from Claude', () => {
    expect(classifyAgentToolCall('mcp__doxloop_capture__browser_take_screenshot', {}, { captureServer: 'doxloop_capture' })).toEqual({ kind: 'screenshot' })
    expect(classifyAgentToolCall('mcp__doxloop_capture__browser_navigate', {}, { captureServer: 'doxloop_capture' })).toBeUndefined()
    expect(classifyAgentToolCall('Bash', { command: 'doxloop test --cwd .' })).toEqual({ kind: 'validation' })
    expect(classifyAgentToolCall('Bash', { command: 'ls' })).toBeUndefined()
    expect(classifyAgentToolCall('Write', { file_path: 'index.mdx' })).toBeUndefined()
    // Gemini exposes MCP tools by their bare name; Codex reports them under the server prefix.
    expect(classifyAgentToolCall('browser_take_screenshot', {}, { captureServer: 'doxloop_capture' })).toEqual({ kind: 'screenshot' })
    expect(classifyAgentToolCall('mcp__other__take_screenshot', {}, { captureServer: 'doxloop_capture' })).toBeUndefined()
    expect(classifyAgentToolCall('Bash', { command: 'npx doxloop test' })).toEqual({ kind: 'validation' })
  })

  test('counts only the pages a plan asks the agent to write', () => {
    const page = (action: 'create' | 'update' | 'preserve' | 'remove') => ({ action } as { action: typeof action })
    expect(plannedPageCount({ pages: [page('create'), page('update'), page('preserve'), page('remove')] } as never)).toBe(2)
    expect(plannedPageCount({ pages: [page('preserve')] } as never)).toBeUndefined()
    expect(plannedPageCount(undefined)).toBeUndefined()
  })
})

describe('authoring progress tracker', () => {
  test('announces every stage, then advances them one at a time with a page counter', () => {
    const { tracker: progress, events } = tracker({ plannedPages: 3, screenshots: true })
    progress.begin()
    expect(events.map((event) => `${event.id}:${event.status}`)).toEqual([
      `${AUTHORING_STAGE.authoring}:pending`,
      `${AUTHORING_STAGE.navigation}:pending`,
      `${AUTHORING_STAGE.evidence}:pending`,
      `${AUTHORING_STAGE.screenshots}:pending`,
      `${AUTHORING_STAGE.validating}:pending`,
    ])
    expect(events[0]?.progress).toEqual({ done: 0, total: 3 })
    events.length = 0

    progress.record({ kind: 'page', path: 'index.mdx' })
    progress.record({ kind: 'page', path: 'index.mdx' })
    progress.record({ kind: 'page', path: 'guides/setup.mdx' })
    expect(events).toEqual([
      { id: AUTHORING_STAGE.authoring, label: 'Authoring approved pages', status: 'running', progress: { done: 1, total: 3 } },
      { id: AUTHORING_STAGE.authoring, label: 'Authoring approved pages', status: 'running', progress: { done: 2, total: 3 } },
    ])
    events.length = 0

    progress.record({ kind: 'screenshot' })
    progress.record({ kind: 'screenshot', path: '.doxloop/capture-output/a.png' })
    progress.record({ kind: 'navigation', path: 'docs.json' })
    progress.record({ kind: 'evidence' })
    progress.record({ kind: 'evidence' })
    expect(events.map((event) => `${event.id}:${event.status}`)).toEqual([
      `${AUTHORING_STAGE.screenshots}:running`,
      `${AUTHORING_STAGE.navigation}:running`,
      `${AUTHORING_STAGE.evidence}:running`,
    ])
    expect(progress.pagesWritten()).toBe(2)
  })

  test('settles untouched stages honestly and hands validation to Doxloop', () => {
    const { tracker: progress, events } = tracker({ plannedPages: 2, pageLabel: 'Editing selected pages' })
    progress.begin()
    progress.record({ kind: 'page', path: 'index.mdx' })
    events.length = 0
    progress.finish()
    progress.validating()
    expect(events).toEqual([
      { id: AUTHORING_STAGE.authoring, label: 'Editing selected pages', status: 'completed', progress: { done: 1, total: 2 } },
      { id: AUTHORING_STAGE.navigation, label: 'Navigation and theme unchanged', status: 'completed' },
      { id: AUTHORING_STAGE.evidence, label: 'Page evidence unchanged', status: 'completed' },
      { id: AUTHORING_STAGE.validating, label: 'Validating generated documentation', status: 'running' },
    ])
    // Activity after the run finished changes nothing.
    events.length = 0
    progress.record({ kind: 'page', path: 'late.mdx' })
    expect(events).toEqual([])
  })

  test('starts validation when the agent runs the validator itself', () => {
    const { tracker: progress, events } = tracker()
    progress.begin()
    events.length = 0
    progress.record({ kind: 'validation' })
    progress.record({ kind: 'validation' })
    expect(events).toEqual([{ id: AUTHORING_STAGE.validating, label: 'Validating generated documentation', status: 'running' }])
  })
})

describe('workspace watcher', () => {
  test('reports page, navigation, and evidence writes as they land', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'doxloop-progress-watch-'))
    roots.push(workspace)
    await mkdir(join(workspace, '.doxloop'), { recursive: true })
    await mkdir(join(workspace, 'guides'), { recursive: true })
    const seen: string[] = []
    const stop = await watchWorkspaceActivity(workspace, doxbrix, (activity) => seen.push(`${activity.kind}:${activity.path ?? ''}`))
    try {
      await writeFile(join(workspace, 'guides', 'setup.mdx'), '# Setup\n')
      await writeFile(join(workspace, 'docs.json'), '{}\n')
      await writeFile(join(workspace, '.doxloop', 'evidence-map.json'), '{}\n')
      await writeFile(join(workspace, 'notes.txt'), 'ignored\n')
      const started = Date.now()
      while (seen.length < 3 && Date.now() - started < 8_000) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 100))
      }
    } finally {
      await stop()
    }
    expect(new Set(seen)).toEqual(new Set(['page:guides/setup.mdx', 'navigation:docs.json', 'evidence:.doxloop/evidence-map.json']))
  })
})
