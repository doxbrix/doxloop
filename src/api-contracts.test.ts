import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { projectContracts } from './api-contracts.js'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))) })

test('finds a generated contract inside a repository even when its info title is empty', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-contracts-'))
  roots.push(root)
  await mkdir(join(root, 'product', 'proto', 'gen'), { recursive: true })
  await mkdir(join(root, 'product', 'node_modules', 'pkg'), { recursive: true })
  // protoc-gen-openapi writes an empty title, as Memos' contract does.
  await writeFile(join(root, 'product', 'proto', 'gen', 'openapi.yaml'), '# Generated with protoc-gen-openapi\nopenapi: 3.0.3\ninfo:\n    title: ""\n    version: 0.0.1\npaths:\n    /api/v1/memos:\n        get:\n            responses:\n                "200": { description: OK }\n')
  await writeFile(join(root, 'product', 'node_modules', 'pkg', 'openapi.yaml'), 'openapi: 3.0.3\ninfo: { title: vendored, version: 1.0.0 }\npaths: {}\n')
  const contracts = await projectContracts(root, { sources: [{ name: 'product', path: 'product' }] })
  expect(contracts.map((contract) => [contract.source, contract.location, contract.loaded.summary.title])).toEqual([['product', 'proto/gen/openapi.yaml', 'openapi']])
  expect(Object.keys(contracts[0]!.loaded.snapshot.operations)).toEqual(['GET /api/v1/memos'])
})
