import { describe, expect, test } from 'vitest'
import { diffOpenApi, fetchRemoteOpenApi, parseOpenApi } from './openapi.js'
import { connectorForSource, SOURCE_CONNECTOR_API_VERSION } from './source-connectors.js'

const BASE = {
  openapi: '3.1.0',
  info: { title: 'Payments API', version: '2026-08' },
  servers: [{ url: 'https://api.example.test' }],
  paths: {
    '/payments': {
      post: {
        operationId: 'createPayment',
        parameters: [{ in: 'header', name: 'idempotency-key' }],
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Payment' } } } },
        responses: { 201: { description: 'Created', content: { 'application/json': { example: { id: 'pay_1' } } } } },
        security: [{ bearer: [] }],
      },
    },
  },
  components: { schemas: { Payment: { type: 'object', properties: { amount: { type: 'number' } } } }, securitySchemes: { bearer: { type: 'http', scheme: 'bearer' } } },
}

describe('OpenAPI validation and structural inspection', () => {
  test('exposes the complete versioned connector contract', () => {
    const connector = connectorForSource({ name: 'api', path: 'openapi.json', kind: 'openapi' })
    expect(connector.version).toBe(SOURCE_CONNECTOR_API_VERSION)
    for (const method of ['validate', 'inventory', 'snapshot', 'detectChanges', 'evidenceIdentifiers', 'redact', 'health']) expect(typeof connector[method as keyof typeof connector]).toBe('function')
    expect(connector.redact({ name: 'api', path: 'https://example.com/openapi.json?token=secret', kind: 'openapi' }).path).not.toContain('secret')
  })
  test('parses JSON and YAML and returns a useful connection summary', () => {
    const json = parseOpenApi(JSON.stringify(BASE))
    expect(json.summary).toMatchObject({ title: 'Payments API', version: '2026-08', operationCount: 1, securitySchemes: ['bearer'], schemas: ['Payment'] })
    const yaml = parseOpenApi('openapi: 3.0.3\ninfo:\n  title: Sample\n  version: 1.0.0\npaths: {}\n')
    expect(yaml.summary.title).toBe('Sample')
  })

  test('returns actionable errors for malformed and unsupported documents', () => {
    expect(() => parseOpenApi('{oops')).toThrow(/not valid JSON or YAML/)
    expect(() => parseOpenApi('swagger: "1.2"\ninfo:\n  title: Old\n  version: 1\npaths: {}')).toThrow(/OpenAPI 3.x.*Swagger 2.0/)
    expect(() => parseOpenApi('openapi: 3.0.0\ninfo:\n  version: 1\npaths: {}')).toThrow(/info.title/)
  })

  test('diffs operation facets, schemas, authentication, and examples', () => {
    const before = parseOpenApi(JSON.stringify(BASE)).snapshot
    const changed = structuredClone(BASE)
    changed.paths['/payments'].post.parameters.push({ in: 'query', name: 'expand' })
    changed.paths['/payments'].post.responses['201']!.content['application/json'].example = { id: 'pay_2' }
    changed.components.schemas.Payment.properties.currency = { type: 'string' }
    changed.components.securitySchemes.apiKey = { type: 'apiKey', in: 'header', name: 'x-api-key' }
    const delta = diffOpenApi(before, parseOpenApi(JSON.stringify(changed)).snapshot)
    expect(delta.operations.changed[0]).toMatchObject({ id: 'POST /payments' })
    expect(delta.operations.changed[0]?.facets).toEqual(expect.arrayContaining(['parameters', 'responses', 'examples']))
    expect(delta.schemas.changed[0]?.id).toBe('Payment')
    expect(delta.securitySchemes.added).toEqual(['apiKey'])
  })
})

describe('remote OpenAPI safety', () => {
  const publicDns = async () => ['203.0.113.10']
  test('rejects credentials and private-network destinations', async () => {
    await expect(fetchRemoteOpenApi('https://user:secret@example.com/openapi.json', { resolveHostname: publicDns })).rejects.toThrow(/credentials/)
    await expect(fetchRemoteOpenApi('http://127.0.0.1/openapi.json', { resolveHostname: publicDns })).rejects.toThrow(/private networks/)
  })

  test('honors validators and returns cached content for 304', async () => {
    let sentEtag = ''
    const fetcher: typeof fetch = async (_input, init) => {
      sentEtag = new Headers(init?.headers).get('if-none-match') ?? ''
      return new Response(null, { status: 304 })
    }
    const content = JSON.stringify(BASE)
    const result = await fetchRemoteOpenApi('https://example.com/openapi.json', { fetch: fetcher, resolveHostname: publicDns, validators: { etag: '"v1"' }, cached: { url: 'https://example.com/openapi.json', content, hash: 'hash', etag: '"v1"' } })
    expect(sentEtag).toBe('"v1"')
    expect(result).toMatchObject({ notModified: true, content })
  })

  test('enforces redirects, content type, and response size', async () => {
    await expect(fetchRemoteOpenApi('https://example.com/openapi', { fetch: async () => new Response('html', { headers: { 'content-type': 'text/html' } }), resolveHostname: publicDns })).rejects.toThrow(/content type/)
    await expect(fetchRemoteOpenApi('https://example.com/openapi.json', { fetch: async () => new Response('123456', { headers: { 'content-type': 'application/json' } }), resolveHostname: publicDns, maxBytes: 5 })).rejects.toThrow(/safety limit/)
    let calls = 0
    await expect(fetchRemoteOpenApi('https://example.com/openapi.json', { fetch: async () => { calls += 1; return new Response(null, { status: 302, headers: { location: '/next.json' } }) }, resolveHostname: publicDns })).rejects.toThrow(/redirect limit/)
    expect(calls).toBe(4)
  })
})
