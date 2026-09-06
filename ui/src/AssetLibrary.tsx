import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'
import { api, post } from './api'
import { Button, Empty, Input, Note } from './components'
import { Icon } from './icons'
import type { AssetEntry, AssetLibraryData } from './types'

type Action = <T>(run: () => Promise<T>, success?: string, reload?: boolean) => Promise<T | undefined>

const ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.svg,.avif,.ico,.pdf,.mp4,.webm,.mov,.zip'
const IMAGE_ACCEPT = '.png,.jpg,.jpeg,.gif,.webp,.svg,.avif,.ico'

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error(`Could not read ${file.name}.`))
    reader.onload = () => resolve(String(reader.result ?? '').replace(/^data:[^;]*;base64,/, ''))
    reader.readAsDataURL(file)
  })
}

/** Upload files one at a time; an existing name asks before replacing. */
export async function uploadAssetFiles(files: File[], act: Action, options: { replace?: boolean; name?: string; directory?: string } = {}): Promise<AssetEntry[]> {
  const uploaded: AssetEntry[] = []
  for (const file of files) {
    const data = await readFileAsBase64(file)
    const body = { name: options.name ?? file.name, data, replace: options.replace === true, ...(options.directory ? { directory: options.directory } : {}) }
    let result = await act(() => post<AssetEntry>('/api/assets', body).catch((error: Error) => {
      if (/already exists/.test(error.message) && !options.replace && confirm(`${body.name} already exists. Replace it?`)) {
        return post<AssetEntry>('/api/assets', { ...body, replace: true })
      }
      throw error
    }), `${options.replace ? 'Replaced' : 'Uploaded'} ${body.name}`, false)
    if (result) uploaded.push(result)
    result = undefined
  }
  return uploaded
}

export function assetFileUrl(asset: Pick<AssetEntry, 'path' | 'modifiedAt'>): string {
  return `/api/assets/file?path=${encodeURIComponent(asset.path)}&v=${encodeURIComponent(asset.modifiedAt)}`
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`
  return `${Math.round(bytes / 104857.6) / 10} MB`
}

/**
 * The asset library on the Pages route: upload, replace, delete, and edit the
 * alt text of every image the documentation embeds.
 */
export function AssetLibrary({ act, onError, onChanged }: { act: Action; onError: (error: string) => void; onChanged?: () => void }) {
  const [library, setLibrary] = useState<AssetLibraryData>()
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('')
  const [selectedPath, setSelectedPath] = useState<string>()
  const [alt, setAlt] = useState('')
  const [busy, setBusy] = useState(false)
  const uploadInput = useRef<HTMLInputElement>(null)
  const replaceInput = useRef<HTMLInputElement>(null)

  const load = async () => {
    try { setLibrary(await api<AssetLibraryData>('/api/assets')) }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
    finally { setLoading(false) }
  }
  useEffect(() => { void load() }, [])
  const assets = library?.assets ?? []
  const selected = assets.find((asset) => asset.path === selectedPath)
  useLayoutEffect(() => { setAlt(selected?.references[0]?.alt ?? '') }, [selected?.path, selected?.references.map((reference) => reference.alt).join('|')])
  const query = filter.trim().toLowerCase()
  const visible = query ? assets.filter((asset) => `${asset.name} ${asset.path}`.toLowerCase().includes(query)) : assets
  const unused = assets.filter((asset) => asset.references.length === 0).length

  const upload = async (files: File[], replace = false) => {
    if (files.length === 0) return
    setBusy(true)
    try {
      const directory = selected?.path.split('/').slice(0, -1).join('/')
      const uploaded = await uploadAssetFiles(files, act, replace && selected ? { replace: true, name: selected.name, ...(directory ? { directory } : {}) } : {})
      await load()
      if (uploaded[0]) setSelectedPath(uploaded[0].path)
      onChanged?.()
    } finally { setBusy(false) }
  }
  const saveAlt = async () => {
    if (!selected) return
    setBusy(true)
    try {
      const updated = await act(() => post<AssetEntry>('/api/assets/alt', { path: selected.path, alt }), 'Alt text updated', false)
      if (updated) { await load(); onChanged?.() }
    } finally { setBusy(false) }
  }
  const remove = async () => {
    if (!selected) return
    if (!confirm(`Delete ${selected.name}? This cannot be undone.`)) return
    setBusy(true)
    try {
      const result = await act(() => post('/api/assets/delete', { path: selected.path }), `Deleted ${selected.name}`, false)
      if (result) { setSelectedPath(undefined); await load(); onChanged?.() }
    } finally { setBusy(false) }
  }
  const copyPath = async (value: string) => {
    try { await navigator.clipboard.writeText(value) } catch { /* Clipboard access can be refused; the path stays visible. */ }
  }

  return <div class="asset-library">
    <input ref={uploadInput} type="file" accept={ACCEPT} multiple hidden onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ''; void upload(files) }} />
    <input ref={replaceInput} type="file" accept={selected?.kind === 'image' ? IMAGE_ACCEPT : ACCEPT} hidden onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ''; void upload(files, true) }} />
    <header class="asset-library-head">
      <div>
        <h2>Images and files</h2>
        <p>{library ? <>Uploads go to <code>{library.directory}</code> and pages reference them as <code>{library.publicPrefix.replace(/\/$/, '')}/name</code>. {assets.length} asset{assets.length === 1 ? '' : 's'}{unused ? `, ${unused} unused` : ''}.</> : 'Loading the asset library…'}</p>
      </div>
      <div class="asset-library-actions">
        <label class="page-search asset-search"><span class="sr-only">Search assets</span><Icon name="search" size={16} /><Input type="search" value={filter} placeholder="Search by name" onInput={(event) => setFilter(event.currentTarget.value)} /></label>
        <Button tone="primary" icon="plus" busy={busy} onClick={() => uploadInput.current?.click()}>Upload</Button>
      </div>
    </header>
    <div class={`asset-library-body ${selected ? 'with-detail' : ''}`} onDragOver={(event) => { event.preventDefault() }} onDrop={(event) => { event.preventDefault(); void upload([...(event.dataTransfer?.files ?? [])]) }}>
      <div class="asset-grid" role="list">
        {loading ? <div class="page-list-empty"><span class="spinner" />Loading assets…</div>
          : visible.length === 0
            ? <Empty icon="file" title={query ? `No assets match “${filter.trim()}”` : 'No images or files yet'} {...(query ? {} : { detail: 'Upload images here, or drop files onto this area. Uploaded images can be inserted into any page by the agent.' })} />
            : visible.map((asset) => <button type="button" role="listitem" key={asset.path} class={`asset-tile ${selectedPath === asset.path ? 'active' : ''}`} onClick={() => setSelectedPath(asset.path === selectedPath ? undefined : asset.path)}>
              <span class="asset-thumb">{asset.kind === 'image' ? <img src={assetFileUrl(asset)} alt="" loading="lazy" /> : <Icon name="file" size={26} />}</span>
              <span class="asset-tile-copy"><strong>{asset.name}</strong><small>{formatBytes(asset.bytes)} · {asset.references.length ? `${asset.references.length} use${asset.references.length === 1 ? '' : 's'}` : 'Unused'}</small></span>
            </button>)}
      </div>
      {selected && <aside class="asset-detail" aria-label={`${selected.name} details`}>
        <header><strong>{selected.name}</strong><button type="button" aria-label="Close details" onClick={() => setSelectedPath(undefined)}><Icon name="close" size={14} /></button></header>
        {selected.kind === 'image' && <a class="asset-detail-preview" href={assetFileUrl(selected)} target="_blank" rel="noreferrer"><img src={assetFileUrl(selected)} alt={alt || selected.name} /></a>}
        <dl class="asset-detail-facts">
          <dt>Public path</dt><dd><code>{selected.publicPath}</code><button type="button" aria-label="Copy public path" title="Copy" onClick={() => void copyPath(selected.publicPath)}><Icon name="copy" size={13} /></button></dd>
          <dt>File</dt><dd><code>{selected.path}</code></dd>
          <dt>Size</dt><dd>{formatBytes(selected.bytes)}</dd>
        </dl>
        {selected.kind === 'image' && <div class="asset-alt">
          <label class="field"><span class="field-label">Alt text</span><Input value={alt} disabled={selected.references.length === 0 || busy} placeholder={selected.references.length ? 'Describe what the image shows' : 'Embed the image in a page first'} onInput={(event) => setAlt(event.currentTarget.value)} /><small>{selected.references.length ? `Applied to every page that embeds this image (${selected.references.length}).` : 'Alt text lives on the page that embeds the image.'}</small></label>
          {selected.references.length > 0 && <Button size="sm" tone="primary" busy={busy} disabled={alt.trim() === (selected.references[0]?.alt ?? '')} onClick={() => void saveAlt()}>Save alt text</Button>}
        </div>}
        {selected.references.length > 0 && <div class="asset-references"><strong>Used on</strong><ul>{selected.references.map((reference, index) => <li key={`${reference.page}-${index}`}><code>{reference.page}</code>{reference.alt ? <small>“{reference.alt}”</small> : <small class="warn">No alt text</small>}</li>)}</ul></div>}
        {selected.references.length === 0 && <Note>This file is not embedded in any page.</Note>}
        <footer>
          <Button size="sm" icon="refresh" busy={busy} onClick={() => replaceInput.current?.click()}>Replace file</Button>
          <Button size="sm" tone="danger" icon="trash" busy={busy} disabled={selected.references.length > 0} title={selected.references.length > 0 ? 'Pages still embed this file. Ask the agent to remove it from them first.' : undefined} onClick={() => void remove()}>Delete</Button>
        </footer>
      </aside>}
    </div>
  </div>
}

/** Choose an image, uploading a new one if needed. Used by the page composer, metadata form, and branding panel. */
export function AssetPicker({ act, onPick, onClose, title = 'Choose an image' }: { act: Action; onPick: (asset: AssetEntry) => void; onClose: () => void; title?: string }) {
  const [assets, setAssets] = useState<AssetEntry[]>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const input = useRef<HTMLInputElement>(null)
  const load = async () => {
    try { setAssets((await api<AssetLibraryData>('/api/assets')).assets.filter((asset) => asset.kind === 'image')) }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => { void load() }, [])
  const upload = async (files: File[]) => {
    setBusy(true)
    try {
      const uploaded = await uploadAssetFiles(files, act)
      if (uploaded[0]) onPick(uploaded[0])
    } finally { setBusy(false) }
  }
  return <div class="sources-modal-scrim" onClick={onClose}>
    <section class="sources-reference-dialog asset-picker" role="dialog" aria-modal="true" aria-label={title} onClick={(event) => event.stopPropagation()}>
      <header><span class="sources-dialog-icon"><Icon name="file" size={22} /></span><div><h2>{title}</h2><p>Pick an image from the project or upload a new one.</p></div><button type="button" aria-label="Close" onClick={onClose}><Icon name="close" size={17} /></button></header>
      <div class="sources-dialog-body">
        <input ref={input} type="file" accept={IMAGE_ACCEPT} hidden onChange={(event) => { const files = [...(event.currentTarget.files ?? [])]; event.currentTarget.value = ''; void upload(files) }} />
        {error && <Note tone="bad">{error}</Note>}
        {!assets ? <div class="page-list-empty"><span class="spinner" />Loading images…</div> : assets.length === 0 ? <Empty icon="file" title="No images in this project yet" detail="Upload one to continue." /> : <div class="asset-grid picker" role="list">
          {assets.map((asset) => <button type="button" role="listitem" key={asset.path} class="asset-tile" onClick={() => onPick(asset)}>
            <span class="asset-thumb"><img src={assetFileUrl(asset)} alt="" loading="lazy" /></span>
            <span class="asset-tile-copy"><strong>{asset.name}</strong><small>{asset.publicPath}</small></span>
          </button>)}
        </div>}
      </div>
      <footer><Button onClick={onClose}>Cancel</Button><Button tone="primary" icon="plus" busy={busy} onClick={() => input.current?.click()}>Upload image</Button></footer>
    </section>
  </div>
}
