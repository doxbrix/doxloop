import { describe, expect, test } from 'vitest'
import { generatorLabel, inspectionSummary, projectFolderName, recentProjectChoices } from './project-presentation'
import type { ProjectInspection } from './types'

const generators = [{ id: 'doxbrix', displayName: 'Doxbrix' }, { id: 'mkdocs', displayName: 'MkDocs Material' }]

function inspection(overrides: { [K in keyof ProjectInspection]?: ProjectInspection[K] | undefined } = {}): ProjectInspection {
  const base: ProjectInspection = {
    root: '/work/site',
    alreadyProject: false,
    detection: { candidates: [] },
    generator: 'mkdocs',
    contentDir: 'docs',
    title: 'Site',
    markers: ['mkdocs.yml'],
    pageCount: 12,
    pages: ['docs/index.md'],
    generatorInstalled: true,
    generatorPackage: '@doxbrix/doxloop-generator-mkdocs',
  }
  const merged: Record<string, unknown> = { ...base, ...overrides }
  for (const [key, value] of Object.entries(overrides)) if (value === undefined) delete merged[key]
  return merged as unknown as ProjectInspection
}

describe('project switcher presentation', () => {
  test('lists recent projects newest first without the open one', () => {
    const choices = recentProjectChoices([
      { path: '/a', title: 'A', generator: 'doxbrix', lastOpenedAt: '2026-09-01T00:00:00.000Z' },
      { path: '/current', title: 'Current', generator: 'doxbrix', lastOpenedAt: '2026-09-04T00:00:00.000Z' },
      { path: '/b', title: 'B', generator: 'mkdocs', lastOpenedAt: '2026-09-03T00:00:00.000Z', missing: true },
    ], '/current')
    expect(choices.map((project) => project.path)).toEqual(['/b', '/a'])
    expect(recentProjectChoices(undefined, '/current')).toEqual([])
  })

  test('names a project by its folder', () => {
    expect(projectFolderName('/work/product-docs/')).toBe('product-docs')
    expect(projectFolderName('C:\\docs\\site')).toBe('site')
    expect(generatorLabel('mkdocs', generators)).toBe('MkDocs Material')
    expect(generatorLabel('hugo', generators)).toBe('hugo')
    expect(generatorLabel(undefined, generators)).toBe('Unknown generator')
  })

  test('summarizes what an import would adopt', () => {
    expect(inspectionSummary(inspection(), generators)).toMatchObject({ headline: 'MkDocs Material site · 12 pages', tone: 'ok', canImport: true })
    expect(inspectionSummary(inspection({ generator: 'doxbrix', contentDir: '', pageCount: 1 }), generators).headline).toBe('Doxbrix site · 1 page')
    expect(inspectionSummary(inspection({ pageCount: 0 }), generators)).toMatchObject({ tone: 'warn', canImport: true })
    expect(inspectionSummary(inspection({ generatorInstalled: false }), generators)).toMatchObject({ tone: 'warn', canImport: true })
    expect(inspectionSummary(inspection({ generator: undefined, contentDir: undefined, markers: [] }), generators)).toMatchObject({ tone: 'warn', canImport: false })
    expect(inspectionSummary(inspection({ alreadyProject: true }), generators)).toMatchObject({ tone: 'bad', canImport: false })
  })
})
