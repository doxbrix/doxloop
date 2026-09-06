import { execFile } from 'node:child_process'
import { cp, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'

const execute = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function runCli(cwd: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const home = await mkdtemp(join(tmpdir(), 'doxloop-cli-home-'))
  roots.push(home)
  return execute(process.execPath, [tsx, join(process.cwd(), 'src', 'cli.ts'), ...args], {
    cwd,
    env: { ...process.env, DOXLOOP_HOME: home },
  })
}

describe('init --existing', () => {
  test('adopts the current folder and reports what it found', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-cli-existing-'))
    roots.push(parent)
    const root = join(parent, 'site')
    await cp(join(process.cwd(), 'evals', 'fixtures', 'cli', 'project'), root, { recursive: true })
    await rm(join(root, '.doxloop'), { recursive: true, force: true })
    const pageBefore = await readFile(join(root, 'docs', 'index.md'), 'utf8')

    const { stdout } = await runCli(root, 'init', '--existing')
    // The CLI resolves the folder from the process working directory, which macOS reports without its /var symlink.
    expect(stdout).toContain(`Imported existing documentation at ${await realpath(root)}`)
    expect(stdout).toContain('Generator: Doxbrix')
    expect(stdout).toContain('Content directory: docs')
    expect(stdout).toContain('No page was changed.')
    expect(stdout).toContain('doxloop ui --project')
    expect(await readFile(join(root, 'docs', 'index.md'), 'utf8')).toBe(pageBefore)
    expect(JSON.parse(await readFile(join(root, '.doxloop', 'project.json'), 'utf8'))).toMatchObject({ generator: 'doxbrix', contentDir: 'docs' })
  })

  test('rejects source flags and unknown folders', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-cli-existing-'))
    roots.push(parent)
    await expect(runCli(parent, 'init', '--existing', '--source', 'app=../app')).rejects.toMatchObject({
      stderr: expect.stringContaining('adopts the folder as it is'),
    })
    await expect(runCli(parent, 'init', '--existing', 'missing-folder')).rejects.toMatchObject({
      stderr: expect.stringContaining('does not exist'),
    })
  })
})
