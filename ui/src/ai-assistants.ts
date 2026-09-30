/**
 * Settings → AI assistants: where the AI-readable copies of the site live and
 * the setup each coding assistant needs to reach the local docs MCP server.
 * Pure so the snippets are tested exactly as a person will paste them.
 */

export const DOXLOOP_PACKAGE = '@doxbrix/doxloop'

export interface AssistantSnippet {
  id: 'claude' | 'codex' | 'json'
  label: string
  /** Where the snippet goes, in a few words. */
  where: string
  language: 'bash' | 'toml' | 'json'
  text: string
}

export interface AiReadableFile {
  label: string
  detail: string
  path: string
  /** Present when the site is running or published somewhere Doxloop knows. */
  url?: string
}

/** A server name assistants accept everywhere: lowercase letters, digits, and hyphens. */
export function assistantServerSlug(value: string): string {
  const slug = value
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return slug || 'project'
}

export function assistantSnippets(input: { slug: string; root: string }): AssistantSnippet[] {
  const slug = assistantServerSlug(input.slug)
  // A project slug such as "acme-docs" should not become "acme-docs-docs".
  const name = /(^|-)docs$/.test(slug) ? slug : `${slug}-docs`
  const args = ['-y', DOXLOOP_PACKAGE, 'mcp', '--cwd', input.root]
  return [
    {
      id: 'claude',
      label: 'Claude Code',
      where: 'Run once in a terminal',
      language: 'bash',
      text: `claude mcp add ${name} -- npx ${args.map(shellQuote).join(' ')}`,
    },
    {
      id: 'codex',
      label: 'Codex',
      where: 'Add to ~/.codex/config.toml',
      language: 'toml',
      // JSON strings are valid TOML basic strings, escapes included.
      text: `[mcp_servers.${name.replace(/-/g, '_')}]\ncommand = "npx"\nargs = [${args.map((arg) => JSON.stringify(arg)).join(', ')}]`,
    },
    {
      id: 'json',
      label: 'Cursor and other assistants',
      where: 'Add to .cursor/mcp.json or the assistant\'s MCP settings',
      language: 'json',
      text: JSON.stringify({ mcpServers: { [name]: { command: 'npx', args } } }, null, 2),
    },
  ]
}

/**
 * The files every published site carries. Links need a site that serves them:
 * the running Doxbrix preview, or the last published address.
 */
export function aiReadableFiles(input: { previewUrl?: string | undefined; publishedUrl?: string | undefined; generator: string }): { base?: string; files: AiReadableFile[] } {
  const base = (input.generator === 'doxbrix' && input.previewUrl) || input.publishedUrl
  const at = (path: string): string | undefined => {
    if (!base) return undefined
    try { return new URL(path, base.endsWith('/') ? base : `${base}/`).toString() } catch { return undefined }
  }
  const files: AiReadableFile[] = [
    { label: 'llms.txt', detail: 'An index of every page, in navigation order, for assistants to read first.', path: '/llms.txt' },
    { label: 'llms-full.txt', detail: 'The whole documentation as one Markdown file.', path: '/llms-full.txt' },
    { label: 'Markdown copies', detail: 'Each page is also published as Markdown: add .md to its address.', path: '/<page>.md' },
  ]
  return {
    ...(base ? { base } : {}),
    files: files.map((file) => {
      const url = file.path.includes('<') ? undefined : at(file.path.slice(1))
      return url ? { ...file, url } : file
    }),
  }
}

function shellQuote(value: string): string {
  return /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`
}
