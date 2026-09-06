import { useEffect, useState } from 'preact/hooks'
import { api } from './api'
import { ErrorBoundary } from './error-boundary'
import { SetupApplication } from './SetupApplication'
import { WorkspaceApplication } from './WorkspaceApplication'
import { workspacePath } from './routes'
import type { UiState } from './types'

export function App() {
  const [state, setState] = useState<UiState | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  // The wizard can be opened from an existing workspace to start or import another project.
  const [setupOpen, setSetupOpen] = useState(false)

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

  const act: Action = async <T,>(run: () => Promise<T>, _success?: string, refresh = true): Promise<T | undefined> => {
    setError('')
    try {
      const result = await run()
      if (refresh) await reload()
      return result
    } catch (cause) {
      setError(message(cause))
      return undefined
    }
  }

  if (!state && loading) return <Splash />
  if (!state) return <Splash error={error} />

  if (!state.projectFound || setupOpen) {
    return <ErrorBoundary onReset={() => void reload()}><SetupApplication
      state={state}
      act={act}
      error={error}
      onContinue={async (page) => {
        setSetupOpen(false)
        history.pushState({}, '', workspacePath(page))
        await reload()
      }}
      {...(state.projectFound ? { onCancel: () => { setSetupOpen(false); setError('') } } : {})}
    /></ErrorBoundary>
  }

  return <ErrorBoundary onReset={() => void reload()}><WorkspaceApplication
    key={state.root}
    state={state}
    onNewProject={() => setSetupOpen(true)}
    loading={loading}
    error={error}
    reload={reload}
    act={act}
    onJobsUpdate={(jobs) => setState((current) => current ? { ...current, jobs } : current)}
    onError={setError}
    onErrorDismiss={() => setError('')}
  /></ErrorBoundary>
}

function Splash({ error }: { error?: string }) {
  return <div class="splash"><span class="splash-mark">D</span><strong>Doxloop</strong><p>{error ?? 'Opening the local control center…'}</p></div>
}

type Action = <T>(run: () => Promise<T>, success?: string, refresh?: boolean) => Promise<T | undefined>

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
