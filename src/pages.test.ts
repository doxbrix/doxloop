import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { writeEvidenceMap } from './evidence.js'
import { listPages, pageRoute, resolveEditScope } from './pages.js'
import { loadProject, scaffoldProject } from './project.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-pages-'))
  roots.push(root)
  await scaffoldProject({ directory: root, title: 'Pages test', sources: [] })
  await writeFile(join(root, 'orphan.mdx'), '---\ntitle: Orphan page\ndescription: A page outside navigation.\n---\n\nSome useful orphan content.\n')
  return { root, project: await loadProject(root) }
}

describe('documentation pages', () => {
  test('lists navigation pages first and groups an orphan last', async () => {
    const { root } = await fixture()
    await writeEvidenceMap(root, { schemaVersion: 1, pages: { 'index.mdx': { sources: [], claimVerification: { Intro: 'verified' } } } })
    const pages = await listPages(root)
    expect(pages.at(-1)).toMatchObject({ path: 'orphan.mdx', title: 'Orphan page', inNavigation: false, evidence: 'none' })
    expect(pages[0]).toMatchObject({ path: 'index.mdx', route: '/', inNavigation: true, evidence: 'verified' })
    expect(pages[0]!.wordCount).toBeGreaterThan(0)
  })

  test('maps index, nested, and external-generator pages to preview routes', async () => {
    const { project } = await fixture()
    expect(pageRoute(project, 'index.mdx')).toBe('/')
    expect(pageRoute(project, 'guides/install.mdx')).toBe('/guides/install')
    expect(pageRoute({ ...project, generator: 'docusaurus', contentDir: 'docs' }, 'docs/reference/api.md')).toBe('/reference/api')
  })

  test('rejects paths outside content and adds navigation only for related edits', async () => {
    const { root, project } = await fixture()
    await expect(resolveEditScope(root, project, ['.doxloop/project.json'], false)).rejects.toThrow('.doxloop/project.json')
    const strict = await resolveEditScope(root, project, ['index.mdx'], false)
    const related = await resolveEditScope(root, project, ['index.mdx'], true)
    expect(strict.supportingPaths.has('.doxloop/evidence-map.json')).toBe(true)
    expect(strict.supportingPaths.has('docs.json')).toBe(false)
    expect(related.supportingPaths.has('docs.json')).toBe(true)
    expect(related.supportingPrefixes?.has('assets/index')).toBe(true)
  })
})
