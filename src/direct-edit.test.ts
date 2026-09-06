import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { applyDirectEdit, listDirectEdits, undoDirectEdit } from './direct-edit.js'
import { scaffoldProject } from './project.js'
import { withProjectLock, ProjectBusyError } from './project-lock.js'

const parents: string[] = []
afterEach(async () => { await Promise.all(parents.splice(0).map((path) => rm(path, { recursive: true, force: true }))) })
async function fixture() {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-direct-'))
  parents.push(parent)
  return scaffoldProject({ directory: join(parent, 'docs'), title: 'Direct edits', sources: [], generator: 'doxbrix' })
}

test('restores earlier writes and removes created files when a later write fails', async () => {
  const root = await fixture()
  const path = join(root, 'index.mdx')
  const original = await readFile(path, 'utf8')
  await expect(applyDirectEdit(root, { kind: 'edit', requestText: 'Failure injection', files: ['index.mdx', 'new.txt'], apply: async () => {
    await writeFile(path, 'partial')
    await writeFile(join(root, 'new.txt'), 'created')
    throw new Error('second write failed')
  } })).rejects.toThrow('second write failed')
  expect(await readFile(path, 'utf8')).toBe(original)
  await expect(readFile(join(root, 'new.txt'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await listDirectEdits(root))[0]?.status).toBe('rolled-back')
})

test('persists undo snapshots and refuses undo after an external edit', async () => {
  const root = await fixture()
  const path = join(root, 'index.mdx')
  const original = await readFile(path, 'utf8')
  const next = original.replace('Direct edits', 'Edited title')
  const result = await applyDirectEdit(root, { kind: 'edit', requestText: 'Change title', files: ['index.mdx'], apply: () => writeFile(path, next) })
  await writeFile(path, `${next}\nExternal wording.\n`)
  await expect(undoDirectEdit(root, result.editId)).rejects.toThrow('without overwriting')
  expect(await readFile(path, 'utf8')).toContain('External wording')
  await writeFile(path, next)
  await undoDirectEdit(root, result.editId)
  expect(await readFile(path, 'utf8')).toBe(original)
})

test('serializes separate operations while allowing nested mutations', async () => {
  const root = await fixture()
  let release!: () => void
  let entered!: () => void
  const ready = new Promise<void>((resolve) => { entered = resolve })
  const running = withProjectLock(root, 'write', async () => {
    await withProjectLock(root, 'write', async () => undefined)
    entered()
    await new Promise<void>((resolve) => { release = resolve })
  })
  await ready
  await expect(withProjectLock(root, 'write', async () => undefined, 0)).rejects.toBeInstanceOf(ProjectBusyError)
  release()
  await running
  await withProjectLock(root, 'write', async () => undefined, 0)
})

test('attempts every rollback and preserves a recovery journal if one path cannot be restored safely', async () => {
  const root = await fixture()
  const { symlink } = await import('node:fs/promises')
  const original = await readFile(join(root, 'index.mdx'), 'utf8')
  await writeFile(join(root, 'second.txt'), 'before')
  await writeFile(join(root, 'protected.txt'), 'untouched')
  await expect(applyDirectEdit(root, { kind: 'edit', requestText: 'Rollback safety', files: ['second.txt', 'index.mdx'], apply: async () => {
    await writeFile(join(root, 'index.mdx'), 'partial')
    await rm(join(root, 'second.txt'))
    await symlink(join(root, 'protected.txt'), join(root, 'second.txt'))
    throw new Error('interrupted')
  } })).rejects.toThrow('rollback needs recovery')
  expect(await readFile(join(root, 'index.mdx'), 'utf8')).toBe(original)
  expect(await readFile(join(root, 'protected.txt'), 'utf8')).toBe('untouched')
  const record = (await listDirectEdits(root))[0]!
  expect(record.status).toBe('recovery-required')
  expect(JSON.parse(await readFile(join(root, '.doxloop/direct-edits', `${record.id}.json`), 'utf8')).before['second.txt']).toBe(Buffer.from('before').toString('base64'))
})
