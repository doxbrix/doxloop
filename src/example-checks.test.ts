import { describe, expect, test } from 'vitest'
import type { ProjectContract } from './api-contracts.js'
import { codeBlocks, exampleIssues, httpExamples, isPlaceholder, matchOperation, runPageExamples, shellWords } from './example-checks.js'
import { parseOpenApi } from './openapi.js'

const SPEC = JSON.stringify({
  openapi: '3.0.3',
  info: { title: 'Conduit', version: '1.0.0' },
  servers: [{ url: 'https://api.conduit.test/api' }],
  paths: {
    '/users/login': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } } }, responses: { 200: { description: 'ok' } } } },
    '/articles': {
      get: { responses: { 200: { description: 'ok' } } },
      post: { requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['article'], properties: { article: { allOf: [{ $ref: '#/components/schemas/NewArticle' }] } } } } } }, responses: { 201: { description: 'created' } } },
    },
    '/articles/{slug}': { get: { responses: { 200: { description: 'ok' } } }, delete: { responses: { 204: { description: 'gone' } } } },
  },
  components: {
    schemas: {
      LoginRequest: { type: 'object', required: ['user'], properties: { user: { type: 'object', required: ['email', 'password'], additionalProperties: false, properties: { email: { type: 'string' }, password: { type: 'string' } } } } },
      NewArticle: { type: 'object', required: ['title', 'body'], properties: { title: { type: 'string' }, body: { type: 'string' }, tagList: { type: 'array', items: { type: 'string' } }, status: { type: 'string', enum: ['draft', 'published'] } } },
    },
  },
})

const contracts: ProjectContract[] = [{ source: 'api', location: 'openapi.json', loaded: parseOpenApi(SPEC) }]

const fence = (language: string, code: string) => `\`\`\`${language}\n${code}\n\`\`\``

describe('reading examples', () => {
  test('finds fenced blocks with their language and line', () => {
    const blocks = codeBlocks(`# Title\n\nText.\n\n${fence('bash', 'curl https://x.test')}\n\n~~~json\n{}\n~~~\n`)
    expect(blocks.map((block) => [block.language, block.line])).toEqual([['bash', 5], ['json', 9]])
  })

  test('splits shell words with quotes and continuations', () => {
    expect(shellWords(`curl -X POST "https://a.test/x" \\\n  -d '{"a": "b c"}'`)).toEqual(['curl', '-X', 'POST', 'https://a.test/x', '-d', '{"a": "b c"}'])
  })

  test('reads curl flags, bodies, and an expected status', () => {
    const [example] = httpExamples({ language: 'bash', line: 1, code: `# expect-status: 404\ncurl --request GET "$API_URL/articles/missing" -H "Authorization: Token <token>"` })
    expect(example).toMatchObject({ method: 'GET', path: '/articles/missing', host: '$', expectStatus: 404, headers: { authorization: 'Token <token>' } })
    const [post] = httpExamples({ language: 'shell', line: 1, code: `$ curl https://api.conduit.test/api/users/login --json '{"user":{"email":"a@b.c","password":"x"}}'` })
    expect(post).toMatchObject({ method: 'POST', host: 'api.conduit.test', path: '/api/users/login', body: '{"user":{"email":"a@b.c","password":"x"}}' })
  })

  test('reads a raw HTTP request', () => {
    const [example] = httpExamples({ language: 'http', line: 1, code: 'POST /api/articles HTTP/1.1\nHost: api.conduit.test\nContent-Type: application/json\n\n{"article": {"title": "Hi", "body": "x"}}' })
    expect(example).toMatchObject({ method: 'POST', path: '/api/articles', host: 'api.conduit.test', body: '{"article": {"title": "Hi", "body": "x"}}' })
  })

  test('recognises placeholders', () => {
    for (const value of ['<token>', '{{baseUrl}}', '$TOKEN', ':slug', 'your-api-key', 'YOUR_TOKEN', '...']) expect(isPlaceholder(value)).toBe(true)
    for (const value of ['draft', 'how-to-train', '42']) expect(isPlaceholder(value)).toBe(false)
  })
})

describe('matching the contract', () => {
  test('strips the server base path and matches templates', () => {
    const example = httpExamples({ language: 'bash', line: 1, code: 'curl https://api.conduit.test/api/articles/how-to-train' })[0]!
    expect(matchOperation(example, contracts).operation).toMatchObject({ method: 'GET', template: '/articles/{slug}' })
  })

  test('names the methods a path does have, and suggests a similar operation', () => {
    const wrongMethod = httpExamples({ language: 'bash', line: 1, code: 'curl -X PUT https://api.conduit.test/api/articles/x' })[0]!
    expect(matchOperation(wrongMethod, contracts).otherMethods).toEqual(['GET', 'DELETE'])
    const unknown = httpExamples({ language: 'bash', line: 1, code: 'curl -X POST https://api.conduit.test/api/login' })[0]!
    expect(matchOperation(unknown, contracts).suggestion).toBe('POST /users/login')
  })
})

describe('static example issues', () => {
  test('flags JSON and YAML that do not parse, but not elided or commented examples', () => {
    const body = [
      fence('json', '{"a": 1,, }'),
      fence('json', '{\n  // the user\n  "a": 1,\n}'),
      fence('json', '{ "items": [ ... ] }'),
      fence('yaml', 'a: b\n  c: d'),
      fence('yaml', 'image: {{ .Values.image }}'),
    ].join('\n\n')
    expect(exampleIssues(body, 'page.mdx', []).map((item) => item.code)).toEqual(['example-invalid-json', 'example-invalid-yaml'])
  })

  test('flags a request to an endpoint the contract does not have', () => {
    const issues = exampleIssues(fence('bash', 'curl -X POST https://api.conduit.test/api/login -d \'{"user":{}}\''), 'auth.mdx', contracts)
    expect(issues).toEqual([expect.objectContaining({ code: 'example-unknown-endpoint', file: 'auth.mdx' })])
    expect(issues[0]!.message).toContain('POST /users/login')
  })

  test('checks a JSON body against the request schema', () => {
    const body = fence('bash', `curl -X POST https://api.conduit.test/api/users/login -H 'Content-Type: application/json' -d '{"user":{"email":"a@b.c","pass":"x"}}'`)
    const [found] = exampleIssues(body, 'auth.mdx', contracts)
    expect(found).toMatchObject({ code: 'example-schema-mismatch' })
    expect(found!.message).toContain('user.password is required')
    expect(found!.message).toContain('user.pass is not a field the contract accepts')
  })

  test('follows allOf and checks enums and types', () => {
    const body = fence('http', 'POST /api/articles HTTP/1.1\nHost: api.conduit.test\n\n{"article":{"title":"Hi","body":"x","status":"live","tagList":"one"}}')
    const [found] = exampleIssues(body, 'articles.mdx', contracts)
    expect(found!.message).toContain('article.status is "live"; the contract allows "draft", "published"')
    expect(found!.message).toContain('article.tagList is a string; the contract expects array')
  })

  test('accepts a valid request, placeholders, and third-party APIs', () => {
    const body = [
      fence('bash', `curl -X POST https://api.conduit.test/api/users/login -d '{"user":{"email":"<email>","password":"<password>"}}'`),
      fence('bash', 'curl https://api.github.com/repos/o/r/releases'),
      fence('bash', 'curl "$API_URL/articles?limit=5"'),
    ].join('\n\n')
    expect(exampleIssues(body, 'ok.mdx', contracts)).toEqual([])
  })
})

describe('live example runs', () => {
  test('sends only read-only requests and compares the status', async () => {
    const seen: string[] = []
    const fake = (async (url: string | URL, init?: RequestInit) => {
      seen.push(`${init?.method} ${String(url)} ${JSON.stringify(init?.headers)}`)
      const status = String(url).endsWith('/articles') ? 200 : String(url).includes('private') ? 401 : 404
      return new Response(null, { status })
    }) as typeof fetch
    const body = [
      fence('bash', 'curl https://api.conduit.test/api/articles -H "Authorization: Token <token>"'),
      fence('bash', '# expect-status: 404\ncurl https://api.conduit.test/api/articles/missing'),
      fence('bash', 'curl https://api.conduit.test/api/articles/private'),
      fence('bash', 'curl -X DELETE https://api.conduit.test/api/articles/x'),
      fence('bash', 'curl https://api.conduit.test/api/articles/{slug}'),
    ].join('\n\n')
    const results = await runPageExamples(body, 'http://localhost:3000/api', contracts, { fetch: fake })
    expect(results.map((result) => result.outcome)).toEqual(['passed', 'passed', 'needs-sign-in', 'skipped', 'skipped'])
    expect(seen[0]).toBe('GET http://localhost:3000/api/articles {}')
  })
})
