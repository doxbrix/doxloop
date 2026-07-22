import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import { loadProject } from './project.js'
import { validateProject } from './validation.js'

interface EvaluationManifest {
  schemaVersion: number
  cases: Array<{
    id: string
    productType: string
    minimumSignalGroups: number
    minimumEvidenceGroups: number
    signalGroups: string[][]
    evidenceGroups: string[][]
  }>
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('authoring evaluation fixtures', () => {
  test('cover the four professional documentation surfaces', async () => {
    const manifest = JSON.parse(
      await readFile(join(root, 'evals', 'cases.json'), 'utf8'),
    ) as EvaluationManifest

    expect(manifest.schemaVersion).toBe(1)
    expect(manifest.cases.map((entry) => entry.productType).sort()).toEqual([
      'cli',
      'library',
      'rest-api',
      'web-app',
    ])

    for (const entry of manifest.cases) {
      expect(entry.minimumSignalGroups).toBeGreaterThan(0)
      expect(entry.minimumSignalGroups).toBeLessThanOrEqual(
        entry.signalGroups.length,
      )
      expect(entry.minimumEvidenceGroups).toBeGreaterThan(0)
      expect(entry.minimumEvidenceGroups).toBeLessThanOrEqual(
        entry.evidenceGroups.length,
      )
      const projectRoot = join(root, 'evals', 'fixtures', entry.id, 'project')
      const project = await loadProject(projectRoot)
      expect(project.documentation.primaryAudience).toBeTruthy()
      expect(project.documentation.priorityOutcomes).not.toHaveLength(0)
      const result = await validateProject(projectRoot)
      expect(result.pages).toEqual(['index'])
      expect(
        result.issues.filter(
          (issue) =>
            !['missing-image-alt', 'weak-link-text'].includes(issue.code),
        ),
      ).toHaveLength(0)
    }
  })
})
