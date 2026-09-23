/**
 * Resolve an application route (`/settings`) against the configured base URL.
 *
 * Plain `new URL(route, base)` is wrong for a hash-routed single-page
 * application (`https://host/_/#`): the route lives in the fragment, so
 * `/settings` must open `https://host/_/#/settings`, not `https://host/settings`
 * (which the server answers with 404). Every other base URL keeps the standard
 * resolution, because some projects configure a page such as `/login` as the
 * base and still write routes from the origin root.
 */
export function applicationUrl(baseUrl: string, route: string | undefined): URL {
  const base = new URL(baseUrl)
  const path = route?.trim() || '/'
  if (!hashRouted(base) || /^[a-z][a-z0-9+.-]*:/i.test(path) || path.startsWith('//')) return new URL(path, base)
  const document = new URL(base.toString())
  const routed = path.startsWith('#') ? path.slice(1) : path
  document.hash = routed.startsWith('/') ? routed : `/${routed}`
  return document
}

/** A base URL ending in an empty or route-shaped fragment (`#`, `#/`) is hash-routed. */
export function hashRouted(base: URL | string): boolean {
  const url = typeof base === 'string' ? new URL(base) : base
  return url.href.includes('#') && (url.hash === '' || url.hash.startsWith('#/'))
}
