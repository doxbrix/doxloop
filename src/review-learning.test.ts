import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { recordReviewPreference, REVIEW_PREFERENCES_FILE, reviewPreferenceGuidance } from './review-learning.js'

const roots: string[] = []
afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))))

describe('review preference learning', () => {
  test('retains concurrent feedback and redacts credentials before future prompts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-preferences-')); roots.push(root)
    await Promise.all([
      recordReviewPreference(root, { kind: 'revision', paths: ['quickstart.mdx'], instruction: 'Prefer TypeScript examples.' }),
      recordReviewPreference(root, { kind: 'inline-edit', paths: ['api.mdx'], instruction: 'Use token ghp_abcdefghijklmnopqrstuvwxyz1234567890 only here.' }),
    ])
    const saved = await readFile(join(root, REVIEW_PREFERENCES_FILE), 'utf8')
    expect(JSON.parse(saved).entries).toHaveLength(2)
    expect(saved).not.toContain('ghp_')
    expect(await reviewPreferenceGuidance(root)).toContain('Prefer TypeScript examples.')
    expect(await readFile(join(root, '.gitignore'), 'utf8')).toContain('.doxloop/review-preferences.json')
  })
})
