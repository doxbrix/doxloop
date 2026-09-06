import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { listRequests } from './history.js'
import { readNavigation, writeNavigation, type NavigationNode } from './navigation.js'
import { scaffoldProject } from './project.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function scaffold(generator: 'doxbrix' | 'mkdocs' = 'doxbrix'): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-navigation-'))
  roots.push(parent)
  return scaffoldProject({ directory: join(parent, 'docs'), title: 'Pulse', sources: [], generator })
}

function group(node: NavigationNode): Extract<NavigationNode, { type: 'group' }> {
  if (node.type !== 'group') throw new Error(`Expected a group, got ${node.type}`)
  return node
}

describe('Doxbrix navigation editing', () => {
  test('reads docs.json as an editable tree with page paths and orphans', async () => {
    const root = await scaffold()
    await writeFile(join(root, 'extra.mdx'), '---\ntitle: "Extra"\ndescription: "An orphan page."\n---\n\n# Extra\n\nNot yet in navigation.\n', 'utf8')
    const tree = await readNavigation(root)
    expect(tree.editable).toBe(true)
    expect(tree.requiresEveryPage).toBe(true)
    expect(tree.configFile).toBe('docs.json')
    expect(tree.supports.icons).toBe(true)
    const started = group(tree.spaces[0]!.nav[0]!)
    expect(started.label).toBe('Get started')
    expect(started.items.map((node) => node.type === 'page' ? [node.file, node.path, node.pageTitle] : node.type)).toEqual([
      ['index', 'index.mdx', 'Pulse'],
      ['quickstart', 'quickstart.mdx', 'Quickstart'],
    ])
    expect(tree.orphans).toEqual([{ file: 'extra', path: 'extra.mdx', title: 'Extra' }])
  })

  test('writes a reordered, relabelled, and partly hidden tree back to docs.json and records history', async () => {
    const root = await scaffold()
    const before = await readNavigation(root)
    const started = group(before.spaces[0]!.nav[0]!)
    const after = await writeNavigation(root, {
      fingerprint: before.fingerprint,
      spaces: [{
        name: 'Documentation',
        nav: [
          { type: 'group', label: 'Start here', icon: 'compass', items: [started.items[1], { ...started.items[0], title: 'Home', hidden: true }] },
          { type: 'divider' },
          { type: 'link', title: 'Status', href: 'https://status.example.com', icon: 'globe' },
        ],
      }],
    })
    const config = JSON.parse(await readFile(join(root, 'docs.json'), 'utf8')) as { spaces: Array<{ slug: string; nav: NavigationNode[] }> }
    expect(config.spaces[0]!.slug).toBe('docs')
    expect(config.spaces[0]!.nav).toEqual([
      { type: 'group', label: 'Start here', icon: 'compass', items: [
        { type: 'page', file: 'quickstart', title: 'Quickstart', icon: 'bolt' },
        { type: 'page', file: 'index', title: 'Home', icon: 'compass', hidden: true },
      ] },
      { type: 'divider' },
      { type: 'link', title: 'Status', href: 'https://status.example.com', icon: 'globe' },
    ])
    expect(after.fingerprint).not.toBe(before.fingerprint)
    expect(after.orphans).toEqual([])
    const requests = await listRequests(root)
    expect(requests[0]).toMatchObject({ kind: 'navigation', status: 'completed', requestText: 'Reorganized the navigation' })
  })

  test('refuses stale fingerprints, unknown pages, duplicates, and invalid links', async () => {
    const root = await scaffold()
    const tree = await readNavigation(root)
    const nav = tree.spaces[0]!.nav
    await expect(writeNavigation(root, { fingerprint: 'stale', spaces: [{ name: 'Documentation', nav }] })).rejects.toThrow('changed on disk')
    await expect(writeNavigation(root, { fingerprint: tree.fingerprint, spaces: [{ name: 'Documentation', nav: [...nav, { type: 'page', file: 'missing' }] }] })).rejects.toThrow('not a page in this project')
    await expect(writeNavigation(root, { fingerprint: tree.fingerprint, spaces: [{ name: 'Documentation', nav: [...nav, { type: 'page', file: 'index' }] }] })).rejects.toThrow('more than once')
    await expect(writeNavigation(root, { fingerprint: tree.fingerprint, spaces: [{ name: 'Documentation', nav: [...nav, { type: 'link', title: 'Bad', href: 'javascript:alert(1)' }] }] })).rejects.toThrow('HTTPS or root-relative')
    expect(await readFile(join(root, 'docs.json'), 'utf8')).toContain('"label": "Get started"')
  })

  test('rolls back a write that drops a page from navigation, since Doxbrix validation requires every page', async () => {
    const root = await scaffold()
    const original = await readFile(join(root, 'docs.json'), 'utf8')
    const tree = await readNavigation(root)
    const started = group(tree.spaces[0]!.nav[0]!)
    await expect(writeNavigation(root, {
      fingerprint: tree.fingerprint,
      spaces: [{ name: 'Documentation', nav: [{ type: 'group', label: 'Get started', items: [started.items[0]] }] }],
    })).rejects.toThrow('would break validation')
    expect(await readFile(join(root, 'docs.json'), 'utf8')).toBe(original)
    const requests = await listRequests(root)
    expect(requests[0]).toMatchObject({ kind: 'navigation', status: 'failed' })
  })

  test('adds an orphan page and clears its validation error', async () => {
    const root = await scaffold()
    await writeFile(join(root, 'guides/extra.mdx'.replace('guides/', '')), '---\ntitle: "Extra"\ndescription: "An orphan page."\n---\n\n# Extra\n\nNow in navigation.\n', 'utf8')
    const tree = await readNavigation(root)
    expect(tree.orphans.map((orphan) => orphan.file)).toEqual(['extra'])
    const after = await writeNavigation(root, {
      fingerprint: tree.fingerprint,
      spaces: [{ name: 'Documentation', nav: [...tree.spaces[0]!.nav, { type: 'page', file: 'extra' }] }],
    })
    expect(after.orphans).toEqual([])
    expect(after.spaces[0]!.nav.at(-1)).toMatchObject({ type: 'page', file: 'extra', path: 'extra.mdx', pageTitle: 'Extra' })
  })
})

describe('MkDocs navigation editing', () => {
  test('reads mkdocs.yml as a tree and writes regrouped sections back', async () => {
    const root = await scaffold('mkdocs')
    const tree = await readNavigation(root)
    expect(tree.editable).toBe(true)
    expect(tree.requiresEveryPage).toBe(false)
    expect(tree.supports).toEqual({ icons: false, hidden: false, labels: false, links: false, dividers: false, spaces: false })
    const pages = tree.spaces[0]!.nav.flatMap(function collect(node): string[] {
      if (node.type === 'page') return [node.file]
      if (node.type === 'group') return node.items.flatMap(collect)
      return []
    })
    expect(pages.length).toBeGreaterThanOrEqual(2)
    const after = await writeNavigation(root, {
      fingerprint: tree.fingerprint,
      spaces: [{ name: 'Docs', nav: [{ type: 'group', label: 'Everything', items: pages.map((file) => ({ type: 'page', file, title: `Page ${file}` })) }] }],
    })
    const everything = group(after.spaces[0]!.nav[0]!)
    expect(everything.label).toBe('Everything')
    expect(everything.items.map((node) => node.type === 'page' ? node.file : node.type)).toEqual(pages)
    const yaml = await readFile(join(root, 'mkdocs.yml'), 'utf8')
    expect(yaml).toContain('- Everything:')
    expect(yaml).toContain(`Page ${pages[0]}: ${pages[0]}`)
    await expect(writeNavigation(root, { fingerprint: after.fingerprint, spaces: [{ name: 'Docs', nav: [{ type: 'divider' }] }] })).rejects.toThrow('no dividers')
  })
})
