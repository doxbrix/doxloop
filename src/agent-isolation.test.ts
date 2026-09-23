import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { codexConfigMcpServerNames, codexIsolationArguments, codexUserMcpServers } from './agent-isolation.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('codex isolation', () => {
  test('reads MCP server names from every config.toml form', () => {
    const toml = `
model = "gpt"
[mcp_servers.node_repl]
command = "/Applications/node_repl"
[mcp_servers.node_repl.env]
A = "1"
[mcp_servers."computer-use"]
command = "x"
mcp_servers.inline.command = "y"
[mcp_servers]
tabled = { command = "z" }
[projects."/tmp/mcp_servers.fake"]
trust_level = "trusted"
`
    expect(codexConfigMcpServerNames(toml).sort()).toEqual(['computer-use', 'inline', 'node_repl', 'tabled'])
  })

  test('merges the user and project configs', async () => {
    const home = await mkdtemp(join(tmpdir(), 'doxloop-codex-home-'))
    const project = await mkdtemp(join(tmpdir(), 'doxloop-codex-project-'))
    roots.push(home, project)
    await writeFile(join(home, 'config.toml'), '[mcp_servers.node_repl]\ncommand = "a"\n')
    await mkdir(join(project, '.codex'))
    await writeFile(join(project, '.codex', 'config.toml'), '[mcp_servers.project_tool]\ncommand = "b"\n')
    await expect(codexUserMcpServers(project, { CODEX_HOME: home })).resolves.toEqual(['node_repl', 'project_tool'])
    await expect(codexUserMcpServers(join(project, 'missing'), { CODEX_HOME: join(home, 'missing') })).resolves.toEqual([])
  })

  test('disables plugins, apps, and every user server except the kept ones', () => {
    expect(codexIsolationArguments(['node_repl', 'doxloop_capture'], ['doxloop_capture'])).toEqual([
      '--disable', 'plugins', '--disable', 'apps', '-c', 'mcp_servers.node_repl.enabled=false',
    ])
    expect(codexIsolationArguments()).toEqual(['--disable', 'plugins', '--disable', 'apps'])
  })
})
