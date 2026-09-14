/**
 * Minimal frontmatter reader/writer for the CLI's lint + bundle steps. Handles
 * the common YAML subset Doxbrix page files use: `key: value`, quoted strings,
 * booleans, numbers, inline `[a, b]` arrays, and `-` list items. The SERVER
 * re-parses authoritatively on push (`gitFileToPage`), so this only needs to be
 * good enough for local validation and display.
 */

export interface ParsedFrontmatter {
  data: Record<string, unknown>
  body: string
}

const FRONTMATTER_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?/

export function parseFrontmatter(source: string): ParsedFrontmatter {
  const match = FRONTMATTER_RE.exec(source)
  if (!match) return { data: {}, body: source.replace(/^﻿/, '') }
  const data = parseYamlSubset(match[1] ?? '')
  return { data, body: source.slice(match[0].length) }
}

export function serializeFrontmatter(data: Record<string, unknown>, body: string): string {
  const entries = Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (entries.length === 0) return body
  const lines = entries.map(([key, value]) => `${key}: ${serializeValue(value)}`)
  return `---\n${lines.join('\n')}\n---\n${body}`
}

function serializeValue(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((v) => serializeScalar(v)).join(', ')}]`
  return serializeScalar(value)
}

function serializeScalar(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'number') return String(value)
  const s = String(value)
  return /[:#\[\]{}]|^\s|\s$/.test(s) ? JSON.stringify(s) : s
}

function parseYamlSubset(block: string): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  const lines = block.split(/\r?\n/)
  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    i++
    if (!line.trim() || line.trimStart().startsWith('#')) continue
    const m = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!m) continue
    const key = m[1]!
    const rest = (m[2] ?? '').trim()
    if (rest === '') {
      // Possibly a `-` list on following indented lines.
      const items: string[] = []
      while (i < lines.length && /^\s*-\s+/.test(lines[i]!)) {
        items.push(coerceScalar(lines[i]!.replace(/^\s*-\s+/, '').trim()) as string)
        i++
      }
      out[key] = items.length ? items : ''
    } else if (rest.startsWith('[') && rest.endsWith(']')) {
      out[key] = rest
        .slice(1, -1)
        .split(',')
        .map((s) => coerceScalar(s.trim()))
        .filter((s) => s !== '')
    } else {
      out[key] = coerceScalar(rest)
    }
  }
  return out
}

function coerceScalar(raw: string): unknown {
  if (raw === '') return ''
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1)
  }
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(raw)) return Number(raw)
  return raw
}
