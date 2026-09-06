import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { DoxloopError } from './errors.js'

const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>()
export class ProjectBusyError extends DoxloopError {}

/** Reentrant within one operation; exclusive across UI, CLI and scheduled processes. */
export async function withProjectLock<T>(root: string, name: string, work: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  if (!/^[a-z-]+$/.test(name)) throw new Error('Invalid project lock name')
  const directory = join(await realpath(root), '.doxloop', 'locks')
  const path = join(directory, `${name}.lock`)
  if (heldLocks.getStore()?.has(path)) return work()
  await mkdir(directory, { recursive: true, mode: 0o700 })
  const token = randomUUID()
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      await mkdir(path, { mode: 0o700 })
      try { await writeFile(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, token }), { mode: 0o600 }) }
      catch (error) { await rm(path, { recursive: true, force: true }); throw error }
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (await abandoned(path)) {
        const claim = join(path, 'reaping')
        let claimed = false
        try {
          await mkdir(claim)
          claimed = true
          // Another owner may have acquired the path since our initial observation.
          if (await abandoned(path)) {
            const stale = `${path}.${token}.abandoned`
            await rename(path, stale)
            await rm(stale, { recursive: true, force: true })
            claimed = false
          }
        } catch (cause) {
          if (!['ENOENT', 'EEXIST'].includes((cause as NodeJS.ErrnoException).code ?? '')) throw cause
        } finally { if (claimed) await rm(claim, { recursive: true, force: true }) }
      }
      if (Date.now() >= deadline) throw new ProjectBusyError(`Another ${name} operation is running for this project. Wait for it to finish and retry.`)
      await delay(40)
    }
  }
  try { return await heldLocks.run(new Set([...(heldLocks.getStore() ?? []), path]), work) }
  finally {
    const owner = await readFile(join(path, 'owner.json'), 'utf8').catch(() => '')
    if (owner && JSON.parse(owner).token === token) await rm(path, { recursive: true, force: true })
  }
}

async function abandoned(path: string): Promise<boolean> {
  try {
    const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as { pid?: number }
    if (!Number.isInteger(owner.pid) || owner.pid! <= 0) return false
    try { process.kill(owner.pid!, 0); return false }
    catch (error) { return (error as NodeJS.ErrnoException).code === 'ESRCH' }
  } catch {
    // A creator may not yet have written its owner record. Never steal a new lock.
    return Date.now() - (await stat(path).catch(() => ({ mtimeMs: Date.now() }))).mtimeMs > 60_000
  }
}
