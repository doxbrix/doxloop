import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test } from 'vitest'
import {
  AGENT_CATALOG,
  agentAuthenticationStatus,
  chooseAgent,
  installAgent,
  installSkill,
} from './agents.js'
import { selectAgentInteractive } from './interactive.js'
import { scaffoldProject } from './project.js'
import type { PromptIo } from './prompts.js'

const roots: string[] = []
const originalPath = process.env.PATH
const originalCodexOverride = process.env.DOXLOOP_AGENT_EXECUTABLE_CODEX

function fakeIo(lines: string[]): PromptIo & { rendered: () => string } {
  const input = new PassThrough()
  const output = new PassThrough()
  let rendered = ''
  output.on('data', (chunk: Buffer) => {
    rendered += chunk.toString('utf8')
  })
  setImmediate(() => {
    for (const line of lines) input.write(`${line}\n`)
  })
  return { input, output, rendered: () => rendered }
}

afterEach(async () => {
  if (originalPath === undefined) delete process.env.PATH
  else process.env.PATH = originalPath
  if (originalCodexOverride === undefined) delete process.env.DOXLOOP_AGENT_EXECUTABLE_CODEX
  else process.env.DOXLOOP_AGENT_EXECUTABLE_CODEX = originalCodexOverride
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('agent discovery', () => {
  test('uses the official npm package for every supported agent', () => {
    expect(
      AGENT_CATALOG.map(({ name, packageName }) => ({ name, packageName })),
    ).toEqual([
      { name: 'codex', packageName: '@openai/codex' },
      { name: 'claude', packageName: '@anthropic-ai/claude-code' },
      { name: 'gemini', packageName: '@google/gemini-cli' },
    ])
  })

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

  test('uses the test-only executable override before PATH', async () => {
    if (process.platform === 'win32') return

    const root = await mkdtemp(join(tmpdir(), 'doxloop-agent-'))
    roots.push(root)
    const executable = join(root, 'fake-codex')
    await writeFile(executable, '#!/bin/sh\nexit 0\n')
    await chmod(executable, 0o755)
    process.env.DOXLOOP_AGENT_EXECUTABLE_CODEX = executable
    process.env.PATH = ''

    await expect(chooseAgent('codex')).resolves.toEqual({ name: 'codex', executable })
  })

  test('installs an agent through its official npm package', async () => {
    if (process.platform === 'win32') return

    const root = await mkdtemp(join(tmpdir(), 'doxloop-agent-'))
    roots.push(root)
    const npm = join(root, 'npm')
    const executable = join(root, 'claude')
    const calls = join(root, 'npm-args')
    await writeFile(
      npm,
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${calls}"\nprintf '#!/bin/sh\\nexit 0\\n' > "${executable}"\n/bin/chmod +x "${executable}"\n`,
    )
    await chmod(npm, 0o755)
    process.env.PATH = root

    await expect(installAgent('claude')).resolves.toEqual({
      name: 'claude',
      executable,
    })
    await expect(readFile(calls, 'utf8')).resolves.toBe(
      'install\n--global\n@anthropic-ai/claude-code\n',
    )
  })

  test('shows every agent and installs a missing selection', async () => {
    if (process.platform === 'win32') return

    const root = await mkdtemp(join(tmpdir(), 'doxloop-agent-'))
    roots.push(root)
    const codex = join(root, 'codex')
    const claude = join(root, 'claude')
    const npm = join(root, 'npm')
    await writeFile(codex, '#!/bin/sh\nexit 0\n')
    await writeFile(
      npm,
      `#!/bin/sh\nprintf '#!/bin/sh\\nexit 0\\n' > "${claude}"\n/bin/chmod +x "${claude}"\n`,
    )
    await Promise.all([chmod(codex, 0o755), chmod(npm, 0o755)])
    process.env.PATH = root
    const io = fakeIo(['2'])

    await expect(selectAgentInteractive(io)).resolves.toBe('claude')
    expect(io.rendered()).toContain('Codex  installed')
    expect(io.rendered()).toContain('Claude Code  not installed · will install')
    expect(io.rendered()).toContain('Gemini  not installed · will install')
    expect(io.rendered()).toContain('✓ Claude Code installed.')
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

  test('reads Gemini sign-in from the environment or the token file without exposing either', async () => {
    const home = await mkdtemp(join(tmpdir(), 'doxloop-gemini-home-'))
    roots.push(home)
    const gemini = { name: 'gemini' as const, executable: 'gemini' }

    await expect(agentAuthenticationStatus(gemini, { env: {}, home })).resolves.toEqual({
      status: 'unauthenticated',
      detail: 'Gemini is not signed in. Run `gemini` once in a terminal and complete the sign-in, or set GEMINI_API_KEY.',
    })
    await expect(agentAuthenticationStatus(gemini, { env: { GEMINI_API_KEY: 'secret-key' }, home })).resolves.toEqual({
      status: 'authenticated',
      detail: 'Gemini uses the API key from the environment.',
    })
    await expect(agentAuthenticationStatus(gemini, { env: { GOOGLE_GENAI_USE_VERTEXAI: 'true', GOOGLE_CLOUD_PROJECT: 'acme' }, home })).resolves.toMatchObject({ status: 'authenticated' })
    await expect(agentAuthenticationStatus(gemini, { env: { GOOGLE_GENAI_USE_VERTEXAI: 'true' }, home })).resolves.toMatchObject({ status: 'unauthenticated' })

    await mkdir(join(home, '.gemini'), { recursive: true })
    await writeFile(join(home, '.gemini', 'oauth_creds.json'), JSON.stringify({ access_token: 'ya29.secret', refresh_token: '1//secret' }), 'utf8')
    const signedIn = await agentAuthenticationStatus(gemini, { env: {}, home })
    expect(signedIn).toEqual({ status: 'authenticated', detail: 'Gemini is signed in with a Google account.' })
    expect(JSON.stringify(signedIn)).not.toContain('secret')

    await writeFile(join(home, '.gemini', 'oauth_creds.json'), 'not json', 'utf8')
    await expect(agentAuthenticationStatus(gemini, { env: {}, home })).resolves.toMatchObject({ status: 'unauthenticated' })
  })
})
