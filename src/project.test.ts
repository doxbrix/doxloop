import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  addDesignReferences,
  loadProject,
  loadSiteConfig,
  parseDesignReference,
  parseSource,
  resolveSeparateProjectLayout,
  saveProjectSettings,
  scaffoldProject,
  validateProjectSourceBoundaries,
} from './project.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('project scaffolding', () => {
  test('allows a project without a product source', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)

    await expect(
      validateProjectSourceBoundaries(join(parent, 'sample-docs'), []),
    ).resolves.toBeUndefined()
  })

  test('resolves a new documentation project beside a read-only product source', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const source = join(parent, 'sample-product')
    await mkdir(source)

    await expect(
      resolveSeparateProjectLayout({
        cwd: parent,
        source: './sample-product',
        output: './sample-docs',
      }),
    ).resolves.toEqual({
      sourceRoot: source,
      projectRoot: join(parent, 'sample-docs'),
      sourceBinding: { name: 'product', path: '../sample-product' },
    })
  })

  test('rejects documentation output inside the product source', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const source = join(parent, 'sample-product')
    await mkdir(source)

    await expect(
      resolveSeparateProjectLayout({
        cwd: parent,
        source,
        output: join(source, 'docs'),
      }),
    ).rejects.toThrow('must be separate directories')
  })

  test('rejects a product source inside the documentation project', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const projectRoot = join(parent, 'sample-docs')
    const source = join(projectRoot, 'sample-product')
    await mkdir(source, { recursive: true })

    await expect(
      validateProjectSourceBoundaries(projectRoot, [
        { name: 'product', path: './sample-product' },
      ]),
    ).rejects.toThrow('must be separate directories')
  })

  test('rejects a missing product source before creating documentation', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)

    await expect(
      resolveSeparateProjectLayout({
        cwd: parent,
        source: './missing-product',
        output: './sample-docs',
      }),
    ).rejects.toThrow('product source does not exist')
  })

  test('rejects a non-empty documentation output directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    await mkdir(join(parent, 'sample-product'))
    await mkdir(join(parent, 'sample-docs'))
    await writeFile(join(parent, 'sample-docs', 'README.md'), '# Existing docs\n')

    await expect(
      resolveSeparateProjectLayout({
        cwd: parent,
        source: './sample-product',
        output: './sample-docs',
      }),
    ).rejects.toThrow('documentation output is not empty')
  })

  test('creates a native Doxbrix project by default', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'sample-docs'),
      sources: [parseSource('product=../product')],
      designReferences: [
        parseDesignReference('https://docs.example.com/guides/getting-started#install'),
      ],
    })
    const project = await loadProject(root)
    expect(project.title).toBe('Sample Docs')
    expect(project.generator).toBe('doxbrix')
    expect(project.sources).toEqual([{ name: 'product', path: '../product' }])
    expect(project.designReferences).toEqual([
      { url: 'https://docs.example.com/guides/getting-started' },
    ])
    expect(project.documentation).toEqual({
      locale: 'en-US',
      tone: ['clear', 'direct', 'professional'],
      standardsProfile: 'doxloop-v1',
      styleGuide: 'doxloop',
      terminology: {},
      exclusions: [],
      accessibilityTarget: 'WCAG 2.2 AA',
    })
    const indexPage = await readFile(join(root, 'docs', 'index.mdx'), 'utf8')
    const quickstartPage = await readFile(
      join(root, 'docs', 'quickstart.mdx'),
      'utf8',
    )
    expect(indexPage).toContain('<CardGroup')
    expect(indexPage).toMatch(/^---[\s\S]*\nicon: compass\n---/)
    expect(quickstartPage).toMatch(/^---[\s\S]*\nicon: bolt\n---/)
    const site = await loadSiteConfig(root, project)
    expect(site.version).toBe(1)
    expect(site.spaces[0]).toMatchObject({
      name: 'Documentation',
      icon: 'book',
      nav: [
        {
          type: 'group',
          label: 'Get started',
          icon: 'rocket',
          items: [
            {
              type: 'page',
              file: 'index',
              title: 'Overview',
              icon: 'compass',
            },
            {
              type: 'page',
              file: 'quickstart',
              title: 'Quickstart',
              icon: 'bolt',
            },
          ],
        },
      ],
    })
  })

  test('persists user-facing project and deployment settings', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'sample-docs'),
      sources: [],
    })

    await saveProjectSettings(root, {
      title: 'Payments API',
      defaultAgent: 'codex',
      deployment: {
        name: 'Payments Documentation',
        slug: 'payments-docs',
        visibility: 'public',
        apiUrl: 'https://docs.example.com',
      },
    })

    expect(await loadProject(root)).toMatchObject({
      title: 'Payments API',
      defaultAgent: 'codex',
      deployment: {
        name: 'Payments Documentation',
        slug: 'payments-docs',
        visibility: 'public',
        apiUrl: 'https://docs.example.com',
      },
    })
    expect((await loadSiteConfig(root)).name).toBe('Payments API')
  })

  test('rejects malformed Doxbrix navigation with an actionable field path', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'sample-docs'),
      sources: [],
    })
    const configPath = join(root, 'docs', 'docs.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      spaces: Array<{ nav: Array<Record<string, unknown>> }>
    }
    config.spaces[0]!.nav = [{ type: 'link', href: '/support' }]
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

    await expect(loadSiteConfig(root)).rejects.toThrow(
      'docs/docs.json is invalid: spaces[0].nav[0].title must be a non-empty string.',
    )
  })

  test('creates a native Docusaurus project when selected', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'sample-docs'),
      sources: [],
      generator: 'docusaurus',
    })

    expect(await loadProject(root)).toMatchObject({
      generator: 'docusaurus',
      generatorPackage: '@doxbrix/doxloop-generator-docusaurus',
    })
    expect(await readFile(join(root, 'docusaurus.config.js'), 'utf8')).toContain(
      "routeBasePath: '/'",
    )
    expect(await readFile(join(root, 'sidebars.js'), 'utf8')).toContain(
      "type: 'autogenerated'",
    )
    expect(
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8')),
    ).toMatchObject({
      dependencies: {
        '@docusaurus/core': '3.10.2',
        '@docusaurus/faster': '3.10.2',
        '@docusaurus/preset-classic': '3.10.2',
      },
    })
  })

  test('creates a native MkDocs Material project through its generator package', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const corePackage = JSON.parse(
      await readFile(new URL('../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    const generatorPackage = JSON.parse(
      await readFile(
        new URL('../packages/generator-mkdocs/package.json', import.meta.url),
        'utf8',
      ),
    ) as { version: string }
    const root = await scaffoldProject({
      directory: join(parent, 'sample-docs'),
      sources: [],
      generator: 'mkdocs',
    })

    expect(await loadProject(root)).toMatchObject({
      generator: 'mkdocs',
      generatorPackage: '@doxbrix/doxloop-generator-mkdocs',
    })
    expect(await readFile(join(root, 'mkdocs.yml'), 'utf8')).toContain(
      'name: material',
    )
    expect(await readFile(join(root, 'mkdocs.yml'), 'utf8')).toContain(
      'Quickstart: quickstart.md',
    )
    expect(await readFile(join(root, 'requirements.txt'), 'utf8')).toContain(
      'mkdocs-material==',
    )
    expect(
      JSON.parse(await readFile(join(root, 'package.json'), 'utf8')),
    ).toMatchObject({
      devDependencies: {
        '@doxbrix/doxloop': `^${corePackage.version}`,
        '@doxbrix/doxloop-generator-mkdocs': `^${generatorPackage.version}`,
      },
    })
  })

  test('loads legacy projects with a default documentation brief', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'sample-docs'),
      sources: [],
    })
    const projectPath = join(root, '.doxloop', 'project.json')
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as Record<
      string,
      unknown
    >
    delete project.documentation
    delete project.designReferences
    const { writeFile } = await import('node:fs/promises')
    await writeFile(projectPath, `${JSON.stringify(project, null, 2)}\n`)

    expect((await loadProject(root)).documentation).toMatchObject({
      locale: 'en-US',
      standardsProfile: 'doxloop-v1',
      styleGuide: 'doxloop',
      accessibilityTarget: 'WCAG 2.2 AA',
    })
    expect((await loadProject(root)).designReferences).toEqual([])
  })

  test('loads optional application screenshot configuration', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'sample-docs'),
      sources: [parseSource('product=../product')],
    })
    const projectPath = join(root, '.doxloop', 'project.json')
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as Record<
      string,
      unknown
    >
    await writeFile(
      projectPath,
      `${JSON.stringify(
        {
          ...project,
          application: {
            baseUrl: 'http://localhost:3000/',
            source: 'product',
            startCommand: 'npm run dev',
            readyPath: '/health',
            screenshots: {
              policy: 'requested',
              viewport: { width: 1440, height: 900 },
              highlight: true,
            },
          },
        },
        null,
        2,
      )}\n`,
    )

    expect((await loadProject(root)).application).toEqual({
      baseUrl: 'http://localhost:3000/',
      source: 'product',
      startCommand: 'npm run dev',
      readyPath: '/health',
      screenshots: {
        policy: 'requested',
        viewport: { width: 1440, height: 900 },
        highlight: true,
      },
    })
  })

  test('rejects unsafe application screenshot configuration', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'sample-docs'),
      sources: [parseSource('product=../product')],
    })
    const projectPath = join(root, '.doxloop', 'project.json')
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as Record<
      string,
      unknown
    >

    await writeFile(
      projectPath,
      `${JSON.stringify({
        ...project,
        application: {
          baseUrl: 'file:///tmp/application.html',
          source: 'missing',
          startCommand: 'npm run dev',
        },
      })}\n`,
    )

    await expect(loadProject(root)).rejects.toThrow('unsupported format')
  })

  test('rejects unsafe design reference URL schemes and embedded credentials', () => {
    expect(() => parseDesignReference('file:///tmp/reference.html')).toThrow(
      'Use an HTTP or HTTPS URL',
    )
    expect(() =>
      parseDesignReference('https://user:secret@example.com/docs'),
    ).toThrow('without embedded credentials')
  })

  test('adds normalized design references without discarding project fields', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'sample-docs'),
      sources: [],
    })
    const projectPath = join(root, '.doxloop', 'project.json')
    const raw = JSON.parse(await readFile(projectPath, 'utf8')) as Record<
      string,
      unknown
    >
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      projectPath,
      `${JSON.stringify({ ...raw, futureSetting: true }, null, 2)}\n`,
    )

    await addDesignReferences(root, [
      parseDesignReference('https://docs.example.com/'),
      parseDesignReference('https://docs.example.com/#overview'),
    ])

    const updated = JSON.parse(await readFile(projectPath, 'utf8')) as Record<
      string,
      unknown
    >
    expect(updated.futureSetting).toBe(true)
    expect(updated.designReferences).toEqual([
      { url: 'https://docs.example.com/' },
    ])
  })

  test('rejects documentation content directories outside the project', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-project-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'sample-docs'),
      sources: [],
    })
    const projectPath = join(root, '.doxloop', 'project.json')
    const project = JSON.parse(await readFile(projectPath, 'utf8')) as Record<
      string,
      unknown
    >
    await writeFile(
      projectPath,
      `${JSON.stringify({ ...project, contentDir: '../outside' }, null, 2)}\n`,
    )

    await expect(loadProject(root)).rejects.toThrow('unsupported format')
  })
})
