import { agentAuthenticationStatus, chooseAgent } from './agents.js'
import { runAuthor } from './author.js'
import { computeDrift, computeDriftFromChanges, formatDrift } from './drift.js'
import { DoxloopError } from './errors.js'
import { readEvidenceMap } from './evidence.js'
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
import { collectSourceChanges } from './sync.js'
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

/**
 * Apply a sync configuration: persist it, then make the local machine match it.
 * Installing and removing are the same operation with different inputs, so a
 * project can move between trigger sets without leaving orphaned jobs behind.
 */
export async function applySyncConfig(
  root: string,
  project: DoxloopProject,
  sync: SyncConfig,
): Promise<string[]> {
  const frequency = scheduleFrequency(sync.on)
  const sources = sync.branch
    ? project.sources.map((source) =>
        source.remote
          ? { ...source, remote: { ...source.remote, branch: sync.branch! } }
          : source)
    : project.sources
  if (frequency) {
    const missing = sources.filter(
      (source) => sourceKind(source) === 'directory' && !source.remote,
    )
    if (missing.length > 0) {
      throw new DoxloopError(
        `Scheduled sync requires a read-only remote for: ${missing.map((source) => source.name).join(', ')}. Doxloop will not install source-repository hooks.`,
      )
    }
  }
  await saveProjectSettings(root, { sources, sync })
  const lines: string[] = []

  if (frequency) {
    const state = await installSchedule(root, frequency)
    lines.push(
      statusLine('✓', 'Schedule installed', `${formatScheduleFrequency(frequency)} · ${state.label}`),
    )
  } else {
    const existing = await scheduleState(root)
    if (existing.installed) {
      await removeSchedule(root)
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

  for (const source of project.sources) {
    if (sourceKind(source) !== 'directory') continue
    lines.push(
      source.remote
        ? statusLine('✓', 'Remote source', `${source.remote.provider}:${source.remote.repository} @ ${source.remote.branch}`)
        : statusLine('✗', 'Remote source', `${source.name} is not configured`),
    )
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
export async function runSyncNow(options: {
  root: string
  project: DoxloopProject
  quiet?: boolean
  trigger?: SyncRunTrigger
  /** Test seam; production callers always use the real author runner. */
  author?: typeof runAuthor
  /** Manual authoring request and controls supplied by the workspace UI. */
  authoring?: CreateSyncRunOptions['authoring']
}): Promise<number> {
  const { root, project } = options
  const write = (text: string): void => {
    if (!options.quiet) process.stdout.write(text)
  }
  const monitored = hasRemoteSources(project)
    ? await monitorRemoteSources(root, project)
    : undefined
  const drift = monitored
    ? await computeDriftFromChanges(root, project, monitored.changes)
    : await computeDrift(root, project)

  if (drift.status === 'current' && !options.authoring) {
    await appendSyncLog(root, 'check: no reader-visible changes')
    write(`${formatDrift(drift)}\n`)
    return 0
  }

  write(`${formatDrift(drift)}\n`)
  if (project.sync.mode === 'check' && !options.authoring) {
    await appendSyncLog(root, `check: ${pageCount(drift.pages.length)}, reporting only`)
    return 1
  }

  const blocked = await authoringBlocker(root, project)
  if (blocked) {
    await appendSyncLog(root, `skipped: ${blocked}`)
    write(`\nSkipping the documentation update: ${blocked}\n`)
    return 1
  }

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
    return 1
  }
  await appendSyncLog(
    root,
    `proposal: ${proposal.id} ready for review with ${proposal.changes.length} changed files`,
  )
  write(
    `\nProposal ${proposal.id} is ready. The actual documentation is unchanged.\nReview and accept changes with:\n  doxloop sync review --open\n`,
  )
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

async function runsToday(root: string): Promise<number> {
  const today = new Date().toISOString().slice(0, 10)
  const log = await readSyncLog(root, 500)
  return log.filter(
    (line) =>
      line.startsWith(today) &&
      (line.includes('proposal: starting') || line.includes('update: starting')),
  ).length
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
