import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { scaffoldProject } from './project.js'
import { hasDiagram, validateProject } from './validation.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('planned diagrams', () => {
  test('warns when an approved plan requires a diagram the page does not have', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-diagram-'))
    roots.push(parent)
    const root = await scaffoldProject({ directory: join(parent, 'docs'), title: 'Pulse', sources: [], generator: 'doxbrix' })
    await mkdir(join(root, '.doxloop'), { recursive: true })
    await writeFile(join(root, '.doxloop', 'documentation-plan.json'), JSON.stringify({
      pages: [
        { path: 'index', type: 'concept', diagram: 'required' },
        { path: 'quickstart', type: 'getting-started', diagram: 'none' },
      ],
    }), 'utf8')
    const before = await validateProject(root)
    expect(before.issues.filter((issue) => issue.code === 'missing-diagram').map((issue) => issue.file)).toEqual(['index.mdx'])
    await writeFile(join(root, 'index.mdx'), '---\ntitle: "Pulse"\ndescription: "Understand how Pulse routes events."\n---\n\n# Pulse\n\n<Mermaid>\nflowchart LR\n  A[Source] --> B[Pulse] --> C[Sink]\n</Mermaid>\n\nEvents flow from sources through Pulse to sinks.\n', 'utf8')
    const after = await validateProject(root)
    expect(after.issues.filter((issue) => issue.code === 'missing-diagram')).toEqual([])
  })

  test('recognises the Mermaid syntaxes the supported generators render', () => {
    expect(hasDiagram('<Mermaid>\nflowchart LR\n</Mermaid>')).toBe(true)
    expect(hasDiagram('```mermaid\nflowchart LR\n```')).toBe(true)
    expect(hasDiagram('.. mermaid::\n\n   flowchart LR')).toBe(true)
    expect(hasDiagram('{{< mermaid >}}flowchart LR{{< /mermaid >}}')).toBe(true)
    expect(hasDiagram('<pre class="mermaid">flowchart LR</pre>')).toBe(true)
    expect(hasDiagram('Just prose about mermaids.')).toBe(false)
  })
})
