import { describe, expect, test } from 'vitest'
import { WORKSPACE_ROUTES, workspacePath, workspaceRoute } from './routes'

describe('workspace routes', () => {
  test.each(WORKSPACE_ROUTES)('resolves the stable /%s deep link', (route) => {
    expect(workspaceRoute(workspacePath(route))).toBe(route)
  })

  test('uses overview for the root and does not silently redirect unknown paths', () => {
    expect(workspaceRoute('/')).toBe('overview')
    expect(workspaceRoute('/quality/details')).toBe('not-found')
    expect(workspaceRoute('/sync')).toBe('not-found')
    expect(workspaceRoute('/anything')).toBe('not-found')
  })
})
