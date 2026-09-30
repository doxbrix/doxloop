import { describe, expect, test } from 'vitest'
import { aiReadableFiles, assistantServerSlug, assistantSnippets } from './ai-assistants'

describe('AI assistant setup', () => {
  test('names the server from the project slug', () => {
    expect(assistantServerSlug('Acme API')).toBe('acme-api')
    expect(assistantServerSlug('  Über Docs!! ')).toBe('uber-docs')
    expect(assistantServerSlug('***')).toBe('project')
    expect(assistantSnippets({ slug: 'acme-docs', root: '/p' })[0]!.text).toContain('claude mcp add acme-docs --')
  })

  test('builds the Claude Code, Codex, and JSON snippets for the absolute project folder', () => {
    const [claude, codex, json] = assistantSnippets({ slug: 'acme', root: '/Users/me/acme docs' })
    expect(claude!.text).toBe("claude mcp add acme-docs -- npx -y @doxbrix/doxloop mcp --cwd '/Users/me/acme docs'")
    expect(codex!.text).toBe('[mcp_servers.acme_docs]\ncommand = "npx"\nargs = ["-y", "@doxbrix/doxloop", "mcp", "--cwd", "/Users/me/acme docs"]')
    expect(JSON.parse(json!.text)).toEqual({ mcpServers: { 'acme-docs': { command: 'npx', args: ['-y', '@doxbrix/doxloop', 'mcp', '--cwd', '/Users/me/acme docs'] } } })
  })

  test('quotes a folder with a single quote for the shell and escapes Windows paths for TOML', () => {
    const [claude, codex] = assistantSnippets({ slug: 'acme', root: "C:\\Docs\\Bob's" })
    expect(claude!.text).toBe("claude mcp add acme-docs -- npx -y @doxbrix/doxloop mcp --cwd 'C:\\Docs\\Bob'\\''s'")
    expect(codex!.text).toContain('"C:\\\\Docs\\\\Bob\'s"')
  })

  test('links the AI-readable files to the Doxbrix preview, else the published site, else shows paths', () => {
    const preview = aiReadableFiles({ generator: 'doxbrix', previewUrl: 'http://127.0.0.1:4321', publishedUrl: 'https://acme.sites.doxbrix.com' })
    expect(preview.files.map((file) => file.url)).toEqual(['http://127.0.0.1:4321/llms.txt', 'http://127.0.0.1:4321/llms-full.txt', undefined])
    const published = aiReadableFiles({ generator: 'mkdocs', previewUrl: 'http://127.0.0.1:8000', publishedUrl: 'https://docs.acme.dev/app' })
    expect(published.files[0]!.url).toBe('https://docs.acme.dev/app/llms.txt')
    const local = aiReadableFiles({ generator: 'doxbrix' })
    expect(local.base).toBeUndefined()
    expect(local.files.map((file) => file.path)).toEqual(['/llms.txt', '/llms-full.txt', '/<page>.md'])
    expect(local.files.every((file) => !file.url)).toBe(true)
  })
})
