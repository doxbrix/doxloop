/**
 * A local control-center call that takes longer than this has hung, not
 * finished slowly. Without a limit a stalled server left buttons on
 * "Working…" forever with no way to tell what happened.
 */
export const REQUEST_TIMEOUT_MS = 120_000

/** Pass as `init` for calls that legitimately wait on the person, such as a native folder picker. */
export const NO_TIMEOUT: RequestInit = { signal: new AbortController().signal }

export const TIMEOUT_MESSAGE = 'The Doxloop control center did not respond within two minutes. Check that `doxloop ui` is still running in your terminal, then try again.'

export async function api<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      headers: {
        ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
        ...init?.headers,
      },
    })
  } catch (cause) {
    if (isTimeout(cause)) throw new Error(TIMEOUT_MESSAGE)
    throw cause
  }
  const body = await response.json().catch(() => ({})) as { error?: string }
  if (isInvalidLocalUiSession(response.status, body.error)) {
    window.location.reload()
    throw new Error('The local UI session changed. Reloading Doxloop…')
  }
  if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`)
  return body as T
}

export function isTimeout(cause: unknown): boolean {
  return cause instanceof Error && (cause.name === 'TimeoutError' || cause.name === 'AbortError')
}

export function isInvalidLocalUiSession(status: number, error: string | undefined): boolean {
  return status === 409 && error === 'Invalid local UI session. Reload the Doxloop UI.'
}

export function post<T>(path: string, body: unknown = {}, init?: RequestInit): Promise<T> {
  return api<T>(path, { ...init, method: 'POST', body: JSON.stringify(body) })
}

export function patch<T>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) })
}

export function remove<T>(path: string): Promise<T> {
  return api<T>(path, { method: 'DELETE' })
}
