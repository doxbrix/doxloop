import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DoxloopError } from './errors.js'
import { approveDocumentationPlan, applyDocumentationPlanProposal, createDocumentationPlan } from './documentation-plan.js'
import { writeEvidenceMap } from './evidence.js'
import { scaffoldProject } from './project.js'
import { persistReviewReport } from './review-report.js'
import { recordSyncState } from './sync.js'
import { validateProject } from './validation.js'
import type { DocumentationPlan, DocumentationReviewReport, ValidationResult } from './types.js'

export interface DemoWorkspace {
  parent: string
  root: string
  plan: DocumentationPlan
  review: DocumentationReviewReport
  validation: ValidationResult
  cleanup(): Promise<void>
}

/** Build a deterministic showcase in an isolated temporary directory. */
export async function createDemoWorkspace(): Promise<DemoWorkspace> {
  const parent = await mkdtemp(join(tmpdir(), 'doxloop-demo-'))
  const product = join(parent, 'product')
  const root = join(parent, 'pulse-api-docs')
  await mkdir(product, { recursive: true })
  const specification = join(product, 'openapi.json')
  await writeFile(specification, `${JSON.stringify(DEMO_OPENAPI, null, 2)}\n`, 'utf8')
  await scaffoldProject({
    directory: root,
    title: 'Pulse API',
    sources: [{ name: 'pulse-api', path: '../product/openapi.json', kind: 'openapi', scope: { routePrefix: 'reference', navigationGroup: 'API reference' } }],
  })

  for (const [path, content] of Object.entries(DEMO_PAGES)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), content, 'utf8')
  }
  await writeFile(join(root, 'docs.json'), `${JSON.stringify(DEMO_NAVIGATION, null, 2)}\n`, 'utf8')

  const created = await createDocumentationPlan(root, {
    mode: 'create',
    scope: 'standard',
    request: 'Create complete onboarding and API reference documentation for Pulse API.',
    execution: { agent: 'codex', model: 'demo-bundled', reasoning: 'low', screenshots: false },
  })
  const pageDefinitions = Object.keys(DEMO_PAGES).map((path, index) => {
    const id = path.replace(/\.mdx$/, '').replaceAll('/', '-')
    const title = DEMO_TITLES[path]!
    return {
      id,
      title,
      path: path.replace(/\.mdx$/, ''),
      type: index < 2 ? 'getting-started' : path.startsWith('reference/') ? 'reference' : path.includes('troubleshooting') ? 'troubleshooting' : 'how-to',
      priority: 'must-have',
      action: index < 2 ? 'update' : 'create',
      purpose: `Help developers ${DEMO_PURPOSES[path]}.`,
      rationale: 'The bundled OpenAPI contract directly supports this reader task.',
      evidence: [`pulse-api: ${DEMO_EVIDENCE[path]}`],
      evidenceDetails: [{ source: 'pulse-api', path: 'openapi.json', kind: 'openapi', label: DEMO_EVIDENCE[path] }],
    }
  })
  const ready = await applyDocumentationPlanProposal(root, created.id, {
    productProfile: 'Event ingestion and webhook delivery API',
    summary: 'Take a developer from authentication through event ingestion, webhook handling, and error recovery.',
    audiences: ['Application developers', 'Platform engineers'],
    outcomes: ['Send a first event', 'Verify webhooks', 'Recover from API errors'],
    terminology: { project: 'Pulse API workspace' },
    exclusions: ['Dashboard administration and internal operations'],
    instructions: 'Use runnable curl examples and explain observable success states.',
    experienceLevel: 'beginner',
    preferredExamples: ['curl', 'TypeScript'],
    estimatedEffort: 'medium',
    estimatedPages: pageDefinitions.length,
    capabilities: pageDefinitions.map((page) => ({ id: `capability-${page.id}`, title: page.title, kind: page.type, evidence: page.evidenceDetails, pageIds: [page.id], disposition: 'planned' })),
    navigation: { top: ['Documentation'], sections: [{ id: 'getting-started', title: 'Get started', pageIds: pageDefinitions.slice(0, 2).map((page) => page.id) }, { id: 'guides', title: 'Guides', pageIds: pageDefinitions.slice(2, 5).map((page) => page.id) }, { id: 'reference', title: 'Reference', pageIds: pageDefinitions.slice(5).map((page) => page.id) }] },
    pages: pageDefinitions,
    questions: [],
  }, 'codex')
  const approved = await approveDocumentationPlan(root, ready.id)
  const generated: DocumentationPlan = { ...approved, status: 'generated', updatedAt: new Date().toISOString() }
  await writeFile(join(root, '.doxloop', 'plans', generated.id, 'plan.json'), `${JSON.stringify(generated, null, 2)}\n`, 'utf8')
  await writeFile(join(root, '.doxloop', 'documentation-plan.json'), `${JSON.stringify(generated, null, 2)}\n`, 'utf8')

  await writeEvidenceMap(root, { schemaVersion: 1, pages: Object.fromEntries(Object.keys(DEMO_PAGES).map((path) => [path, { sources: [{ source: 'pulse-api', operations: [DEMO_EVIDENCE[path]!] }], confidence: 'verified' as const, verifiedOn: { 'pulse-api': new Date().toISOString() } }])) })
  await recordSyncState(root, [{ name: 'pulse-api', path: '../product/openapi.json', kind: 'openapi' }])
  const review = await persistReviewReport(root, '<doxloop-review>{"score":96,"hardGates":"pass","summary":"The bundled documentation is complete, navigable, evidence-backed, and ready to preview.","findings":[]}</doxloop-review>', { agent: 'codex', model: 'demo-bundled', reasoning: 'low' })
  const validation = await validateProject(root)
  if (validation.errors > 0) {
    await rm(parent, { recursive: true, force: true })
    throw new DoxloopError(`The bundled demo failed its own validation with ${validation.errors} errors.`)
  }
  return { parent, root, plan: generated, review, validation, cleanup: () => rm(parent, { recursive: true, force: true }) }
}

const DEMO_OPENAPI = {
  openapi: '3.1.0',
  info: { title: 'Pulse API', version: '1.0.0', description: 'Ingest product events and deliver signed webhooks.' },
  servers: [{ url: 'https://api.pulse.example/v1' }],
  components: { securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer' } }, schemas: { Event: { type: 'object', required: ['type', 'data'], properties: { type: { type: 'string' }, data: { type: 'object' } } } } },
  security: [{ bearerAuth: [] }],
  paths: {
    '/events': { post: { operationId: 'createEvent', summary: 'Send an event', responses: { '202': { description: 'Accepted' }, '400': { description: 'Invalid event' }, '401': { description: 'Unauthorized' } } } },
    '/webhooks': { get: { operationId: 'listWebhooks', summary: 'List webhook endpoints', responses: { '200': { description: 'Webhook endpoints' } } }, post: { operationId: 'createWebhook', summary: 'Create a webhook endpoint', responses: { '201': { description: 'Created' } } } },
  },
}

const DEMO_TITLES: Record<string, string> = {
  'index.mdx': 'Pulse API overview', 'quickstart.mdx': 'Quickstart', 'guides/authentication.mdx': 'Authentication', 'guides/send-events.mdx': 'Send events', 'guides/webhooks.mdx': 'Receive webhooks', 'reference/events.mdx': 'Events API', 'troubleshooting.mdx': 'Troubleshooting',
}
const DEMO_PURPOSES: Record<string, string> = {
  'index.mdx': 'understand the API and choose a workflow', 'quickstart.mdx': 'send a first successful event', 'guides/authentication.mdx': 'authenticate requests safely', 'guides/send-events.mdx': 'construct and submit event payloads', 'guides/webhooks.mdx': 'configure and verify webhook delivery', 'reference/events.mdx': 'look up request and response behavior', 'troubleshooting.mdx': 'diagnose common request failures',
}
const DEMO_EVIDENCE: Record<string, string> = {
  'index.mdx': 'POST /events', 'quickstart.mdx': 'POST /events', 'guides/authentication.mdx': 'bearerAuth', 'guides/send-events.mdx': 'POST /events', 'guides/webhooks.mdx': 'POST /webhooks', 'reference/events.mdx': 'POST /events', 'troubleshooting.mdx': 'POST /events 400/401',
}

function page(title: string, description: string, body: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\ndescription: ${JSON.stringify(description)}\n---\n\n# ${title}\n\n${body.trim()}\n`
}

const DEMO_PAGES: Record<string, string> = {
  'index.mdx': page('Pulse API overview', 'Understand what Pulse API does and choose the right integration workflow.', 'Pulse API accepts product events and delivers them to signed webhook endpoints.\n\n- Start with the [quickstart](/quickstart).\n- Learn how [authentication](/guides/authentication) works.\n- Use the [Events API reference](/reference/events) while integrating.'),
  'quickstart.mdx': page('Quickstart', 'Authenticate and send your first accepted event in a few minutes.', '## Send an event\n\n```bash\ncurl -X POST https://api.pulse.example/v1/events \\\n  -H "Authorization: Bearer $PULSE_API_TOKEN" \\\n  -H "Content-Type: application/json" \\\n  -d \'{"type":"user.created","data":{"id":"usr_123"}}\'\n```\n\nA successful request returns HTTP `202 Accepted`. Continue with [webhooks](/guides/webhooks).'),
  'guides/authentication.mdx': page('Authentication', 'Send API credentials safely with every Pulse API request.', 'Pulse API uses bearer authentication. Store the token in a secret manager and send it in the `Authorization` header.\n\n```http\nAuthorization: Bearer YOUR_TOKEN\n```\n\nNever place a token in a URL, source file, or client-side application.'),
  'guides/send-events.mdx': page('Send events', 'Create valid event payloads and recognize an accepted request.', 'Send JSON to `POST /events` with a string `type` and an object `data`. The API returns `202` after accepting the event for processing.\n\nUse stable event names such as `user.created` so consumers can route them predictably.'),
  'guides/webhooks.mdx': page('Receive webhooks', 'Create an endpoint and prepare an application to receive event deliveries.', 'Create a destination with `POST /webhooks`, then expose an HTTPS handler that returns a successful response promptly. List configured destinations with `GET /webhooks`.\n\nTest the complete path with a non-production event before enabling a live integration.'),
  'reference/events.mdx': page('Events API', 'Look up the request contract and response behavior for event ingestion.', '## `POST /events`\n\nRequires bearer authentication and a JSON body containing `type` and `data`.\n\n| Status | Meaning |\n| --- | --- |\n| `202` | Event accepted |\n| `400` | Payload is invalid |\n| `401` | Authentication failed |'),
  'troubleshooting.mdx': page('Troubleshooting', 'Resolve authentication and payload errors when sending Pulse API events.', '## `401 Unauthorized`\n\nConfirm that the token is present, active, and sent as a bearer token.\n\n## `400 Bad Request`\n\nConfirm that the body is JSON and includes both `type` and `data`. Compare the request with the [quickstart](/quickstart).'),
}

const DEMO_NAVIGATION = {
  version: 1, name: 'Pulse API', description: 'Evidence-backed example documentation generated by Doxloop.',
  spaces: [{ name: 'Documentation', slug: 'docs', icon: 'book', nav: [
    { type: 'group', label: 'Get started', icon: 'rocket', items: [{ type: 'page', file: 'index', title: 'Overview' }, { type: 'page', file: 'quickstart', title: 'Quickstart' }] },
    { type: 'group', label: 'Guides', icon: 'book', items: [{ type: 'page', file: 'guides/authentication', title: 'Authentication' }, { type: 'page', file: 'guides/send-events', title: 'Send events' }, { type: 'page', file: 'guides/webhooks', title: 'Receive webhooks' }] },
    { type: 'group', label: 'Reference', icon: 'api', items: [{ type: 'page', file: 'reference/events', title: 'Events API' }, { type: 'page', file: 'troubleshooting', title: 'Troubleshooting' }] },
  ] }], theme: { primaryColor: '#0f766e', mode: 'system', font: 'Inter', headingFont: 'Inter', codeFont: 'ui-monospace' },
}
