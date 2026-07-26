import { afterEach, describe, expect, test, vi } from 'vitest'
import { apiUrl, authenticatedRequest, whoami } from './auth.js'

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
