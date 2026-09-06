import { describe, expect, test } from 'vitest'
import { effectiveDeployment, formatProjectSettings } from './settings.js'
import type { DoxloopProject } from './types.js'

function project(overrides: Partial<DoxloopProject> = {}): DoxloopProject {
  return {
    schemaVersion: 1,
    title: 'Acme Payments',
    contentDir: 'docs',
    generator: 'doxbrix',
    sources: [],
    designReferences: [],
    documentation: {
      locale: 'en-US',
      tone: ['clear', 'direct'],
      standardsProfile: 'doxloop-v1',
      styleGuide: 'doxloop',
      terminology: {},
      exclusions: [],
      accessibilityTarget: 'WCAG 2.2 AA',
    },
    ...overrides,
  }
}

describe('project settings presentation', () => {
  test('derives safe deployment defaults from the project title', () => {
    expect(effectiveDeployment(project())).toMatchObject({
      name: 'Acme Payments',
      slug: 'acme-payments',
      visibility: 'private',
    })
  })

  test('uses saved deployment settings and includes them in the summary', () => {
    const configured = project({
      defaultAgent: 'codex',
      deployment: {
        name: 'Acme Docs',
        slug: 'payments',
        visibility: 'public',
        apiUrl: 'https://docs.example.com',
      },
    })
    expect(effectiveDeployment(configured)).toEqual({
      target: 'doxbrix',
      name: 'Acme Docs',
      slug: 'payments',
      visibility: 'public',
      apiUrl: 'https://docs.example.com',
    })
    expect(formatProjectSettings('/workspace/docs', configured)).toContain(
      'Visibility: public',
    )
  })
})
