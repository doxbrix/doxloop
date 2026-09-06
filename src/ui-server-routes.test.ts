import { createServer as createNetServer } from 'node:net'
import { describe, expect, it } from 'vitest'
import { DoxloopError } from './errors.js'
import { availableLocalPort, assertNoActiveDocumentationJobs, assertProjectSwitchAllowed, normalizeInitialPage, pageEditJobSpec, pageRefineJobSpec, previewIdentityMatches, uiErrorStatus, uiSessionCookieName } from './ui-server.js'
import type { DoxloopProject, SyncRun } from './types.js'

describe('control-center CLI routes', () => {
  it.each(['overview', 'sources', 'update', 'pages', 'review', 'deploy', 'settings'])('accepts %s', (route) => {
    expect(normalizeInitialPage(route)).toBe(route)
  })

  it('lands the previous page names on the renamed pages', () => {
    expect(normalizeInitialPage('authoring')).toBe('update')
    expect(normalizeInitialPage('proposals')).toBe('review')
    expect(normalizeInitialPage('publish')).toBe('deploy')
  })

  it('defaults to overview and rejects obsolete pages', () => {
    expect(normalizeInitialPage(undefined)).toBe('overview')
    expect(() => normalizeInitialPage('sync')).toThrow('Unknown UI page')
    expect(() => normalizeInitialPage('quality')).toThrow('Unknown UI page')
    expect(() => normalizeInitialPage('preview')).toThrow('Unknown UI page')
    expect(() => normalizeInitialPage('home')).toThrow('Unknown UI page')
  })
})

describe('control-center sessions', () => {
  it('isolates session cookies by UI port', () => {
    expect(uiSessionCookieName(4317)).toBe('doxloop_ui_4317')
    expect(uiSessionCookieName(4318)).toBe('doxloop_ui_4318')
    expect(uiSessionCookieName(4317)).not.toBe(uiSessionCookieName(4318))
  })
})

describe('preview isolation', () => {
  it('matches a Doxbrix preview to the project that started it', () => {
    expect(previewIdentityMatches({ root: '/tmp/current-docs' }, '/tmp/current-docs')).toBe(true)
    expect(previewIdentityMatches({ root: '/tmp/other-docs' }, '/tmp/current-docs')).toBe(false)
    expect(previewIdentityMatches({}, '/tmp/current-docs')).toBe(false)
  })

  it('allocates valid local ports instead of relying on a global fixed port', async () => {
    const occupied = createNetServer()
    await new Promise<void>((resolveListen) => occupied.listen(0, '127.0.0.1', resolveListen))
    const address = occupied.address()
    const occupiedPort = typeof address === 'object' && address ? address.port : 0
    try {
      const allocated = await availableLocalPort()
      expect(allocated).toBeGreaterThan(0)
      expect(allocated).not.toBe(occupiedPort)
    } finally {
      await new Promise<void>((resolveClose) => occupied.close(() => resolveClose()))
    }
  })
})

describe('page edit routes', () => {
  const project = { defaultAgent: 'codex' } as DoxloopProject

  it('validates the edit body as a bad request', () => {
    expect(() => pageEditJobSpec('/tmp/docs', project, 'run-page', { paths: ['index.mdx'], instruction: 'short' })).toThrow('Describe what should change.')
    try {
      pageEditJobSpec('/tmp/docs', project, 'run-page', { paths: [], instruction: 'Clarify this page.' })
    } catch (error) {
      expect(uiErrorStatus(error)).toBe(400)
    }
  })

  it('builds the page-edit job type and complete CLI arguments', () => {
    expect(pageEditJobSpec('/tmp/docs', project, 'run-page', {
      paths: ['index.mdx', 'guides/install.mdx'],
      instruction: 'Add a tested curl example.',
      allowRelated: true,
      screenshots: 'enabled',
      agent: 'codex',
      model: 'gpt-test',
      reasoning: 'high',
    })).toEqual({
      type: 'page-edit:run-page',
      paths: ['index.mdx', 'guides/install.mdx'],
      allowRelated: true,
      agent: 'codex',
      args: ['pages', 'edit', '--run-id', 'run-page', '--request', 'Add a tested curl example.', '--path', 'index.mdx', '--path', 'guides/install.mdx', '--allow-related', '--screenshots', '--agent', 'codex', '--model', 'gpt-test', '--reasoning', 'high', '--cwd', '/tmp/docs'],
    })
  })

  it('maps a concurrent documentation job to conflict', () => {
    try {
      assertNoActiveDocumentationJobs([{ status: 'running', type: 'page-edit:run-one' }])
    } catch (error) {
      expect(error).toBeInstanceOf(DoxloopError)
      expect(uiErrorStatus(error)).toBe(409)
    }
  })

  it('rejects refine for a non-edit proposal', () => {
    expect(() => pageRefineJobSpec('/tmp/docs', { id: 'run-update', changes: [] } as unknown as SyncRun, { instruction: 'Make this clearer.' }))
      .toThrow('Only a page edit can be refined from the Pages view.')
  })

  it('refines every page change in an edit proposal', () => {
    const run = {
      id: 'run-page',
      editRequest: { instruction: 'Clarify the page.', paths: ['index.mdx'], allowRelated: false, followUps: [] },
      changes: [
        { id: 'change-1', category: 'page' },
        { id: 'change-2', category: 'evidence' },
      ],
    } as unknown as SyncRun
    expect(pageRefineJobSpec('/tmp/docs', run, { instruction: 'Use a shorter example.' })).toEqual({
      type: 'proposal:revise:run-page',
      args: ['proposal', 'revise', '--id', 'run-page', '--request', 'Use a shorter example.', '--change', 'change-1', '--cwd', '/tmp/docs'],
    })
  })
})

describe('project switching', () => {
  it('refuses while a documentation or deploy job runs', () => {
    expect(() => assertProjectSwitchAllowed([{ status: 'running', type: 'plan:propose' }])).toThrow('still in progress')
    expect(() => assertProjectSwitchAllowed([{ status: 'running', type: 'deploy' }])).toThrow('still in progress')
    try {
      assertProjectSwitchAllowed([{ status: 'running', type: 'author:update' }])
    } catch (error) {
      expect(uiErrorStatus(error)).toBe(409)
    }
  })

  it('allows a switch when only previews or finished jobs remain', () => {
    expect(() => assertProjectSwitchAllowed([
      { status: 'running', type: 'preview' },
      { status: 'running', type: 'proposal-preview:run-1' },
      { status: 'succeeded', type: 'plan:generate' },
      { status: 'failed', type: 'deploy' },
    ])).not.toThrow()
    expect(() => assertProjectSwitchAllowed([])).not.toThrow()
  })
})
