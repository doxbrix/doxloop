import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { DoxloopError } from './errors.js'
import { loadOpenApiSource } from './openapi.js'
import { isSpecUrl, sourceKind } from './project.js'
import { remoteHead } from './remote-source.js'
import { readSyncState } from './sync.js'
import type { OpenApiSnapshot, SourceBinding, SourceHealth } from './types.js'

export const SOURCE_CONNECTOR_API_VERSION = 1 as const

export interface SourceConnectorSnapshot {
  revision: string
  capturedAt: string
  validators?: { etag?: string; lastModified?: string }
  openapi?: OpenApiSnapshot
}

export interface SourceConnectorInventory {
  identifiers: string[]
  metadata: Record<string, string | number | string[]>
}

/** Versioned provider boundary used by source validation, inventory, drift, and health. */
export interface SourceConnector {
  readonly id: string
  readonly version: typeof SOURCE_CONNECTOR_API_VERSION
  validate(root: string, source: SourceBinding): Promise<void>
  inventory(root: string, source: SourceBinding): Promise<SourceConnectorInventory>
  snapshot(root: string, source: SourceBinding): Promise<SourceConnectorSnapshot>
  detectChanges(previous: SourceConnectorSnapshot | undefined, current: SourceConnectorSnapshot): Promise<{ changed: boolean; identifiers: string[] }>
  evidenceIdentifiers(snapshot: SourceConnectorSnapshot): string[]
  redact(source: SourceBinding): SourceBinding
  health(root: string, source: SourceBinding): Promise<SourceHealth>
}

export function connectorForSource(source: SourceBinding): SourceConnector {
  return sourceKind(source) === 'openapi' ? openApiConnector : directoryConnector
}

export async function sourceHealth(root: string, sources: SourceBinding[]): Promise<SourceHealth[]> {
  return Promise.all(sources.map(async (source) => {
    try { return await connectorForSource(source).health(root, source) }
    catch (error) {
      const connector = connectorForSource(source)
      const redacted = connector.redact(source)
      return {
        name: source.name,
        connector: connector.id,
        status: 'error' as const,
        checkedAt: new Date().toISOString(),
        location: redacted.remote?.repository ?? redacted.path,
        provider: source.remote?.provider ?? connector.id,
        ...(source.remote?.branch ? { branch: source.remote.branch } : {}),
        ...(source.remote?.subdirectory ? { subdirectory: source.remote.subdirectory } : {}),
        monitored: Boolean(source.remote),
        summary: safeHealthError(error, source, root),
        details: ['Check that the location is reachable and that read-only credentials are available in the configured environment.'],
        ...(source.scope ? { scope: source.scope } : {}),
      }
    }
  }))
}

const openApiConnector: SourceConnector = {
  id: 'openapi',
  version: SOURCE_CONNECTOR_API_VERSION,
  async validate(root, source) { await loadOpenApiSource(root, source) },
  async inventory(root, source) {
    const loaded = await loadOpenApiSource(root, source)
    return {
      identifiers: [
        ...Object.keys(loaded.snapshot.operations),
        ...Object.keys(loaded.snapshot.schemas).map((item) => `schema:${item}`),
      ],
      metadata: {
        title: loaded.summary.title,
        version: loaded.summary.version,
        operationCount: loaded.summary.operationCount,
        servers: loaded.summary.servers,
        securitySchemes: loaded.summary.securitySchemes,
        schemas: loaded.summary.schemas,
      },
    }
  },
  async snapshot(root, source) {
    const loaded = await loadOpenApiSource(root, source)
    return {
      revision: loaded.hash,
      capturedAt: new Date().toISOString(),
      ...(loaded.etag || loaded.lastModified ? { validators: { ...(loaded.etag ? { etag: loaded.etag } : {}), ...(loaded.lastModified ? { lastModified: loaded.lastModified } : {}) } } : {}),
      openapi: loaded.snapshot,
    }
  },
  async detectChanges(previous, current) {
    return { changed: previous?.revision !== current.revision, identifiers: this.evidenceIdentifiers(current) }
  },
  evidenceIdentifiers(snapshot) {
    return snapshot.openapi ? [
      ...Object.keys(snapshot.openapi.operations),
      ...Object.keys(snapshot.openapi.schemas).map((item) => `schema:${item}`),
    ] : []
  },
  redact(source) {
    if (!isSpecUrl(source.path)) return source
    const url = new URL(source.path)
    url.search = url.search ? '?…' : ''
    return { ...source, path: url.toString() }
  },
  async health(root, source) {
    const loaded = await loadOpenApiSource(root, source)
    const baseline = (await readSyncState(root)).sources[source.name]
    const redacted = this.redact(source)
    const checkedAt = new Date().toISOString()
    return {
      name: source.name,
      connector: this.id,
      status: 'healthy',
      checkedAt,
      lastSuccessfulAt: checkedAt,
      ...(baseline?.recordedAt ? { lastMonitoringAt: baseline.recordedAt } : {}),
      location: redacted.path,
      provider: isSpecUrl(source.path) ? 'https' : 'file',
      monitored: isSpecUrl(source.path),
      revision: loaded.hash,
      summary: `${loaded.summary.title} ${loaded.summary.version} · ${loaded.summary.operationCount} operations`,
      details: [
        `OpenAPI ${loaded.summary.specificationVersion}`,
        `${loaded.summary.schemas.length} schemas`,
        `${loaded.summary.securitySchemes.length} security schemes`,
        `${loaded.summary.servers.length} servers`,
      ],
      openapi: loaded.summary,
      ...(source.scope ? { scope: source.scope } : {}),
    }
  },
}

const directoryConnector: SourceConnector = {
  id: 'directory',
  version: SOURCE_CONNECTOR_API_VERSION,
  async validate(root, source) {
    const path = resolve(root, source.path)
    let stats
    try { stats = await lstat(path) } catch { throw new DoxloopError(`Source directory does not exist: ${path}`) }
    if (!stats.isDirectory() || stats.isSymbolicLink()) throw new DoxloopError(`Source must be a non-symlinked directory: ${path}`)
  },
  async inventory(root, source) {
    await this.validate(root, source)
    const entries = await readdir(resolve(root, source.path), { withFileTypes: true })
    return { identifiers: entries.map((entry) => entry.name).sort(), metadata: { entries: entries.length } }
  },
  async snapshot(root, source) {
    const inventory = await this.inventory(root, source)
    return { revision: createHash('sha256').update(JSON.stringify(inventory)).digest('hex'), capturedAt: new Date().toISOString() }
  },
  async detectChanges(previous, current) { return { changed: previous?.revision !== current.revision, identifiers: [] } },
  evidenceIdentifiers() { return [] },
  redact(source) {
    return {
      ...source,
      path: basename(source.path) || source.path,
      ...(source.remote ? { remote: { ...source.remote, repository: redactedRepository(source.remote.repository) } } : {}),
    }
  },
  async health(root, source) {
    const [snapshot, baseline, head] = await Promise.all([
      this.snapshot(root, source),
      readSyncState(root).then((state) => state.sources[source.name]),
      source.remote ? remoteHead(source.remote) : Promise.resolve(undefined),
    ])
    const inventory = await this.inventory(root, source)
    const redacted = this.redact(source)
    const checkedAt = new Date().toISOString()
    return {
      name: source.name,
      connector: this.id,
      status: 'healthy',
      checkedAt,
      lastSuccessfulAt: checkedAt,
      ...(baseline?.recordedAt ? { lastMonitoringAt: baseline.recordedAt } : {}),
      location: redacted.remote?.repository ?? redacted.path,
      provider: source.remote?.provider ?? 'directory',
      ...(source.remote?.branch ? { branch: source.remote.branch } : {}),
      ...(source.remote?.subdirectory ? { subdirectory: source.remote.subdirectory } : {}),
      monitored: Boolean(source.remote),
      revision: head ?? snapshot.revision,
      summary: `${inventory.metadata.entries ?? 0} top-level entries available`,
      details: source.remote ? [`Monitored from ${source.remote.provider}:${redacted.remote?.repository}@${source.remote.branch}`] : ['Local read-only directory'],
      ...(source.scope ? { scope: source.scope } : {}),
    }
  },
}

function redactedRepository(value: string): string {
  try {
    const url = new URL(value)
    if (url.username) url.username = '…'
    url.password = ''
    url.search = url.search ? '?…' : ''
    url.hash = ''
    return url.toString()
  } catch {
    return value
  }
}

function safeHealthError(error: unknown, source: SourceBinding, root: string): string {
  let value = error instanceof Error ? error.message : String(error)
  for (const secret of [resolve(root, source.path), source.path, source.remote?.repository]) {
    if (secret) value = value.split(secret).join(connectorForSource(source).redact(source).remote?.repository ?? connectorForSource(source).redact(source).path)
  }
  return value.replace(/([?&](?:token|key|secret|password|signature)=)[^&\s]+/gi, '$1…').slice(0, 500)
}
