import { spawn as nodeSpawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { constants as osConstants } from 'node:os'
import crossSpawn from 'cross-spawn'

/**
 * A documentation agent is never alone: Claude and Codex start the capture
 * MCP server, which starts a browser. Stopping only the agent left those
 * helpers running and writing screenshots into a workspace the user had
 * already abandoned. An unattended agent therefore runs in its own process
 * group so the whole tree can be stopped together.
 */
export interface AgentProcess {
  readonly child: ChildProcess
  /** True when the agent leads its own process group and helpers stop with it. */
  readonly isolated: boolean
  /** Resolves once the agent has exited, however it exited. */
  readonly exited: Promise<AgentExit>
  /**
   * Ask the agent to stop, then force it after the grace period. Resolves once
   * the agent process is gone. Safe to call more than once.
   */
  stop(options?: { signal?: NodeJS.Signals; graceMs?: number }): Promise<void>
}

export interface AgentExit {
  code: number | null
  signal: NodeJS.Signals | null
  /** Set when the process could not be started at all. */
  error?: Error
}

export const AGENT_STOP_GRACE_MS = 10_000

export function spawnAgentProcess(
  executable: string,
  args: readonly string[],
  options: {
    cwd: string
    env?: NodeJS.ProcessEnv
    stdio: StdioOptions
    /**
     * Put the agent in its own process group. Only unattended runs qualify: an
     * interactive agent must stay in the terminal's foreground group so it can
     * own the keyboard and receive Ctrl+C itself.
     */
    isolate?: boolean
  },
): AgentProcess {
  const isolated = options.isolate === true && process.platform !== 'win32'
  const child = crossSpawn(executable, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio: options.stdio,
    ...(isolated ? { detached: true } : {}),
  })
  let settled = false
  const exited = new Promise<AgentExit>((resolveExit) => {
    child.once('error', (error) => {
      if (settled) return
      settled = true
      resolveExit({ code: null, signal: null, error })
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      resolveExit({ code, signal })
    })
  })
  let stopping: Promise<void> | undefined
  const stop = (stopOptions: { signal?: NodeJS.Signals; graceMs?: number } = {}): Promise<void> => {
    if (stopping) return stopping
    stopping = (async () => {
      if (settled) {
        if (isolated) signalTree(child, isolated, 'SIGKILL')
        return
      }
      const grace = stopOptions.graceMs ?? AGENT_STOP_GRACE_MS
      signalTree(child, isolated, stopOptions.signal ?? 'SIGTERM')
      const escalation = setTimeout(() => {
        if (!settled) signalTree(child, isolated, 'SIGKILL')
      }, grace)
      escalation.unref?.()
      await exited
      clearTimeout(escalation)
      // The agent may have exited politely while a helper it started did not.
      if (isolated) signalTree(child, isolated, 'SIGKILL')
    })()
    return stopping
  }
  return { child, isolated, exited, stop }
}

/**
 * Deliver a signal to an agent and everything it started. On Windows there is
 * no process group to signal, so the tree is terminated through taskkill.
 */
export function signalTree(child: ChildProcess, isolated: boolean, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (!pid) return
  if (process.platform === 'win32') {
    try {
      const killer = nodeSpawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.once('error', () => { try { child.kill() } catch { /* already gone */ } })
    } catch {
      try { child.kill() } catch { /* already gone */ }
    }
    return
  }
  if (isolated) {
    try {
      process.kill(-pid, signal)
      return
    } catch {
      // The group is gone or was never created; fall back to the process itself.
    }
  }
  try { child.kill(signal) } catch { /* already gone */ }
}

const SIGNAL_EXIT_CODES: Partial<Record<NodeJS.Signals, number>> = {
  SIGINT: 128 + osConstants.signals.SIGINT,
  SIGTERM: 128 + osConstants.signals.SIGTERM,
  SIGHUP: 128 + osConstants.signals.SIGHUP,
}

/**
 * Forward a termination signal received by this process to the running agent,
 * wait for it to stop, then exit with the conventional 128+signal status. The
 * Doxloop UI stops a run by signalling the CLI it started; without this the
 * CLI died at once and the agent kept working on a run nobody was watching.
 * Returns a function that removes the handlers once the agent has finished.
 */
export function forwardTerminationSignals(
  agent: AgentProcess,
  options: {
    label: string
    signals?: readonly NodeJS.Signals[]
    graceMs?: number
    /** Runs after the agent stopped and before the process exits. */
    onStopped?: () => Promise<void> | void
    log?: (line: string) => void
    exit?: (code: number) => void
  },
): () => void {
  const signals = options.signals ?? ['SIGTERM', 'SIGINT']
  const log = options.log ?? ((line: string) => process.stderr.write(`${line}\n`))
  const exit = options.exit ?? ((code: number) => process.exit(code))
  let forwarding = false
  const handler = (signal: NodeJS.Signals): void => {
    if (forwarding) return
    forwarding = true
    log(`Received ${signal}. Stopping ${options.label} and any capture browser it started…`)
    void agent
      .stop({ graceMs: options.graceMs ?? AGENT_STOP_GRACE_MS })
      .then(() => options.onStopped?.())
      .catch(() => undefined)
      .then(() => exit(SIGNAL_EXIT_CODES[signal] ?? 1))
  }
  for (const signal of signals) process.on(signal, handler)
  return () => {
    for (const signal of signals) process.off(signal, handler)
  }
}
