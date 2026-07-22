import {
  chmod,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  agentAuthenticationStatus,
  chooseAgent,
  installSkill,
} from './agents.js'
import { scaffoldProject } from './project.js'

const roots: string[] = []
const originalPath = process.env.PATH

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('agent discovery', () => {
  test('finds an executable installed through a symbolic link', async () => {
    if (process.platform === 'win32') return

    const root = await mkdtemp(join(tmpdir(), 'doxloop-agent-'))
    roots.push(root)
    const target = join(root, 'codex-cli')
    const executable = join(root, 'codex')
    await writeFile(target, '#!/bin/sh\nexit 0\n')
    await chmod(target, 0o755)
    await symlink(target, executable)
    process.env.PATH = root

    await expect(chooseAgent('codex')).resolves.toEqual({
      name: 'codex',
      executable,
    })
  })

  test('installs only the shared and selected generator skills', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-agent-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'docs'),
      sources: [],
      generator: 'mkdocs',
    })

    await installSkill({ root, agent: 'codex' })

    expect(
      await readdir(join(root, '.agents', 'skills')),
    ).toEqual(['doxloop-authoring', 'doxloop-mkdocs'])
  })

  test('reads Claude authentication status without exposing account details', async () => {
    if (process.platform === 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'doxloop-agent-'))
    roots.push(root)
    const executable = join(root, 'claude')
    await writeFile(
      executable,
      '#!/bin/sh\necho \'{"loggedIn":false,"email":"private@example.com"}\'\nexit 0\n',
    )
    await chmod(executable, 0o755)

    await expect(
      agentAuthenticationStatus({ name: 'claude', executable }),
    ).resolves.toEqual({
      status: 'unauthenticated',
      detail: 'Claude Code is not signed in. Run `claude auth login`.',
    })
  })

  test('reports Gemini authentication as unknown without reading credentials', async () => {
    await expect(
      agentAuthenticationStatus({ name: 'gemini', executable: 'gemini' }),
    ).resolves.toMatchObject({ status: 'unknown' })
  })
})
