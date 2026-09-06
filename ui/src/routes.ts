/**
 * Internal route ids stay stable so components can name a screen without
 * caring what its URL segment is. The URL segments match the navigation
 * labels (Update, Review, Deploy) and older segments keep resolving so
 * bookmarks and `doxloop ui --page` links written before the rename still open
 * the right screen.
 */
export const WORKSPACE_ROUTES = ['overview', 'sources', 'authoring', 'pages', 'proposals', 'publish', 'settings'] as const
export type WorkspaceRoute = typeof WORKSPACE_ROUTES[number]
export type ResolvedWorkspaceRoute = WorkspaceRoute | 'not-found'

const ROUTE_SEGMENTS: Record<WorkspaceRoute, string> = {
  overview: 'overview',
  sources: 'sources',
  authoring: 'update',
  pages: 'pages',
  proposals: 'review',
  publish: 'deploy',
  settings: 'settings',
}

/** Segments from before the rename. They redirect to the canonical segment. */
const LEGACY_SEGMENTS: Record<string, WorkspaceRoute> = {
  authoring: 'authoring',
  proposals: 'proposals',
  publish: 'publish',
}

export type WorkspaceParams = Record<string, string | undefined>

export function workspaceRoute(pathname: string): ResolvedWorkspaceRoute {
  const segment = pathname.split('/').filter(Boolean)[0]
  if (!segment) return 'overview'
  const canonical = (Object.keys(ROUTE_SEGMENTS) as WorkspaceRoute[]).find((route) => ROUTE_SEGMENTS[route] === segment)
  return canonical ?? LEGACY_SEGMENTS[segment] ?? 'not-found'
}

/** `/review?proposal=run-1&file=change-2`: the screen plus the state that must survive refresh and back. */
export function workspacePath(route: WorkspaceRoute, params: WorkspaceParams = {}): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) if (value) search.set(key, value)
  const query = search.toString()
  return `/${ROUTE_SEGMENTS[route]}${query ? `?${query}` : ''}`
}

/**
 * The canonical location for a legacy or trailing-slash URL, or `undefined`
 * when the given location is already canonical or unknown. The app replaces
 * the address bar with this on load so the old names never linger.
 */
export function canonicalWorkspacePath(pathname: string, search = ''): string | undefined {
  const route = workspaceRoute(pathname)
  if (route === 'not-found') return undefined
  const canonical = `/${ROUTE_SEGMENTS[route]}${search.startsWith('?') && search.length > 1 ? search : ''}`
  return canonical === `${pathname}${search}` ? undefined : canonical
}
