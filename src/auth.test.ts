import { afterEach, describe, expect, test, vi } from 'vitest'
import { apiUrl, whoami } from './auth.js'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe('API URL security', () => {
  test('requires HTTPS outside loopback', () => {
    expect(apiUrl('https://api.example.test/')).toBe('https://api.example.test')
    expect(apiUrl('http://localhost:3000/')).toBe('http://localhost:3000')
    expect(() => apiUrl('http://api.example.test')).toThrow('must use HTTPS')
    expect(() => apiUrl('https://user:secret@api.example.test')).toThrow(
      'cannot contain credentials',
    )
  })

  test('refuses redirects for token-bearing account requests', async () => {
    vi.stubEnv('DOXLOOP_TOKEN', 'dxb_test')
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        Response.json({ id: '1', email: 'user@example.test', name: null }),
      )

    await whoami('https://api.example.test')

    expect(fetch).toHaveBeenCalledWith(
      'https://api.example.test/api/v1/me',
      expect.objectContaining({ redirect: 'error' }),
    )
  })
})
