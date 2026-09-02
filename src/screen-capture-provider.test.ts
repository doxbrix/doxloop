import { basename, isAbsolute } from 'node:path'
import { describe, expect, test } from 'vitest'
import { agentArguments } from './author.js'
import {
  claudeCaptureArguments,
  codexCaptureArguments,
  screenCaptureProvider,
} from './screen-capture-provider.js'

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

  test('injects the provider into unattended Codex and Claude runs', () => {
    const provider = { name: 'doxloop_capture' as const, command: '/usr/bin/node', args: ['/pkg/cli.js', '--headless'] }
    const codex = agentArguments('codex', 'prompt', {
      mode: 'create', nonInteractive: true, captureProvider: provider, captureRequired: true,
    })
    expect(codex).toEqual([
      'exec',
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
})
