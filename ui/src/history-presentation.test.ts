import { describe, expect, it } from 'vitest'
import { historyActionLabel, historyInstruction, historyRequestSummary } from './WorkspaceApplication'

describe('historyRequestSummary', () => {
  it('keeps short requests intact while normalizing whitespace', () => {
    expect(historyRequestSummary('Document  API keys\nfor admins')).toEqual({
      text: 'Document API keys for admins',
      truncated: false,
    })
  })

  it('keeps generated implementation prompts compact', () => {
    const request = `Implement the approved documentation plan. ${'Only change approved pages and preserve existing behavior. '.repeat(5)}`
    const summary = historyRequestSummary(request)

    expect(summary.truncated).toBe(true)
    expect(summary.text.length).toBeLessThanOrEqual(141)
    expect(summary.text.endsWith('…')).toBe(true)
  })
})

describe('history presentation', () => {
  it('shows create, update, and edit as explicit actions', () => {
    expect(historyActionLabel('create')).toBe('Create')
    expect(historyActionLabel('update')).toBe('Update')
    expect(historyActionLabel('edit')).toBe('Edit')
  })

  it('replaces an internal generation prompt with a useful instruction', () => {
    expect(historyInstruction({
      kind: 'update',
      trigger: 'manual',
      requestText: 'Implement the approved Doxloop documentation plan at .doxloop/documentation-plan.json exactly as approved.\n\nApproved plan ID: internal',
    })).toBe('Update documentation from the approved plan.')
  })

  it('keeps the instruction the user entered', () => {
    expect(historyInstruction({ kind: 'create', trigger: 'manual', requestText: 'Focus on new administrators.' }))
      .toBe('Focus on new administrators.')
  })
})
