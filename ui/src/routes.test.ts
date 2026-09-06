import { describe, expect, test } from 'vitest'
import { WORKSPACE_ROUTES, canonicalWorkspacePath, workspacePath, workspaceRoute } from './routes'

describe('workspace routes', () => {
  test.each(WORKSPACE_ROUTES)('resolves the stable deep link for %s', (route) => {
    expect(workspaceRoute(workspacePath(route))).toBe(route)
  })

  test('uses segments that match the navigation labels', () => {
    expect(workspacePath('authoring')).toBe('/update')
    expect(workspacePath('proposals')).toBe('/review')
    expect(workspacePath('publish')).toBe('/deploy')
    expect(workspacePath('overview')).toBe('/overview')
  })

  test('keeps the previous segments working and redirects them to the new names', () => {
    expect(workspaceRoute('/authoring')).toBe('authoring')
    expect(workspaceRoute('/proposals')).toBe('proposals')
    expect(workspaceRoute('/publish')).toBe('publish')
    expect(canonicalWorkspacePath('/authoring')).toBe('/update')
    expect(canonicalWorkspacePath('/proposals', '?proposal=run-1')).toBe('/review?proposal=run-1')
    expect(canonicalWorkspacePath('/publish')).toBe('/deploy')
    expect(canonicalWorkspacePath('/review', '?proposal=run-1')).toBeUndefined()
    expect(canonicalWorkspacePath('/overview')).toBeUndefined()
    expect(canonicalWorkspacePath('/')).toBe('/overview')
    expect(canonicalWorkspacePath('/anything')).toBeUndefined()
  })

  test('carries the selected proposal, file, and settings section in the URL', () => {
    expect(workspacePath('proposals', { proposal: 'run-1', file: 'change-2' })).toBe('/review?proposal=run-1&file=change-2')
    expect(workspacePath('proposals', { proposal: 'run-1', file: undefined })).toBe('/review?proposal=run-1')
    expect(workspacePath('settings', { section: 'capture' })).toBe('/settings?section=capture')
    expect(workspacePath('pages', { path: 'reference/events.mdx' })).toBe('/pages?path=reference%2Fevents.mdx')
  })

  test('uses overview for the root and does not silently redirect unknown paths', () => {
    expect(workspaceRoute('/')).toBe('overview')
    expect(workspaceRoute('/quality/details')).toBe('not-found')
    expect(workspaceRoute('/sync')).toBe('not-found')
    expect(workspaceRoute('/anything')).toBe('not-found')
  })
})
