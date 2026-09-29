#!/usr/bin/env node
/**
 * Pack a real, finished Doxloop workspace into the bundled demo fixture.
 *
 * The demo must show what a real run produces, so the fixture is not written
 * by hand: build it by running Doxloop on the sample product (plan, generate,
 * accept, then let Monitoring draft an update), and pack the result here.
 *
 *   node scripts/build-demo-fixture.mjs <workspace-parent> [--product pet-store-api] [--project pet-store-docs]
 *
 * <workspace-parent> holds the product folder and the documentation project
 * side by side. Absolute paths are replaced with a placeholder that the demo
 * resolves to its temporary directory, the history database is checkpointed
 * into a single file, and everything is written as one gzip JSON bundle so
 * npm cannot strip the `.doxloop/runs` folders that the project's own
 * `.gitignore` lists.
 */
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'

const ROOT_PLACEHOLDER = '{{DOXLOOP_DEMO_ROOT}}'
const packageRoot = fileURLToPath(new URL('..', import.meta.url))
const output = join(packageRoot, 'assets', 'demo', 'pet-store.json.gz')

const args = process.argv.slice(2)
const parent = args[0] ? resolve(args[0]) : undefined
if (!parent) {
  process.stderr.write('Usage: node scripts/build-demo-fixture.mjs <workspace-parent> [--product <dir>] [--project <dir>]\n')
  process.exit(2)
}
const option = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}
const product = option('product', 'pet-store-api')
const project = option('project', 'pet-store-docs')

/** Operational or machine-specific files that a fresh demo must not inherit. */
const EXCLUDED = [
  /(^|\/)\.DS_Store$/,
  /(^|\/)\.git(\/|$)/,
  /^[^/]+\/\.doxloop\/locks(\/|$)/,
  /^[^/]+\/\.doxloop\/doxloop\.db(-wal|-shm)?$/,
  /^[^/]+\/\.doxloop\/(monitor-budget|monitor-interval)\.json$/,
  /^[^/]+\/\.doxloop\/exports(\/|$)/,
  /^[^/]+\/\.doxloop\/cache\/authoring-batch-[^/]*$/,
  /(^|\/)node_modules(\/|$)/,
]
const TEXT_EXTENSIONS = /\.(json|jsonl|log|md|mdx|txt|yaml|yml|css|svg|html|js|mjs|ts|tsx|gitignore)$|(^|\/)(LICENSE|NOTICE|\.gitignore)$/

async function walk(directory, base, files) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const absolute = join(directory, entry.name)
    const path = relative(base, absolute).split(sep).join('/')
    if (EXCLUDED.some((pattern) => pattern.test(path))) continue
    if (entry.isDirectory()) await walk(absolute, base, files)
    else if (entry.isFile()) files.push(path)
  }
  return files
}

/** Runtime noise from the Node version that recorded the run, not part of the story. */
const NOISE = [/\(node:\d+\) ExperimentalWarning: SQLite[^\n"]*/, /\(Use `node --trace-warnings[^\n"]*/]

/** Local previews opened while the fixture was recorded are not part of the story. */
const OMITTED_JOB_TYPES = /^(proposal-)?preview(:|$)/

function scrub(path, text) {
  // The workspace parent becomes the placeholder; any other home-directory
  // path (agent binaries, transcripts) is shortened so no developer machine
  // path ships in the package.
  let result = text
    .split(parent).join(ROOT_PLACEHOLDER)
    .split(homedir()).join('~')
  if (path.endsWith('.log')) result = result.split('\n').filter((line) => !NOISE.some((pattern) => pattern.test(line))).join('\n')
  if (path.endsWith('ui-jobs.json')) {
    const jobs = JSON.parse(result)
    jobs.jobs = (jobs.jobs ?? []).filter((job) => !OMITTED_JOB_TYPES.test(job.type))
    for (const job of jobs.jobs) job.lines = (job.lines ?? []).filter((line) => !NOISE.some((pattern) => pattern.test(line)))
    result = `${JSON.stringify(jobs, null, 2)}\n`
  }
  return result
}

async function checkpointDatabase() {
  const source = join(parent, project, '.doxloop', 'doxloop.db')
  if (!existsSync(source)) return undefined
  const scratch = await mkdtemp(join(tmpdir(), 'doxloop-fixture-db-'))
  const target = join(scratch, 'doxloop.db')
  const database = new DatabaseSync(source)
  try { database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`) } finally { database.close() }
  const bytes = await readFile(target)
  await rm(scratch, { recursive: true, force: true })
  return bytes
}

const files = []
for (const folder of [product, project]) {
  if (!existsSync(join(parent, folder))) throw new Error(`Missing ${join(parent, folder)}`)
  await walk(join(parent, folder), parent, files)
}
files.sort()

// Logs of omitted jobs go with them.
const jobsFile = join(parent, project, '.doxloop', 'ui-jobs.json')
const omittedLogs = new Set(JSON.parse(await readFile(jobsFile, 'utf8')).jobs.filter((job) => OMITTED_JOB_TYPES.test(job.type)).map((job) => `${project}/.doxloop/ui-job-logs/${job.id}.log`))
for (let index = files.length - 1; index >= 0; index -= 1) if (omittedLogs.has(files[index])) files.splice(index, 1)

let bytes = 0
const entries = []
for (const path of files) {
  const content = await readFile(join(parent, path))
  bytes += content.length
  if (TEXT_EXTENSIONS.test(path) && !content.includes(0)) entries.push([path, 'utf8', scrub(path, content.toString('utf8'))])
  else entries.push([path, 'base64', content.toString('base64')])
}
const database = await checkpointDatabase()
if (database) entries.push([`${project}/.doxloop/doxloop.db`, 'base64', database.toString('base64')])

// The newest recorded moment: the demo shifts every timestamp so this lands
// a few minutes before the reader opens it.
const capturedAt = (await stat(join(parent, project, '.doxloop', 'ui-jobs.json'))).mtime.toISOString()
const bundle = { schemaVersion: 1, capturedAt, product, project, files: entries }
const packed = gzipSync(Buffer.from(JSON.stringify(bundle)), { level: 9 })
await writeFile(output, packed)
const leaked = entries.filter(([, encoding, content]) => encoding === 'utf8' && content.includes(`${sep}Users${sep}`))
process.stdout.write(`Packed ${entries.length} files (${(bytes / 1024).toFixed(0)} KB) into ${relative(packageRoot, output)} (${(packed.length / 1024).toFixed(0)} KB).\n`)
if (leaked.length > 0) {
  process.stderr.write(`Machine paths remain in: ${leaked.map(([path]) => path).join(', ')}\n`)
  process.exit(1)
}
