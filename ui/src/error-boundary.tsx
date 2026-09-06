import { Component, type ComponentChildren } from 'preact'
import { Button } from './components'
import { Icon } from './icons'

/**
 * A rendering error in one screen must not blank the whole control center.
 * The boundary shows what broke and offers a way back that does not depend
 * on the broken state.
 */
export class ErrorBoundary extends Component<{ children: ComponentChildren; onReset?: () => void }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  override componentDidCatch(error: Error): void {
    console.error('Doxloop control center rendering error', error)
  }

  override render() {
    if (!this.state.error) return this.props.children
    const detail = this.state.error.message || String(this.state.error)
    return <div class="page">
      <section class="panel error-boundary" role="alert">
        <div class="panel-body">
          <span class="error-boundary-icon"><Icon name="alert" size={22} /></span>
          <h2>This screen could not be shown</h2>
          <p>Doxloop hit an unexpected error while drawing this page. Your documentation and any running job are unaffected.</p>
          <pre class="error-boundary-detail">{detail}</pre>
          <div class="form-actions">
            <Button onClick={() => { this.setState({ error: null }); this.props.onReset?.() }}>Try again</Button>
            <Button tone="primary" onClick={() => { history.replaceState({}, '', '/overview'); location.reload() }}>Reload the control center</Button>
          </div>
        </div>
      </section>
    </div>
  }
}
