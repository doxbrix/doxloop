import { test } from 'node:test'
import assert from 'node:assert/strict'
import { affectedPages, impactComment } from './docs-impact.mjs'

test('maps source-relative globs including renamed files and avoids claiming remote coverage', () => {
  const project = { sources: [{ name: 'product', path: '..' }, { name: 'remote', remote: { repository: 'example/repo' } }] }
  const evidence = { pages: { 'docs/start.md': { sources: [{ source: 'product', paths: ['src/**'] }] }, 'docs/other.md': { sources: [{ source: 'product', paths: ['server/*'] }] } } }
  const result = affectedPages(project, evidence, ['src/nested/new.ts', 'README.md'], 'docs')
  assert.deepEqual(result.affected, [{ page: 'docs/start.md', source: 'product', paths: ['src/nested/new.ts'] }])
  assert.deepEqual(result.unavailable, ['remote'])
  assert.match(impactComment(result), /could not be checked: remote/)
})
test('untrusted file names cannot inject headings, markup, or mentions into the bot comment', () => {
  const body = impactComment({ affected: [{ page: '`\n# @everyone <b>', source: 'product', paths: ['@user'] }], unavailable: [] })
  assert.ok(!body.includes('@everyone'))
  assert.ok(!body.includes('<b>'))
  assert.ok(!body.includes('\n# @'))
})
