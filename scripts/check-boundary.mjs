import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const ignoredDirectories = new Set(['.git', 'node_modules', 'coverage'])
const readableExtensions = new Set([
  '',
  '.json',
  '.map',
  '.md',
  '.mjs',
  '.ts',
  '.yaml',
  '.yml',
])
const forbidden = [
  { pattern: ['@doxbrix', '/cli'].join(''), reason: 'closed CLI package dependency' },
  {
    pattern: ['/workspace', '/', 'docs', 'ai'].join(''),
    reason: 'closed repository path',
  },
  { pattern: ['docs', 'ai'].join(''), reason: 'closed repository name' },
  { pattern: ['/Users', '/'].join(''), reason: 'developer machine path' },
  { pattern: ['C:', '\\Users\\'].join(''), reason: 'developer machine path' },
  { pattern: ['@doc', 'flow/'].join(''), reason: 'closed package namespace' },
  { pattern: ['packages', '/doxbrix'].join(''), reason: 'closed repository package path' },
  { pattern: ['apps', '/cli'].join(''), reason: 'closed repository application path' },
]

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const output = []
  for (const entry of entries) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue
    const path = join(directory, entry.name)
    const local = relative(root, path).replaceAll('\\', '/')
    if (['evals/results', 'test-results', 'playwright-report'].includes(local)) continue
    if (entry.isDirectory()) output.push(...(await files(path)))
    else if (entry.isFile() && readableExtensions.has(extname(entry.name))) output.push(path)
  }
  return output
}

const violations = []
for (const path of await files(root)) {
  const content = await readFile(path, 'utf8')
  for (const rule of forbidden) {
    if (content.includes(rule.pattern)) {
      violations.push(
      `${relative(root, path)}: ${rule.reason} (${rule.pattern})`,
      )
    }
  }
}

if (violations.length > 0) {
  console.error('Source-boundary check failed:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log('Source-boundary check passed.')
}
