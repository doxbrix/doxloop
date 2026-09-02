import { describe, expect, test } from 'vitest'
import { documentationPlanTarget } from './plan-generator.js'
import type { DoxloopProject } from './types.js'

const project = (generator: DoxloopProject['generator']): DoxloopProject => ({
  schemaVersion: 1,
  title: 'Docs',
  contentDir: generator === 'doxbrix' ? '' : 'docs',
  generator,
  sources: [],
  designReferences: [],
  documentation: { locale: 'en-US', tone: [], standardsProfile: 'doxloop-v1', styleGuide: 'doxloop', terminology: {}, exclusions: [], accessibilityTarget: 'WCAG 2.2 AA' },
  sync: { mode: 'check', on: [], watch: [], ignore: [] },
})

describe('documentation plan generator targets', () => {
  test('describes built-in Doxbrix navigation without loading an external package', async () => {
    await expect(documentationPlanTarget('/tmp/unused', project('doxbrix'))).resolves.toEqual({
      generator: 'doxbrix',
      contentDir: '',
      contentFormat: 'markdown',
      pageExtensions: ['.md', '.mdx'],
      navigationFiles: ['docs.json'],
    })
  })
})
