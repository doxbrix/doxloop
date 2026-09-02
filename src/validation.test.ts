import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { scaffoldProject } from './project.js'
import { validateProject } from './validation.js'

const roots: string[] = []

afterEach(async () => {
  const { rm } = await import('node:fs/promises')
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-validation-'))
  roots.push(parent)
  return scaffoldProject({ directory: join(parent, 'docs'), sources: [] })
}

describe('validateProject', () => {
  test('blocks the generated starter project from release', async () => {
    const root = await fixture()
    const result = await validateProject(root)
    expect(result.issues.map((issue) => issue.code)).toContain('starter-content')
    expect(result.pages).toEqual(['index', 'quickstart'])
  })

  test('finds missing navigation pages and broken links', async () => {
    const root = await fixture()
    const config = JSON.parse(
      await readFile(join(root, 'docs.json'), 'utf8'),
    ) as {
      spaces: Array<{
        nav: Array<{ type: string; items: Array<Record<string, unknown>> }>
      }>
    }
    config.spaces[0]?.nav[0]?.items.push({ type: 'page', file: 'missing' })
    await writeFile(
      join(root, 'docs.json'),
      `${JSON.stringify(config, null, 2)}\n`,
    )
    await writeFile(
      join(root, 'index.mdx'),
      '---\ntitle: Home\ndescription: Find a missing page.\n---\n\n[Missing](./does-not-exist.md)\n',
    )
    const result = await validateProject(root)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['missing-page', 'broken-link']),
    )
  })

  test('validates a captioned guide screenshot asset', async () => {
    const root = await fixture()
    const pagePath = join(root, 'index.mdx')
    await writeFile(
      pagePath,
      `---
title: Invite a team member
description: Invite a teammate from team settings.
---

1. Open **Settings**, then select **Invite member**.

<Frame caption="The highlighted control opens the invitation form.">

![Team settings with Invite member marked as step 1](/assets/guides/invite-team-member/01-team-settings.png)

</Frame>
`,
    )

    const missing = await validateProject(root)
    expect(missing.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'broken-link', file: 'index.mdx' }),
      ]),
    )

    const assets = join(
      root,
      'assets',
      'guides',
      'invite-team-member',
    )
    await mkdir(assets, { recursive: true })
    await writeFile(join(assets, '01-team-settings.png'), 'png fixture')

    const present = await validateProject(root)
    expect(
      present.issues.filter((issue) =>
        ['broken-link', 'missing-image-alt', 'component-tag'].includes(issue.code),
      ),
    ).toHaveLength(0)
  })

  test('does not treat project files outside content as documentation assets', async () => {
    const root = await fixture()
    await writeFile(
      join(root, 'index.mdx'),
      `---
title: Unsafe asset
description: Demonstrate an invalid asset reference.
---

![A file outside documentation content](../package.json)
`,
    )

    const result = await validateProject(root)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: 'broken-link', file: 'index.mdx' }),
      ]),
    )
  })

  test('validates a generated Docusaurus project', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-validation-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'docs'),
      sources: [],
      generator: 'docusaurus',
    })

    const result = await validateProject(root)
    expect(
      result.issues
        .filter((issue) => issue.code !== 'starter-content')
        .filter((issue) => issue.severity === 'error'),
    ).toHaveLength(0)
    expect(result.pages).toEqual(['index', 'quickstart'])
  })

  test('resolves Docusaurus guide screenshots from its public asset directory', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-validation-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'docs'),
      sources: [],
      generator: 'docusaurus',
    })
    const pagePath = join(root, 'docs', 'index.md')
    await writeFile(
      pagePath,
      `---
title: Configure the workspace
description: Configure the workspace from application settings.
---

Open **Settings**.

![Workspace settings with Save marked as step 1](/img/guides/configure-workspace/01-settings.png)
`,
    )

    const missing = await validateProject(root)
    expect(missing.issues.map((issue) => issue.code)).toContain('broken-link')

    const assets = join(
      root,
      'static',
      'img',
      'guides',
      'configure-workspace',
    )
    await mkdir(assets, { recursive: true })
    await writeFile(join(assets, '01-settings.png'), 'png fixture')

    const present = await validateProject(root)
    expect(present.issues.map((issue) => issue.code)).not.toContain('broken-link')
  })

  test('validates MkDocs navigation through the installed adapter', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-validation-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'docs'),
      sources: [],
      generator: 'mkdocs',
    })

    const valid = await validateProject(root)
    expect(
      valid.issues
        .filter((issue) => issue.code !== 'starter-content')
        .filter((issue) => issue.severity === 'error'),
    ).toHaveLength(0)
    expect(valid.pages).toEqual(['index', 'quickstart'])

    const config = await readFile(join(root, 'mkdocs.yml'), 'utf8')
    await writeFile(
      join(root, 'mkdocs.yml'),
      config.replace(
        '  - Quickstart: quickstart.md',
        '  - Quickstart: quickstart.md\n  - Missing: missing.md',
      ),
    )
    const invalid = await validateProject(root)
    expect(invalid.issues.map((issue) => issue.code)).toContain('missing-page')
  })

  test('detects unbalanced Doxbrix component tags', async () => {
    const root = await fixture()
    await writeFile(
      join(root, 'index.mdx'),
      '---\ntitle: Home\ndescription: Complete a task.\n---\n\n<Steps><Step title="One">Content</Steps>\n',
    )

    const result = await validateProject(root)
    expect(result.issues.map((issue) => issue.code)).toContain('component-tag')
  })

  test('rejects an ApiEndpoint opening tag that borrows a child delimiter', async () => {
    const root = await fixture()
    await writeFile(
      join(root, 'index.mdx'),
      `---
title: List projects
description: List accessible projects.
---

<ApiEndpoint
  method="GET"
  path="/projects"
  baseUrl="https://api.example.com/v1"
  summary="List projects"
  description="Returns a page of projects."
<Param name="limit" in="query" type="integer" example="50">Maximum results.</Param>
<Response status={200} contentType="application/json" description="Projects listed">
{ "data": [] }
</Response>
</ApiEndpoint>
`,
    )

    const result = await validateProject(root)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'component-tag',
          message: expect.stringContaining('opening tag is missing ">" before'),
        }),
      ]),
    )
  })

  test('requires Doxbrix component opening tags on one physical line', async () => {
    const root = await fixture()
    await writeFile(
      join(root, 'index.mdx'),
      `---
title: List projects
description: List accessible projects.
---

<ApiEndpoint
  method="GET"
  path="/projects"
>
<Response status={200} contentType="application/json" description="Projects listed">
{ "data": [] }
</Response>
</ApiEndpoint>
`,
    )

    const result = await validateProject(root)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'component-tag',
          message: expect.stringContaining('must end with ">" on the same line'),
        }),
      ]),
    )
  })

  test('ignores Doxbrix component examples inside code spans and fences', async () => {
    const root = await fixture()
    await writeFile(
      join(root, 'index.mdx'),
      `---
title: Component syntax
description: Learn how component syntax works.
---

Write \`<ApiEndpoint>\` for an endpoint.

\`\`\`mdx
<ApiEndpoint
  method="GET"
</ApiEndpoint>
\`\`\`
`,
    )

    const result = await validateProject(root)
    expect(
      result.issues.filter((issue) => issue.code === 'component-tag'),
    ).toHaveLength(0)
  })

  test('enforces the native Doxbrix ApiEndpoint contract', async () => {
    const root = await fixture()
    await writeFile(
      join(root, 'index.mdx'),
      `---
title: List projects
description: List accessible projects.
---

<ApiEndpoint method="FETCH" path="projects/{projectId}">
<Param name="projectId" in="path">Project identifier.</Param>
</ApiEndpoint>
`,
    )

    const result = await validateProject(root)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'api-endpoint-method',
        'api-endpoint-path',
        'api-endpoint-base-url',
        'api-endpoint-param',
        'api-endpoint-path-param',
        'api-endpoint-response',
      ]),
    )
  })

  test('accepts a complete native Doxbrix ApiEndpoint block', async () => {
    const root = await fixture()
    await writeFile(
      join(root, 'index.mdx'),
      `---
title: Get project
description: Retrieve one project.
---

<ApiEndpoint method="GET" path="/projects/{projectId}" baseUrl="https://api.example.com/v1" summary="Get project" description="Returns one project.">
<Param name="Authorization" in="header" type="string" required example="Bearer api_test_example">Bearer token.</Param>
<Param name="projectId" in="path" type="string" required example="prj_01H9">Project identifier.</Param>
<Response status={200} contentType="application/json" description="Project returned">
{ "id": "prj_01H9" }
</Response>
</ApiEndpoint>
`,
    )

    const result = await validateProject(root)
    expect(
      result.issues.filter((issue) => issue.code.startsWith('api-endpoint-')),
    ).toHaveLength(0)
  })

  test('validates Doxbrix brand colors and local assets', async () => {
    const root = await fixture()
    const configPath = join(root, 'docs.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      theme: Record<string, unknown>
    }
    config.theme.primaryColor = 'indigo'
    config.theme.logoLight = '/assets/missing-logo.svg'
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

    const result = await validateProject(root)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining(['theme-color', 'missing-theme-asset']),
    )
  })

  test('accepts copied Doxbrix logos and font sources', async () => {
    const root = await fixture()
    await mkdir(join(root, 'assets'))
    await mkdir(join(root, 'fonts'))
    await writeFile(join(root, 'assets', 'logo.svg'), '<svg></svg>')
    await writeFile(join(root, 'fonts', 'brand.woff2'), 'font fixture')

    const configPath = join(root, 'docs.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      theme: Record<string, unknown>
    }
    config.theme.logoLight = '/assets/logo.svg'
    config.theme.font = 'Brand Sans'
    config.theme.fontSources = [
      {
        family: 'Brand Sans',
        source: '/fonts/brand.woff2',
        format: 'woff2',
        weight: 400,
      },
    ]
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

    const result = await validateProject(root)
    expect(
      result.issues.filter((issue) => issue.code !== 'starter-content' && !issue.code.startsWith('thin-')),
    ).toHaveLength(0)
  })

  test('enforces professional release gates and reports editorial warnings', async () => {
    const root = await fixture()
    await writeFile(
      join(root, 'index.mdx'),
      `---
title: Unsafe guide
---

# Unsafe guide

TODO: finish this page.

<img src="/diagram.png">

[Click here](./quickstart.mdx)

## Configure

#### Verify

\`\`\`
example
\`\`\`
`,
    )

    const result = await validateProject(root)
    expect(result.issues.map((issue) => issue.code)).toEqual(
      expect.arrayContaining([
        'missing-description',
        'unresolved-placeholder',
        'missing-image-alt',
        'weak-link-text',
        'heading-order',
        'code-language',
      ]),
    )
  })

  test('treats duplicate and missing Doxbrix navigation as errors', async () => {
    const root = await fixture()
    const configPath = join(root, 'docs.json')
    const config = JSON.parse(await readFile(configPath, 'utf8')) as {
      spaces: Array<{
        nav: Array<{ items: Array<Record<string, unknown>> }>
      }>
    }
    config.spaces[0]?.nav[0]?.items.push({ type: 'page', file: 'index' })
    config.spaces[0]!.nav[0]!.items = config.spaces[0]!.nav[0]!.items.filter(
      (item) => item.file !== 'quickstart',
    )
    await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`)

    const result = await validateProject(root)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: 'error',
          code: 'duplicate-navigation',
        }),
        expect.objectContaining({
          severity: 'error',
          code: 'unnavigated-page',
        }),
      ]),
    )
  })
})

describe('evidence map validation', () => {
  async function withEvidenceMap(pages: Record<string, unknown>): Promise<string> {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-validation-'))
    roots.push(parent)
    const root = await scaffoldProject({
      directory: join(parent, 'docs-project'),
      sources: [{ name: 'product', path: '../product' }],
    })
    await writeFile(
      join(root, '.doxloop', 'evidence-map.json'),
      `${JSON.stringify({ schemaVersion: 1, pages }, null, 2)}\n`,
    )
    return root
  }

  test('reports nothing for a project without an evidence map', async () => {
    const root = await fixture()

    const codes = (await validateProject(root)).issues.map((issue) => issue.code)

    expect(codes.filter((code) => code.startsWith('evidence'))).toEqual([])
  })

  test('accepts a map that covers every page', async () => {
    const root = await withEvidenceMap({
      'index.mdx': { sources: [{ source: 'product', paths: ['src'] }] },
      'quickstart.mdx': { sources: [{ source: 'product', paths: ['src'] }] },
    })

    const codes = (await validateProject(root)).issues.map((issue) => issue.code)

    expect(codes.filter((code) => code.startsWith('evidence'))).toEqual([])
  })

  test('warns about a page the map does not cover', async () => {
    const root = await withEvidenceMap({
      'index.mdx': { sources: [{ source: 'product', paths: ['src'] }] },
    })

    const result = await validateProject(root)

    const missing = result.issues.find(
      (issue) => issue.code === 'evidence-map-missing-page',
    )
    expect(missing?.severity).toBe('warning')
    expect(missing?.file).toBe('quickstart.mdx')
  })

  test('warns about an entry for a page that no longer exists', async () => {
    const root = await withEvidenceMap({
      'index.mdx': { sources: [{ source: 'product' }] },
      'quickstart.mdx': { sources: [{ source: 'product' }] },
      'removed.mdx': { sources: [{ source: 'product' }] },
    })

    const result = await validateProject(root)

    expect(
      result.issues.find((issue) => issue.code === 'evidence-map-orphan')?.message,
    ).toContain('removed.mdx')
  })

  test('warns about an entry bound to an unconfigured source', async () => {
    const root = await withEvidenceMap({
      'index.mdx': { sources: [{ source: 'legacy' }] },
      'quickstart.mdx': { sources: [{ source: 'product' }] },
    })

    const result = await validateProject(root)

    expect(
      result.issues.find((issue) => issue.code === 'evidence-map-unknown-source')
        ?.message,
    ).toContain('"legacy"')
  })

  test('surfaces a page the agent could not verify', async () => {
    const root = await withEvidenceMap({
      'index.mdx': { sources: [{ source: 'product' }], confidence: 'needs-human' },
      'quickstart.mdx': { sources: [{ source: 'product' }] },
    })

    const result = await validateProject(root)

    const unverified = result.issues.find((issue) => issue.code === 'evidence-unverified')
    expect(unverified?.severity).toBe('warning')
    expect(unverified?.file).toBe('index.mdx')
  })

  test('never fails validation for evidence-map coverage alone', async () => {
    const root = await withEvidenceMap({
      'removed.mdx': { sources: [{ source: 'legacy' }] },
    })

    const result = await validateProject(root)

    for (const issue of result.issues.filter((issue) => issue.code.startsWith('evidence'))) {
      expect(issue.severity).toBe('warning')
    }
  })
})

describe('page depth gate', () => {
  test('reports thin pages and shallow procedures as warnings, never errors', async () => {
    const root = await fixture()
    await mkdir(join(root, 'guides'), { recursive: true })
    await writeFile(
      join(root, 'guides', 'deploy.mdx'),
      `---
title: Deploy documentation
description: Publish the site.
---

# Deploy documentation

<Steps>
<Step title="Open Deploy">
Open **Deploy** and select **Publish**.
</Step>
</Steps>
`,
    )
    await writeFile(
      join(root, 'guides', 'complete.mdx'),
      `---
title: Configure monitoring
description: Schedule drift checks for a remote source.
---

# Configure monitoring

${'This guide walks an administrator through configuring a monitoring schedule for a remote read-only source, choosing budgets, and verifying the first run. '.repeat(12)}

<Steps>
<Step title="Open Sources">
Open **Sources** and select **Monitoring**. The dialog lists the remote source and its schedule.
</Step>
<Step title="Choose a schedule">
Select **Every day** and enter a budget of 20 minutes. The summary updates.
</Step>
<Step title="Save">
Select **Save monitoring**. The schedule badge shows the next run time.
</Step>
</Steps>

Next, [review the first proposal](/guides/review).
`,
    )

    const result = await validateProject(root)
    const deploy = result.issues.filter((issue) => issue.file === 'guides/deploy.mdx')
    expect(deploy.map((issue) => issue.code)).toEqual(expect.arrayContaining(['thin-page', 'thin-procedure']))
    expect(deploy.filter((issue) => issue.code.startsWith('thin-')).every((issue) => issue.severity === 'warning')).toBe(true)
    const complete = result.issues.filter((issue) => issue.file === 'guides/complete.mdx' && issue.code.startsWith('thin-'))
    expect(complete).toEqual([])
  })
})
