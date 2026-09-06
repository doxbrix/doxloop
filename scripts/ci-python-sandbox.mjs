import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { verifyExamples } from '../dist/quality-examples.js'

assert.match(process.env.DOXLOOP_PYTHON_SANDBOX_IMAGE ?? '', /@sha256:[a-f0-9]{64}$/)
const root = await mkdtemp(join(tmpdir(), 'doxloop-real-container-'))
try {
  await mkdir(join(root, '.doxloop'))
  const sentinel = join(root, 'host-only.txt')
  await writeFile(sentinel, 'host content must remain unchanged')
  const code = `from pathlib import Path
import socket
host = Path(${JSON.stringify(sentinel)})
assert not host.exists(), 'host file was exposed'
for target in ['/workspace/escape.txt', '/etc/escape.txt']:
    try:
        Path(target).write_text('unsafe')
        raise AssertionError('filesystem write was allowed')
    except (PermissionError, OSError):
        pass
sock = socket.socket()
sock.settimeout(1)
try:
    sock.connect(('192.0.2.1', 80))
    raise AssertionError('external network was reachable')
except OSError:
    pass
finally:
    sock.close()
assert Path('/workspace/fixture.txt').read_text() == 'declared fixture'
print('filesystem and network checks passed')
`
  await writeFile(join(root, 'probe.py'), code)
  await writeFile(join(root, 'fixture.txt'), 'declared fixture')
  await writeFile(join(root, '.doxloop/examples.json'), JSON.stringify({ schemaVersion: 1, examples: [{ id: 'real-container-boundary', runtime: 'python', file: 'probe.py', workingDirectory: '.', fixtures: ['fixture.txt'], network: 'denied', expected: { exitCode: 0, stdoutIncludes: 'filesystem and network checks passed' } }] }))
  const checks = await verifyExamples(root, true)
  assert.equal(checks[0]?.status, 'pass', JSON.stringify(checks))
  assert.equal(await readFile(sentinel, 'utf8'), 'host content must remain unchanged')
  console.log(JSON.stringify({ image: process.env.DOXLOOP_PYTHON_SANDBOX_IMAGE, checkedAt: new Date().toISOString(), checks }, null, 2))
} finally { await rm(root, { recursive: true, force: true }) }
