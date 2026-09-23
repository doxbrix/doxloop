/**
 * Keeps the computer from idle-sleeping while documentation jobs run: laptop
 * sleep used to kill authoring batches mid-session. One helper process is
 * held while any job needs it (reference-counted across concurrent jobs) and
 * released when the last one ends or the server exits.
 *
 * macOS: `caffeinate -i -w <server pid>` (also exits on its own if the
 * server dies). Linux: `systemd-inhibit --what=idle:sleep … sleep infinity`
 * when systemd-inhibit is installed. Elsewhere, or with
 * DOXLOOP_KEEP_AWAKE=0, nothing happens.
 */
import { spawn as nodeSpawn, type ChildProcess } from 'node:child_process'
import { accessSync, constants } from 'node:fs'
import { delimiter, join } from 'node:path'

export interface KeepAwakeOptions {
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
  pid?: number
  spawn?: (command: string, args: string[], options: { stdio: 'ignore' }) => ChildProcess
  /** Whether a command is on PATH; replaced in tests. */
  hasCommand?: (command: string) => boolean
  /** Register process-exit cleanup (off in tests). */
  registerExitHook?: boolean
}

export function keepAwakeCommand(options: Pick<KeepAwakeOptions, 'platform' | 'env' | 'pid' | 'hasCommand'> = {}): { command: string; args: string[] } | undefined {
  const env = options.env ?? process.env
  if (env.DOXLOOP_KEEP_AWAKE === '0' || env.DOXLOOP_KEEP_AWAKE === 'false') return undefined
  const platform = options.platform ?? process.platform
  const hasCommand = options.hasCommand ?? ((command: string) => commandOnPath(command, env))
  if (platform === 'darwin') {
    return { command: 'caffeinate', args: ['-i', '-w', String(options.pid ?? process.pid)] }
  }
  if (platform === 'linux' && hasCommand('systemd-inhibit')) {
    return {
      command: 'systemd-inhibit',
      args: ['--what=idle:sleep', '--who=Doxloop', '--why=Doxloop is generating documentation', '--mode=block', 'sleep', 'infinity'],
    }
  }
  return undefined
}

function commandOnPath(command: string, env: NodeJS.ProcessEnv): boolean {
  for (const directory of (env.PATH ?? '').split(delimiter)) {
    if (!directory) continue
    try {
      accessSync(join(directory, command), constants.X_OK)
      return true
    } catch {
      // Keep looking.
    }
  }
  return false
}

export class KeepAwake {
  private holders = 0
  private child: ChildProcess | undefined
  private exitHooked = false

  constructor(private readonly options: KeepAwakeOptions = {}) {}

  /** Number of jobs currently holding the computer awake. */
  get count(): number {
    return this.holders
  }

  /** Whether a keep-awake helper process is running. */
  get active(): boolean {
    return this.child !== undefined
  }

  /**
   * Hold the computer awake until the returned release function is called.
   * Releasing twice is harmless; the helper stops when the last holder releases.
   */
  acquire(): () => void {
    this.holders += 1
    if (this.holders === 1) this.start()
    let released = false
    return () => {
      if (released) return
      released = true
      this.holders = Math.max(0, this.holders - 1)
      if (this.holders === 0) this.stop()
    }
  }

  /** Stop the helper regardless of holders (process exit). */
  stop(): void {
    const child = this.child
    this.child = undefined
    if (child && child.exitCode === null && child.signalCode === null) {
      try {
        child.kill('SIGTERM')
      } catch {
        // Already gone.
      }
    }
  }

  private start(): void {
    const command = keepAwakeCommand(this.options)
    if (!command) return
    let child: ChildProcess
    try {
      child = (this.options.spawn ?? nodeSpawn)(command.command, command.args, { stdio: 'ignore' })
    } catch {
      return
    }
    this.child = child
    // A missing binary or a helper that exits early just means no keep-awake.
    child.once('error', () => {
      if (this.child === child) this.child = undefined
    })
    child.once('exit', () => {
      if (this.child === child) this.child = undefined
    })
    child.unref?.()
    if (!this.exitHooked && this.options.registerExitHook !== false) {
      this.exitHooked = true
      process.once('exit', () => this.stop())
    }
  }
}

/** The UI server's shared keep-awake. */
export const keepAwake = new KeepAwake()
