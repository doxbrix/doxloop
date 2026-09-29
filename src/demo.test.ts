import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { withHistory, closeHistory } from './db.js'
import { createDemoWorkspace, shiftJsonTimestamps } from './demo.js'
import { latestDocumentationPlan } from './documentation-plan.js'
import { computeDrift } from './drift.js'
import { loadProject } from './project.js'
import { listSyncRuns } from './sync-runs.js'

describe('bundled demo', () => {
  it('unpacks a finished project with a pending Monitoring update, outside the current directory', async () => {
    const now = new Date('2031-05-04T10:00:00.000Z')
    const demo = await createDemoWorkspace({ now })
    try {
      expect(demo.root.startsWith(demo.parent)).toBe(true)
      expect(demo.product.startsWith(demo.parent)).toBe(true)
      expect(demo.validation.errors).toBe(0)
      expect(demo.validation.pages.length).toBeGreaterThanOrEqual(12)
      expect((await latestDocumentationPlan(demo.root))?.status).toBe('generated')

      // The update Monitoring drafted waits in Review and can be rendered.
      const runs = await listSyncRuns(demo.root)
      const pending = runs.find((run) => run.id === demo.pendingProposal?.id)
      expect(pending?.status).toBe('awaiting-review')
      expect(pending?.changes.length).toBeGreaterThan(0)
      expect(runs.some((run) => run.status === 'applied')).toBe(true)

      // The product moved on, and the drift names the pages that document the change.
      const project = await loadProject(demo.root)
      expect(project.sources[0]?.path).toBe('../pet-store-api/openapi.json')
      const drift = await computeDrift(demo.root, project)
      expect(drift.status).toBe('stale')
      expect(drift.pages.length).toBeGreaterThan(0)
      expect(drift.pages.length).toBeLessThan(demo.validation.pages.length)

      // No placeholder or developer path survives, and the story happened just now.
      const jobs = await readFile(join(demo.root, '.doxloop', 'ui-jobs.json'), 'utf8')
      expect(jobs).not.toContain('{{DOXLOOP_DEMO_ROOT}}')
      expect(jobs).not.toMatch(/\/Users\/|\\Users\\/)
      const newest = Math.max(...runs.map((run) => Date.parse(run.createdAt)))
      expect(newest).toBeLessThan(now.getTime())
      expect(newest).toBeGreaterThan(now.getTime() - 6 * 60 * 60_000)
      const latestRequest = await withHistory(demo.root, (database) => database.prepare('SELECT MAX(created_at) AS at FROM requests').get() as { at: string | null })
      closeHistory(demo.root)
      if (latestRequest?.at) expect(Date.parse(latestRequest.at)).toBeLessThan(now.getTime())
    } finally {
      await demo.cleanup()
    }
  })

  it('moves ISO timestamps and leaves other strings alone', () => {
    const text = `${JSON.stringify({ createdAt: '2026-09-29T10:00:00.000Z', id: 'run-20260929t100000z-abc123', note: 'at 2026-09-29T10:00:00.000Z', nested: [{ at: '2026-09-29T10:00:00Z' }] }, null, 2)}\n`
    const shifted = JSON.parse(shiftJsonTimestamps(text, 60_000))
    expect(shifted).toEqual({ createdAt: '2026-09-29T10:01:00.000Z', id: 'run-20260929t100000z-abc123', note: 'at 2026-09-29T10:00:00.000Z', nested: [{ at: '2026-09-29T10:01:00.000Z' }] })
  })
})
