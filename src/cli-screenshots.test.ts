import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { scaffoldProject } from './project.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

function cli(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const child = spawn(process.execPath, [tsx, 'src/cli.ts', ...args], { cwd: process.cwd() })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })))
}

describe('screenshots CLI', () => {
  // The control center runs `doxloop screenshots check`; the action used to
  // be rejected as an unexpected argument before the command ran.
  test('accepts its action and reports what the check needs', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-cli-shots-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), title: 'CLI docs', sources: [] })
    const result = await cli(['screenshots', 'check', '--cwd', root])
    expect(result.stderr).not.toMatch(/does not accept arguments/)
    expect(result.stderr).toMatch(/application URL/)
    const unknown = await cli(['screenshots', 'bogus', '--cwd', root])
    expect(unknown.stderr).toMatch(/Usage: doxloop screenshots <check\|refresh>/)
  }, 60_000)
})
