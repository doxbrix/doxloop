import { createHash } from 'node:crypto'
import { cp, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { readEvidenceMap } from './evidence.js'
import { listFiles } from './fs.js'
import { listPages } from './pages.js'
import { importExistingDocumentation, inspectExistingDocumentation } from './project-import.js'
import { loadProject, scaffoldProject } from './project.js'

const roots: string[] = []
const previousHome = process.env.DOXLOOP_HOME

beforeEach(async () => {
  const home = await mkdtemp(join(tmpdir(), 'doxloop-import-home-'))
  roots.push(home)
  process.env.DOXLOOP_HOME = home
})

afterEach(async () => {
  if (previousHome === undefined) delete process.env.DOXLOOP_HOME
  else process.env.DOXLOOP_HOME = previousHome
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixtureCopy(name: string): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-import-'))
  roots.push(parent)
  const root = join(parent, 'site')
  await cp(join(process.cwd(), 'evals', 'fixtures', name, 'project'), root, { recursive: true })
  await rm(join(root, '.doxloop'), { recursive: true, force: true })
  return root
}

async function contentDigest(root: string, extensions: string[]): Promise<Map<string, string>> {
  const files = await listFiles(root, new Set(extensions), { ignoredDirectories: new Set(['.doxloop', '.agents', '.claude', 'node_modules']) })
  const digest = new Map<string, string>()
  for (const file of files) digest.set(file, createHash('sha256').update(await readFile(file)).digest('hex'))
  return digest
}

describe('importing existing documentation', () => {
  test('adopts a Doxbrix site from the eval fixtures without touching a page', async () => {
    const root = await fixtureCopy('cli')
    const before = await contentDigest(root, ['.md', '.mdx', '.json'])

    const inspection = await inspectExistingDocumentation(root)
    expect(inspection).toMatchObject({ alreadyProject: false, generator: 'doxbrix', contentDir: 'docs', generatorInstalled: true })
    expect(inspection.pageCount).toBeGreaterThan(0)
    expect(inspection.pages).toContain('docs/index.md')

    const result = await importExistingDocumentation({ directory: root })
    expect(result).toMatchObject({ root, generator: 'doxbrix', contentDir: 'docs', pageCount: inspection.pageCount })
    expect(result.skills.some((install) => install.action === 'installed')).toBe(true)

    const project = await loadProject(root)
    expect(project).toMatchObject({ generator: 'doxbrix', contentDir: 'docs', sources: [] })
    expect(project.title).toBe(inspection.title)

    const evidence = await readEvidenceMap(root)
    expect(Object.keys(evidence?.pages ?? {})).toEqual(inspection.pages)
    expect(evidence?.pages['docs/index.md']).toEqual({ sources: [], confidence: 'needs-human' })

    const pages = await listPages(root)
    expect(pages.map((page) => page.path)).toEqual(inspection.pages)
    expect(pages.every((page) => page.evidence === 'needs-review')).toBe(true)

    expect(await contentDigest(root, ['.md', '.mdx', '.json'])).toEqual(before)
    expect((await readFile(join(root, '.gitignore'), 'utf8'))).toContain('.doxloop/cache/')
  })

  test('adopts an external generator site with its content directory detected', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-import-mkdocs-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'manual'), sources: [], generator: 'mkdocs', title: 'Scaffolded' })
    await rm(join(root, '.doxloop'), { recursive: true, force: true })
    const before = await contentDigest(root, ['.md', '.yml'])

    const inspection = await inspectExistingDocumentation(root)
    expect(inspection).toMatchObject({ generator: 'mkdocs', contentDir: 'docs', title: 'Scaffolded', generatorInstalled: true })
    const result = await importExistingDocumentation({ directory: root, title: 'Adopted manual' })
    expect(result).toMatchObject({ generator: 'mkdocs', contentDir: 'docs', title: 'Adopted manual' })
    expect((await loadProject(root)).generatorPackage).toBe('@doxbrix/doxloop-generator-mkdocs')
    expect((await listPages(root)).map((page) => page.path).sort()).toEqual(['docs/index.md', 'docs/quickstart.md'])
    expect(await contentDigest(root, ['.md', '.yml'])).toEqual(before)
  })

  test('honours explicit choices and refuses folders it cannot adopt', async () => {
    const root = await fixtureCopy('cli')
    await expect(importExistingDocumentation({ directory: join(root, 'nope') })).rejects.toThrow('does not exist')
    await expect(importExistingDocumentation({ directory: root, contentDir: 'missing' })).rejects.toThrow()
    const plain = await mkdtemp(join(tmpdir(), 'doxloop-import-plain-'))
    roots.push(plain)
    await expect(importExistingDocumentation({ directory: plain })).rejects.toThrow('Could not recognize')
    const explicit = await importExistingDocumentation({ directory: plain, generator: 'doxbrix', contentDir: '', title: 'Empty' })
    expect(explicit).toMatchObject({ generator: 'doxbrix', contentDir: '', pageCount: 0 })

    await importExistingDocumentation({ directory: root })
    await expect(importExistingDocumentation({ directory: root })).rejects.toThrow('already a Doxloop project')
    expect((await inspectExistingDocumentation(root)).alreadyProject).toBe(true)
    await expect(stat(join(root, '.doxloop', 'project.json'))).resolves.toBeTruthy()
  })
})
