import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { DoxloopError } from './errors.js'
import { pathExists } from './fs.js'
import type { SyncTrigger } from './types.js'

const run = promisify(execFile)

export const SYNC_LOG_FILE = join('.doxloop', 'sync.log')

export interface DailyTime {
  hour: number
  minute: number
}

export type ScheduleFrequency =
  | { kind: 'interval'; minutes: number }
  | { kind: 'daily'; time: DailyTime }

export interface ScheduleState {
  installed: boolean
  label: string
  path?: string
  time?: DailyTime
  frequency?: ScheduleFrequency
  registered?: boolean
  running?: boolean
  runs?: number
  lastExitCode?: number
  logPath?: string
}

/** The first `daily@HH:MM` trigger, or undefined when none is configured. */
export function dailyTime(triggers: readonly SyncTrigger[]): DailyTime | undefined {
  for (const trigger of triggers) {
    const match = /^daily@(\d{2}):(\d{2})$/.exec(trigger)
    if (match) return { hour: Number(match[1]), minute: Number(match[2]) }
  }
  return undefined
}

export function scheduleFrequency(
  triggers: readonly SyncTrigger[],
): ScheduleFrequency | undefined {
  for (const trigger of triggers) {
    const interval = /^every@(\d+)([mh])$/.exec(trigger)
    if (interval) {
      const amount = Number(interval[1])
      return { kind: 'interval', minutes: interval[2] === 'h' ? amount * 60 : amount }
    }
  }
  const time = dailyTime(triggers)
  return time ? { kind: 'daily', time } : undefined
}

export function formatScheduleFrequency(frequency: ScheduleFrequency): string {
  if (frequency.kind === 'daily') return `daily ${formatDailyTime(frequency.time)}`
  if (frequency.minutes % 60 === 0) {
    const hours = frequency.minutes / 60
    return `every ${hours} hour${hours === 1 ? '' : 's'}`
  }
  return `every ${frequency.minutes} minute${frequency.minutes === 1 ? '' : 's'}`
}

export function formatDailyTime(time: DailyTime): string {
  return `${String(time.hour).padStart(2, '0')}:${String(time.minute).padStart(2, '0')}`
}

/**
 * A stable per-project identifier. The directory name keeps it recognizable in
 * `launchctl list` or `systemctl --user`, and the path hash keeps two projects
 * with the same directory name apart.
 */
export function scheduleLabel(root: string): string {
  const slug =
    basename(root)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '') || 'docs'
  const digest = createHash('sha256').update(root).digest('hex').slice(0, 8)
  return `doxloop-${slug}-${digest}`
}

function cliPath(): string {
  return fileURLToPath(new URL('cli.js', import.meta.url))
}

export function renderLaunchAgent(options: {
  label: string
  root: string
  frequency: ScheduleFrequency
}): string {
  const escape = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // launchd opens stdout/stderr before spawning the process. macOS can reject
  // that spawn when the destination is inside a protected Documents folder,
  // so native scheduler diagnostics live in the user's Library logs instead.
  const log = nativeScheduleLog(options.label)
  // LaunchServices may reject a user-managed Node binary as the top-level
  // executable. Start with Apple's signed shell, then exec the exact Node and
  // CLI paths selected during setup.
  const command = [
    'exec',
    shellQuote(process.execPath),
    shellQuote(cliPath()),
    'sync',
    'now',
    '--trigger',
    'schedule',
    '--cwd',
    shellQuote(options.root),
  ].join(' ')
  const scheduledPath = process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin'
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>com.doxbrix.${escape(options.label)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>${escape(command)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escape(scheduledPath)}</string>
    <key>HOME</key>
    <string>${escape(homedir())}</string>
  </dict>
  ${options.frequency.kind === 'daily' ? `<key>StartCalendarInterval</key>
  <dict>
    <key>Hour</key>
    <integer>${options.frequency.time.hour}</integer>
    <key>Minute</key>
    <integer>${options.frequency.time.minute}</integer>
  </dict>` : `<key>StartInterval</key>
  <integer>${options.frequency.minutes * 60}</integer>`}
  <key>StandardOutPath</key>
  <string>${escape(log)}</string>
  <key>StandardErrorPath</key>
  <string>${escape(log)}</string>
  <key>ProcessType</key>
  <string>Background</string>
</dict>
</plist>
`
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

export function renderSystemdService(options: { root: string }): string {
  return `[Unit]
Description=Doxloop documentation sync for ${options.root}

[Service]
Type=oneshot
ExecStart=${process.execPath} ${cliPath()} sync now --trigger schedule --cwd ${options.root}
StandardOutput=append:${join(options.root, SYNC_LOG_FILE)}
StandardError=append:${join(options.root, SYNC_LOG_FILE)}
`
}

export function renderSystemdTimer(options: {
  root: string
  frequency: ScheduleFrequency
}): string {
  return `[Unit]
Description=Doxloop documentation sync for ${options.root}

[Timer]
${options.frequency.kind === 'daily' ? `OnCalendar=*-*-* ${formatDailyTime(options.frequency.time)}:00` : `OnUnitActiveSec=${options.frequency.minutes}m`}
Persistent=true

[Install]
WantedBy=timers.target
`
}

/** `Persistent=true` and launchd both run a missed job once the machine wakes. */
export function cronLine(options: {
  label: string
  root: string
  frequency: ScheduleFrequency
}): string {
  const log = join(options.root, SYNC_LOG_FILE)
  const expression = options.frequency.kind === 'daily'
    ? `${options.frequency.time.minute} ${options.frequency.time.hour} * * *`
    : options.frequency.minutes < 60
      ? `*/${options.frequency.minutes} * * * *`
      : `0 */${options.frequency.minutes / 60} * * *`
  return `${expression} ${process.execPath} ${cliPath()} sync now --trigger schedule --cwd ${options.root} >> ${log} 2>&1 # ${options.label}`
}

export async function installSchedule(
  root: string,
  frequency: ScheduleFrequency,
  platform: NodeJS.Platform = process.platform,
): Promise<ScheduleState> {
  const label = scheduleLabel(root)
  if (platform === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', `com.doxbrix.${label}.plist`)
    await mkdir(join(homedir(), 'Library', 'LaunchAgents'), { recursive: true })
    await mkdir(join(homedir(), 'Library', 'Logs', 'Doxloop'), { recursive: true })
    await writeFile(path, renderLaunchAgent({ label, root, frequency }), 'utf8')
    await launchctl(['bootout', `gui/${process.getuid?.() ?? 0}`, path])
    await launchctl(['bootstrap', `gui/${process.getuid?.() ?? 0}`, path], true)
    try {
      const health = await smokeLaunchAgent(label)
      return {
        installed: true,
        label,
        path,
        ...(frequency.kind === 'daily' ? { time: frequency.time } : {}),
        frequency,
        registered: true,
        logPath: nativeScheduleLog(label),
        ...health,
      }
    } catch (error) {
      await launchctl(['bootout', `gui/${process.getuid?.() ?? 0}`, path])
      await rm(path, { force: true })
      await rm(nativeScheduleLog(label), { force: true })
      throw error
    }
  }
  if (platform === 'linux') {
    if (await hasSystemdUser()) {
      const directory = join(homedir(), '.config', 'systemd', 'user')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${label}.service`), renderSystemdService({ root }), 'utf8')
      await writeFile(join(directory, `${label}.timer`), renderSystemdTimer({ root, frequency }), 'utf8')
      await systemctl(['daemon-reload'])
      await systemctl(['enable', '--now', `${label}.timer`], true)
      return { installed: true, label, path: join(directory, `${label}.timer`), frequency }
    }
    await writeCrontab(await crontabWithout(label, cronLine({ label, root, frequency })))
    return { installed: true, label, frequency }
  }
  if (platform === 'win32') {
    await run('schtasks', [
      '/create',
      '/f',
      '/tn',
      label,
      '/sc',
      frequency.kind === 'daily' ? 'daily' : 'minute',
      ...(frequency.kind === 'daily'
        ? ['/st', formatDailyTime(frequency.time)]
        : ['/mo', String(frequency.minutes)]),
      '/tr',
      `"${process.execPath}" "${cliPath()}" sync now --trigger schedule --cwd "${root}"`,
    ])
    return { installed: true, label, frequency }
  }
  throw new DoxloopError(
    `Scheduled documentation sync is not supported on ${platform}. Run \`doxloop sync now\` from your own scheduler instead.`,
  )
}

export async function removeSchedule(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ScheduleState> {
  const label = scheduleLabel(root)
  if (platform === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', `com.doxbrix.${label}.plist`)
    await launchctl(['bootout', `gui/${process.getuid?.() ?? 0}`, path])
    await rm(path, { force: true })
    await rm(nativeScheduleLog(label), { force: true })
    return { installed: false, label, path, logPath: nativeScheduleLog(label) }
  }
  if (platform === 'linux') {
    const directory = join(homedir(), '.config', 'systemd', 'user')
    if (await pathExists(join(directory, `${label}.timer`))) {
      await systemctl(['disable', '--now', `${label}.timer`])
      await rm(join(directory, `${label}.timer`), { force: true })
      await rm(join(directory, `${label}.service`), { force: true })
      await systemctl(['daemon-reload'])
      return { installed: false, label }
    }
    await writeCrontab(await crontabWithout(label))
    return { installed: false, label }
  }
  if (platform === 'win32') {
    await run('schtasks', ['/delete', '/f', '/tn', label]).catch(() => undefined)
    return { installed: false, label }
  }
  return { installed: false, label }
}

export async function scheduleState(
  root: string,
  platform: NodeJS.Platform = process.platform,
): Promise<ScheduleState> {
  const label = scheduleLabel(root)
  if (platform === 'darwin') {
    const path = join(homedir(), 'Library', 'LaunchAgents', `com.doxbrix.${label}.plist`)
    const installed = await pathExists(path)
    if (!installed) {
      return {
        installed: false,
        label,
        path,
        registered: false,
        logPath: nativeScheduleLog(label),
      }
    }
    const native = await launchAgentState(label)
    return native
      ? {
          installed: true,
          label,
          path,
          registered: true,
          logPath: nativeScheduleLog(label),
          ...native,
        }
      : {
          installed: true,
          label,
          path,
          registered: false,
          logPath: nativeScheduleLog(label),
        }
  }
  if (platform === 'linux') {
    const path = join(homedir(), '.config', 'systemd', 'user', `${label}.timer`)
    if (await pathExists(path)) return { installed: true, label, path }
    return { installed: (await currentCrontab()).includes(`# ${label}`), label }
  }
  if (platform === 'win32') {
    const found = await run('schtasks', ['/query', '/tn', label])
      .then(() => true)
      .catch(() => false)
    return { installed: found, label }
  }
  return { installed: false, label }
}

function nativeScheduleLog(label: string): string {
  return join(homedir(), 'Library', 'Logs', 'Doxloop', `${label}.log`)
}

export function parseLaunchctlState(output: string): {
  running: boolean
  runs?: number
  lastExitCode?: number
} {
  const runs = /\bruns = (\d+)/.exec(output)
  const lastExit = /\blast exit code = (\d+)/.exec(output)
  return {
    running: /\bstate = running\b/.test(output),
    ...(runs ? { runs: Number(runs[1]) } : {}),
    ...(lastExit ? { lastExitCode: Number(lastExit[1]) } : {}),
  }
}

async function launchAgentState(
  label: string,
): Promise<{ running: boolean; runs?: number; lastExitCode?: number } | undefined> {
  try {
    const service = `gui/${process.getuid?.() ?? 0}/com.doxbrix.${label}`
    return parseLaunchctlState((await run('launchctl', ['print', service])).stdout)
  } catch {
    return undefined
  }
}

async function smokeLaunchAgent(label: string): Promise<{
  running: boolean
  runs?: number
  lastExitCode?: number
}> {
  const before = await launchAgentState(label)
  const service = `gui/${process.getuid?.() ?? 0}/com.doxbrix.${label}`
  await launchctl(['kickstart', '-k', service], true)
  const deadline = Date.now() + 8_000
  while (Date.now() < deadline) {
    const state = await launchAgentState(label)
    if (state?.running) return state
    if (state && (state.runs ?? 0) > (before?.runs ?? 0)) {
      // Exit 1 is the documented check-mode signal for detected drift. It
      // still proves that launchd started Node and reached the Doxloop CLI.
      if (state.lastExitCode === 0 || state.lastExitCode === 1) return state
      if (state.lastExitCode !== undefined) {
        throw new DoxloopError(
          `The scheduled sync started but failed its setup smoke test with exit ${state.lastExitCode}.`,
        )
      }
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 200))
  }
  throw new DoxloopError('The scheduled sync did not start during its setup smoke test.')
}

async function launchctl(args: string[], required = false): Promise<void> {
  try {
    await run('launchctl', args)
  } catch (error) {
    // `bootout` fails when nothing is loaded, which is the normal install path.
    if (required) {
      throw new DoxloopError(
        `Could not register the scheduled sync with launchd: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

async function systemctl(args: string[], required = false): Promise<void> {
  try {
    await run('systemctl', ['--user', ...args])
  } catch (error) {
    if (required) {
      throw new DoxloopError(
        `Could not register the scheduled sync with systemd: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
  }
}

async function hasSystemdUser(): Promise<boolean> {
  try {
    await run('systemctl', ['--user', 'show-environment'])
    return true
  } catch {
    return false
  }
}

async function currentCrontab(): Promise<string> {
  try {
    return (await run('crontab', ['-l'])).stdout
  } catch {
    return ''
  }
}

/** Rewrite the user's crontab, preserving every line that is not ours. */
export function withoutLabel(crontab: string, label: string, add?: string): string {
  const lines = crontab
    .split('\n')
    .filter((line) => line.trim() !== '' && !line.includes(`# ${label}`))
  if (add) lines.push(add)
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

async function crontabWithout(label: string, add?: string): Promise<string> {
  return withoutLabel(await currentCrontab(), label, add)
}

async function writeCrontab(content: string): Promise<void> {
  const path = join(homedir(), `.doxloop-crontab-${process.pid}`)
  await writeFile(path, content, 'utf8')
  try {
    await run('crontab', [path])
  } finally {
    await rm(path, { force: true })
  }
}

export async function readSyncLog(root: string, lines = 20): Promise<string[]> {
  const path = join(root, SYNC_LOG_FILE)
  if (!(await pathExists(path))) return []
  const content = await readFile(path, 'utf8')
  return content.split('\n').filter(Boolean).slice(-lines)
}

export async function appendSyncLog(root: string, message: string): Promise<void> {
  const path = join(root, SYNC_LOG_FILE)
  const existing = (await pathExists(path)) ? await readFile(path, 'utf8') : ''
  await writeFile(path, `${existing}${new Date().toISOString()}  ${message}\n`, 'utf8')
}
