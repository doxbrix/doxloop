import { useEffect, useRef, useState } from 'preact/hooks'
import { post, NO_TIMEOUT } from './api'
import { Button, Field, Input, Note, Tabs } from './components'
import type { MintlifyInspection } from '../../src/mintlify-import'

export function MintlifyImportPanel({ initialPath = '', onImported, onCancel }: {
  initialPath?: string
  onImported: () => Promise<void>
  onCancel?: (() => void) | undefined
}) {
  const [location, setLocation] = useState<'local' | 'github'>('local')
  const [path, setPath] = useState(initialPath)
  const [repository, setRepository] = useState('')
  const [branch, setBranch] = useState('')
  const [subdirectory, setSubdirectory] = useState('')
  const [secret, setSecret] = useState('')
  const [report, setReport] = useState<MintlifyInspection | null>(null)
  const [destination, setDestination] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [busy, setBusy] = useState('')
  const [error, setError] = useState('')
  const [completed, setCompleted] = useState(false)
  const activeId = useRef<string | undefined>()
  const alive = useRef(true)
  useEffect(() => () => {
    alive.current = false
    if (activeId.current) void post('/api/projects/mintlify/discard', { id: activeId.current }).catch(() => undefined)
  }, [])

  const browse = async () => {
    setBusy('browse'); setError('')
    try {
      const result = await post<{ path: string | null }>('/api/projects/browse', {}, NO_TIMEOUT)
      if (result.path) setPath(result.path)
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy('') }
  }
  const inspect = async () => {
    setBusy('inspect'); setError('')
    try {
      const result = await post<MintlifyInspection>('/api/projects/mintlify/inspect', {
        ...(location === 'local' ? { path } : { repository, branch, authMethod: secret ? 'credentials' : 'automatic', gitSecret: secret }),
        subdirectory,
      }, NO_TIMEOUT)
      if (!alive.current) { await post('/api/projects/mintlify/discard', { id: result.id }); return }
      activeId.current = result.id
      setReport(result); setDestination(result.suggestedDestination); setAcknowledged(false); setSecret('')
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy('') }
  }
  const back = async () => {
    if (report) await post('/api/projects/mintlify/discard', { id: report.id }).catch(() => undefined)
    activeId.current = undefined; setReport(null); setError('')
  }
  const convert = async () => {
    if (!report) return
    setBusy('convert'); setError('')
    try {
      await post('/api/projects/mintlify/convert', { id: report.id, destination, allowWarnings: acknowledged }, NO_TIMEOUT)
      activeId.current = undefined; setCompleted(true)
    } catch (error) { setError(errorMessage(error)) }
    finally { setBusy('') }
  }
  const hasWarnings = Boolean(report && (report.unmapped.length || report.warnings.length))
  if (completed) return <div class="import-existing-panel">
    <Note>Converted {report?.pageCount} {report?.pageCount === 1 ? 'page' : 'pages'} to Doxbrix. Your documentation is ready in {destination}.</Note>
    <p>Open Pages to review the converted site and preview it. Connect your product code or API specification in Sources, request changes in Update, then publish from Deploy → Doxbrix.</p>
    <p>The conversion report is saved with the project. Imported pages start as unverified until their claims are checked against your product sources.</p>
    <Button tone="primary" onClick={() => void onImported().catch((error) => setError(errorMessage(error)))}>Open documentation</Button>
    {error && <Note tone="bad">{error}</Note>}
  </div>
  return <div class="import-existing-panel mintlify-import-panel">
    <p>Convert your Mintlify site into a new Doxbrix project, ready to edit and deploy with Doxloop. The original project stays in place.</p>
    {!report ? <>
      <Tabs value={location} onChange={(value) => { setLocation(value); setError('') }} items={[[ 'local', 'Local folder' ], [ 'github', 'GitHub repository' ]]} />
      <fieldset disabled={Boolean(busy)} class="mintlify-import-fields">
        {location === 'local' ? <Field label="Mintlify project folder" hint="Choose the documentation folder or its parent repository. A single nested Mintlify site is detected automatically.">
          <div class="source-folder-input"><Input aria-label="Mintlify project folder" value={path} placeholder="/path/to/mintlify-docs" onInput={(event) => setPath(event.currentTarget.value)} /><Button icon="folder" onClick={() => void browse()}>Browse</Button></div>
        </Field> : <>
          <Field label="GitHub repository"><Input aria-label="GitHub repository" value={repository} placeholder="https://github.com/your-team/docs or your-team/docs" onInput={(event) => setRepository(event.currentTarget.value)} /></Field>
          <Field label="Branch (optional)" hint="Leave empty to use the repository's default branch."><Input aria-label="Branch (optional)" value={branch} onInput={(event) => setBranch(event.currentTarget.value)} /></Field>
          <details><summary>Private repository access</summary><Field label="GitHub access token" hint="Uses your existing Git credentials by default. A token is held only for this local session."><Input aria-label="GitHub access token" type="password" autoComplete="off" value={secret} onInput={(event) => setSecret(event.currentTarget.value)} /></Field></details>
        </>}
        <Field label="Documentation subfolder (optional)" hint="For repositories with several documentation sites, enter the folder containing docs.json or mint.json."><Input aria-label="Documentation subfolder (optional)" value={subdirectory} placeholder="e.g. website/docs" onInput={(event) => setSubdirectory(event.currentTarget.value)} /></Field>
      </fieldset>
    </> : <>
      <div class="import-inspection ok"><div><strong>{report.title} → Doxbrix</strong><small>{report.pageCount} {report.pageCount === 1 ? 'page' : 'pages'} · {report.assetCount} {report.assetCount === 1 ? 'asset' : 'assets'} · {report.spaces.length} navigation {report.spaces.length === 1 ? 'space' : 'spaces'} · {report.redirects.length} redirects</small><small>{report.source.repository || report.source.path}{report.source.branch ? ' · ' + report.source.branch : ''}{report.source.subdirectory ? ' · ' + report.source.subdirectory : ''}</small></div></div>
      <Field label="New Doxbrix project folder" hint="Choose a new folder outside the original project. Its parent folder must already exist."><Input aria-label="New Doxbrix project folder" value={destination} disabled={Boolean(busy)} onInput={(event) => setDestination(event.currentTarget.value)} /></Field>
      <details class="import-page-sample"><summary>{report.pageCount > report.pages.length ? 'First ' + report.pages.length + ' converted pages' : 'Converted pages'}</summary><ul>{report.pages.map((path) => <li key={path}><code>{path}</code></li>)}</ul></details>
      {hasWarnings ? <div class="mintlify-conversion-warnings"><Note tone="warn">Some content needs review after conversion.</Note>
        {report.unmapped.length > 0 && <p>Unsupported constructs: {report.unmapped.join(', ')}</p>}
        {report.warnings.length > 0 && <ul>{report.warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        <label><input type="checkbox" checked={acknowledged} disabled={Boolean(busy)} onChange={(event) => setAcknowledged(event.currentTarget.checked)} /> I understand these limitations and will review the converted documentation.</label>
      </div> : <Note>No unsupported constructs were reported by the converter. Review the rendered pages before publishing.</Note>}
    </>}
    {busy && <p role="status">{busy === 'inspect' ? 'Reading the project, converting pages, and checking API references…' : busy === 'convert' ? 'Creating your Doxbrix workspace…' : 'Choose a folder in the system dialog…'}</p>}
    {error && <Note tone="bad">{error}</Note>}
    <footer class="import-existing-actions">
      {onCancel && <Button disabled={Boolean(busy)} onClick={onCancel}>Cancel</Button>}
      {report ? <><Button disabled={Boolean(busy)} onClick={() => void back()}>Change source</Button><Button tone="primary" busy={busy === 'convert'} disabled={Boolean(busy) || !destination.trim() || (hasWarnings && !acknowledged)} onClick={() => void convert()}>Convert and open Doxbrix project</Button></> : <Button tone="primary" busy={busy === 'inspect'} disabled={Boolean(busy) || !(location === 'local' ? path.trim() : repository.trim())} onClick={() => void inspect()}>Review conversion</Button>}
    </footer>
  </div>
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
