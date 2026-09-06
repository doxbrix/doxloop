import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, isAbsolute, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { agentArguments } from './author.js'
import {
  claudeCaptureArguments,
  codexCaptureArguments,
  geminiCaptureServer,
  screenCaptureProvider,
  writeGeminiCaptureSettings,
} from './screen-capture-provider.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('screen capture provider', () => {
  test('creates a workspace-scoped Playwright MCP command', () => {
    const provider = screenCaptureProvider('/tmp/doxloop-capture', {
      baseUrl: 'http://127.0.0.1:4317',
      screenshots: { policy: 'auto', viewport: { width: 1280, height: 800 } },
    })

    expect(isAbsolute(provider.command)).toBe(true)
    expect(basename(provider.args[0]!)).toBe('cli.js')
    expect(provider.args).toContain('--headless')
    expect(provider.args).toContain('chrome')
    expect(provider.args).toContain('/tmp/doxloop-capture/.doxloop/capture-output')
    expect(provider.args).toContain('1280x800')
  })

  test('passes a recorded session and saved credentials to the capture server', () => {
    const application = { baseUrl: 'http://127.0.0.1:4317' }
    expect(screenCaptureProvider('/tmp/doxloop-capture', application).args).not.toContain('--storage-state')
    const provider = screenCaptureProvider('/tmp/doxloop-capture', application, {
      storageStatePath: '/home/user/.config/doxloop/capture-auth/abc/storage-state.json',
      secretsPath: '/home/user/.config/doxloop/capture-auth/abc/secrets-1.env',
    })
    const args = provider.args
    expect(args[args.indexOf('--storage-state') + 1]).toBe('/home/user/.config/doxloop/capture-auth/abc/storage-state.json')
    expect(args[args.indexOf('--secrets') + 1]).toBe('/home/user/.config/doxloop/capture-auth/abc/secrets-1.env')
    // The isolated profile is what the storage state seeds.
    expect(args).toContain('--isolated')
  })

  test('injects the provider into unattended Codex and Claude runs', () => {
    const provider = { name: 'doxloop_capture' as const, command: '/usr/bin/node', args: ['/pkg/cli.js', '--headless'] }
    const codex = agentArguments('codex', 'prompt', {
      mode: 'create', nonInteractive: true, captureProvider: provider, captureRequired: true,
    })
    expect(codex).toEqual([
      'exec',
      '--json',
      ...codexCaptureArguments(provider, true),
      '--sandbox', 'workspace-write', '--skip-git-repo-check', 'prompt',
    ])
    expect(codex).toContain('mcp_servers.doxloop_capture.default_tools_approval_mode="approve"')

    const claude = agentArguments('claude', 'prompt', {
      mode: 'create', nonInteractive: true, captureProvider: provider,
    })
    expect(claude).toContain('--mcp-config')
    expect(claude).toContain(claudeCaptureArguments(provider)[1])
    expect(claude).toContain('mcp__doxloop_capture__*')
  })

  test('makes the capture browser available to read-only planning agents', () => {
    const provider = { name: 'doxloop_capture' as const, command: '/usr/bin/node', args: ['/pkg/cli.js', '--headless'] }
    const codex = agentArguments('codex', 'plan', { mode: 'review', captureProvider: provider, captureRequired: true })
    expect(codex).toContain('mcp_servers.doxloop_capture.default_tools_approval_mode="approve"')
    expect(codex).toContain('mcp_servers.doxloop_capture.required=true')

    const claude = agentArguments('claude', 'plan', { mode: 'review', captureProvider: provider })
    expect(claude).toContain('--allowedTools')
    expect(claude).toContain('mcp__doxloop_capture__*')
  })

  test('merges the capture browser into the workspace Gemini settings without losing other settings', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-gemini-settings-'))
    roots.push(root)
    await mkdir(join(root, '.gemini'), { recursive: true })
    await writeFile(join(root, '.gemini', 'settings.json'), JSON.stringify({ theme: 'Dracula', mcpServers: { other: { command: 'other' } } }), 'utf8')
    const provider = { name: 'doxloop_capture' as const, command: '/usr/bin/node', args: ['/pkg/cli.js', '--headless'] }

    const path = await writeGeminiCaptureSettings(root, provider)

    expect(path).toBe(join(root, '.gemini', 'settings.json'))
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({
      theme: 'Dracula',
      mcpServers: {
        other: { command: 'other' },
        doxloop_capture: geminiCaptureServer(provider),
      },
    })
    expect(geminiCaptureServer(provider)).toMatchObject({ command: '/usr/bin/node', args: ['/pkg/cli.js', '--headless'], trust: true })

    // A workspace without settings yet gets a fresh file.
    const fresh = await mkdtemp(join(tmpdir(), 'doxloop-gemini-fresh-'))
    roots.push(fresh)
    await writeGeminiCaptureSettings(fresh, provider)
    expect(JSON.parse(await readFile(join(fresh, '.gemini', 'settings.json'), 'utf8'))).toEqual({ mcpServers: { doxloop_capture: geminiCaptureServer(provider) } })
  })
})
