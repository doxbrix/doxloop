import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { expect, test, vi } from 'vitest'
import { verifyExamples } from './quality-examples.js'

test('never executes Python on the host when a sandbox is unavailable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-python-boundary-'))
  vi.stubEnv('DOXLOOP_PYTHON_SANDBOX_IMAGE', '')
  try {
    await mkdir(join(root, '.doxloop'))
    const sentinel = join(root, 'outside.txt')
    await writeFile(sentinel, 'original')
    await writeFile(join(root, 'example.py'), `open(${JSON.stringify(sentinel)}, 'w').write('escaped')`)
    await writeFile(join(root, '.doxloop', 'examples.json'), JSON.stringify({ schemaVersion: 1, examples: [{ id: 'python-boundary', runtime: 'python', file: 'example.py', workingDirectory: '.', fixtures: [], network: 'denied', expected: { exitCode: 0 } }] }))
    expect(await verifyExamples(root, true)).toEqual([expect.objectContaining({ status: 'skipped', message: expect.stringContaining('host Python is never used') })])
    expect(await readFile(sentinel, 'utf8')).toBe('original')
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
})

test('container execution requests resource, network, filesystem and identity restrictions and cleans up on failure', async () => {
  const root = await mkdtemp(join(tmpdir(), 'doxloop-python-container-'))
  const { chmod } = await import('node:fs/promises')
  const originalPath = process.env.PATH
  try {
    await mkdir(join(root, '.doxloop'))
    const calls = join(root, 'calls.jsonl')
    await writeFile(join(root, 'docker'), `#!${process.execPath}\nrequire('fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2))+'\\n'); process.exit(process.argv[2] === 'run' ? 125 : 0);\n`)
    await chmod(join(root, 'docker'), 0o755)
    vi.stubEnv('PATH', `${root}:${originalPath}`)
    vi.stubEnv('DOXLOOP_PYTHON_SANDBOX_IMAGE', `python@sha256:${'a'.repeat(64)}`)
    await writeFile(join(root, 'example.py'), 'print("fixture")')
    await writeFile(join(root, '.doxloop/examples.json'), JSON.stringify({ schemaVersion: 1, examples: [{ id: 'bounded', runtime: 'python', file: 'example.py', workingDirectory: '.', fixtures: [], network: 'denied', expected: { exitCode: 0 } }] }))
    expect(await verifyExamples(root, true)).toEqual([expect.objectContaining({ status: 'fail', message: expect.stringContaining('received 125') })])
    const [invoke, cleanup] = (await readFile(calls, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as string[])
    expect(invoke).toEqual(expect.arrayContaining(['--pull=never', '--network=none', '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pids-limit=32', '--memory=256m', '--cpus=1', '--user=65534:65534']))
    expect(invoke?.find((arg) => arg.startsWith('type=bind'))).toContain('readonly')
    expect(cleanup).toEqual(['rm', '-f', invoke![invoke!.indexOf('--name') + 1]])
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }) }
})
