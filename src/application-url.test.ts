import { describe, expect, test } from 'vitest'
import { applicationUrl, hashRouted } from './application-url.js'

describe('applicationUrl', () => {
  test('puts routes after the fragment of a hash-routed application', () => {
    expect(applicationUrl('https://pocketbase.io/_/#', '/settings').toString()).toBe('https://pocketbase.io/_/#/settings')
    expect(applicationUrl('https://pocketbase.io/_/#/', '/settings/backups').toString()).toBe('https://pocketbase.io/_/#/settings/backups')
    expect(applicationUrl('https://pocketbase.io/_/#', '/').toString()).toBe('https://pocketbase.io/_/#/')
    expect(applicationUrl('https://pocketbase.io/_/#', undefined).toString()).toBe('https://pocketbase.io/_/#/')
  })

  test('keeps standard resolution for every other base URL', () => {
    expect(applicationUrl('http://localhost:3000', '/settings').toString()).toBe('http://localhost:3000/settings')
    // A page used as the base still resolves routes from the origin root.
    expect(applicationUrl('https://try.vikunja.io/login', '/projects').toString()).toBe('https://try.vikunja.io/projects')
    expect(applicationUrl('http://localhost:3000', '/setting#member').toString()).toBe('http://localhost:3000/setting#member')
    expect(applicationUrl('https://pocketbase.io/_/#', 'https://elsewhere.test/x').origin).toBe('https://elsewhere.test')
  })

  test('recognizes hash-routed base URLs only by an empty or route-shaped fragment', () => {
    expect(hashRouted('https://pocketbase.io/_/#')).toBe(true)
    expect(hashRouted('https://host/app/#/')).toBe(true)
    expect(hashRouted('https://host/app')).toBe(false)
    expect(hashRouted('https://host/app#section')).toBe(false)
  })
})
