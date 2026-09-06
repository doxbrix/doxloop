import { useEffect, useState } from 'preact/hooks'
import { workspacePath, type WorkspaceParams, type WorkspaceRoute } from './routes'

/**
 * The query string of the current location, re-read whenever history moves.
 * Screens keep their selection (a proposal, a file, a settings section) here
 * so a refresh or the back button returns to the same view.
 */
export function useSearchParams(): URLSearchParams {
  const [, rerender] = useState(0)
  useEffect(() => {
    const listener = () => rerender((value) => value + 1)
    addEventListener('popstate', listener)
    return () => removeEventListener('popstate', listener)
  }, [])
  return new URLSearchParams(location.search)
}

/**
 * Write screen state into the URL. A `replace` keeps the history entry the
 * reader is on (typing in a search box, switching a file); a `push` creates
 * one (opening a proposal) so back returns to the list.
 */
export function setLocation(route: WorkspaceRoute, params: WorkspaceParams = {}, mode: 'push' | 'replace' = 'replace'): void {
  const next = workspacePath(route, params)
  if (`${location.pathname}${location.search}` === next) return
  history[mode === 'push' ? 'pushState' : 'replaceState']({}, '', next)
  dispatchEvent(new PopStateEvent('popstate'))
}
