export const WORKSPACE_ROUTES = ['overview', 'sources', 'authoring', 'proposals', 'publish', 'settings'] as const
export type WorkspaceRoute = typeof WORKSPACE_ROUTES[number]
export type ResolvedWorkspaceRoute = WorkspaceRoute | 'not-found'

export function workspaceRoute(pathname: string): ResolvedWorkspaceRoute {
  const segment = pathname.split('/').filter(Boolean)[0]
  if (!segment) return 'overview'
  return (WORKSPACE_ROUTES as readonly string[]).includes(segment) ? segment as WorkspaceRoute : 'not-found'
}

export function workspacePath(route: WorkspaceRoute): string { return `/${route}` }
