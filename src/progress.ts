const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const FRAME_INTERVAL_MS = 90
const SHOW_ELAPSED_AFTER_MS = 2000

const GREEN = '\x1b[32m'
const RED = '\x1b[31m'
const DIM = '\x1b[2m'
const RESET = '\x1b[0m'
const CLEAR_LINE = '\r\x1b[2K'

export interface StepHandle {
  /** Milliseconds since the step started. */
  readonly durationMs: number
  /** Mark the step complete. `label` replaces the running label; `detail` is appended dimmed after a dot. */
  done(label?: string, detail?: string): void
}

export interface StepList {
  start(label: string): StepHandle
  /** Mark whichever step is currently running as failed. No-op when none is. */
  failActive(): void
}

/**
 * Renders a checklist of sequential steps. On a TTY the active step shows an
 * animated spinner (plus elapsed time once it runs long) and is rewritten in
 * place; on non-TTY streams each step prints as a plain line when it finishes.
 */
export function createStepList(stream: NodeJS.WriteStream = process.stdout): StepList {
  const interactive = stream.isTTY === true

  interface ActiveStep {
    label: string
    startedAt: number
    frame: number
    timer?: NodeJS.Timeout
  }

  let active: ActiveStep | undefined

  function renderActive(): void {
    if (!active) return
    const frame = FRAMES[active.frame % FRAMES.length]
    active.frame += 1
    const elapsed = Date.now() - active.startedAt
    const suffix =
      elapsed >= SHOW_ELAPSED_AFTER_MS ? ` ${DIM}${formatDuration(elapsed)}${RESET}` : ''
    stream.write(`${CLEAR_LINE}  ${frame} ${active.label}…${suffix}`)
  }

  function finish(step: ActiveStep, mark: string, text: string): void {
    if (active !== step) return
    if (step.timer) clearInterval(step.timer)
    if (interactive) stream.write(CLEAR_LINE)
    stream.write(`  ${mark} ${text}\n`)
    active = undefined
  }

  return {
    start(label) {
      const step: ActiveStep = { label, startedAt: Date.now(), frame: 0 }
      active = step
      if (interactive) {
        renderActive()
        step.timer = setInterval(renderActive, FRAME_INTERVAL_MS)
        step.timer.unref?.()
      }
      return {
        get durationMs() {
          return Date.now() - step.startedAt
        },
        done(label, detail) {
          const text = `${label ?? step.label}${
            detail ? `${interactive ? DIM : ''} · ${detail}${interactive ? RESET : ''}` : ''
          }`
          finish(step, interactive ? `${GREEN}✓${RESET}` : '✓', text)
        },
      }
    },
    failActive() {
      if (!active) return
      finish(active, interactive ? `${RED}✗${RESET}` : '✗', active.label)
    },
  }
}

export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(1, Math.round(ms / 1000))
  if (totalSeconds < 60) return `${totalSeconds}s`
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`
}
