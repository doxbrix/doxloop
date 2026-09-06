import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, test } from 'vitest'
import { scaffoldProject } from './project.js'

const execute = promisify(execFile)
const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function runPages(...args: string[]): Promise<{ stdout: string; stderr: string }> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-cli-pages-'))
  roots.push(parent)
  const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  return execute(process.execPath, [tsx, 'src/cli.ts', 'pages', 'edit', '--cwd', root, ...args], { cwd: process.cwd() })
}

describe('pages CLI', () => {
  test('requires a selected page', async () => {
    await expect(runPages('--request', 'Clarify the introduction.')).rejects.toMatchObject({
      stderr: expect.stringContaining('pages edit requires at least one --path <page>.'),
    })
  })

  test('requires an edit instruction', async () => {
    await expect(runPages('--path', 'index.mdx')).rejects.toMatchObject({
      stderr: expect.stringContaining('pages edit requires --request <instruction>.'),
    })
  })
})
