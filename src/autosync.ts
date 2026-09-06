import { readFile, writeFile, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ProjectBusyError, withProjectLock } from './project-lock.js'
import { agentAuthenticationStatus, chooseAgent } from './agents.js'
import { runAuthor } from './author.js'
import { computeDrift, computeDriftFromChanges, formatDrift } from './drift.js'
import { DoxloopError } from './errors.js'
import { readEvidenceMap } from './evidence.js'
import { emitJobOutcome, type JobOutcome } from './job-events.js'
import { saveProjectSettings, sourceKind } from './project.js'
import { heading, note, promptConfirm, promptSelect, type PromptIo } from './prompts.js'
import { monitorRemoteSources } from './remote-monitor.js'
import {
  appendSyncLog,
  formatScheduleFrequency,
  installSchedule,
  readSyncLog,
  removeSchedule,
  scheduleFrequency,
  scheduleState,
} from './schedule.js'
import { collectSourceChanges, readSyncState, LOCAL_CONTENT_BASELINE } from './sync.js'
import { createSyncRun, listSyncRuns, pendingRunCount, type CreateSyncRunOptions } from './sync-runs.js'
import type {
  DoxloopProject,
  SyncConfig,
  SyncMode,
  SyncRunTrigger,
  SyncTrigger,
} from './types.js'

const MODE_LABELS: Record<SyncMode, string> = {
  check: 'Just tell me — write nothing',
  propose: 'Generate an isolated proposal for review',
  auto: 'Automatically generate an isolated proposal',
}

export function replaySyncSetupCommand(sync: SyncConfig): string {
  const parts = ['doxloop sync setup', `--mode ${sync.mode}`]
  if (sync.branch) parts.push(`--branch ${sync.branch}`)
  parts.push(`--on ${sync.on.length > 0 ? sync.on.join(',') : 'manual'}`)
  return parts.join(' ')
}

export function parseTriggerList(raw: string): SyncTrigger[] {
  if (raw.trim().toLowerCase() === 'manual') return []
  if (raw.split(',').filter((value) => value.trim()).length > 1) throw new DoxloopError('Choose one schedule per project; multiple triggers are not supported.')
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => {
      if (/^every@\d+[mh]$/.test(value)) {
        const amount = Number(value.match(/\d+/)?.[0])
        if (
          (value.endsWith('m') && amount >= 1 && amount <= 59) ||
          (value.endsWith('h') && amount >= 1 && amount <= 24)
        ) return value as SyncTrigger
      }
      const daily = /^daily@(\d{2}):(\d{2})$/.exec(value)
      if (daily && Number(daily[1]) <= 23 && Number(daily[2]) <= 59) {
        return value as SyncTrigger
      }
      const weekdays = /^weekdays@(\d{2}):(\d{2})$/.exec(value)
      if (weekdays && Number(weekdays[1]) <= 23 && Number(weekdays[2]) <= 59) {
        return value as SyncTrigger
      }
      const weekly = /^weekly@(sun|mon|tue|wed|thu|fri|sat)@(\d{2}):(\d{2})$/.exec(value)
      if (weekly && Number(weekly[2]) <= 23 && Number(weekly[3]) <= 59) {
        return value as SyncTrigger
      }
      const monthly = /^monthly@(\d{1,2})@(\d{2}):(\d{2})$/.exec(value)
      if (monthly && Number(monthly[1]) >= 1 && Number(monthly[1]) <= 28 && Number(monthly[2]) <= 23 && Number(monthly[3]) <= 59) {
        return value as SyncTrigger
      }
      throw new DoxloopError(
        `Invalid --on value "${value}". Use daily@HH:MM, weekdays@HH:MM, weekly@day@HH:MM, monthly@day@HH:MM, every@Nm, every@Nh, or manual.`,
        2,
      )
    })
}

export function parseSyncMode(raw: string): SyncMode {
  if (raw === 'check' || raw === 'propose' || raw === 'auto') return raw
  throw new DoxloopError(`--mode must be check, propose, or auto.`, 2)
}

/** Use provider APIs whenever a remote source is configured. */
export async function computeConfiguredDrift(
  root: string,
  project: DoxloopProject,
) {
  if (!hasRemoteSources(project)) return computeDrift(root, project)
  const monitored = await monitorRemoteSources(root, project)
  return computeDriftFromChanges(root, project, monitored.changes)
}

/** The native scheduler, replaceable in tests so no real job is registered. */
export interface SyncScheduler {
  install: typeof installSchedule
  remove: typeof removeSchedule
  state: typeof scheduleState
}

const NATIVE_SCHEDULER: SyncScheduler = { install: installSchedule, remove: removeSchedule, state: scheduleState }

/**
 * Apply a sync configuration: persist it, then make the local machine match it.
 * Installing and removing are the same operation with different inputs, so a
 * project can move between trigger sets without leaving orphaned jobs behind.
 * Local folders are checked in place: a Git checkout by its HEAD commit and
 * working tree, any other folder by the content it held at the last sync.
 * Nothing is fetched, pulled, or written in the source, so a local folder
 * needs no remote to be scheduled.
 */
export async function applySyncConfig(
  root: string,
  project: DoxloopProject,
  sync: SyncConfig,
  scheduler: SyncScheduler = NATIVE_SCHEDULER,
): Promise<string[]> {
  const frequency = scheduleFrequency(sync.on)
  const sources = sync.branch
    ? project.sources.map((source) =>
        source.remote
          ? { ...source, remote: { ...source.remote, branch: sync.branch! } }
          : source)
    : project.sources
  await saveProjectSettings(root, { sources, sync })
  const lines: string[] = []

  if (frequency) {
    const state = await scheduler.install(root, frequency)
    lines.push(
      statusLine('✓', 'Schedule installed', `${formatScheduleFrequency(frequency)} · ${state.label}`),
    )
    for (const source of sources) {
      if (sourceKind(source) !== 'directory' || source.remote) continue
      lines.push(statusLine('✓', 'Local source', `${source.name} is checked in place; nothing is fetched or written there`))
    }
  } else {
    const existing = await scheduler.state(root)
    if (existing.installed) {
      await scheduler.remove(root)
      lines.push(statusLine('✓', 'Schedule removed', existing.label))
    }
  }

  lines.push(statusLine('✓', 'Settings saved', '.doxloop/project.json'))
  return lines
}

const LABEL_WIDTH = 20

function statusLine(mark: string, label: string, detail: string): string {
  return `  ${mark} ${label.padEnd(LABEL_WIDTH)}${detail}`
}

function pageCount(count: number): string {
  return `${count} stale page${count === 1 ? '' : 's'}`
}

export async function runSyncSetupWizard(options: {
  root: string
  project: DoxloopProject
  io: PromptIo
}): Promise<SyncConfig | undefined> {
  const { root, project, io } = options
  const detected = project.sources.find((source) => source.remote)?.remote?.branch
  const current = project.sync

  const branch = await promptSelect<string | undefined>({
    message: 'Which branch should documentation follow?',
    choices: [
      ...(detected
        ? [{ value: detected, label: detected, hint: 'detected default branch' }]
        : []),
      { value: undefined, label: 'Any branch', hint: 'never skip a run' },
    ],
    io,
  })

  const on = await promptSelect<SyncTrigger[]>({
    message: 'When should Doxloop look for drift?',
    choices: [
      {
        value: ['every@15m'],
        label: 'Every 15 minutes',
        hint: 'recommended',
      },
      { value: ['every@1h'], label: 'Every hour' },
      { value: ['daily@09:00'], label: 'Daily at 09:00 only' },
      { value: [], label: 'Only when I run it myself' },
    ],
    io,
  })

  const mode = await promptSelect<SyncMode>({
    message: 'Documentation is stale. What should happen?',
    choices: [
      { value: 'check', label: MODE_LABELS.check, hint: 'no agent runs' },
      { value: 'propose', label: MODE_LABELS.propose, hint: 'recommended' },
      { value: 'auto', label: MODE_LABELS.auto },
    ],
    initialIndex: 1,
    io,
  })

  const sync: SyncConfig = {
    ...current,
    mode,
    ...(branch ? { branch } : {}),
    on,
  }

  heading(io, 'Automatic sync')
  note(
    io,
    [
      `Follows:      ${project.sources.map((source) => source.path).join(', ') || 'no configured source'}${branch ? ` @ ${branch}` : ''}`,
      `Checks:       ${describeTriggers(on)}`,
      `When stale:   ${MODE_LABELS[mode]}`,
      mode === 'check'
        ? 'Never:        starts an agent, deploys, or writes documentation'
        : 'Never:        writes to the product repository or deploys',
    ].join('\n'),
  )
  io.output.write('\n')

  const proceed = await promptConfirm({ message: 'Set this up?', initial: true, io })
  return proceed ? sync : undefined
}

function describeTriggers(on: SyncTrigger[]): string {
  if (on.length === 0) return 'only when you run doxloop check'
  const parts: string[] = []
  const frequency = scheduleFrequency(on)
  if (frequency) parts.push(formatScheduleFrequency(frequency))
  return parts.join(', ')
}

/**
 * Prove the automation can actually run before anyone depends on it. An expired
 * agent sign-in is the most common silent failure for unattended runs, so it is
 * checked here rather than discovered at 09:00 three weeks later.
 */
export async function formatSyncStatus(
  root: string,
  project: DoxloopProject,
): Promise<string> {
  const sync = project.sync
  const enabled = sync.on.length > 0
  const lines: string[] = [`Automatic sync: ${enabled ? 'ON' : 'OFF'}`, '']

  const syncState = await readSyncState(root)
  for (const source of project.sources) {
    if (sourceKind(source) !== 'directory') continue
    if (source.remote) {
      lines.push(statusLine('✓', 'Remote source', `${source.remote.provider}:${source.remote.repository} @ ${source.remote.branch}`))
      continue
    }
    const record = syncState.sources[source.name]
    lines.push(statusLine('✓', 'Local source', `${source.name} · ${describeLocalBaseline(record?.commit)}`))
  }

  const schedule = await scheduleState(root)
  const frequency = scheduleFrequency(sync.on)
  const scheduleName = `${frequency ? formatScheduleFrequency(frequency) : 'installed'} · ${schedule.label}`
  if (!schedule.installed) {
    lines.push(statusLine(frequency ? '✗' : '-', 'Schedule', 'not installed'))
  } else if (schedule.registered === false) {
    lines.push(statusLine('✗', 'Schedule', `${scheduleName} · not loaded`))
  } else if (schedule.lastExitCode === 1) {
    lines.push(
      statusLine('!', 'Schedule', `${scheduleName} · last exit 1 (drift or update failure)`),
    )
  } else if (schedule.lastExitCode !== undefined && schedule.lastExitCode !== 0) {
    lines.push(
      statusLine('✗', 'Schedule', `${scheduleName} · last exit ${schedule.lastExitCode}`),
    )
  } else if (schedule.running) {
    lines.push(statusLine('✓', 'Schedule', `${scheduleName} · running`))
  } else if (schedule.lastExitCode === 0) {
    lines.push(statusLine('✓', 'Schedule', `${scheduleName} · smoke test passed`))
  } else {
    lines.push(statusLine('!', 'Schedule', `${scheduleName} · never verified`))
  }

  if (sync.mode === 'check') {
    lines.push(statusLine('-', 'Agent', 'not needed in check mode'))
  } else {
    lines.push(await agentStatusLine(project))
  }

  const map = await readEvidenceMap(root)
  lines.push(
    map
      ? statusLine(
          '✓',
          'Evidence map',
          `${Object.keys(map.pages).length} page${Object.keys(map.pages).length === 1 ? '' : 's'} tracked`,
        )
      : statusLine('✗', 'Evidence map', 'missing — run `doxloop update` to build it'),
  )

  const log = await readSyncLog(root, 1)
  lines.push('', `  Last run    ${log[0] ?? 'never'}`)

  const pending = pendingRunCount(await listSyncRuns(root))
  lines.push(
    `  Reviews     ${pending === 0 ? 'none pending' : `${pending} pending · open with: doxloop sync review --open`}`,
  )

  const drift = await computeConfiguredDrift(root, project)
  lines.push(
    `  Drift now   ${
      drift.status === 'current'
        ? 'none'
        : drift.status === 'stale'
          ? `${drift.pages.length} page${drift.pages.length === 1 ? '' : 's'} stale`
          : 'cannot be determined'
    }`,
  )
  if (!enabled) lines.push('', 'Enable it with: doxloop sync setup')
  return lines.join('\n')
}

function describeLocalBaseline(commit: string | undefined): string {
  if (!commit) return 'checked in place; no baseline recorded yet'
  if (commit === LOCAL_CONTENT_BASELINE) return 'compared by content (no Git history)'
  return `Git HEAD, baseline ${commit.slice(0, 12)}`
}

async function agentStatusLine(project: DoxloopProject): Promise<string> {
  try {
    const agent = await chooseAgent(project.defaultAgent)
    const status = await agentAuthenticationStatus(agent)
    if (status.status === 'authenticated') {
      return statusLine('✓', 'Agent', `${agent.name}, signed in`)
    }
    if (status.status === 'unauthenticated') {
      return statusLine('✗', 'Agent', status.detail)
    }
    return statusLine('-', 'Agent', `${agent.name}, sign-in not verifiable`)
  } catch (error) {
    return statusLine('✗', 'Agent', error instanceof Error ? error.message : String(error))
  }
}

/**
 * One full maintenance cycle. Detection always runs; authoring runs only when
 * the mode allows it, the configured branch is checked out, and the run budget
 * has not been spent.
 */
interface RunSyncOptions {
  root: string
  project: DoxloopProject
  quiet?: boolean
  trigger?: SyncRunTrigger
  /** Test seam; production callers always use the real author runner. */
  author?: typeof runAuthor
  /** Manual authoring request and controls supplied by the workspace UI. */
  authoring?: CreateSyncRunOptions['authoring']
}
export async function runSyncNow(options: RunSyncOptions): Promise<number> {
  try { return await withProjectLock(options.root, 'monitor', () => withProjectLock(options.root, 'authoring', () => runSyncNowLocked(options), 0), 0) }
  catch (error) {
    if (!(error instanceof ProjectBusyError)) throw error
    await appendSyncLog(options.root, `skipped: ${error.message}`)
    emitJobOutcome({ kind: 'sync', status: 'skipped', message: error.message })
    return 1
  }
}
async function runSyncNowLocked(options: RunSyncOptions): Promise<number> {
  const { root, project } = options
  const frequency = scheduleFrequency(project.sync.on)
  if (options.trigger === 'schedule' && frequency?.kind === 'interval') {
    const clockPath = join(root, '.doxloop', 'monitor-interval.json')
    let last = 0
    try { last = Number(JSON.parse(await readFile(clockPath, 'utf8')).startedAt) } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const now = Date.now()
    if (last > 0 && now >= last && now - last < frequency.minutes * 60_000) return 0
    const temporary = `${clockPath}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify({ startedAt: now }), { mode: 0o600 })
    await rename(temporary, clockPath)
  }
  const write = (text: string): void => {
    if (!options.quiet) process.stdout.write(text)
  }
  const monitored = hasRemoteSources(project)
    ? await monitorRemoteSources(root, project)
    : undefined
  const drift = monitored
    ? await computeDriftFromChanges(root, project, monitored.changes)
    : await computeDrift(root, project)

  const outcome = (status: JobOutcome['status'], message: string, extra: Partial<JobOutcome> = {}): void =>
    emitJobOutcome({ kind: 'sync', status, message, pages: drift.pages.length, ...extra })
  if (drift.status === 'current' && !options.authoring) {
    await appendSyncLog(root, 'check: no reader-visible changes')
    write(`${formatDrift(drift)}\n`)
    outcome('current', 'No reader-visible source changes since the last check.')
    return 0
  }

  write(`${formatDrift(drift)}\n`)
  if (project.sync.mode === 'check' && !options.authoring) {
    await appendSyncLog(root, `check: ${pageCount(drift.pages.length)}, reporting only`)
    if (drift.status === 'stale') outcome('stale', `${pageCount(drift.pages.length)} · monitoring is in check mode, so no proposal was drafted.`)
    else outcome('unknown', drift.notes[0] ?? 'Doxloop could not determine whether the documentation is current.')
    return 1
  }

  const pending = !options.authoring && (await listSyncRuns(root)).some((run) => ['generating', 'awaiting-review', 'partially-applied', 'conflicted'].includes(run.status) && !run.archivedAt)
  if (pending) {
    const message = 'An existing proposal needs review. Accept, reject, or archive it before monitoring drafts another update.'
    await appendSyncLog(root, `skipped: ${message}`)
    outcome('skipped', message)
    return 1
  }
  let blocked = await authoringBlocker(root, project)
  if (!blocked && !options.author) {
    try {
      const agent = await chooseAgent(options.authoring?.agent ?? project.defaultAgent)
      const authentication = await agentAuthenticationStatus(agent)
      if (authentication.status === 'unauthenticated' || (options.trigger === 'schedule' && authentication.status !== 'authenticated')) blocked = `sign in to ${agent.name} before unattended authoring: ${authentication.detail}`
    } catch (error) { blocked = error instanceof Error ? error.message : String(error) }
  }
  if (blocked) {
    await appendSyncLog(root, `skipped: ${blocked}`)
    write(`\nSkipping the documentation update: ${blocked}\n`)
    outcome('skipped', `${pageCount(drift.pages.length)} · the update was skipped because ${blocked}`)
    return 1
  }

  await reserveRun(root)
  await appendSyncLog(root, `proposal: starting for ${pageCount(drift.pages.length)}`)
  const changes = monitored?.changes ?? await collectSourceChanges(root, project.sources)
  const proposal = await createSyncRun({
    root,
    project,
    drift,
    sourceChanges: changes,
    ...(monitored ? { authoringSources: monitored.project.sources } : {}),
    ...(monitored ? { nextSyncState: monitored.nextState } : {}),
    ...(options.trigger ? { trigger: options.trigger } : {}),
    ...(options.author ? { author: options.author } : {}),
    ...(options.authoring ? { authoring: options.authoring } : {}),
  })
  if (proposal.status === 'failed') {
    await appendSyncLog(root, `proposal: ${proposal.id} failed: ${proposal.error ?? 'unknown error'}`)
    write(`\nDocumentation proposal failed: ${proposal.error ?? 'unknown error'}\n`)
    outcome('failed', `The documentation proposal failed: ${proposal.error ?? 'unknown error'}`, { proposalId: proposal.id })
    return 1
  }
  await appendSyncLog(
    root,
    `proposal: ${proposal.id} ready for review with ${proposal.changes.length} changed files`,
  )
  write(
    `\nProposal ${proposal.id} is ready. The actual documentation is unchanged.\nReview and accept changes with:\n  doxloop sync review --open\n`,
  )
  outcome('proposal', `${options.authoring ? 'The requested update' : pageCount(drift.pages.length)} · proposal ${proposal.id} is ready for review with ${proposal.changes.length} changed file${proposal.changes.length === 1 ? '' : 's'}.`, { proposalId: proposal.id })
  return 0
}

/** A reason authoring must not start, or undefined when it may proceed. */
async function authoringBlocker(
  root: string,
  project: DoxloopProject,
): Promise<string | undefined> {
  const limit = project.sync.budget?.maxRunsPerDay
  if (limit !== undefined && (await runsToday(root)) >= limit) {
    return `the configured budget of ${limit} run${limit === 1 ? '' : 's'} per day is spent.`
  }
  return undefined
}

interface BudgetLedger { date: string; count: number }
async function budgetLedger(root: string): Promise<BudgetLedger> {
  const date = new Date().toISOString().slice(0, 10)
  try {
    const ledger = JSON.parse(await readFile(join(root, '.doxloop', 'monitor-budget.json'), 'utf8')) as BudgetLedger
    if (!Number.isInteger(ledger.count) || ledger.count < 0) throw new DoxloopError('Monitoring budget state is invalid. Repair it before starting another run.')
    return ledger.date === date ? ledger : { date, count: 0 }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    // Migrate starts recorded before the durable ledger was introduced.
    const log = await readSyncLog(root, 100_000)
    return { date, count: log.filter((line) => line.startsWith(date) && (line.includes('proposal: starting') || line.includes('update: starting'))).length }
  }
}
async function runsToday(root: string): Promise<number> { return (await budgetLedger(root)).count }
async function reserveRun(root: string): Promise<void> {
  const ledger = await budgetLedger(root)
  const path = join(root, '.doxloop', 'monitor-budget.json')
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, JSON.stringify({ ...ledger, count: ledger.count + 1 }), { mode: 0o600 })
  await rename(temporary, path)
}

export async function disableSync(
  root: string,
  project: DoxloopProject,
): Promise<string[]> {
  const lines: string[] = []
  const schedule = await scheduleState(root)
  if (schedule.installed) {
    await removeSchedule(root)
    lines.push(statusLine('✓', 'Schedule removed', schedule.label))
  }
  await saveProjectSettings(root, { sync: { ...project.sync, on: [] } })
  lines.push(statusLine('✓', 'Settings kept', 're-enable with: doxloop sync setup'))
  return lines
}

function hasRemoteSources(project: DoxloopProject): boolean {
  return project.sources.some(
    (source) => sourceKind(source) === 'directory' && source.remote !== undefined,
  )
}
