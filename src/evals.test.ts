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
    scenarioTags?: string[]
    minimumSignalGroups: number
    minimumEvidenceGroups: number
    signalGroups: string[][]
    evidenceGroups: string[][]
  }>
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

describe('authoring evaluation fixtures', () => {
  test('cover the release-grade product and adversarial scenarios', async () => {
    const manifest = JSON.parse(
      await readFile(join(root, 'evals', 'cases.json'), 'utf8'),
    ) as EvaluationManifest

    expect(manifest.schemaVersion).toBe(2)
    expect(manifest.cases).toHaveLength(10)
    const scenarios = new Set(manifest.cases.flatMap((entry) => entry.scenarioTags ?? []))
    expect(scenarios).toEqual(new Set([
      'authentication-security',
      'multi-package-monorepo',
      'evolving-rest-api',
      'ui-heavy-saas',
      'data-infrastructure-tools',
      'migration-release-documentation',
      'misleading-source-comments',
      'incomplete-contradictory-evidence',
      'localized-existing-doc-update',
    ]))

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
      expect(result.pages.length).toBeGreaterThan(0)
      if (entry.id === 'web-app') expect(result.issues).toContainEqual(expect.objectContaining({ code: 'broken-link', message: 'Local link target does not exist: /invite-dialog.png' }))
      expect(
        result.issues.filter(
          (issue) =>
            // Fixture pages are deliberately small; depth is measured on real runs.
            !['missing-image-alt', 'weak-link-text', 'thin-page', 'thin-procedure'].includes(issue.code) &&
            // The web-app fixture intentionally references an absent screenshot.
            !(entry.id === 'web-app' && issue.code === 'broken-link' && issue.message === 'Local link target does not exist: /invite-dialog.png'),
        ),
      ).toHaveLength(0)
    }
  })
})
