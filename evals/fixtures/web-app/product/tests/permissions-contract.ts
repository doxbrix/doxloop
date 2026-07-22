import { expect, test } from 'vitest'
import { canInvite } from '../src/permissions.js'

test('only administrators can invite members', () => {
  expect(canInvite('admin')).toBe(true)
  expect(canInvite('operator')).toBe(false)
})
