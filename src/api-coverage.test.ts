import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { contractCoverageIssues, documentedOperations } from './api-coverage.js'
import { scaffoldProject } from './project.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

const CONTRACT = ['openapi: 3.1.0', 'info: { title: Conduit, version: 1.0.0 }', 'paths:', '  /users/login:', '    post: { responses: { "200": { description: OK } } }', '  /articles/{slug}/favorite:', '    post: { responses: { "200": { description: OK } } }', '    delete: { responses: { "200": { description: OK } } }', '  /tags:', '    get: { responses: { "200": { description: OK } } }', ''].join('\n')

test('reads documented operations from ApiEndpoint tags in any attribute order', () => {
  expect(documentedOperations('<ApiEndpoint path="/articles/:slug/favorite" method="post" baseUrl="x">\n<ApiEndpoint method="GET" path="/tags">')).toEqual(['POST /articles/{slug}/favorite', 'GET /tags'])
})

test('files each contract operation without a reference block against the page that mentions it', async () => {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-api-coverage-'))
  roots.push(parent)
  await mkdir(join(parent, 'product', 'specs'), { recursive: true })
  await writeFile(join(parent, 'product', 'specs', 'openapi.yml'), CONTRACT)
  const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [{ name: 'product', path: '../product' }] })
  await writeFile(join(root, 'tags.mdx'), '# Tags\n\n<ApiEndpoint method="GET" path="/tags" baseUrl="https://api.example.com">\n</ApiEndpoint>\n')
  await writeFile(join(root, 'favorites.mdx'), '# Favorites\n\nSend `POST /articles/{slug}/favorite`, then `DELETE /articles/{slug}/favorite`.\n')
  const issues = await contractCoverageIssues(root, ['tags.mdx', 'favorites.mdx'])
  expect(issues.map((issue) => [issue.code, issue.file, /'s (\S+ \S+) has/.exec(issue.message)?.[1]])).toEqual([
    ['api-endpoint-missing', undefined, 'POST /users/login'],
    ['api-endpoint-missing', 'favorites.mdx', 'POST /articles/{slug}/favorite'],
    ['api-endpoint-missing', 'favorites.mdx', 'DELETE /articles/{slug}/favorite'],
  ])
})
