import { readFileSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { forwardTerminationSignals, spawnAgentProcess } from './agent-process.js'

const roots: string[] = []
const posix = process.platform !== 'win32'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

/**
 * A fake agent that ignores SIGTERM, starts a helper (standing in for the
 * capture browser), and records both process ids so the test can check they
 * are gone afterwards.
 */
async function stubbornAgent(): Promise<{ script: string; pidFile: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'doxloop-agent-process-'))
  roots.push(directory)
  const pidFile = join(directory, 'pids.json')
  const script = join(directory, 'agent.mjs')
  await writeFile(script, `
import { spawn } from 'node:child_process'
import { writeFileSync } from 'node:fs'
process.on('SIGTERM', () => {})
process.on('SIGINT', () => {})
const helper = spawn(process.execPath, ['-e', 'process.on("SIGTERM", () => {}); setInterval(() => {}, 1000)'], { stdio: 'ignore' })
writeFileSync(${JSON.stringify(pidFile)}, JSON.stringify({ agent: process.pid, helper: helper.pid }))
setInterval(() => {}, 1000)
`)
  await chmod(script, 0o755)
  return { script, pidFile }
}

async function waitFor(condition: () => boolean, timeoutMs = 5_000): Promise<void> {
  const started = Date.now()
  while (!condition()) {
    if (Date.now() - started > timeoutMs) throw new Error('Timed out waiting for the condition.')
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('agent process control', () => {
  test('stops an agent that ignores SIGTERM together with the helper it started', async () => {
    if (!posix) return
    const { script, pidFile } = await stubbornAgent()
    const agent = spawnAgentProcess(process.execPath, [script], { cwd: tmpdir(), stdio: 'ignore', isolate: true })
    expect(agent.isolated).toBe(true)
    let pids: { agent: number; helper: number } | undefined
    await waitFor(() => {
      try {
        pids = JSON.parse(readFileSync(pidFile, 'utf8')) as { agent: number; helper: number }
        return true
      } catch {
        return false
      }
    })
    expect(alive(pids!.helper)).toBe(true)

    const started = Date.now()
    await agent.stop({ graceMs: 300 })
    expect(Date.now() - started).toBeLessThan(5_000)
    const exit = await agent.exited
    expect(exit.signal).toBe('SIGKILL')
    await waitFor(() => !alive(pids!.agent) && !alive(pids!.helper))
  })

  test('resolves at once for an agent that exits politely', async () => {
    if (!posix) return
    const agent = spawnAgentProcess(process.execPath, ['-e', 'process.on("SIGTERM", () => process.exit(0)); process.stdout.write("ready\\n"); setInterval(() => {}, 1000)'], { cwd: tmpdir(), stdio: ['ignore', 'pipe', 'ignore'], isolate: true })
    // Only stop once the handler is installed, or the signal ends the process outright.
    await new Promise<void>((resolveReady) => agent.child.stdout?.once('data', () => resolveReady()))
    await agent.stop({ graceMs: 10_000 })
    await expect(agent.exited).resolves.toMatchObject({ code: 0 })
  })

  test('reports a missing executable instead of hanging', async () => {
    const agent = spawnAgentProcess(join(tmpdir(), 'doxloop-no-such-agent'), [], { cwd: tmpdir(), stdio: 'ignore' })
    const exit = await agent.exited
    expect(exit.error).toBeDefined()
    await expect(agent.stop({ graceMs: 100 })).resolves.toBeUndefined()
  })

  test('forwards a termination signal, cleans up, and exits with the signal status', async () => {
    if (!posix) return
    const { script, pidFile } = await stubbornAgent()
    const agent = spawnAgentProcess(process.execPath, [script], { cwd: tmpdir(), stdio: 'ignore', isolate: true })
    await waitFor(() => { try { readFileSync(pidFile); return true } catch { return false } })
    const pids = JSON.parse(await readFile(pidFile, 'utf8')) as { agent: number; helper: number }
    const log: string[] = []
    let cleaned = false
    const exited = new Promise<number>((resolveExit) => {
      const dispose = forwardTerminationSignals(agent, {
        label: 'the fake agent',
        signals: ['SIGUSR2'],
        graceMs: 300,
        log: (line) => log.push(line),
        onStopped: () => { cleaned = true },
        exit: (code) => { dispose(); resolveExit(code) },
      })
      process.emit('SIGUSR2', 'SIGUSR2')
    })
    // Handlers receive the signal name; SIGUSR2 has no reserved status, so
    // the fallback status is used. SIGTERM would map to 143.
    await expect(exited).resolves.toBe(1)
    expect(cleaned).toBe(true)
    expect(log[0]).toContain('Received SIGUSR2')
    await waitFor(() => !alive(pids.agent) && !alive(pids.helper))
  })
})
