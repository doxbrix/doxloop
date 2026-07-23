import { UsageError } from './errors.js'
import type { ParsedArgs } from './types.js'

const BOOLEAN_FLAGS = new Set([
  'dry-run',
  'h',
  'help',
  'open',
  'print',
  'public',
  'screenshots',
  'no-screenshots',
  'v',
  'version',
])

export function parseArgs(argv: string[]): ParsedArgs {
  const flags = new Map<string, string[]>()
  const positionals: string[] = []
  let command: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === undefined) continue
    if (token === '--') {
      positionals.push(...argv.slice(index + 1))
      break
    }
    if (token.startsWith('--')) {
      const equals = token.indexOf('=')
      if (equals > 2) {
        addFlag(flags, token.slice(2, equals), token.slice(equals + 1))
        continue
      }
      const name = token.slice(2)
      const next = argv[index + 1]
      if (
        !BOOLEAN_FLAGS.has(name) &&
        next !== undefined &&
        !next.startsWith('-')
      ) {
        addFlag(flags, name, next)
        index += 1
      } else {
        addFlag(flags, name, 'true')
      }
      continue
    }
    if (token.startsWith('-') && token.length > 1) {
      for (const name of token.slice(1)) addFlag(flags, name, 'true')
      continue
    }
    if (command === undefined) command = token
    else positionals.push(token)
  }

  return command === undefined ? { positionals, flags } : { command, positionals, flags }
}

export function assertAllowedFlags(
  args: ParsedArgs,
  allowed: ReadonlySet<string>,
): void {
  const common = new Set(['cwd', 'h', 'help', 'v', 'version'])
  for (const name of args.flags.keys()) {
    if (!common.has(name) && !allowed.has(name)) {
      throw new UsageError(
        `Unknown option --${name}${args.command ? ` for doxloop ${args.command}` : ''}.`,
      )
    }
  }
}

function addFlag(flags: Map<string, string[]>, name: string, value: string): void {
  const values = flags.get(name) ?? []
  values.push(value)
  flags.set(name, values)
}

export function flag(args: ParsedArgs, name: string, short?: string): string | undefined {
  return (args.flags.get(name) ?? (short ? args.flags.get(short) : undefined))?.at(-1)
}

export function flags(args: ParsedArgs, name: string): string[] {
  return args.flags.get(name) ?? []
}

export function booleanFlag(
  args: ParsedArgs,
  name: string,
  short?: string,
  fallback = false,
): boolean {
  const value = flag(args, name, short)
  if (value === undefined) return fallback
  if (value === 'true') return true
  if (value === 'false') return false
  throw new UsageError(`--${name} must be true or false`)
}

export function numberFlag(
  args: ParsedArgs,
  name: string,
  fallback: number,
): number {
  const raw = flag(args, name)
  if (raw === undefined) return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new UsageError(`--${name} must be an integer between 1 and 65535`)
  }
  return value
}
