import { describe, expect, it } from 'vitest'
import { normalizeInitialPage, uiSessionCookieName } from './ui-server.js'

describe('control-center CLI routes', () => {
  it.each(['overview', 'sources', 'authoring', 'proposals', 'publish', 'settings'])('accepts %s', (route) => {
    expect(normalizeInitialPage(route)).toBe(route)
  })

  it('defaults to overview and rejects obsolete pages', () => {
    expect(normalizeInitialPage(undefined)).toBe('overview')
    expect(() => normalizeInitialPage('sync')).toThrow('Unknown UI page')
    expect(() => normalizeInitialPage('quality')).toThrow('Unknown UI page')
    expect(() => normalizeInitialPage('preview')).toThrow('Unknown UI page')
    expect(() => normalizeInitialPage('home')).toThrow('Unknown UI page')
  })
})

describe('control-center sessions', () => {
  it('isolates session cookies by UI port', () => {
    expect(uiSessionCookieName(4317)).toBe('doxloop_ui_4317')
    expect(uiSessionCookieName(4318)).toBe('doxloop_ui_4318')
    expect(uiSessionCookieName(4317)).not.toBe(uiSessionCookieName(4318))
  })
})
