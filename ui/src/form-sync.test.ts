import { describe, expect, test } from 'vitest'
import { reconcileSeed } from './form-sync'

describe('form resync after reload', () => {
  const seeded = { title: 'Pulse docs', agent: 'codex' }

  test('takes the new values when the form has not been edited', () => {
    const next = { title: 'Pulse documentation', agent: 'codex' }
    expect(reconcileSeed({ ...seeded }, seeded, next)).toEqual({ form: next, seeded: next, stale: false })
  })

  test('takes the new values when they match what the reader just saved', () => {
    const edited = { title: 'Pulse documentation', agent: 'claude' }
    expect(reconcileSeed(edited, seeded, { ...edited })).toEqual({ form: edited, seeded: edited, stale: false })
  })

  test('keeps unsaved edits and marks the form stale when the project changed elsewhere', () => {
    const edited = { title: 'Half typed', agent: 'codex' }
    const next = { title: 'Changed by the wizard', agent: 'gemini' }
    expect(reconcileSeed(edited, seeded, next)).toEqual({ form: edited, seeded: next, stale: true })
  })
})
