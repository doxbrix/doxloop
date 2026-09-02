import {
  chmod,
  mkdir,
  mkdtemp,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { installSkill } from './agents.js'
import { formatDoctorReport, runDoctor } from './doctor.js'
import { scaffoldProject } from './project.js'

const roots: string[] = []
const originalPath = process.env.PATH

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  )
})

describe('doctor', () => {
  test('checks a safe new-project layout and authenticated agent', async () => {
    if (process.platform === 'win32') return
    const parent = await fixture()
    await mkdir(join(parent, 'product'))
    await fakeCodex(parent, true)

    const report = await runDoctor({
      cwd: parent,
      source: './product',
      output: './docs',
      agent: 'codex',
    })

    expect(report.ready).toBe(true)
    expect(report.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'pass',
          label: 'Product source found',
        }),
        expect.objectContaining({
          status: 'pass',
          label: 'Documentation output is separate and available',
        }),
        expect.objectContaining({ status: 'pass', label: 'Codex is signed in' }),
      ]),
    )
    expect(formatDoctorReport(report)).toContain('Doxloop is ready.')
  })

  test('reports an unsafe nested documentation project', async () => {
    if (process.platform === 'win32') return
    const parent = await fixture()
    await mkdir(join(parent, 'product'))
    await fakeCodex(parent, true)

    const report = await runDoctor({
      cwd: parent,
      source: './product',
      output: './product/docs',
      agent: 'codex',
    })

    expect(report.ready).toBe(false)
    expect(formatDoctorReport(report)).toContain('must be separate directories')
  })

  test('reports an agent that is installed but not authenticated', async () => {
    if (process.platform === 'win32') return
    const parent = await fixture()
    await mkdir(join(parent, 'product'))
    await fakeCodex(parent, false)

    const report = await runDoctor({
      cwd: parent,
      source: './product',
      output: './docs',
      agent: 'codex',
    })

    expect(report.ready).toBe(false)
    expect(formatDoctorReport(report)).toContain('Run `codex login`')
  })

  test('checks an existing documentation project end to end', async () => {
    if (process.platform === 'win32') return
    const parent = await fixture()
    await mkdir(join(parent, 'product'))
    const root = await scaffoldProject({
      directory: join(parent, 'docs'),
      sources: [{ name: 'product', path: '../product' }],
    })
    await installSkill({ root, agent: 'codex' })
    await writeFile(
      join(root, 'index.mdx'),
      '---\ntitle: Overview\ndescription: Understand the product.\n---\n\n# Overview\n\nChoose a workflow.\n',
    )
    await writeFile(
      join(root, 'quickstart.mdx'),
      '---\ntitle: Quickstart\ndescription: Complete the first workflow.\n---\n\n# Quickstart\n\nComplete the first workflow and verify the result.\n',
    )
    await fakeCodex(parent, true)

    const report = await runDoctor({ cwd: root, agent: 'codex' })

    expect(report.ready).toBe(true)
    expect(formatDoctorReport(report)).toContain('Codex project skills are ready')
    expect(formatDoctorReport(report)).toContain('Doxbrix generator is ready')
    expect(formatDoctorReport(report)).toContain('2 documentation pages checked')
  })
})

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-doctor-'))
  roots.push(root)
  return root
}

async function fakeCodex(root: string, authenticated: boolean): Promise<void> {
  const executable = join(root, 'codex')
  await writeFile(
    executable,
    `#!/bin/sh\n${authenticated ? 'echo "Logged in"\nexit 0' : 'exit 1'}\n`,
  )
  await chmod(executable, 0o755)
  process.env.PATH = root
}
