import { afterEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apiUrl, authenticatedRequest, loadUserConfig, saveToken, signedInServers, tokenFor, whoami } from './auth.js'

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

  test('reports the failing API operation and structured server diagnostics', async () => {
    vi.stubEnv('DOXLOOP_TOKEN', 'dxb_test')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        {
          error: 'Private projects are not available on your plan.',
          code: 'PLAN_LIMIT',
          details: { limitKey: 'privateReaderSeats', limit: 0, used: 1 },
          requestId: 'req-123',
        },
        { status: 402, statusText: 'Payment Required' },
      ),
    )

    await expect(
      authenticatedRequest(
        '/api/v1/projects',
        { method: 'POST' },
        'https://api.example.test',
      ),
    ).rejects.toThrow(
      [
        'Doxbrix API error: POST /api/v1/projects returned 402 Payment Required [PLAN_LIMIT]',
        'Private projects are not available on your plan.',
        'Details: {"limitKey":"privateReaderSeats","limit":0,"used":1}',
        'Request ID: req-123',
      ].join('\n'),
    )
  })

  test('points internal errors to the correlated server log entry', async () => {
    vi.stubEnv('DOXLOOP_TOKEN', 'dxb_test')
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      Response.json(
        {
          error: 'Internal server error',
          code: 'internal_error',
          requestId: 'req-500',
        },
        { status: 500, statusText: 'Internal Server Error' },
      ),
    )

    await expect(
      authenticatedRequest(
        '/api/v1/projects',
        { method: 'POST' },
        'https://api.example.test',
      ),
    ).rejects.toThrow(
      'The underlying exception is recorded in the Doxbrix server logs under this request ID.',
    )
  })
})

describe('per-server sign-in', () => {
  test('signing in to a second server keeps the first and never sends a token to the wrong server', async () => {
    const home = await mkdtemp(join(tmpdir(), 'doxloop-auth-'))
    vi.stubEnv('XDG_CONFIG_HOME', home)
    vi.stubEnv('DOXLOOP_TOKEN', '')
    vi.stubEnv('DOXBRIX_TOKEN', '')
    delete process.env.DOXLOOP_TOKEN
    delete process.env.DOXBRIX_TOKEN
    try {
      // A file from before per-server tokens: one token for localhost.
      await mkdir(join(home, 'doxloop'), { recursive: true })
      await writeFile(join(home, 'doxloop', 'config.json'), JSON.stringify({ apiUrl: 'http://localhost:3000', token: 'dxb_local' }))
      let config = await loadUserConfig()
      expect(tokenFor(config, 'http://localhost:3000')).toBe('dxb_local')
      expect(tokenFor(config, 'https://app.doxbrix.com')).toBeUndefined()

      await saveToken('dxb_prod', 'https://app.doxbrix.com')
      config = await loadUserConfig()
      expect(tokenFor(config, 'https://app.doxbrix.com')).toBe('dxb_prod')
      expect(tokenFor(config, 'http://localhost:3000')).toBe('dxb_local')
      expect(signedInServers(config).sort()).toEqual(['http://localhost:3000', 'https://app.doxbrix.com'])
      expect(JSON.parse(await readFile(join(home, 'doxloop', 'config.json'), 'utf8')).apiUrl).toBe('https://app.doxbrix.com')

      const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ ok: true }))
      await authenticatedRequest('/api/v1/me', { method: 'GET' }, 'http://localhost:3000')
      expect(new Headers((fetch.mock.calls[0]![1] as RequestInit).headers).get('Authorization')).toBe('Bearer dxb_local')
      await expect(authenticatedRequest('/api/v1/me', { method: 'GET' }, 'https://other.example.test')).rejects.toThrow('Not signed in to other.example.test')
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  })
})
