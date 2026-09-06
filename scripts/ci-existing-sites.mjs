#!/usr/bin/env node
/** Real generator import/update/accept/undo check. Requires pnpm run build. */
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { importExistingDocumentation } from '../dist/project-import.js'
import { loadProject } from '../dist/project.js'
import { listPages } from '../dist/pages.js'
import { createSyncRun, acceptSyncChanges, undoSyncRun } from '../dist/sync-runs.js'
import { createDocumentationCollection } from '../dist/documentation-collections.js'
import { undoDirectEdit } from '../dist/direct-edit.js'
const run = promisify(execFile)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const scratch = await mkdtemp(join(tmpdir(), 'doxloop-existing-sites-'))
const oldHome = process.env.DOXLOOP_HOME
process.env.DOXLOOP_HOME = join(scratch, 'home')
const fakeAgent = join(scratch, 'fake-agent.mjs')
await cp(join(repo, 'e2e', 'fake-page-edit-agent.mjs'), fakeAgent)
await chmod(fakeAgent, 0o755)
process.env.DOXLOOP_AGENT_EXECUTABLE_CODEX = fakeAgent
const results = []
try {
  for (const generator of ['docusaurus', 'mkdocs']) {
    const root = join(scratch, generator)
    await cp(join(repo, 'evals/native-sites', generator), root, { recursive: true })
    const path = generator === 'docusaurus' ? 'content/guide/export.md' : 'manual/guides/custom-export.md'
    const before = await readFile(join(root, path), 'utf8')
    const asset = generator === 'docusaurus' ? 'static/img/export.svg' : 'manual/assets/export.svg'
    const assetBefore = await readFile(join(root, asset))
    const config = generator === 'docusaurus' ? 'docusaurus.config.js' : 'mkdocs.yml'
    const configBefore = await readFile(join(root, config), 'utf8')
    let build
    if (generator === 'docusaurus') {
      await execute('npm', ['install', '--no-audit', '--no-fund', '--loglevel=error'], root)
      build = () => execute('npm', ['run', 'build'], root)
    } else {
      await execute('python3', ['-m', 'venv', '.venv'], root)
      await execute(join(root, '.venv/bin/python'), ['-m', 'pip', 'install', '-r', 'requirements.txt', '--quiet'], root)
      build = () => execute(join(root, '.venv/bin/mkdocs'), ['build', '--strict'], root)
    }
    await build()
    await importExistingDocumentation({ directory: root, generator, contentDir: generator === 'docusaurus' ? 'content' : 'manual' })
    assert.equal(await readFile(join(root, path), 'utf8'), before, 'Import must preserve prose')
    assert.equal(await readFile(join(root, config), 'utf8'), configBefore, 'Import must preserve native config')
    const expectedRoute = generator === 'docusaurus' ? '/manual/help/start-here' : '/operations/guides/custom-export.html'
    assert.equal((await listPages(root)).find((page) => page.path === path)?.route, expectedRoute)
    const project = await loadProject(root)
    const proposal = await createSyncRun({ root, project, drift: { status: 'unknown', pages: [], notes: [] }, sourceChanges: [], editRequest: { instruction: 'Add the smoke-test clarification.', paths: [path], allowRelated: false, followUps: [] }, authoring: { agent: 'codex', screenshots: 'disabled' } })
    assert.equal(proposal.status, 'awaiting-review', proposal.error)
    assert.equal(await readFile(join(root, path), 'utf8'), before, 'Proposal must leave live pages unchanged')
    const accepted = await acceptSyncChanges(root, proposal.id, proposal.changes.map((change) => ({ changeId: change.id })))
    assert.equal(accepted.status, 'applied')
    assert.match(await readFile(join(root, path), 'utf8'), /smoke-test clarification/)
    await build()
    const htmlPath = generator === 'docusaurus' ? 'build/help/start-here/index.html' : 'site/guides/custom-export.html'
    const html = await readFile(join(root, htmlPath), 'utf8')
    assert.match(html, /smoke-test clarification/)
    assert.match(html, generator === 'docusaurus' ? /\/manual\/img\/export.svg/ : /\.\.\/assets\/export.svg/)
    assert.deepEqual(await readFile(join(root, generator === 'docusaurus' ? 'build/img/export.svg' : 'site/assets/export.svg')), assetBefore)
    await undoSyncRun(root, proposal.id)
    assert.equal(await readFile(join(root, path), 'utf8'), before, 'Undo must restore exact prose')
    assert.equal(await readFile(join(root, config), 'utf8'), configBefore)
    assert.deepEqual(await readFile(join(root, asset)), assetBefore)
    await build()
    assert.doesNotMatch(await readFile(join(root, htmlPath), 'utf8'), /smoke-test clarification/)
    const version = await createDocumentationCollection(root, { sourceDirectory: project.contentDir, version: '1.0', locale: 'default' })
    await build()
    assert.equal((await listPages(root)).filter((page) => page.version === '1.0').length, 2)
    const versionHtml = generator === 'docusaurus' ? 'build/help/start-here/index.html' : 'site/editions/1.0/default/guides/custom-export.html'
    assert.match(await readFile(join(root, versionHtml), 'utf8'), /Export/)
    const translation = await createDocumentationCollection(root, { sourceDirectory: project.contentDir, version: 'current', locale: 'fr' })
    await build()
    assert.equal((await listPages(root)).filter((page) => page.locale === 'fr').length, 2)
    const translationHtml = generator === 'docusaurus' ? 'build/fr/help/next/start-here/index.html' : 'site/editions/current/fr/guides/custom-export.html'
    assert.match(await readFile(join(root, translationHtml), 'utf8'), /Export/)
    await undoDirectEdit(root, translation.editId)
    await undoDirectEdit(root, version.editId)
    assert.equal(await readFile(join(root, config), 'utf8'), configBefore)
    await build()
    results.push({ generator, route: expectedRoute, importedUnchanged: true, nativeBuilds: 6, versionsAndLocales: true, assetPreserved: true, updateAcceptedAndUndone: true })
    console.log(`PASS ${generator}: existing site import, native routes/assets, update/accept/undo`)
  }
  const output = { at: new Date().toISOString(), results }
  await mkdir(join(repo, 'evals/results'), { recursive: true })
  await writeFile(join(repo, 'evals/results/existing-sites.json'), `${JSON.stringify(output, null, 2)}\n`)
} finally {
  if (oldHome === undefined) delete process.env.DOXLOOP_HOME
  else process.env.DOXLOOP_HOME = oldHome
  if (process.argv.includes('--keep')) console.log(`Kept ${scratch}`)
  else await rm(scratch, { recursive: true, force: true })
}
async function execute(command, args, cwd) {
  console.log(`${cwd.split('/').at(-1)}: ${command} ${args.join(' ')}`)
  try { return await run(command, args, { cwd, env: process.env, timeout: 600_000, maxBuffer: 8_000_000 }) }
  catch (error) { throw new Error(`${command} failed: ${error.stdout ?? ''}\n${error.stderr ?? ''}`, { cause: error }) }
}
