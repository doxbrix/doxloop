import { expect, test } from 'vitest'
import { run } from '../src/cli.js'

test('uses --format and returns a nonzero status for invalid input', () => {
  expect(run(['validate', 'invalid.txt', '--format', 'json'])).toBe(1)
})
