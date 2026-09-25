import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { ProjectBusyError, withProjectLock } from './project-lock.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

async function projectWithLock(pid: number): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-lock-'))
  roots.push(root)
  const lock = join(root, '.doxloop', 'locks', 'authoring.lock')
  await mkdir(lock, { recursive: true })
  await writeFile(join(lock, 'owner.json'), JSON.stringify({ pid, token: 'old' }))
  return root
}

describe('project locks', () => {
  test('a lock left by a dead process is taken over even when no wait is allowed', async () => {
    // A process killed mid-run (a UI server restart) leaves its lock behind.
    const root = await projectWithLock(2 ** 22 + 12345)
    await expect(withProjectLock(root, 'authoring', async () => 'ran', 0)).resolves.toBe('ran')
  })

  test('a lock held by a live process still refuses a second operation', async () => {
    const root = await projectWithLock(process.pid)
    await expect(withProjectLock(root, 'authoring', async () => 'ran', 0)).rejects.toBeInstanceOf(ProjectBusyError)
  })
})
