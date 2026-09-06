import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { createDocumentationPlan, planWritingRequirements, templateInstructions } from './documentation-plan.js'
import { loadProject, scaffoldProject } from './project.js'
import {
  changelogExcerpt,
  collectReleaseInventory,
  extractVersionSection,
  formatReleaseInventory,
  gitBackedSources,
  listSourceRefs,
  releaseNotesPagePath,
} from './release-notes.js'

const execute = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await execute('git', args, {
    cwd,
    env: { ...process.env, GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com', GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com' },
  })
  return result.stdout
}

async function fixture(): Promise<{ root: string; product: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-release-'))
  roots.push(parent)
  const product = join(parent, 'product')
  await mkdir(product, { recursive: true })
  await git(product, 'init', '-q', '-b', 'main')
  await writeFile(join(product, 'CHANGELOG.md'), '# Changelog\n\n## v1.1.0\n\n- Added webhooks for event delivery.\n- Removed the legacy `syncMode` flag.\n\n## v1.0.0\n\n- First release.\n', 'utf8')
  await writeFile(join(product, 'index.ts'), 'export const version = "1.0.0"\n', 'utf8')
  await git(product, 'add', '.')
  await git(product, 'commit', '-q', '-m', 'Initial release')
  await git(product, 'tag', 'v1.0.0')
  await writeFile(join(product, 'webhooks.ts'), 'export function deliver() {}\n', 'utf8')
  await git(product, 'add', '.')
  await git(product, 'commit', '-q', '-m', 'Add webhook delivery', '-m', 'Delivers each event to configured HTTPS endpoints.')
  await writeFile(join(product, 'index.ts'), 'export const version = "1.1.0"\n', 'utf8')
  await git(product, 'add', '.')
  await git(product, 'commit', '-q', '-m', 'Remove legacy syncMode flag')
  await git(product, 'tag', 'v1.1.0')
  const root = await scaffoldProject({ directory: join(parent, 'docs'), title: 'Pulse', sources: [{ name: 'product', path: '../product' }], generator: 'doxbrix' })
  return { root, product }
}

describe('release notes inventory', () => {
  test('lists tags newest first with a suggested range', async () => {
    const { root } = await fixture()
    const project = await loadProject(root)
    expect((await gitBackedSources(root, project)).map((source) => source.name)).toEqual(['product'])
    const refs = await listSourceRefs(root, 'product')
    expect(refs.tags).toEqual(['v1.1.0', 'v1.0.0'])
    expect(refs.branches).toEqual(['main'])
    expect(refs.suggested).toEqual({ from: 'v1.0.0', to: 'v1.1.0', version: 'v1.1.0' })
    await expect(listSourceRefs(root, 'missing')).rejects.toThrow('not a directory source')
  })

  test('collects the commits, changed files, and changelog section between two refs', async () => {
    const { root } = await fixture()
    const project = await loadProject(root)
    const inventory = await collectReleaseInventory(root, project, { version: 'v1.1.0', from: 'v1.0.0', to: 'v1.1.0' })
    expect(inventory.sources).toHaveLength(1)
    const source = inventory.sources[0]!
    expect(source.commits.map((commit) => commit.subject)).toEqual(['Remove legacy syncMode flag', 'Add webhook delivery'])
    expect(source.commits[1]!.body).toBe('Delivers each event to configured HTTPS endpoints.')
    expect(source.changedFiles).toEqual(['M index.ts', 'A webhooks.ts'])
    expect(source.truncated).toBe(false)
    expect(source.changelog).toEqual({ path: 'CHANGELOG.md', excerpt: '## v1.1.0\n\n- Added webhooks for event delivery.\n- Removed the legacy `syncMode` flag.' })
    const text = formatReleaseInventory(inventory)
    expect(text).toContain('Release: v1.1.0 (v1.0.0..v1.1.0')
    expect(text).toContain('Add webhook delivery — Delivers each event')
    expect(text).toContain('- A webhooks.ts')
    await expect(collectReleaseInventory(root, project, { version: 'v2', from: 'v9.9.9', to: 'HEAD' })).rejects.toThrow('not a commit, tag, or branch')
    await expect(collectReleaseInventory(root, project, { version: 'v2', from: '--output=/tmp/x', to: 'HEAD' })).rejects.toThrow('must be a Git tag, branch, or commit')
    await expect(collectReleaseInventory(root, project, { version: 'v2', from: 'v1.0.0', to: 'HEAD', sources: ['other'] })).rejects.toThrow('None of other')
  })

  test('feeds the inventory into a plan and its planner and writer instructions', async () => {
    const { root } = await fixture()
    const plan = await createDocumentationPlan(root, { mode: 'update', scope: 'custom', execution: { screenshots: 'disabled' }, template: { version: 'v1.1.0', from: 'v1.0.0', to: 'v1.1.0' } })
    expect(plan.request).toBe('Release notes for v1.1.0')
    expect(plan.template).toMatchObject({ kind: 'release-notes', version: 'v1.1.0', from: 'v1.0.0', to: 'v1.1.0', sources: [] })
    expect(plan.template?.inventory.sources[0]?.commits).toHaveLength(2)
    const instructions = templateInstructions(plan)
    expect(instructions).toContain('type "release" at path "release-notes/1.1.0"')
    expect(instructions).toContain('Remove legacy syncMode flag')
    const writer = planWritingRequirements({ ...plan, pages: [{ id: 'model', title: 'Event model', path: 'concepts/event-model', type: 'concept', priority: 'must-have', action: 'create', purpose: 'p', rationale: 'r', evidence: [], evidenceDetails: [], diagram: 'required' }] })
    expect(writer).toContain('Pages that must contain a Mermaid diagram')
    expect(writer).toContain('- Event model (concepts/event-model)')
    expect(writer).toContain('Release inventory the release-notes page must be grounded in')
    expect(planWritingRequirements({ pages: [], target: plan.target })).toBe('')
  })

  test('extracts the matching changelog section, including the migration-release eval fixture', async () => {
    const text = '# Changelog\n\n## [2.0.0] - 2026-09-01\n\n### Breaking\n\n- Dropped Node 18.\n\n## [1.5.0]\n\n- Older.\n'
    expect(extractVersionSection(text, 'v2.0.0')).toBe('## [2.0.0] - 2026-09-01\n\n### Breaking\n\n- Dropped Node 18.')
    expect(extractVersionSection(text, '9.9.9')).toBe(text.slice(0, 6000))
    const fixture = await changelogExcerpt(join(process.cwd(), 'evals', 'fixtures', 'migration-release', 'product'), '3')
    expect(fixture?.path).toBe('CHANGELOG.md')
    expect(fixture?.excerpt.startsWith('# Version 3')).toBe(true)
    expect(fixture?.excerpt).toContain('legacyMode')
    expect(await readFile(join(process.cwd(), 'evals', 'fixtures', 'migration-release', 'product', 'CHANGELOG.md'), 'utf8')).toContain('Version 3')
  })

  test('derives a stable page path from the version label', () => {
    expect(releaseNotesPagePath('v1.1.0')).toBe('release-notes/1.1.0')
    expect(releaseNotesPagePath('2026.09 Autumn')).toBe('release-notes/2026.09-autumn')
    expect(releaseNotesPagePath('   ')).toBe('release-notes/latest')
  })
})
