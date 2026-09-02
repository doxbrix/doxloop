import { describe, expect, it } from 'vitest'
import { screenshotIntentFromChoice, setupApplicationCaptureTarget, setupCaptureProfileStatus, setupDocumentationPlanRequest } from './setup-plan'

describe('setupDocumentationPlanRequest', () => {
  it('turns an explicit Yes into required screenshots', () => {
    expect(screenshotIntentFromChoice('yes')).toBe('enabled')
    expect(screenshotIntentFromChoice('no')).toBe('disabled')
  })

  it('joins a trailing-slash application URL to a starting route without creating a double slash', () => {
    expect(setupApplicationCaptureTarget('http://127.0.0.1:4318/', '/')).toBe('http://127.0.0.1:4318/')
    expect(setupApplicationCaptureTarget('http://127.0.0.1:4318/', '/authoring')).toBe('http://127.0.0.1:4318/authoring')
  })

  it('asks for only the URL and starting route when optional capture is selected', () => {
    expect(setupCaptureProfileStatus({ screenshots: 'disabled', applicationBaseUrl: '', applicationStartPath: '/' })).toEqual({ required: false, started: false, complete: false })
    expect(setupCaptureProfileStatus({ screenshots: 'auto', applicationBaseUrl: '', applicationStartPath: '/' })).toEqual({ required: true, started: true, complete: false })
    expect(setupCaptureProfileStatus({ screenshots: 'auto', applicationBaseUrl: 'http://localhost:3000', applicationStartPath: '/settings/team' })).toEqual({ required: true, started: true, complete: true })
  })

  it('starts a reviewable create plan with the selected Codex settings', () => {
    expect(setupDocumentationPlanRequest({
      scope: 'comprehensive',
      readerOutcome: 'Integrate the SDK and operate it safely.',
      clarificationMode: 'review',
      agent: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      effort: '',
      screenshots: 'enabled',
    })).toEqual({
      mode: 'create',
      scope: 'comprehensive',
      request: 'Primary reader outcome: Integrate the SDK and operate it safely.\nResearch the complete evidence-supported public product surface and propose a coherent comprehensive documentation set.',
      clarificationMode: 'review',
      agent: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      screenshots: 'enabled',
    })
  })

  it('sends Claude effort without leaking an unrelated reasoning value', () => {
    expect(setupDocumentationPlanRequest({
      scope: 'standard',
      readerOutcome: '',
      clarificationMode: 'defaults',
      agent: 'claude',
      model: 'claude-sonnet-4-5',
      reasoning: 'high',
      effort: 'max',
      screenshots: 'disabled',
    })).toEqual({
      mode: 'create',
      scope: 'standard',
      request: 'Primary reader outcome: Understand the product, get started, and complete the primary supported workflows.\nResearch the complete evidence-supported public product surface and propose a coherent standard documentation set.',
      clarificationMode: 'defaults',
      agent: 'claude',
      model: 'claude-sonnet-4-5',
      effort: 'max',
      screenshots: 'disabled',
    })
  })

  it('carries the user-approved capture surface into the initial planning request', () => {
    const request = setupDocumentationPlanRequest({
      scope: 'standard',
      readerOutcome: 'Invite a team member.',
      clarificationMode: 'review',
      agent: 'codex',
      model: 'gpt-5.6-sol',
      reasoning: 'high',
      effort: '',
      screenshots: 'enabled',
      applicationBaseUrl: 'http://localhost:3000/',
      applicationStartPath: '/settings/team',
    })

    expect(request.request).toContain('http://localhost:3000/settings/team')
    expect(request.request).not.toContain('localhost:3000//')
    expect(request.request).toContain('evidence-supported, non-destructive visible workflows')
    expect(request.screenshots).toBe('enabled')
  })
})
