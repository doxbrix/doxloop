import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { scaffoldProject } from './project.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

function runMcp(args: string[], input: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tsx = join(process.cwd(), 'node_modules', 'tsx', 'dist', 'cli.mjs')
  const child = spawn(process.execPath, [tsx, 'src/cli.ts', 'mcp', ...args], { cwd: process.cwd() })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8') })
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8') })
  child.stdin.end(input)
  return new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout, stderr })))
}

describe('mcp CLI', () => {
  test('writes only protocol messages to stdout and exits when stdin closes', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-cli-mcp-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), title: 'CLI docs', sources: [] })
    const input = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } } },
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_page', arguments: { route: '/quickstart' } } },
    ].map((message) => JSON.stringify(message)).join('\n')
    const result = await runMcp(['--cwd', root], `${input}\n`)
    expect(result.code).toBe(0)
    const messages = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { id: number; result: Record<string, unknown> })
    expect(messages.map((message) => message.id)).toEqual([1, 2])
    expect(messages[0]!.result).toMatchObject({ protocolVersion: '2025-06-18', serverInfo: { name: 'doxloop-docs' } })
    expect(JSON.stringify(messages[1]!.result)).toContain('# Quickstart')
    expect(result.stderr).toContain('serving documentation from')
  })

  test('explains a folder that is not a documentation project', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'doxloop-cli-mcp-empty-'))
    roots.push(empty)
    const result = await runMcp(['--cwd', empty], '')
    expect(result.code).toBe(2)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain('No Doxloop documentation project found')
  })
})
