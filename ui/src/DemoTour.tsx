import { useEffect, useState } from 'preact/hooks'
import { Button } from './components'
import { Icon } from './icons'
import type { WorkspaceParams, WorkspaceRoute } from './routes'
import './DemoTour.css'

/**
 * The guided tour of `doxloop demo`.
 *
 * The demo opens a finished project in a temporary folder. The tour walks the
 * loop in the order a team lives it (sources, plan, docs, the update that
 * Monitoring drafted, publish) and ends by handing over to the reader's own
 * product. Each step opens its screen and rings the one element it talks
 * about; everything stays clickable, so the reader can leave the script.
 */
export interface DemoTourStep {
  id: string
  route: WorkspaceRoute
  params?: WorkspaceParams
  /** The element the step talks about; the first match is ringed and scrolled into view. */
  target?: string
  kicker: string
  title: string
  body: string
  /** One concrete thing to try on this screen. */
  tryThis?: string
}

export function demoTourSteps(proposalId: string | undefined, changeId?: string): DemoTourStep[] {
  return [
    {
      id: 'welcome',
      route: 'overview',
      target: '.ov-hero',
      kicker: 'Welcome',
      title: 'A real Doxloop workspace, ready to explore',
      body: 'Claude Code planned and wrote documentation for the Pet Store API from its OpenAPI specification. Then the API changed, and Doxloop noticed. This tour shows how, in about two minutes.',
    },
    {
      id: 'sources',
      route: 'sources',
      target: '.freshness-panel',
      kicker: 'Sources',
      title: 'Every page traces back to the specification',
      body: 'Doxloop maps each API operation to the page that documents it. When version 1.1.0 added order cancellation and deprecated a search endpoint, it named exactly which pages went out of date.',
      tryThis: 'Open Coverage to see each operation and the page that covers it.',
    },
    {
      id: 'plan',
      route: 'authoring',
      target: '.history-panel, .pl-review-head',
      kicker: 'Plan',
      title: 'Nothing is written until you approve the plan',
      body: 'The agent proposed the brief, audiences, and page structure from the specification, and a person approved it here. Update history records every request, what it changed, and what it cost.',
      tryThis: 'Choose Open plan v2 to see the approved plan.',
    },
    {
      id: 'docs',
      route: 'pages',
      target: '.pages-workbench',
      kicker: 'Docs',
      title: 'Documentation your team can keep editing',
      body: 'Guides, a tutorial, a full reference with code in three languages, diagrams, and a glossary. Select any page to preview it, edit its metadata, or ask the agent for a focused change.',
      tryThis: 'Choose Preview docs in the top bar to open the finished site.',
    },
    {
      id: 'review',
      route: 'proposals',
      ...(proposalId ? { params: { proposal: proposalId, ...(changeId ? { file: changeId } : {}) } } : {}),
      target: '.review-summary-bar',
      kicker: 'Review',
      title: 'Monitoring drafted this update for you',
      body: 'Each change shows the rendered and source diff, why it was made, and the specification evidence behind it. Nothing reaches your documentation until you accept it.',
      tryThis: 'Open Why this change, then choose Accept all.',
    },
    {
      id: 'publish',
      route: 'publish',
      target: '.publish-checklist',
      kicker: 'Publish',
      title: 'Validated before every publish',
      body: 'Links, navigation, metadata, and code fences are checked before anything goes live. In your own project, publish to Doxbrix in one step or export a static site to host anywhere.',
    },
  ]
}

const STORAGE_KEY = 'doxloop-demo-tour'

type TourMemory = { step: number; open: boolean }

function remembered(): TourMemory {
  try {
    const value = JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? 'null') as TourMemory | null
    if (value && typeof value.step === 'number') return value
  } catch { /* storage can be unavailable; the tour simply starts over */ }
  return { step: 0, open: true }
}

function remember(memory: TourMemory): void {
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify(memory)) } catch { /* see remembered() */ }
}

export function DemoTour({ proposalId, changeId, page, navigate, onNewProject }: {
  proposalId?: string | undefined
  changeId?: string | undefined
  page: WorkspaceRoute | 'not-found'
  navigate: (route: WorkspaceRoute, params?: WorkspaceParams) => void
  onNewProject: () => void
}) {
  const steps = demoTourSteps(proposalId, changeId)
  const finale = steps.length
  const [memory, setMemory] = useState<TourMemory>(remembered)
  const { step, open } = memory
  const current = steps[step]
  const update = (next: TourMemory) => { setMemory(next); remember(next) }

  useEffect(() => {
    const reopen = () => setMemory(remembered())
    addEventListener('doxloop:demo-tour', reopen)
    return () => removeEventListener('doxloop:demo-tour', reopen)
  }, [])

  const go = (next: number) => {
    const target = steps[next]
    if (target) navigate(target.route, target.params ?? {})
    update({ step: next, open: true })
  }

  // Ring the element the step describes once its screen has rendered it.
  useEffect(() => {
    if (!open || !current?.target || page !== current.route) return
    let ringed: Element | null = null
    let attempts = 0
    const timer = window.setInterval(() => {
      attempts += 1
      const element = document.querySelector(current.target!)
      if (element) {
        ringed = element
        element.classList.add('demo-spotlight')
        element.scrollIntoView({ behavior: 'smooth', block: 'center' })
        clearInterval(timer)
      } else if (attempts > 40) clearInterval(timer)
    }, 100)
    return () => {
      clearInterval(timer)
      ringed?.classList.remove('demo-spotlight')
    }
  }, [open, step, page])

  if (!open) {
    return <button type="button" class="demo-tour-resume" onClick={() => go(Math.min(step, finale))}>
      <Icon name="play" size={14} /><span>{step >= finale ? 'Replay the tour' : 'Resume the tour'}</span>
    </button>
  }

  const close = () => update({ step, open: false })
  const dots = <div class="demo-tour-dots" aria-hidden="true">
    {[...steps, null].map((_, index) => <i key={index} class={index === step ? 'active' : index < step ? 'done' : ''} />)}
  </div>

  if (!current) {
    return <aside class="demo-tour-card finale" role="dialog" aria-labelledby="demo-tour-title">
      <button type="button" class="demo-tour-close" aria-label="Close the tour" onClick={close}><Icon name="close" size={14} /></button>
      <p class="demo-tour-kicker">Your turn</p>
      <h2 id="demo-tour-title">Now document your own product</h2>
      <p>Point Doxloop at your code or API specification, approve a plan, and review what your coding agent writes. The same loop keeps it current as your product changes.</p>
      <CopyCommand command="npx @doxbrix/doxloop ui" />
      <footer>
        {dots}
        <span class="demo-tour-actions">
          <Button size="sm" tone="ghost" onClick={() => go(0)}>Start over</Button>
          <Button size="sm" tone="primary" icon="plus" onClick={() => { close(); onNewProject() }}>Start a project</Button>
        </span>
      </footer>
    </aside>
  }

  return <aside class="demo-tour-card" role="dialog" aria-labelledby="demo-tour-title">
    <button type="button" class="demo-tour-close" aria-label="Close the tour" onClick={close}><Icon name="close" size={14} /></button>
    <p class="demo-tour-kicker">{current.kicker}<span>{step + 1} of {finale}</span></p>
    <h2 id="demo-tour-title">{current.title}</h2>
    <p>{current.body}</p>
    {current.tryThis && <p class="demo-tour-try"><Icon name="arrowRight" size={13} /><span>{current.tryThis}</span></p>}
    <footer>
      {dots}
      <span class="demo-tour-actions">
        {step > 0 && <Button size="sm" tone="ghost" onClick={() => go(step - 1)}>Back</Button>}
        <Button size="sm" tone="primary" onClick={() => go(step + 1)}>{step === 0 ? 'Start the tour' : 'Next'}</Button>
      </span>
    </footer>
  </aside>
}

function CopyCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return <div class="demo-tour-command">
    <code>{command}</code>
    <button type="button" aria-label="Copy the command" onClick={() => {
      void navigator.clipboard?.writeText(command).then(() => {
        setCopied(true)
        window.setTimeout(() => setCopied(false), 1600)
      })
    }}><Icon name={copied ? 'check' : 'copy'} size={14} /><span>{copied ? 'Copied' : 'Copy'}</span></button>
  </div>
}

/** The navbar badge that says this is the demo and reopens the tour. */
export function DemoBadge({ onOpen }: { onOpen: () => void }) {
  return <button type="button" class="demo-badge" title="This is a temporary demo workspace. It is removed when you stop the demo." onClick={onOpen}>
    <i aria-hidden="true" />Demo workspace
  </button>
}

/** Reopen the tour from wherever the reader is. */
export function reopenDemoTour(): void {
  const memory = remembered()
  remember({ step: memory.step, open: true })
  window.dispatchEvent(new Event('doxloop:demo-tour'))
}
