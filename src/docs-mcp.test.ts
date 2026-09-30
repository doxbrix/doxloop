import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, test } from 'vitest'
import { createDocsMcpHandler, startDocsMcpServer, type JsonRpcResponse } from './docs-mcp.js'
import { scaffoldProject } from './project.js'
import { VERSION } from './version.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-mcp-'))
  roots.push(parent)
  const root = await scaffoldProject({ directory: join(parent, 'docs'), title: 'Acme', sources: [] })
  const config = JSON.parse(await readFile(join(root, 'docs.json'), 'utf8'))
  config.spaces = [{ name: 'Docs', nav: [
    { type: 'group', label: 'Get started', items: [{ type: 'page', file: 'index' }, { type: 'page', file: 'quickstart' }] },
    { type: 'group', label: 'Security', items: [{ type: 'page', file: 'guides/api-keys' }] },
  ] }]
  await writeFile(join(root, 'docs.json'), JSON.stringify(config))
  await mkdir(join(root, 'guides'), { recursive: true })
  await writeFile(join(root, 'index.mdx'), '---\ntitle: Overview\ndescription: What Acme does.\n---\n\nAcme sends messages between services.\n')
  await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: Quickstart\ndescription: Send the first message.\n---\n\nCreate an API key in the dashboard, then send a message with the CLI.\n')
  await writeFile(join(root, 'guides', 'api-keys.mdx'), '---\ntitle: Rotate API keys\ndescription: Replace a leaked key.\n---\n\n## Rotating keys\n\n<Warning>Rotating a key revokes the old one immediately.</Warning>\n\nOpen Settings, choose API keys, and select Rotate.\n')
  return root
}

function call(id: number, name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }
}

function text(response: JsonRpcResponse | undefined): string {
  return ((response?.result as { content: Array<{ text: string }> }).content[0]!).text
}

describe('docs MCP server', () => {
  test('negotiates the protocol version and describes itself', async () => {
    const handle = createDocsMcpHandler(await fixture())
    const known = await handle({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } })
    expect(known).toMatchObject({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'doxloop-docs', version: VERSION } } })
    expect((known!.result as { instructions: string }).instructions).toContain('"Acme" documentation (3 pages)')
    const future = await handle({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '2099-01-01' } })
    expect(future!.result).toMatchObject({ protocolVersion: '2025-06-18' })
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined()
    expect(await handle({ jsonrpc: '2.0', id: 3, method: 'ping' })).toEqual({ jsonrpc: '2.0', id: 3, result: {} })
  })

  test('lists the three read-only tools', async () => {
    const handle = createDocsMcpHandler(await fixture())
    const response = await handle({ jsonrpc: '2.0', id: 'tools', method: 'tools/list' })
    const tools = (response!.result as { tools: Array<{ name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }> }).tools
    expect(tools.map((tool) => tool.name)).toEqual(['search_docs', 'get_page', 'list_pages'])
    expect(tools.every((tool) => tool.inputSchema.type === 'object' && tool.annotations.readOnlyHint)).toBe(true)
  })

  test('lists pages by section and filters to one section', async () => {
    const handle = createDocsMcpHandler(await fixture())
    const all = text(await handle(call(1, 'list_pages')))
    expect(all).toContain('## Get started\n\n- Overview (/): What Acme does.\n- Quickstart (/quickstart): Send the first message.')
    expect(all).toContain('## Security\n\n- Rotate API keys (/guides/api-keys): Replace a leaked key.')
    const security = text(await handle(call(2, 'list_pages', { section: 'security' })))
    expect(security).not.toContain('Quickstart')
    const missing = await handle(call(3, 'list_pages', { section: 'Billing' }))
    expect(missing!.result).toMatchObject({ isError: true })
  })

  test('ranks a page named after the query first and shows a snippet around the match', async () => {
    const handle = createDocsMcpHandler(await fixture())
    const results = text(await handle(call(1, 'search_docs', { query: 'rotate API key' })))
    expect(results.split('\n')[0]).toBe('1. Rotate API keys (/guides/api-keys) · Security')
    expect(results.split('\n')[1]).toMatch(/Rotating a key revokes the old one immediately\.|select Rotate\./)
    expect(results).toContain('2. Quickstart (/quickstart)')
    const limited = text(await handle(call(2, 'search_docs', { query: 'message', limit: 1 })))
    expect(limited).not.toContain('2.')
    expect(text(await handle(call(3, 'search_docs', { query: 'kubernetes' })))).toContain('No pages match')
  })

  test('reads a page as clean Markdown by route, URL, or source path', async () => {
    const root = await fixture()
    const handle = createDocsMcpHandler(root)
    const page = text(await handle(call(1, 'get_page', { route: '/guides/api-keys' })))
    expect(page).toBe('# Rotate API keys\n\nRoute: /guides/api-keys\nSource: guides/api-keys.mdx\n\n> Replace a leaked key.\n\n## Rotating keys\n\n> **Warning:** Rotating a key revokes the old one immediately.\n\nOpen Settings, choose API keys, and select Rotate.\n')
    expect(text(await handle(call(2, 'get_page', { route: 'https://docs.acme.dev/guides/api-keys.md' })))).toContain('# Rotate API keys')
    expect(text(await handle(call(3, 'get_page', { path: 'quickstart.mdx' })))).toContain('Route: /quickstart')
    expect(text(await handle(call(4, 'get_page', { route: '/' })))).toContain('# Overview')
    expect((await handle(call(5, 'get_page', { route: '/nope' })))!.result).toMatchObject({ isError: true })

    // Edits on disk are picked up by the next call.
    await writeFile(join(root, 'quickstart.mdx'), '---\ntitle: Quickstart\n---\n\nUpdated steps.\n')
    await utimes(join(root, 'quickstart.mdx'), new Date(), new Date(Date.now() + 5_000))
    expect(text(await handle(call(6, 'get_page', { route: '/quickstart' })))).toContain('Updated steps.')
  })

  test('answers protocol errors with JSON-RPC error codes', async () => {
    const handle = createDocsMcpHandler(await fixture())
    expect(await handle({ jsonrpc: '2.0', id: 1, method: 'resources/list' })).toMatchObject({ id: 1, error: { code: -32601 } })
    expect(await handle(call(2, 'delete_page'))).toMatchObject({ id: 2, error: { code: -32602 } })
    expect(await handle(call(3, 'search_docs', {}))).toMatchObject({ id: 3, error: { code: -32602 } })
    expect(await handle(call(4, 'search_docs', { query: 'key', limit: 500 }))).toMatchObject({ id: 4, error: { code: -32602 } })
    expect(await handle(call(5, 'get_page', {}))).toMatchObject({ id: 5, error: { code: -32602 } })
    expect(await handle({ id: 6, method: 'ping' })).toMatchObject({ id: 6, error: { code: -32600 } })
  })

  test('speaks newline-delimited JSON over streams and writes nothing else to the output', async () => {
    const root = await fixture()
    const input = new PassThrough()
    const output = new PassThrough()
    const chunks: string[] = []
    output.on('data', (chunk: Buffer) => chunks.push(chunk.toString('utf8')))
    const served = startDocsMcpServer(root, { input, output })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } })}\n`)
    input.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    input.write('not json\n')
    input.end(`${JSON.stringify(call(2, 'search_docs', { query: 'quickstart' }))}\n`)
    await served
    const messages = chunks.join('').trim().split('\n').map((line) => JSON.parse(line) as JsonRpcResponse)
    expect(messages.map((message) => message.id)).toEqual([1, null, 2])
    expect(messages[1]).toMatchObject({ error: { code: -32700 } })
    expect(text(messages[2])).toContain('Quickstart (/quickstart)')
  })
})
