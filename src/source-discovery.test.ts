import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { scaffoldProject } from './project.js'
import { MAXIMUM_SUGGESTED_PAGES, discoverDocumentationSources, formatDiscoveryInventory, suggestedPageCounts } from './source-discovery.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function fixture(): Promise<string> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-discovery-'))
  roots.push(parent)
  const source = join(parent, 'product')
  await mkdir(join(source, 'src'), { recursive: true })
  await mkdir(join(source, 'examples'), { recursive: true })
  await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'example-sdk', exports: { '.': './src/index.ts' }, scripts: { test: 'vitest', release: 'private' } }))
  await writeFile(join(source, 'src', 'index.ts'), 'export interface ClientOptions {}\nexport function createClient() {}\nrouter.post("/jobs", runJob)\nconst token = process.env.API_TOKEN\nif (!token) throw new AuthenticationError()\nauthorize("admin")\nemit("job.completed")\nregisterWebhookConnector()\n')
  await writeFile(join(source, 'examples', 'quickstart.ts'), 'createClient()\n')
  await writeFile(join(source, '.env.example'), 'PUBLIC_API_URL=https://api.example.com\n')
  await writeFile(join(source, '.env'), 'API_TOKEN=never-inventory-this\n')
  return scaffoldProject({ directory: join(parent, 'docs'), sources: [{ name: 'product', path: '../product' }] })
}

describe('deterministic source discovery', () => {
  test('inventories public signals, excludes sensitive files, and reuses the content cache', async () => {
    const root = await fixture()
    const first = await discoverDocumentationSources(root)
    expect(first.cacheHit).toBe(false)
    expect(first.inventory.sources[0]?.packageNames).toEqual(['example-sdk'])
    expect(first.inventory.sources[0]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'export', label: 'createClient', path: 'src/index.ts' }),
      expect.objectContaining({ kind: 'route', label: 'POST /jobs' }),
      expect.objectContaining({ kind: 'example', path: 'examples/quickstart.ts' }),
      expect.objectContaining({ kind: 'authentication' }),
      expect.objectContaining({ kind: 'authorization' }),
      expect.objectContaining({ kind: 'error', label: 'AuthenticationError' }),
      expect.objectContaining({ kind: 'event', label: 'job.completed' }),
      expect.objectContaining({ kind: 'integration' }),
      expect.objectContaining({ kind: 'configuration', label: 'API_TOKEN' }),
      expect.objectContaining({ kind: 'configuration', label: 'PUBLIC_API_URL', path: '.env.example' }),
    ]))
    expect(JSON.stringify(first.inventory)).not.toContain('never-inventory-this')
    // The prompt copy is grouped text, far smaller than the JSON cache, and
    // keeps every citation field: source, path, kind, label, and line.
    const formatted = formatDiscoveryInventory(first.inventory)
    expect(formatted.length).toBeLessThan(JSON.stringify(first.inventory).length)
    expect(formatted).toContain('Source "product"')
    expect(formatted).toMatch(/configuration \(\d+\):\n(?:.*\n)*?\s+\.env\.example: .*PUBLIC_API_URL @\d+/)
    expect(formatted).toMatch(/error \(\d+\)/)
    // Regex hits on code lines are summarised per file instead of listed.
    expect(formatted).toMatch(/event \(\d+ matches? in \d+ files?; read the files for the behavior\)/)
    expect(formatted).not.toContain('job.completed')
    expect(first.inventory.sources[0]?.evidence.some((item) => item.path === '.env')).toBe(false)

    const second = await discoverDocumentationSources(root)
    expect(second.cacheHit).toBe(true)
    expect(second.inventory.cacheKey).toBe(first.inventory.cacheKey)
    expect(JSON.parse(await readFile(join(root, '.doxloop', 'cache', 'discovery', `${first.inventory.cacheKey}.json`), 'utf8'))).toMatchObject({ schemaVersion: 1 })
  })

  test('invalidates the inventory when safe source content changes', async () => {
    const root = await fixture()
    const first = await discoverDocumentationSources(root)
    await writeFile(join(root, '..', 'product', 'src', 'index.ts'), 'export function createClient() {}\nexport function deleteClient() {}\n')
    const second = await discoverDocumentationSources(root)
    expect(second.cacheHit).toBe(false)
    expect(second.inventory.cacheKey).not.toBe(first.inventory.cacheKey)
    expect(second.inventory.sources[0]?.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'export', label: 'deleteClient' }),
    ]))
  })
})

describe('public-surface noise filtering', () => {
  test('counts keyword signals only from product code and exports only from entry points', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-discovery-noise-'))
    roots.push(parent)
    const source = join(parent, 'product')
    await mkdir(join(source, 'src', 'internal'), { recursive: true })
    await mkdir(join(source, 'evals', 'fixtures', 'app', 'src'), { recursive: true })
    await mkdir(join(source, 'docs'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'noisy-product', main: './dist/cli.js', bin: { noisy: './dist/cli.js' } }))
    await writeFile(join(source, 'CHANGELOG.md'), '- Added login, roles, permissions, and a webhook connector.\n- Authentication now refuses redirects.\n')
    await writeFile(join(source, 'docs', 'security.md'), '# Security\n\nBearer tokens and API keys are never stored. Roles and scopes apply.\n')
    await writeFile(join(source, 'evals', 'fixtures', 'app', 'src', 'auth.ts'), "export const authentication = { protocol: 'OIDC' }\nexport type Role = 'admin'\n")
    await writeFile(join(source, 'src', 'cli.ts'), "export function run() {}\nlogin(token)\nlogin(other)\nauthorize('admin')\nregisterConnector()\n")
    await writeFile(join(source, 'src', 'internal', 'helper.ts'), "export function helper() {}\nconst permission = check()\n")
    const root = await scaffoldProject({ directory: join(parent, 'docs-project'), sources: [{ name: 'product', path: '../product' }] })

    const { inventory } = await discoverDocumentationSources(root)
    const evidence = inventory.sources[0]!.evidence
    const prose = evidence.filter((item) => /\.md$/.test(item.path))
    expect(prose.every((item) => item.kind === 'documentation')).toBe(true)
    const fixtures = evidence.filter((item) => item.path.startsWith('evals/'))
    expect(fixtures.every((item) => item.kind === 'test')).toBe(true)
    expect(evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'export', label: 'run', path: 'src/cli.ts' }),
      expect.objectContaining({ kind: 'authentication', path: 'src/cli.ts' }),
      expect.objectContaining({ kind: 'authorization', path: 'src/cli.ts' }),
      expect.objectContaining({ kind: 'integration', path: 'src/cli.ts' }),
      expect.objectContaining({ kind: 'authorization', path: 'src/internal/helper.ts' }),
    ]))
    expect(evidence.some((item) => item.kind === 'export' && item.label === 'helper')).toBe(false)
    expect(evidence.filter((item) => item.kind === 'authentication' && item.path === 'src/cli.ts')).toHaveLength(1)
  })

  test('scales the comprehensive estimate with the public surface instead of capping it at thirty', () => {
    expect(suggestedPageCounts(40, 0).comprehensive).toBeLessThan(30)
    expect(suggestedPageCounts(600, 0).comprehensive).toBeGreaterThan(30)
    expect(suggestedPageCounts(600, 0).standard).toBeGreaterThan(20)
    expect(suggestedPageCounts(100_000, 0).comprehensive).toBe(MAXIMUM_SUGGESTED_PAGES)
    expect(suggestedPageCounts(1, 0)).toEqual({ starter: 3, standard: 7, comprehensive: 12 })
  })
})

describe('product code is inventoried before supporting files', () => {
  test('reads src routes even when an asset folder alone would exhaust an alphabetical cap, and records UI label catalogs', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-discovery-order-'))
    roots.push(parent)
    const source = join(parent, 'product')
    await mkdir(join(source, 'public', 'intl', 'messages'), { recursive: true })
    await mkdir(join(source, 'src', 'app', 'api', 'websites', '[websiteId]'), { recursive: true })
    await mkdir(join(source, 'src', 'app', '(main)', 'dashboard'), { recursive: true })
    await mkdir(join(source, 'db', 'migrations'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'ordered-app', scripts: { start: 'next start', build: 'next build', 'test-e2e': 'playwright', lint: 'eslint', 'build-docker-nightly': 'docker' } }))
    for (let index = 0; index < 60; index += 1) await writeFile(join(source, 'public', `icon-${String(index).padStart(3, '0')}.json`), '{"icon": true}')
    await writeFile(join(source, 'public', 'intl', 'messages', 'en-US.json'), JSON.stringify({ label: { 'two-factor-enable': 'Enable 2FA' } }))
    await writeFile(join(source, 'src', 'app', 'api', 'websites', '[websiteId]', 'route.ts'), 'export async function GET() {}\nexport async function POST() {}\nconst secret = process.env.APP_SECRET\n')
    await writeFile(join(source, 'src', 'app', '(main)', 'dashboard', 'page.tsx'), 'export default function Page() { return null }\n')
    await writeFile(join(source, 'db', 'migrations', '001-api-keys.js'), 'exports.up = (knex) => knex.raw("CREATE TABLE api_key (login TEXT)")\nprocess.exit(1)\nconst url = process.env.DATABASE_URL\n')
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [{ name: 'product', path: '../product' }] })

    const { inventory } = await discoverDocumentationSources(root)
    const result = inventory.sources[0]!
    expect(result.evidence).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'route', label: 'GET /api/websites/:websiteId', path: 'src/app/api/websites/[websiteId]/route.ts' }),
      expect.objectContaining({ kind: 'route', label: 'POST /api/websites/:websiteId' }),
      expect.objectContaining({ kind: 'configuration', label: 'APP_SECRET' }),
      expect.objectContaining({ kind: 'configuration', label: 'DATABASE_URL', path: 'db/migrations/001-api-keys.js' }),
      expect.objectContaining({ kind: 'command', label: 'npm run start' }),
    ]))
    expect(result.evidence.some((item) => item.label.startsWith('exit '))).toBe(false)
    expect(result.evidence.some((item) => item.kind === 'authentication' && item.path.startsWith('db/'))).toBe(false)
    expect(result.evidence.some((item) => item.kind === 'command' && /test-e2e|lint|docker/.test(item.label))).toBe(false)
    expect(result.evidence.some((item) => item.kind === 'asset')).toBe(false)
    expect(result.uiLabelCatalogs).toEqual(['public/intl/messages/en-US.json'])
  })

  test('ignores translated template strings and comments when counting keyword surfaces', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'doxloop-discovery-template-'))
    roots.push(parent)
    const source = join(parent, 'product')
    await mkdir(join(source, 'src', 'components'), { recursive: true })
    await mkdir(join(source, 'src', 'lang'), { recursive: true })
    await writeFile(join(source, 'package.json'), JSON.stringify({ name: 'vue-app' }))
    await writeFile(join(source, 'src', 'lang', 'en.json'), JSON.stringify({ 'Setup Notification': 'Set Up Notification' }))
    await writeFile(join(source, 'src', 'components', 'ApiKeyDialog.vue'), '<template>\n  <h2>{{ $t("Add API Key") }}</h2>\n  <label>{{ $t("login") }}</label>\n</template>\n<script>\n// login handled by the server\nexport default { methods: { save() { this.$root.getSocket().emit("addAPIKey", this.key) } } }\n</script>\n')
    const root = await scaffoldProject({ directory: join(parent, 'docs'), sources: [{ name: 'product', path: '../product' }] })

    const { inventory } = await discoverDocumentationSources(root)
    const result = inventory.sources[0]!
    expect(result.evidence.filter((item) => item.kind === 'authentication')).toEqual([])
    expect(result.evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'event', label: 'addAPIKey' })]))
    expect(result.uiLabelCatalogs).toEqual(['src/lang/en.json'])
  })
})
