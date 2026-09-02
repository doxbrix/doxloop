import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { PNG } from 'pngjs'
import { compareScreenshots } from './quality-rendered.js'

const workspaces: string[] = []

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('rendered visual comparison', () => {
  test('reports an exact pixel ratio and writes a reviewable diff', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-visual-'))
    workspaces.push(root)
    const baseline = join(root, 'baseline.png')
    const current = join(root, 'current.png')
    const diff = join(root, 'diff.png')
    await writeFile(baseline, image([255, 255, 255, 255]))
    await writeFile(current, image([0, 0, 0, 255]))

    const comparison = await compareScreenshots(baseline, current, diff)

    expect(comparison).toEqual({ ratio: 0.25, diff })
    expect(PNG.sync.read(await readFile(diff))).toMatchObject({ width: 2, height: 2 })
  })

  test('does not create a diff when screenshots are byte-identical', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doxloop-visual-'))
    workspaces.push(root)
    const baseline = join(root, 'baseline.png')
    const current = join(root, 'current.png')
    const diff = join(root, 'diff.png')
    const content = image([255, 255, 255, 255])
    await Promise.all([writeFile(baseline, content), writeFile(current, content)])

    await expect(compareScreenshots(baseline, current, diff)).resolves.toEqual({ ratio: 0, diff })
    await expect(readFile(diff)).rejects.toMatchObject({ code: 'ENOENT' })
  })
})

function image(changedPixel: [number, number, number, number]): Buffer {
  const png = new PNG({ width: 2, height: 2 })
  png.data.fill(255)
  png.data.set(changedPixel, 0)
  return PNG.sync.write(png)
}
