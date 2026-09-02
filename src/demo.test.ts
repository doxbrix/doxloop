import { describe, expect, it } from 'vitest'
import { createDemoWorkspace } from './demo.js'
import { latestDocumentationPlan } from './documentation-plan.js'
import { listReviewReports } from './review-report.js'

describe('safe bundled demo', () => {
  it('creates a generated, validated showcase outside the current repository', async () => {
    const demo = await createDemoWorkspace()
    try {
      expect(demo.root.startsWith(demo.parent)).toBe(true)
      expect(demo.validation.errors).toBe(0)
      expect(demo.validation.pages).toHaveLength(7)
      expect((await latestDocumentationPlan(demo.root))?.status).toBe('generated')
      expect((await listReviewReports(demo.root))[0]?.hardGates).toBe('pass')
    } finally { await demo.cleanup() }
  })
})
