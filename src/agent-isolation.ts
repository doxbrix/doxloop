/**
 * Doxloop sessions run with Doxloop's own tools only. The user's personal
 * agent setup (computer-use plugins, browser REPLs, chat connectors) is for
 * their own work: a research session that reached for a global `cua_repl`
 * plugin failed repeatedly instead of using the capture browser Doxloop gave
 * it. The agent's sign-in, model defaults, and skills are left alone.
 *
 * Claude Code: `--strict-mcp-config` loads only the servers passed with
 * `--mcp-config` (the capture browser, when the run has one).
 * Codex: `--disable plugins` and `--disable apps` turn off plugin- and
 * app-provided tools, and every MCP server in the user's (and the project's)
 * config.toml is switched off with `-c mcp_servers.<name>.enabled=false`.
 * A dedicated CODEX_HOME would lose the user's login, so it is not used.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const CLAUDE_ISOLATION_ARGUMENTS = ['--strict-mcp-config'] as const

/** Codex feature flags (see `codex features list`) that bring in the user's plugins and connectors. */
export const CODEX_DISABLED_FEATURES = ['plugins', 'apps'] as const

/** MCP server names declared in a Codex config.toml, as `[mcp_servers.<name>]` tables or inline entries. */
export function codexConfigMcpServerNames(toml: string): string[] {
  const names = new Set<string>()
  let inServersTable = false
  for (const rawLine of toml.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const table = /^\[\s*mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))/.exec(line)
    if (table) {
      names.add(table[1] ?? table[2] ?? table[3]!)
      inServersTable = false
      continue
    }
    if (line.startsWith('[')) {
      inServersTable = /^\[\s*mcp_servers\s*\]$/.test(line)
      continue
    }
    const dotted = /^mcp_servers\s*\.\s*(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*[.=]/.exec(line)
    if (dotted) {
      names.add(dotted[1] ?? dotted[2] ?? dotted[3]!)
      continue
    }
    if (inServersTable) {
      const entry = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*[.=]/.exec(line)
      if (entry) names.add(entry[1] ?? entry[2] ?? entry[3]!)
    }
  }
  return [...names]
}

/**
 * MCP servers the user configured for Codex: `$CODEX_HOME/config.toml`
 * (default `~/.codex`) and the project's own `.codex/config.toml`. Unreadable
 * files contribute nothing.
 */
export async function codexUserMcpServers(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<string[]> {
  const home = env.CODEX_HOME?.trim() || join(homedir(), '.codex')
  const names = new Set<string>()
  for (const file of [join(home, 'config.toml'), join(cwd, '.codex', 'config.toml')]) {
    try {
      for (const name of codexConfigMcpServerNames(await readFile(file, 'utf8'))) names.add(name)
    } catch {
      // No config there.
    }
  }
  return [...names].sort()
}

/**
 * Codex's `-c` dotted paths take bare keys only (a quoted key is read as a
 * new server named with the quotes), so a name outside [A-Za-z0-9_-] cannot
 * be switched off from the command line and is left as it is.
 */
function overridableServerName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name)
}

/**
 * Codex `exec` options that switch off the user's plugins, connectors, and
 * MCP servers, keeping only `keep` (Doxloop's capture server).
 */
export function codexIsolationArguments(userServers: readonly string[] = [], keep: readonly string[] = []): string[] {
  const args: string[] = []
  for (const feature of CODEX_DISABLED_FEATURES) args.push('--disable', feature)
  for (const name of userServers) {
    if (keep.includes(name) || !overridableServerName(name)) continue
    args.push('-c', `mcp_servers.${name}.enabled=false`)
  }
  return args
}
