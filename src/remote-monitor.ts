import { sourceKind } from './project.js'
import {
  changedFilesInRemoteScope,
  materializeRemoteSource,
  remoteChangedFiles,
  remoteHead,
} from './remote-source.js'
import { collectSourceChanges, readSyncState } from './sync.js'
import type {
  DoxloopProject,
  RemoteSource,
  SourceBinding,
  SourceChange,
  SyncState,
} from './types.js'

export interface RemoteMonitorResult {
  project: DoxloopProject
  changes: SourceChange[]
  nextState: SyncState
}

/** Verify read access to a configured remote Git branch without downloading source. */
export async function testRemoteSource(remote: RemoteSource): Promise<{ head: string }> {
  return { head: await remoteHead(remote) }
}

/**
 * Observe configured product repositories without writing to the user's source
 * checkout. Managed snapshots live outside the documentation project.
 */
export async function monitorRemoteSources(
  root: string,
  project: DoxloopProject,
): Promise<RemoteMonitorResult> {
  const previous = await readSyncState(root)
  const nextState: SyncState = {
    schemaVersion: 1,
    sources: { ...previous.sources },
  }
  const changes: SourceChange[] = []
  const sources: SourceBinding[] = []

  for (const source of project.sources) {
    if (sourceKind(source) === 'openapi') {
      changes.push(...await collectSourceChanges(root, [source]))
      sources.push(source)
      continue
    }
    if (!source.remote) {
      changes.push(...await collectSourceChanges(root, [source]))
      sources.push(source)
      continue
    }
    const head = await remoteHead(source.remote)
    const record = previous.sources[source.name]
    if (!record) {
      const snapshot = await materializeRemoteSource(root, source, head)
      changes.push({ ...source, path: snapshot.path, kind: 'no-baseline', head, uncommittedFiles: [] })
      sources.push({ ...source, path: snapshot.path })
      nextState.sources[source.name] = {
        commit: head,
        recordedAt: new Date().toISOString(),
      }
      continue
    }
    if (record.commit === head) {
      changes.push({
        ...source,
        kind: 'unchanged',
        baseline: record.commit,
        head,
        changedFiles: [],
        uncommittedFiles: [],
      })
      sources.push(source)
      continue
    }

    const changedFiles = changedFilesInRemoteScope(
      await remoteChangedFiles(source.remote, record.commit, head),
      source.remote.subdirectory,
    )
    const snapshot = await materializeRemoteSource(root, source, head)
    changes.push({
      ...source,
      path: snapshot.path,
      kind: 'changed',
      baseline: record.commit,
      head,
      changedFiles,
      uncommittedFiles: [],
    })
    sources.push({ ...source, path: snapshot.path })
    nextState.sources[source.name] = {
      commit: head,
      recordedAt: new Date().toISOString(),
    }
  }

  return { project: { ...project, sources }, changes, nextState }
}
