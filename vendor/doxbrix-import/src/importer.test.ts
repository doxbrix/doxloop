import { describe, expect, it } from 'vitest'
import { convertSourceTree, decodeImportedSvgIconDataUrl, materializeMintlifyOpenApiNavigation, transformMintlifyMdx } from './importer.js'

describe('convertSourceTree — Mintlify', () => {
  it('preserves all locales and versions and imports the complete brand shell', () => {
    const result = convertSourceTree([
      {
        path: 'docs.json',
        content: JSON.stringify({
          theme: 'maple',
          name: 'Acme',
          description: 'Acme docs',
          colors: { primary: '#abc', light: '#112233', dark: '#445566' },
          appearance: { default: 'dark', strict: true },
          fonts: { body: { family: 'Inter' }, heading: { family: 'Sora', source: '/fonts/sora.woff2', format: 'woff2', weight: 700 }, code: { family: 'JetBrains Mono', source: '/fonts/code.woff2', format: 'woff2' } },
          styling: { codeblocks: { theme: { light: 'github-light', dark: 'dark-plus' } } },
          logo: { light: '/img/light.svg', dark: '/img/dark.svg', href: 'https://acme.test' },
          favicon: { light: '/fav-light.svg', dark: '/fav-dark.svg' },
          background: { color: { light: '#f2f3f4', dark: '#151617' } },
          api: {
            openapi: ['openapi.json', { source: 'https://api.example.com/v2.json' }],
            mdx: { server: 'https://api.acme.test' },
          },
          navbar: { links: [{ label: 'Status', href: 'https://status.test' }], primary: { type: 'button', label: 'Console', href: 'https://app.test' } },
          footer: { links: [{ header: 'Company', items: [{ label: 'About', href: '/about' }] }], socials: { github: 'https://github.com/acme' } },
          banner: { content: '**New:** v2', dismissible: true, type: 'warning' },
          navigation: {
            languages: [
              { language: 'en', versions: [{ version: 'v2', tag: 'Latest', groups: [{ group: 'Start', pages: ['intro'] }] }, { version: 'v1', tag: 'Deprecated', groups: [{ group: 'Start', pages: ['v1/intro'] }] }] },
              { language: 'fr', groups: [{ group: 'Début', pages: ['fr/intro'] }] },
            ],
          },
        }),
      },
      { path: 'intro.mdx', content: '# Hello' },
      { path: 'v1/intro.mdx', content: '# Old' },
      { path: 'fr/intro.mdx', content: '# Bonjour' },
    ])
    expect(result.dialect).toBe('mintlify')
    expect(result.manifest.theme?.source).toBe('doxbrix-import')
    expect(result.manifest.spaces).toHaveLength(3)
    expect(result.manifest.spaces.map((space) => space.locale)).toEqual(['en', 'en', 'fr'])
    // Versions become first-class entries, not name-suffixed sibling spaces.
    expect(result.manifest.versions).toEqual([
      { version: 'v2', label: 'v2', tag: 'Latest', isDefault: true },
      { version: 'v1', label: 'v1', tag: 'Deprecated' },
    ])
    // The versioned spaces carry their version and keep clean, unsuffixed names.
    const versionedSpaces = result.manifest.spaces.filter((space) => space.locale === 'en')
    expect(versionedSpaces.map((space) => space.version)).toEqual(['v2', 'v1'])
    // Names no longer carry the version label as a suffix (locale suffix stays).
    expect(versionedSpaces.every((space) => !/v[12]/.test(space.name))).toBe(true)
    // The unversioned (French) branch has no version stamp.
    expect(result.manifest.spaces.find((space) => space.locale === 'fr')?.version).toBeUndefined()
    expect(result.manifest.theme).toMatchObject({ preset: 'maple', primaryColor: '#aabbcc', mode: 'dark', strictMode: true, font: 'Inter', headingFont: 'Sora', codeFont: 'JetBrains Mono', codeThemeLight: 'github-light', codeThemeDark: 'dark-plus', backgroundColorLight: '#f2f3f4', backgroundColorDark: '#151617' })
    expect(result.manifest.site?.navbar?.primary?.label).toBe('Console')
    expect(result.manifest.site?.footer?.groups[0]?.title).toBe('Company')
    expect(result.manifest.site?.banner?.content).toBe('**New:** v2')
    expect(result.manifest.openapiSources).toEqual(['openapi.json', 'https://api.example.com/v2.json'])
    expect(result.manifest.apiBaseUrl).toBe('https://api.acme.test')
  })

  it('preserves product-tab icons and Atlas-compatible shell measurements', () => {
    const result = convertSourceTree([
      {
        path: 'docs.json',
        content: JSON.stringify({
          theme: 'mint',
          navigation: { tabs: [{ tab: 'Get started', icon: 'rocket', pages: ['intro'] }, { tab: 'TypeScript SDK', icon: 'js', tag: 'Coming soon', pages: ['typescript'] }, { tab: 'REST API', openapi: 'openapi.yaml', groups: [{ group: 'Start', pages: ['api-intro'] }] }] },
        }),
      },
      { path: 'intro.mdx', content: '# Intro' },
      { path: 'typescript.mdx', content: '# TypeScript' },
      { path: 'api-intro.mdx', content: '# API intro' },
      { path: 'openapi.yaml', content: 'openapi: 3.0.0\npaths: {}' },
      { path: 'docs/docs.json', content: JSON.stringify({ version: 1, spaces: [] }) },
      { path: 'README.md', content: '# Repository instructions' },
      { path: '.agents/skills/example.md', content: '# Agent-only instructions\n<UnknownAgentComponent />' },
    ])

    expect(result.dialect).toBe('mintlify')
    expect(result.manifest.spaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'Get started', icon: 'rocket' }),
      expect.objectContaining({ name: 'TypeScript SDK', icon: 'js', tag: 'Coming soon' }),
      expect.objectContaining({
        name: 'REST API',
        nav: expect.arrayContaining([{ type: 'api', title: 'API Reference', spec: 'openapi.yaml' }]),
      }),
    ]))
    expect(result.manifest.theme?.layout).toMatchObject({ headerHeight: 64, tabsHeight: 48, shellMaxWidth: 1472, sidebarWidth: 288, tocWidth: 264, contentMaxWidth: 920, contentPadding: 32, navPadding: 32 })
    expect(result.manifest.theme).toMatchObject({
      font: 'Inter',
      headingFont: 'Inter',
      typography: {
        titleWeight: 600,
        titleSize: 36,
        titleSizeMobile: 30,
        descriptionSize: 18,
        bodyWeight: 400,
        bodySize: 16,
        bodyLineHeight: 1.75,
        fontFeatures: ['cv02', 'cv03', 'cv04', 'cv11'],
        fontVariationSettings: 'normal',
        fontSmoothing: 'antialiased',
        headingWeight: 600,
        h2Size: 24,
        h3Size: 20,
        h4Size: 18,
        strongWeight: 600,
        apiFieldWeight: 600,
      },
      textColors: {
        light: { heading: '#171717', body: '#3f3f3f', muted: '#505050' },
        dark: { heading: '#dfdfdf', body: '#cecece', muted: '#9f9f9f' },
      },
    })
    expect(result.pages.map((page) => page.path)).toEqual(['intro.mdx', 'typescript.mdx', 'api-intro.mdx'])
    expect(result.unmapped).toEqual([])
  })

  it('materializes a remote OpenAPI document nested inside a Mintlify group', async () => {
    const specUrl = 'https://raw.githubusercontent.com/acme/api/main/openapi.json'
    const converted = convertSourceTree([
      {
        path: 'docs.json',
        content: JSON.stringify({
          name: 'Lightdash',
          navigation: {
            tabs: [{
              tab: 'API',
              groups: [
                { group: 'API', pages: ['api-reference/v1/introduction', 'api-reference/v1/recipes'] },
                { group: 'Reference', openapi: specUrl },
              ],
            }],
          },
        }),
      },
      { path: 'api-reference/v1/introduction.mdx', content: '---\ntitle: Lightdash API\n---\n' },
      { path: 'api-reference/v1/recipes.mdx', content: '---\ntitle: Recipes\n---\n' },
    ])

    const apiSpace = converted.manifest.spaces.find((space) => space.name === 'API')
    expect(apiSpace?.nav[1]).toEqual({
      type: 'group',
      label: 'Reference',
      items: [{ type: 'api', title: 'API Reference', spec: specUrl }],
    })
    expect(converted.manifest.openapiSources).toContain(specUrl)

    const loaded: string[] = []
    const expanded = await materializeMintlifyOpenApiNavigation({
      result: converted,
      files: [],
      loadRemote: async (url) => {
        loaded.push(url)
        return JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'Lightdash API', version: '1' },
          servers: [{ url: 'https://api.lightdash.test' }],
          paths: {
            '/projects': {
              get: { operationId: 'list-projects', summary: 'List projects', tags: ['Projects'], responses: { '200': { description: 'Success' } } },
              post: { operationId: 'create-project', summary: 'Create project', tags: ['Projects'], responses: { '201': { description: 'Created' } } },
            },
          },
        })
      },
    })

    expect(loaded).toEqual([specUrl])
    expect(expanded.warnings).toEqual([])
    const reference = expanded.result.manifest.spaces.find((space) => space.name === 'API')?.nav[1]
    expect(reference).toMatchObject({
      type: 'group',
      label: 'Reference',
      items: [{
        type: 'group',
        label: 'Projects',
        items: [
          { type: 'page', title: 'List projects' },
          { type: 'page', title: 'Create project' },
        ],
      }],
    })
    expect(expanded.result.pages.map((page) => page.path)).toEqual(expect.arrayContaining([
      '__openapi__/api-reference/projects/list-projects.mdx',
      '__openapi__/api-reference/projects/create-project.mdx',
    ]))
  })

  it('resolves operation selectors from a Mintlify OpenAPI object without treating them as files', async () => {
    const specUrl = 'https://api.apitally.test/openapi.json'
    const operations = [
      'GET /v1/apps',
      'GET /v1/apps/{app_id}/consumers',
      'GET /v1/apps/{app_id}/request-logs/{request_uuid}',
    ]
    const converted = convertSourceTree([
      {
        path: 'docs.json',
        content: JSON.stringify({
          name: 'ApiTally',
          navigation: {
            anchors: [{
              anchor: 'API reference',
              openapi: { source: specUrl, directory: 'api-reference' },
              groups: [
                { group: 'API reference', pages: ['api-reference'] },
                { group: 'Endpoints', pages: operations },
              ],
            }],
          },
        }),
      },
      { path: 'api-reference.mdx', content: '---\ntitle: API reference\n---\n' },
    ])

    expect(converted.manifest.openapiSources).toContain(specUrl)
    expect(converted.manifest.spaces[0]?.nav).toContainEqual({
      type: 'api',
      title: 'API Reference',
      spec: specUrl,
    })

    const expanded = await materializeMintlifyOpenApiNavigation({
      result: converted,
      files: [],
      loadRemote: async () => JSON.stringify({
        openapi: '3.1.0',
        info: { title: 'ApiTally API', version: '1' },
        paths: {
          '/v1/apps': {
            get: { operationId: 'list-apps', summary: 'List apps', tags: ['Apps'], responses: { '200': { description: 'Success' } } },
          },
          '/v1/apps/{app_id}/consumers': {
            get: { operationId: 'list-consumers', summary: 'List consumers', tags: ['Consumers'], responses: { '200': { description: 'Success' } } },
          },
          '/v1/apps/{app_id}/request-logs/{request_uuid}': {
            get: { operationId: 'get-request-log', summary: 'Get request log', tags: ['Request logs'], responses: { '200': { description: 'Success' } } },
          },
        },
      }),
    })

    expect(expanded.warnings).toEqual([])
    const endpointGroup = expanded.result.manifest.spaces[0]?.nav.find(
      (node) => node.type === 'group' && node.label === 'Endpoints',
    )
    expect(endpointGroup).toMatchObject({
      type: 'group',
      label: 'Endpoints',
      items: [
        { type: 'page', title: 'List apps' },
        { type: 'page', title: 'List consumers' },
        { type: 'page', title: 'Get request log' },
      ],
    })
    expect(expanded.result.manifest.spaces[0]?.nav.some((node) => node.type === 'api')).toBe(false)
    const generatedFiles = new Set(expanded.result.pages.map((page) => page.path.replace(/\.mdx?$/i, '')))
    if (endpointGroup?.type === 'group') {
      expect(endpointGroup.items.every((node) => node.type !== 'page' || generatedFiles.has(node.file))).toBe(true)
      expect(endpointGroup.items.every((node) => node.type !== 'page' || !/^GET\s/.test(node.file))).toBe(true)
    }

    const unavailable = await materializeMintlifyOpenApiNavigation({
      result: converted,
      files: [],
      loadRemote: async () => null,
    })
    expect(unavailable.warnings).toEqual([`Could not load OpenAPI spec ${specUrl}.`])
    const unavailableEndpointGroup = unavailable.result.manifest.spaces[0]?.nav.find(
      (node) => node.type === 'group' && node.label === 'Endpoints',
    )
    expect(unavailableEndpointGroup?.type === 'group' && unavailableEndpointGroup.items.every(
      (node) => node.type !== 'page' || !/^GET\s/.test(node.file),
    )).toBe(true)
    expect(unavailable.result.manifest.spaces[0]?.nav.some((node) => node.type === 'api')).toBe(true)
  })

  it('preserves inline SVG card icons without leaving unmapped SVG constructs', () => {
    const result = convertSourceTree([
      {
        path: 'docs.json',
        content: JSON.stringify({ navigation: { pages: ['quickstart'] } }),
      },
      {
        path: 'quickstart.mdx',
        content: [
          '---',
          'title: Quickstart',
          'description: Choose a framework.',
          '---',
          '<Card title="JavaScript" icon={',
          '  <svg width="24" height="24" viewBox="0 0 24 24" onload="alert(1)">',
          '    <defs><linearGradient id="brand"><stop stop-color="#f7df1e" /></linearGradient></defs>',
          '    <rect width="24" height="24" fill="url(#brand)" />',
          '    <path d="M4 4h16v16H4z" />',
          '    <script>alert(1)</script>',
          '  </svg>',
          '} href="/javascript">Start with JavaScript.</Card>',
        ].join('\n'),
      },
    ])

    const page = result.pages[0]?.markdown ?? ''
    const encoded = /icon="(data:image\/svg\+xml,[^"]+)"/.exec(page)?.[1]
    expect(encoded).toBeDefined()
    expect(decodeURIComponent(encoded ?? '')).toContain('<linearGradient id="brand">')
    expect(decodeURIComponent(encoded ?? '')).not.toMatch(/<script|onload=/i)
    expect(page).not.toMatch(/<\/?(?:svg|defs|linearGradient|stop|rect|path)\b/i)
    expect(result.unmapped).toEqual([])
  })

  it('inlines imported React SVG icon components as safe portable card icons', () => {
    const result = convertSourceTree([
      {
        path: 'docs.json',
        content: JSON.stringify({ navigation: { pages: ['chains'] } }),
      },
      {
        path: 'chains.mdx',
        content: [
          '---',
          'title: Chains',
          '---',
          'import { IconChain } from "/snippets/icons/icon-chain.jsx";',
          '<Card title="Chain" icon={<IconChain />} href="/chain">Supported chain.</Card>',
        ].join('\n'),
      },
      {
        path: 'style.css',
        content: '[data-component-part="card-icon"] svg path { fill: #18171a !important; }\nhtml.dark [data-component-part="card-icon"] svg path { fill: #ffffff !important; }',
      },
      {
        path: 'snippets/icons/icon-chain.jsx',
        content: [
          'export const IconChain = () => {',
          '  return (',
          '    <svg xmlns="http://www.w3.org/2000/svg" width={24} height={24} style={{ color: "red" }} onClick={() => alert(1)}>',
          '      <defs><style>{".cls-1{fill:currentColor;stroke-width:0}"}</style></defs>',
          '      <path className="cls-1" fillRule="evenodd" clipRule="evenodd" d="M0 0h24v24H0z" />',
          '      <script>alert(1)</script>',
          '    </svg>',
          '  );',
          '};',
        ].join('\n'),
      },
    ])

    const page = result.pages[0]?.markdown ?? ''
    const encoded = /icon="(data:image\/svg\+xml,[^"]+)"/.exec(page)?.[1]
    const svg = decodeURIComponent(encoded ?? '')
    expect(encoded).toBeDefined()
    expect(svg).toContain('width="24"')
    expect(svg).toContain('fill-rule="evenodd"')
    expect(svg).toContain('clip-rule="evenodd"')
    expect(svg).toContain('fill="currentColor"')
    expect(svg).toContain('stroke-width="0"')
    expect(svg).toContain('data-doxbrix-force-current-color="true"')
    expect(svg).not.toMatch(/<script|onClick=|style=/i)
    expect(decodeImportedSvgIconDataUrl(encoded ?? '')).toContain('fill="currentColor"')
    expect(page).not.toContain('IconChain')
    expect(result.unmapped).toEqual([])
  })

  it('only decodes sanitized importer SVG data URLs for inline rendering', () => {
    const safe = `data:image/svg+xml,${encodeURIComponent('<svg viewBox="0 0 24 24"><style>body{display:none}</style><path fill="currentColor" d="M0 0h24v24H0z" onload="alert(1)" /></svg>')}`
    const decoded = decodeImportedSvgIconDataUrl(safe)

    expect(decoded).toContain('<svg viewBox="0 0 24 24">')
    expect(decoded).toContain('fill="currentColor"')
    expect(decoded).not.toMatch(/<style|onload=/i)
    expect(decodeImportedSvgIconDataUrl('data:image/png;base64,AAAA')).toBeNull()
    expect(decodeImportedSvgIconDataUrl('data:image/svg+xml,%E0%A4%A')).toBeNull()
  })

  it('does not report component-like syntax inside inline or fenced code', () => {
    const result = convertSourceTree([
      {
        path: 'docs.json',
        content: JSON.stringify({ navigation: { pages: ['reference'] } }),
      },
      {
        path: 'reference.mdx',
        content: [
          '---',
          'title: Reference',
          '---',
          'The `<iframe>` context exposes `<Relayer>` and wraps `<magic.Relayer />` in `<SafeAreaView />`.',
          'Returns `Promise<void>`.',
          '',
          '```tsx',
          'const state = useState<boolean>(false)',
          'return <button>Continue</button>',
          '```',
        ].join('\n'),
      },
    ])

    expect(result.unmapped).toEqual([])
    expect(result.pages[0]?.markdown).toContain('`<iframe>` context exposes `<Relayer>`')
  })

  it('resolves config refs, variables, and reusable MDX snippets', () => {
    const result = convertSourceTree([
      { path: 'docs.json', content: JSON.stringify({ $ref: './config/base.json', name: 'Overridden' }) },
      { path: 'config/base.json', content: JSON.stringify({ theme: 'mint', colors: { primary: '#123456' }, variables: { product: 'Orbit' }, navigation: { pages: ['intro'] } }) },
      { path: 'snippets/note.mdx', content: '<Tip>Use {product} carefully.</Tip>' },
      { path: 'intro.mdx', content: 'import SharedNote from "/snippets/note.mdx"\n# {product}\n<SharedNote />' },
    ])
    expect(result.manifest.name).toBe('Overridden')
    expect(result.pages[0]?.markdown).toContain('# Orbit')
    expect(result.pages[0]?.markdown).toContain('<Tip>Use Orbit carefully.</Tip>')
    expect(result.pages[0]?.markdown).not.toContain('SharedNote')
  })

  it('expands lower-camel and nested reusable MDX snippets', () => {
    const result = convertSourceTree([
      { path: 'docs.json', content: JSON.stringify({ navigation: { pages: ['overview'] } }) },
      { path: 'overview.mdx', content: '---\ntitle: Overview\n---\nimport integrationOverview from "/snippets/overview.mdx";\n<integrationOverview />' },
      { path: 'snippets/overview.mdx', content: 'import sharedNotice from "./notice.mdx";\n## Integrations\n\n<sharedNotice />' },
      { path: 'snippets/notice.mdx', content: '<Info>Connect a supported provider.</Info>' },
    ])

    const page = result.pages.find((candidate) => candidate.path === 'overview.mdx')?.markdown ?? ''
    expect(page).toContain('## Integrations')
    expect(page).toContain('<Info>Connect a supported provider.</Info>')
    expect(page).not.toContain('integrationOverview')
    expect(page).not.toContain('sharedNotice')
    expect(result.unmapped).toEqual([])
  })

  it('normalizes imported page metadata, heading hierarchy, and root image paths', () => {
    const result = convertSourceTree([
      { path: 'docs.json', content: JSON.stringify({ navigation: { pages: ['guide'] } }) },
      {
        path: 'guide.mdx',
        content: '---\ntitle: Guide\n---\n\n# First workflow\n\nFollow this workflow to configure the integration for your organization.\n\n![Consent](images/consent.png)\n',
      },
    ])
    const page = result.pages[0]?.markdown ?? ''
    expect(page).toContain('description: "Follow this workflow to configure the integration for your organization."')
    expect(page).toContain('## First workflow')
    expect(page).not.toMatch(/^# First workflow/m)
    expect(page).toContain('![Consent](/images/consent.png)')
  })

  it('materializes page-level OpenAPI operations into portable endpoint MDX', () => {
    const result = convertSourceTree([
      {
        path: 'docs.json',
        content: JSON.stringify({
          api: { mdx: { server: 'https://api.acme.test' } },
          navigation: { groups: [{ group: 'REST API', pages: ['reference/create-widget'] }] },
        }),
      },
      {
        path: 'reference/create-widget.mdx',
        content: '---\ntitle: Create widget\nopenapi: "POST /widgets"\n---\n\n<RequestExample>\n```bash cURL\ncurl https://api.acme.test/widgets\n```\n</RequestExample>\n\n## Notes\n\nCustom behavior.\n',
      },
      {
        path: 'openapi.json',
        content: JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'Widgets', version: '1' },
          paths: {
            '/widgets': {
              post: {
                summary: 'Create widget',
                description: 'Creates a widget.\n\nUse a unique name.',
                requestBody: {
                  required: true,
                  content: {
                    'application/json': {
                      schema: {
                        type: 'object',
                        required: ['name'],
                        properties: { name: { type: 'string', description: 'Widget\nname' } },
                      },
                    },
                  },
                },
                responses: {
                  '201': {
                    description: 'Created\nsuccessfully',
                    content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' } } } } },
                  },
                },
              },
            },
          },
        }),
      },
    ])

    const page = result.pages.find((candidate) => candidate.path === 'reference/create-widget.mdx')?.markdown ?? ''
    expect(page).toContain('<ApiEndpoint method="POST" path="/widgets" baseUrl="https://api.acme.test"')
    expect(page).toContain('description="Creates a widget. Use a unique name."')
    expect(page).toContain('<Param name="name" in="body" type="string" required example="&lt;string&gt;">Widget name</Param>')
    expect(page).toContain('<Response status="201" contentType="application/json" description="Created successfully">')
    expect(page).toContain('## Notes\n\nCustom behavior.')
    expect(page.indexOf('<ApiEndpoint')).toBeLessThan(page.indexOf('<RequestExample>'))
    expect(page.indexOf('<RequestExample>')).toBeLessThan(page.indexOf('<Param name="name"'))
    expect(page.indexOf('</ApiEndpoint>')).toBeLessThan(page.indexOf('## Notes'))
    expect(page.match(/<RequestExample>/g)).toHaveLength(1)
  })

  it('preserves tab/anchor hierarchy, group roots, nested specs, and reusable components', () => {
    const result = convertSourceTree([
      {
        path: 'docs.json',
        content: JSON.stringify({
          navigation: {
            tabs: [
              { tab: 'Hub Guides', pages: ['integrations'] },
              {
                tab: 'Legacy Unified APIs',
                anchors: [
                  { anchor: 'Getting Started', icon: 'key', pages: ['legacy/introduction'] },
                  {
                    anchor: 'HRIS',
                    icon: 'users',
                    pages: [{ group: 'Unified HRIS API', root: 'hris/introduction', pages: ['hris/first-request', { group: 'API Reference', pages: ['hris/api-reference/list-employees'] }] }],
                  },
                ],
              },
            ],
          },
        }),
      },
      { path: 'integrations.mdx', content: '---\ntitle: Integrations\n---\nimport { IntegrationTile } from "/snippets/integration-tile.mdx"\n<IntegrationTile logo={\'https://logos.test/one.png\'} title={\'One\'} link={\'/one\'} />' },
      { path: 'snippets/integration-tile.mdx', content: 'export const IntegrationTile = ({ logo, title, link }) => (<a href={link}><img src={logo} alt={title} /></a>);' },
      { path: 'legacy/introduction.mdx', content: '---\ntitle: Legacy\ndescription: Legacy APIs.\n---\nLegacy.' },
      { path: 'hris/introduction.mdx', content: '---\ntitle: HRIS\ndescription: HRIS overview.\n---\nOverview.' },
      { path: 'hris/first-request.mdx', content: '---\ntitle: First request\ndescription: Make a request.\n---\nRequest.' },
      { path: 'hris/api-reference/list-employees.mdx', content: '---\nopenapi: "GET /employees"\n---\n' },
      {
        path: 'hris/api-reference/hris.json',
        content: JSON.stringify({
          openapi: '3.1.0',
          info: { title: 'HRIS', version: '1' },
          paths: { '/employees': { get: { summary: 'List employees', description: 'Returns employees.', responses: { '200': { description: 'Success' } } } } },
        }),
      },
    ])

    expect(result.manifest.spaces.map((space) => space.name)).toEqual(['Hub Guides', 'Legacy Unified APIs'])
    const legacy = result.manifest.spaces[1]!
    expect(legacy.nav).toEqual([
      expect.objectContaining({ type: 'group', label: 'Getting Started', icon: 'key' }),
      expect.objectContaining({ type: 'group', label: 'HRIS', icon: 'users' }),
    ])
    const hris = legacy.nav[1]
    expect(hris.type).toBe('group')
    if (hris.type !== 'group') throw new Error('Expected HRIS group')
    const unified = hris.items[0]
    expect(unified).toMatchObject({ type: 'group', label: 'Unified HRIS API' })
    if (unified?.type !== 'group') throw new Error('Expected Unified HRIS API group')
    expect(unified.items[0]).toEqual({ type: 'page', file: 'hris/introduction' })

    const integrations = result.pages.find((page) => page.path === 'integrations.mdx')?.markdown ?? ''
    expect(integrations).toContain('<Tile title="One" href="/one" image="https://logos.test/one.png" />')
    const endpoint = result.pages.find((page) => page.path === 'hris/api-reference/list-employees.mdx')?.markdown ?? ''
    expect(endpoint).toContain('title: "List employees"')
    expect(endpoint).toContain('description: "Returns employees."')
    expect(endpoint).toContain('<ApiEndpoint method="GET" path="/employees"')
    expect(result.unmapped).toEqual([])
  })
})

describe('transformMintlifyMdx', () => {
  it('preserves imported Field components as portable inline table content', () => {
    const source = [
      'import { Field } from "/snippets/field.jsx";',
      '',
      '| Field | Description |',
      '|---|---|',
      '| <Field name="id" type="string" required /> | Stable identifier. |',
      '| <Field name="title" type="string" recommended /> | Display title. |',
      '| <Field name="<source_id>" type="&#x22;knowledge&#x22; or &#x22;memory&#x22;" /> | Dynamic key. |',
      '| <Field name="mode" type="string | null" /> | Optional mode. |',
    ].join('\n')

    const output = transformMintlifyMdx(source)
    expect(output).toContain('| `id` * `(string)` | Stable identifier. |')
    expect(output).toContain('| `title` ● `(string)` | Display title. |')
    expect(output).toContain('| `<source_id>` `("knowledge" or "memory")` | Dynamic key. |')
    expect(output).toContain('| `mode` `(string \\| null)` | Optional mode. |')
    expect(output).not.toContain('<Field')
    expect(output).not.toContain('import { Field }')
  })

  it('drops imported client-only table-of-contents components without an empty callout', () => {
    const output = transformMintlifyMdx([
      'import { TableOfContents } from "/snippets/table-of-contents.jsx";',
      '<Panel>',
      '  <TableOfContents />',
      '</Panel>',
      '## Details',
    ].join('\n'))
    expect(output).not.toContain('TableOfContents')
    expect(output).not.toMatch(/<Info>\s*<\/Info>/)
    expect(output).toContain('## Details')
  })

  it('converts current Mintlify-only components without leaking raw JSX', () => {
    const source = [
      '<Panel><Info>Side note</Info></Panel>',
      '<Prompt description="Try this">Write docs</Prompt>',
      '<Columns cols={2}><Tile title="One" description="Desc" href="/one"><img src="/one.png" alt="One" /></Tile></Columns>',
      '<Tiles cols={3}><Tile title="Two" description="Second" href="/two" /></Tiles>',
      '<View title="JS">JavaScript</View><View title="Python">Python</View>',
      '<Tooltip tip="Extra context">Term</Tooltip>',
      '<Tree><Tree.Folder name="src"><Tree.File name="index.ts" /></Tree.Folder></Tree>',
      '<Color variant="compact"><Color.Item name="brand" value="#123456" /></Color>',
      '<Visibility for="agents">Agent detail</Visibility>',
    ].join('\n')
    const output = transformMintlifyMdx(source)
    expect(output).toContain('<SidePanel>')
    expect(output).toContain('<PromptCard description="Try this">')
    expect(output).toContain('<Tile title="One" description="Desc" href="/one">')
    expect(output).toContain('<Columns cols={3}>')
    expect(output).toContain('<Tile title="Two" description="Second" href="/two" />')
    expect(output).toContain('<ViewSwitcher>')
    expect(output).toContain('<Tooltip tip="Extra context">Term</Tooltip>')
    expect(output).toContain('<Folder name="src">')
    expect(output).toContain('<ColorSwatch name="brand" value="#123456" />')
    expect(output).toMatch(/<Audience for="agents">\s*Agent detail\s*<\/Audience>/)
    expect(output).not.toMatch(/<(?:Panel|Prompt|View|Visibility|Tree|Color)\b/)
  })

  it('converts raw HTML/JSX layouts into portable columns and Markdown', () => {
    const source = [
      "<div style={{ display: 'flex', gap: '1rem' }}>",
      '  {/* Left column */}',
      '  <div style={{ flex: 1 }}>',
      '    <p>Measure carefully and learn more about{\' \'}<a href="https://example.com">the benchmark</a>.</p>',
      '    <ul><li>Explore</li><li>Plan</li></ul>',
      '  </div>',
      '  <div style={{ flex: 1 }}>',
      '    <img src="/demo.gif" alt="Demo" />',
      '  </div>',
      '</div>',
    ].join('\n')

    const output = transformMintlifyMdx(source)
    expect(output).toContain('<Columns>')
    expect(output.match(/<Column>/g)).toHaveLength(2)
    expect(output).toContain('[the benchmark](https://example.com)')
    expect(output).toContain('- Explore\n- Plan')
    expect(output).toContain('![Demo](/demo.gif)')
    expect(output).not.toMatch(/<\/?(?:div|p|ul|li|a)\b|\{\/\*|\{\' \'\}/)
  })

  it('unwraps HTML button elements while preserving their linked label', () => {
    const output = transformMintlifyMdx(
      '<div><a href="https://example.com/pricing"><button className="cta"><span>View pricing</span></button></a></div>',
    )

    expect(output).toContain('[View pricing](https://example.com/pricing)')
    expect(output).not.toMatch(/<\/?(?:div|a|button|span)\b/)
  })

  it('leaves raw HTML shown inside fenced code unchanged', () => {
    const source = '```html\n<div><p>Example</p></div>\n<Image src={Link} alt="link-icon" />\n<Tab title="Example">Content</Tab>\n```\n<br/>Body'
    const output = transformMintlifyMdx(source)
    expect(output).toContain('<div><p>Example</p></div>')
    expect(output).toContain('<Image src={Link} alt="link-icon" />')
    expect(output).toContain('<Tab title="Example">Content</Tab>')
    expect(output).toMatch(/```\n\nBody$/)
  })

  it('normalizes harmless UI HTML for generic repositories without blocking strict import', () => {
    const result = convertSourceTree([
      {
        path: 'docs/example.mdx',
        content: [
          '# Example',
          '',
          '```jsx',
          "<button onClick={() => alert('example')}>Code example</button>",
          '```',
          '',
          "<button onClick={() => alert('live')}>Live example</button>",
          '<form><label>Name <input name="name" /></label><textarea name="message"></textarea></form>',
          '<svg><linearGradient><stop /></linearGradient><path /></svg>',
        ].join('\n'),
      },
    ])

    expect(result.dialect).toBe('generic')
    expect(result.unmapped).toEqual([])
    expect(result.pages[0]?.markdown).toContain("<button onClick={() => alert('example')}>Code example</button>")
    expect(result.pages[0]?.markdown).toContain('Live example')
    expect(result.pages[0]?.markdown).not.toContain("<button onClick={() => alert('live')}")
  })

  it('converts multiline iframe and HTML video embeds into portable media blocks', () => {
    const source = [
      '<iframe',
      '  src="https://www.loom.com/embed/demo?hide_title=true"',
      '  allowFullScreen={true}',
      '></iframe>',
      '<video controls>',
      '  <source src="./videos/demo.mp4" type="video/mp4" />',
      '</video>',
    ].join('\n')

    const output = transformMintlifyMdx(source)
    expect(output).toContain('<Embed src="https://www.loom.com/embed/demo?hide_title=true" />')
    expect(output).toContain('<Video url="./videos/demo.mp4" />')
    expect(output).not.toMatch(/<\/?(?:iframe|video|source)\b/)
  })

  it('normalizes semantic HTML headings and keeps standalone HTML images block-level', () => {
    const source = [
      '<section className="hero">',
      '  <h2>API references</h2>',
      '  ## <img src="/images/reference.png" alt="Reference" />',
      '</section>',
    ].join('\n')

    const output = transformMintlifyMdx(source)
    expect(output).toContain('## API references')
    expect(output).toContain('![Reference](/images/reference.png)')
    expect(output).not.toMatch(/<\/?(?:section|h2|img)\b/)
    expect(output).not.toMatch(/^\s*##\s*$/m)
  })

  it('combines Mintlify light and dark image variants into one theme-aware image', () => {
    const output = transformMintlifyMdx([
      '<img',
      '  className="block w-full dark:hidden"',
      '  style={{ borderRadius: \'0.5rem\' }}',
      '  alt="Product documentation"',
      '  src="/images/banner-light.png"',
      '/>',
      '<img',
      '  className="w-full hidden dark:block"',
      '  style={{ borderRadius: \'0.5rem\' }}',
      '  alt="Product documentation"',
      '  src="/images/banner-dark.png"',
      '/>',
    ].join('\n'))

    expect(output).toContain(
      '<Image src="/images/banner-light.png" darkSrc="/images/banner-dark.png" alt="Product documentation" />',
    )
    expect(output.match(/<Image\b/g)).toHaveLength(1)
    expect(output).not.toContain('dark:hidden')
    expect(output).not.toContain('dark:block')
  })
})
