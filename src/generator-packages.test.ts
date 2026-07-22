import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { installSkill } from './agents.js'
import { authorPrompt } from './author.js'
import {
  GENERATOR_CATALOG,
  generatorCatalogEntry,
  loadGeneratorAdapter,
} from './generators.js'
import { scaffoldProject } from './project.js'
import type { GeneratorName } from './types.js'
import { validateProject } from './validation.js'

const roots: string[] = []

const externalGenerators = [
  'docusaurus',
  'mkdocs',
  'sphinx',
  'hugo',
  'vitepress',
  'markdoc',
  'nextra',
  'starlight',
  'jekyll',
  'static',
] as const satisfies readonly Exclude<GeneratorName, 'doxbrix'>[]

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('official generator packages', () => {
  test('catalogs every generator supported by Doxbrix Connected Docs', () => {
    expect(GENERATOR_CATALOG.map((entry) => entry.id)).toEqual([
      'doxbrix',
      ...externalGenerators,
    ])
    for (const generator of externalGenerators) {
      expect(generatorCatalogEntry(generator)?.packageName).toBe(
        `@doxbrix/doxloop-generator-${generator}`,
      )
    }
  })

  test.each(externalGenerators)(
    'scaffolds, loads, validates, and installs only the %s format skill',
    async (generator) => {
      const parent = await mkdtemp(join(tmpdir(), `doxloop-${generator}-`))
      roots.push(parent)
      const root = await scaffoldProject({
        directory: join(parent, 'docs'),
        title: `Test ${generator}`,
        sources: [],
        generator,
      })
      const project = JSON.parse(
        await readFile(join(root, '.doxloop', 'project.json'), 'utf8'),
      ) as { generator: string; generatorPackage: string }
      expect(project).toMatchObject({
        generator,
        generatorPackage: `@doxbrix/doxloop-generator-${generator}`,
      })

      const adapter = await loadGeneratorAdapter(root, generator)
      expect(adapter.id).toBe(generator)
      expect(adapter.authoring.skillName).toBe(`doxloop-${generator}`)

      const result = await validateProject(root)
      expect(
        result.issues.filter(
          (issue) =>
            issue.severity === 'error' && issue.code !== 'starter-content',
        ),
      ).toEqual([])
      expect(result.pages.length).toBeGreaterThanOrEqual(2)

      const installed = await installSkill({ root, agent: 'codex' })
      expect(installed.map((entry) => entry.path)).toEqual([
        join(root, '.agents', 'skills', 'doxloop-authoring'),
        join(root, '.agents', 'skills', `doxloop-${generator}`),
      ])
      const prompt = authorPrompt('create', [], undefined, generator)
      expect(prompt).toContain(
        `$doxloop-authoring and $doxloop-${generator}`,
      )
    },
    20_000,
  )
})
