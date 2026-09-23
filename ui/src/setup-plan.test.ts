import { describe, expect, it } from 'vitest'
import { batchLimits, defaultBatchLimits } from '../../src/batch-limits.js'
import { batchLimitsForScope, describeBatchLimits, preferredSetupAgent, screenshotIntentFromChoice, setupApplicationCaptureTarget, setupCaptureProfileIssue, setupCaptureProfileStatus, setupDocumentationPlanRequest, setupDraftSnapshot, setupStepIssue } from './setup-plan'

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
    expect(setupCaptureProfileStatus({ screenshots: 'disabled', applicationBaseUrl: '', applicationStartPath: '/' })).toMatchObject({ required: false, started: false, complete: false })
    expect(setupCaptureProfileStatus({ screenshots: 'auto', applicationBaseUrl: '', applicationStartPath: '/' })).toMatchObject({ required: true, started: true, complete: false })
    expect(setupCaptureProfileStatus({ screenshots: 'auto', applicationBaseUrl: 'http://localhost:3000', applicationStartPath: '/settings/team' })).toEqual({ required: true, started: true, complete: true })
  })

  it('explains what is wrong with the screenshot details instead of silently disabling the check', () => {
    expect(setupCaptureProfileIssue({ applicationBaseUrl: '', applicationStartPath: '/' })).toContain('Enter the application URL')
    expect(setupCaptureProfileIssue({ applicationBaseUrl: 'localhost:3000', applicationStartPath: '/' })).toContain('http://')
    expect(setupCaptureProfileIssue({ applicationBaseUrl: 'http://localhost:3000', applicationStartPath: 'settings' })).toContain('begins with /')
    expect(setupCaptureProfileIssue({ applicationBaseUrl: 'http://localhost:3000', applicationStartPath: '//evil' })).toContain('begins with /')
    expect(setupCaptureProfileIssue({ applicationBaseUrl: 'https://agent-studio-v1.vercel.app', applicationStartPath: '/' })).toBeUndefined()
    expect(setupCaptureProfileStatus({ screenshots: 'enabled', applicationBaseUrl: 'localhost:3000', applicationStartPath: '/' }).complete).toBe(false)
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

describe('setup sign-in choice', () => {
  it('tells the planner not to ask for credentials when the user skipped sign-in', () => {
    const base = { scope: 'starter' as const, readerOutcome: '', clarificationMode: 'review' as const, agent: 'codex', model: '', reasoning: 'high', effort: '', screenshots: 'enabled' as const, applicationBaseUrl: 'http://localhost:5230', applicationStartPath: '/' }
    expect(setupDocumentationPlanRequest({ ...base, applicationSignInSkipped: true }).request).toContain('do not ask for credentials')
    expect(setupDocumentationPlanRequest(base).request).not.toContain('do not ask for credentials')
  })
})

describe('setupStepIssue', () => {
  const complete = {
    directory: 'my-product-docs',
    title: 'Product documentation',
    sourceCount: 1,
    sourceDialogOpen: false,
    agent: 'codex',
    agentInstalled: true,
    agentLabel: 'Codex',
    screenshots: 'disabled' as const,
    applicationBaseUrl: '',
    applicationStartPath: '/',
  }

  it('lets every step through when it is complete', () => {
    for (const step of [1, 2, 3, 4, 5]) expect(setupStepIssue(step, complete)).toBeUndefined()
  })

  it('names the missing workspace field', () => {
    expect(setupStepIssue(1, { ...complete, directory: '  ' })).toBe('Enter a workspace name.')
    expect(setupStepIssue(1, { ...complete, title: '' })).toBe('Enter a title for your documentation.')
  })

  it('requires a source and a closed add-source dialog', () => {
    expect(setupStepIssue(2, { ...complete, sourceCount: 0 })).toContain('Add at least one source')
    expect(setupStepIssue(2, { ...complete, sourceDialogOpen: true })).toContain('Finish adding the source')
  })

  it('requires an installed assistant and usable screenshot details', () => {
    expect(setupStepIssue(3, { ...complete, agent: 'claude', agentInstalled: false, agentLabel: 'Claude Code' })).toBe('Claude Code is not installed. Install it, or choose a different coding assistant.')
    expect(setupStepIssue(3, { ...complete, agent: '' , agentInstalled: false })).toBeUndefined()
    expect(setupStepIssue(3, { ...complete, screenshots: 'enabled' })).toContain('Enter the application URL')
    expect(setupStepIssue(3, { ...complete, screenshots: 'enabled', applicationBaseUrl: 'http://localhost:3000', applicationStartPath: 'home' })).toContain('begins with /')
    expect(setupStepIssue(3, { ...complete, screenshots: 'enabled', applicationBaseUrl: 'http://localhost:3000' })).toBeUndefined()
  })
  it('stops a signed-out assistant before a plan fails on it', () => {
    const issue = setupStepIssue(3, { ...complete, agent: 'claude', agentLabel: 'Claude Code', agentAuthentication: { status: 'unauthenticated', detail: '' } })
    expect(issue).toContain('Claude Code is signed out')
    expect(issue).toContain('claude auth login')
    expect(setupStepIssue(3, { ...complete, agentAuthentication: { status: 'unknown', detail: '' } })).toBeUndefined()
  })

  it('rejects a reasoning level the model does not offer', () => {
    expect(setupStepIssue(3, { ...complete, reasoning: 'lowhigh', reasoningLevels: ['low', 'medium', 'high'] })).toContain('Choose one of: low, medium, high')
    expect(setupStepIssue(3, { ...complete, reasoning: 'high', reasoningLevels: ['low', 'medium', 'high'] })).toBeUndefined()
    expect(setupStepIssue(3, { ...complete, reasoning: 'custom', reasoningLevels: [] })).toBeUndefined()
  })
})

describe('preferredSetupAgent', () => {
  it('starts with an installed assistant that is signed in', () => {
    expect(preferredSetupAgent([
      { name: 'claude', executable: '/bin/claude', authentication: { status: 'authenticated', detail: '' } },
      { name: 'codex', executable: '/bin/codex', authentication: { status: 'unauthenticated', detail: '' } },
    ])).toBe('claude')
    expect(preferredSetupAgent([
      { name: 'claude', executable: '/bin/claude', authentication: { status: 'unauthenticated', detail: '' } },
      { name: 'codex', executable: '/bin/codex', authentication: { status: 'authenticated', detail: '' } },
    ])).toBe('codex')
    expect(preferredSetupAgent([{ name: 'gemini', executable: '/bin/gemini', authentication: { status: 'unauthenticated', detail: '' } }])).toBe('gemini')
    expect(preferredSetupAgent(undefined)).toBe('codex')
  })
})

describe('setupDraftSnapshot', () => {
  it('never keeps passwords or tokens', () => {
    const snapshot = setupDraftSnapshot({ title: 'Docs', applicationPassword: 'secret', gitSecret: 'token' }, [{ name: 'repo', gitSecret: 'token' }], 3)
    expect(snapshot).toEqual({ form: { title: 'Docs', applicationPassword: '', gitSecret: '' }, sources: [{ name: 'repo', gitSecret: '' }], step: 3 })
  })
})

describe('batchLimitsForScope', () => {
  it('leaves hidden limits to the server while displaying the depth-sized batch', () => {
    const request = setupDocumentationPlanRequest({ scope: 'comprehensive', readerOutcome: '', clarificationMode: 'review', agent: 'claude', model: '', reasoning: '', effort: '', screenshots: 'enabled' })
    expect(request).not.toHaveProperty('limits')
    expect(batchLimitsForScope(request.scope, request.screenshots)).toEqual({ maxPages: 500, maxScreenshots: 300, maxMinutes: 120 })
    expect(batchLimitsForScope('starter', 'disabled')).toEqual({ maxPages: 5, maxScreenshots: 0, maxMinutes: 15 })
    expect(batchLimitsForScope('standard', 'auto')).toEqual({ maxPages: 500, maxScreenshots: 300, maxMinutes: 45 })
    expect(describeBatchLimits(batchLimitsForScope('standard', 'auto'))).toBe('No page limit · 300 screenshots · 45 minutes per attempt')
    expect(describeBatchLimits(batchLimitsForScope('starter', 'disabled'))).toBe('5 pages · 0 screenshots · 15 minutes per attempt')
    expect(describeBatchLimits(batchLimitsForScope('starter', 'enabled'))).toBe('5 pages · 15 screenshots · 15 minutes per attempt')
  })
})

// Exercise the wizard/API boundary for every depth and screenshot choice.
describe('setup limit compatibility', () => {
  for (const scope of ['starter', 'standard', 'comprehensive'] as const) {
    it.each(['auto', 'enabled', 'disabled'] as const)(`${scope} with %s screenshots uses valid server defaults`, (screenshots) => {
      const request = setupDocumentationPlanRequest({ scope, screenshots, readerOutcome: '', clarificationMode: 'review', agent: '', model: '', reasoning: '', effort: '' })
      expect(request).not.toHaveProperty('limits')
      const limits = defaultBatchLimits(request.scope, request.screenshots !== 'disabled')
      expect(batchLimits(limits)).toEqual(batchLimitsForScope(scope, screenshots))
    })
  }
})
