import { EventEmitter } from 'node:events'
import type { ChildProcess } from 'node:child_process'
import { describe, expect, test } from 'vitest'
import { KeepAwake, keepAwakeCommand } from './keep-awake.js'

function fakeSpawner() {
  const calls: Array<{ command: string; args: string[] }> = []
  const children: Array<EventEmitter & { killed: string[]; exitCode: number | null; signalCode: string | null }> = []
  const spawn = (command: string, args: string[]): ChildProcess => {
    calls.push({ command, args })
    const child = Object.assign(new EventEmitter(), {
      killed: [] as string[],
      exitCode: null as number | null,
      signalCode: null as string | null,
      kill(signal: string) { this.killed.push(signal); return true },
      unref() {},
    })
    children.push(child)
    return child as unknown as ChildProcess
  }
  return { calls, children, spawn }
}

describe('keepAwakeCommand', () => {
  test('uses caffeinate tied to the server process on macOS', () => {
    expect(keepAwakeCommand({ platform: 'darwin', env: {}, pid: 4242 })).toEqual({ command: 'caffeinate', args: ['-i', '-w', '4242'] })
  })

  test('uses systemd-inhibit on Linux only when it is installed', () => {
    expect(keepAwakeCommand({ platform: 'linux', env: {}, hasCommand: () => true })).toMatchObject({ command: 'systemd-inhibit', args: expect.arrayContaining(['--what=idle:sleep', 'sleep', 'infinity']) })
    expect(keepAwakeCommand({ platform: 'linux', env: {}, hasCommand: () => false })).toBeUndefined()
  })

  test('does nothing on other platforms or when opted out', () => {
    expect(keepAwakeCommand({ platform: 'win32', env: {} })).toBeUndefined()
    expect(keepAwakeCommand({ platform: 'darwin', env: { DOXLOOP_KEEP_AWAKE: '0' } })).toBeUndefined()
  })
})

describe('KeepAwake', () => {
  test('holds one helper across concurrent jobs and stops it when the last one ends', () => {
    const fake = fakeSpawner()
    const awake = new KeepAwake({ platform: 'darwin', env: {}, pid: 7, spawn: fake.spawn, registerExitHook: false })
    const first = awake.acquire()
    const second = awake.acquire()
    expect(fake.calls).toEqual([{ command: 'caffeinate', args: ['-i', '-w', '7'] }])
    expect(awake.count).toBe(2)
    first()
    first()
    expect(awake.count).toBe(1)
    expect(fake.children[0]!.killed).toEqual([])
    second()
    expect(awake.count).toBe(0)
    expect(fake.children[0]!.killed).toEqual(['SIGTERM'])
    expect(awake.active).toBe(false)
    // A later job starts a fresh helper.
    awake.acquire()()
    expect(fake.calls).toHaveLength(2)
  })

  test('survives a missing helper binary', () => {
    const fake = fakeSpawner()
    const awake = new KeepAwake({ platform: 'darwin', env: {}, spawn: fake.spawn, registerExitHook: false })
    const release = awake.acquire()
    fake.children[0]!.emit('error', new Error('spawn caffeinate ENOENT'))
    expect(awake.active).toBe(false)
    expect(() => release()).not.toThrow()
  })

  test('spawns nothing when opted out', () => {
    const fake = fakeSpawner()
    const awake = new KeepAwake({ platform: 'darwin', env: { DOXLOOP_KEEP_AWAKE: '0' }, spawn: fake.spawn, registerExitHook: false })
    awake.acquire()()
    expect(fake.calls).toHaveLength(0)
  })
})
