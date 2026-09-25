import { render } from 'preact'
import './styles.css'
import { App } from './App'
import './theme.css'
import './theme-plan.css'
import './theme-review.css'
import './theme-ops.css'
import './theme-layout.css'

render(<App />, document.getElementById('app')!)
