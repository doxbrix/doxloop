import { describe, expect, test } from 'vitest'
import { assertAllowedFlags, booleanFlag, parseArgs } from './args.js'

describe('argument parsing', () => {
  test('does not consume a request after a boolean flag', () => {
    const args = parseArgs(['create', '--print', 'Document the API'])

    expect(booleanFlag(args, 'print')).toBe(true)
    expect(args.positionals).toEqual(['Document the API'])
  })

  test('treats screenshot controls as boolean flags before a request', () => {
    const enabled = parseArgs([
      'create',
      '--screenshots',
      'Create an onboarding guide',
    ])
    const disabled = parseArgs([
      'update',
      '--no-screenshots',
      'Refresh the onboarding guide',
    ])

    expect(booleanFlag(enabled, 'screenshots')).toBe(true)
    expect(enabled.positionals).toEqual(['Create an onboarding guide'])
    expect(booleanFlag(disabled, 'no-screenshots')).toBe(true)
    expect(disabled.positionals).toEqual(['Refresh the onboarding guide'])
  })

  test('accepts explicit false boolean values', () => {
    const args = parseArgs(['preview', '--open=false'])

    expect(booleanFlag(args, 'open')).toBe(false)
  })

  test('rejects options outside a command schema', () => {
    const args = parseArgs(['test', '--formt', 'json'])

    expect(() => assertAllowedFlags(args, new Set(['format']))).toThrow(
      'Unknown option --formt',
    )
  })
})
