import { useEffect, useState } from 'preact/hooks'
import { api, post } from './api'
import { SetupApplication } from './SetupApplication'
import { WorkspaceApplication } from './WorkspaceApplication'
import type { UiState } from './types'

export function App() {
  const [state, setState] = useState<UiState | null>(null)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)

  const reload = async () => {
    setLoading(true)
    try {
      setState(await api<UiState>('/api/state'))
      setError('')
    } catch (cause) {
      setError(message(cause))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { void reload() }, [])

  const act: Action = async <T,>(run: () => Promise<T>, success?: string, refresh = true): Promise<T | undefined> => {
    setError('')
    setNotice('')
    try {
      const result = await run()
      if (success) setNotice(success)
      if (refresh) await reload()
      return result
    } catch (cause) {
      setError(message(cause))
      return undefined
    }
  }

  if (!state && loading) return <Splash />
  if (!state) return <Splash error={error} />

  if (!state.projectFound) {
    return <SetupApplication
      state={state}
      act={act}
      error={error}
      onOpenPreview={async (openInSystemBrowser) => {
        await act(() => post('/api/preview/start', { open: openInSystemBrowser }), undefined, false)
      }}
      onContinue={async (page) => {
        await reload()
        history.pushState({}, '', `/${page}`)
      }}
    />
  }

  return <WorkspaceApplication
    state={state}
    loading={loading}
    error={error}
    notice={notice}
    reload={reload}
    act={act}
    onJobsUpdate={(jobs) => setState((current) => current ? { ...current, jobs } : current)}
    onError={setError}
    onErrorDismiss={() => setError('')}
    onNoticeDismiss={() => setNotice('')}
  />
}

function Splash({ error }: { error?: string }) {
  return <div class="splash"><span class="splash-mark">D</span><strong>Doxloop</strong><p>{error ?? 'Opening the local control center…'}</p></div>
}

type Action = <T>(run: () => Promise<T>, success?: string, refresh?: boolean) => Promise<T | undefined>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
