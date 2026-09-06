import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  appendSyncLog,
  cronLine,
  dailyTime,
  formatDailyTime,
  parseLaunchctlState,
  readSyncLog,
  renderLaunchAgent,
  renderSystemdService,
  renderSystemdTimer,
  scheduleFrequency,
  scheduleLabel,
  withoutLabel,
} from './schedule.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('dailyTime', () => {
  test('reads the first daily trigger', () => {
    expect(dailyTime(['every@15m', 'daily@09:30'])).toEqual({ hour: 9, minute: 30 })
    expect(dailyTime(['daily@00:05'])).toEqual({ hour: 0, minute: 5 })
  })

  test('is undefined without a daily trigger', () => {
    expect(dailyTime(['every@15m'])).toBeUndefined()
    expect(dailyTime([])).toBeUndefined()
  })

  test('formats back to the configured form', () => {
    expect(formatDailyTime({ hour: 9, minute: 0 })).toBe('09:00')
    expect(formatDailyTime({ hour: 23, minute: 5 })).toBe('23:05')
  })
})

describe('scheduleFrequency', () => {
  test('parses minute, hour, and daily schedules', () => {
    expect(scheduleFrequency(['every@15m'])).toEqual({ kind: 'interval', minutes: 15 })
    expect(scheduleFrequency(['every@2h'])).toEqual({ kind: 'interval', minutes: 120 })
    expect(scheduleFrequency(['daily@09:30'])).toEqual({
      kind: 'daily',
      time: { hour: 9, minute: 30 },
    })
    expect(scheduleFrequency(['weekdays@08:15'])).toEqual({
      kind: 'weekdays',
      time: { hour: 8, minute: 15 },
    })
    expect(scheduleFrequency(['weekly@wed@10:45'])).toEqual({
      kind: 'weekly',
      weekday: 3,
      time: { hour: 10, minute: 45 },
    })
    expect(scheduleFrequency(['monthly@15@07:00'])).toEqual({
      kind: 'monthly',
      day: 15,
      time: { hour: 7, minute: 0 },
    })
  })
})

describe('scheduleLabel', () => {
  test('is stable, readable, and unique per project path', () => {
    const label = scheduleLabel('/srv/work/acme-docs')

    expect(label).toMatch(/^doxloop-acme-docs-[0-9a-f]{8}$/)
    expect(scheduleLabel('/srv/work/acme-docs')).toBe(label)
    expect(scheduleLabel('/srv/other/acme-docs')).not.toBe(label)
  })

  test('survives a directory name with no usable characters', () => {
    expect(scheduleLabel('/tmp/___')).toMatch(/^doxloop-docs-[0-9a-f]{8}$/)
  })
})

describe('job definitions', () => {
  const time = { hour: 9, minute: 0 }
  const root = '/srv/work/acme-docs'

  test('the launch agent preserves the agent environment and uses a safe native log', () => {
    const plist = renderLaunchAgent({ label: 'doxloop-acme-docs-1234abcd', root, frequency: { kind: 'daily', time } })

    expect(plist).toContain('<string>com.doxbrix.doxloop-acme-docs-1234abcd</string>')
    expect(plist).toContain('<string>/bin/sh</string>')
    expect(plist).toContain('<string>-c</string>')
    expect(plist).toContain('sync now --trigger schedule --cwd')
    expect(plist).toContain('<key>EnvironmentVariables</key>')
    expect(plist).toContain('<key>PATH</key>')
    expect(plist).toContain('<key>HOME</key>')
    expect(plist).toContain('<key>Hour</key>\n    <integer>9</integer>')
    expect(plist).toContain('<key>Minute</key>\n    <integer>0</integer>')
    expect(plist).toContain(join('Library', 'Logs', 'Doxloop', 'doxloop-acme-docs-1234abcd.log'))
  })

  test('parses native launchd run health', () => {
    expect(
      parseLaunchctlState(`state = not running\nruns = 2\nlast exit code = 78: EX_CONFIG\n`),
    ).toEqual({ running: false, runs: 2, lastExitCode: 78 })
    expect(parseLaunchctlState('state = running\nruns = 1\n')).toEqual({
      running: true,
      runs: 1,
    })
  })

  test('the launch agent escapes XML characters in paths', () => {
    const plist = renderLaunchAgent({
      label: 'doxloop-a-b-1234abcd',
      root: '/tmp/a&b<docs>',
      frequency: { kind: 'daily', time },
    })

    expect(plist).toContain('/tmp/a&amp;b&lt;docs&gt;')
    expect(plist).not.toContain('a&b<docs>')
  })

  test('the systemd timer runs daily and catches up after downtime', () => {
    const timer = renderSystemdTimer({ root, frequency: { kind: 'daily', time } })

    expect(timer).toContain('OnCalendar=*-*-* 09:00:00')
    expect(timer).toContain('Persistent=true')
    expect(renderSystemdService({ root })).toContain(
      'sync now --trigger schedule --cwd /srv/work/acme-docs',
    )
  })

  test('the cron line is tagged so it can be removed precisely', () => {
    const line = cronLine({ label: 'doxloop-acme-docs-1234abcd', root, frequency: { kind: 'daily', time } })

    expect(line.startsWith('0 9 * * * ')).toBe(true)
    expect(line).toContain("sync now --trigger schedule --cwd '/srv/work/acme-docs'")
    expect(line.endsWith('# doxloop-acme-docs-1234abcd')).toBe(true)
  })

  test('renders an interval without any repository hook', () => {
    const plist = renderLaunchAgent({
      label: 'doxloop-acme-docs-1234abcd',
      root,
      frequency: { kind: 'interval', minutes: 15 },
    })
    expect(plist).toContain('<key>StartInterval</key>\n  <integer>900</integer>')
    expect(plist).not.toContain('StartCalendarInterval')
  })

  test('renders weekday, weekly, and monthly calendar schedules', () => {
    const weekdays = renderLaunchAgent({
      label: 'doxloop-acme-docs-1234abcd', root,
      frequency: { kind: 'weekdays', time },
    })
    expect(weekdays).toContain('<array>')
    expect(weekdays).toContain('<key>Weekday</key>')
    expect(weekdays).toContain('<integer>5</integer>')

    const weekly = renderSystemdTimer({
      root, frequency: { kind: 'weekly', weekday: 1, time },
    })
    expect(weekly).toContain('OnCalendar=Mon *-*-* 09:00:00')

    const monthly = cronLine({
      label: 'doxloop-acme-docs-1234abcd', root,
      frequency: { kind: 'monthly', day: 15, time },
    })
    expect(monthly.startsWith('0 9 15 * * ')).toBe(true)
  })
})

describe('withoutLabel', () => {
  const existing = '0 6 * * * /usr/bin/backup\n0 9 * * * doxloop # doxloop-acme-1234abcd\n'

  test('removes only the tagged line', () => {
    expect(withoutLabel(existing, 'doxloop-acme-1234abcd')).toBe(
      '0 6 * * * /usr/bin/backup\n',
    )
  })

  test('replaces the tagged line when adding', () => {
    const next = withoutLabel(existing, 'doxloop-acme-1234abcd', 'NEW # doxloop-acme-1234abcd')

    expect(next).toBe('0 6 * * * /usr/bin/backup\nNEW # doxloop-acme-1234abcd\n')
  })

  test('leaves another project’s entry alone', () => {
    const other = '0 9 * * * doxloop # doxloop-other-99999999\n'

    expect(withoutLabel(other, 'doxloop-acme-1234abcd')).toBe(other)
  })

  test('produces an empty crontab rather than a blank line', () => {
    expect(withoutLabel('0 9 * * * doxloop # doxloop-acme-1234abcd\n', 'doxloop-acme-1234abcd')).toBe('')
  })
})

describe('sync log', () => {
  test('appends timestamped lines and reads back the tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-schedule-'))
    roots.push(root)
    const { mkdir } = await import('node:fs/promises')
    await mkdir(join(root, '.doxloop'), { recursive: true })

    expect(await readSyncLog(root)).toEqual([])
    await appendSyncLog(root, 'check: no reader-visible changes')
    await appendSyncLog(root, 'update: 2 pages')

    const lines = await readSyncLog(root)
    expect(lines).toHaveLength(2)
    expect(lines[1]).toContain('update: 2 pages')
    expect(lines[0]).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(await readSyncLog(root, 1)).toHaveLength(1)
  })
})

test('interval cron polls and delegates elapsed timing instead of approximating 24 hours as midnight', () => {
  expect(cronLine({ root: '/tmp/docs with spaces', label: 'doxloop-test', frequency: { kind: 'interval', minutes: 1440 } })).toMatch(/^\* \* \* \* \*/)
  expect(cronLine({ root: "/tmp/a'b", label: 'doxloop-test', frequency: { kind: 'interval', minutes: 17 } })).toContain("'/tmp/a'\"'\"'b'")
  expect(() => scheduleFrequency(['every@24h', 'daily@09:00'])).toThrow('one schedule')
})
