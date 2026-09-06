import { useEffect, useState } from 'preact/hooks'
import { api, put } from './api'
import { AssetPicker, assetFileUrl } from './AssetLibrary'
import { Button, Field, Input, Note, Panel, Select } from './components'
import { Icon } from './icons'
import type { Branding, ThemeField } from './types'

type Action = <T>(run: () => Promise<T>, success?: string, reload?: boolean) => Promise<T | undefined>

const FONT_SUGGESTIONS = ['Inter', 'IBM Plex Sans', 'Source Sans 3', 'Roboto', 'Open Sans', 'Lato', 'Nunito', 'Manrope', 'Work Sans', 'Public Sans']
const CODE_FONT_SUGGESTIONS = ['ui-monospace', 'JetBrains Mono', 'Fira Code', 'IBM Plex Mono', 'Source Code Pro', 'Roboto Mono']
const DEFAULTS: Partial<Record<ThemeField, string>> = {
  primaryColor: '#6366f1',
  backgroundColorLight: '#ffffff',
  backgroundColorDark: '#12131a',
  font: 'Inter',
  codeFont: 'ui-monospace',
  mode: 'system',
  codeTheme: 'auto',
}

type Form = { name: string; description: string } & Record<ThemeField, string>

function formFrom(branding: Branding): Form {
  const form = { name: branding.site?.name ?? '', description: branding.site?.description ?? '' } as Form
  for (const field of THEME_FIELDS) form[field] = branding.theme?.[field] ?? ''
  return form
}

const THEME_FIELDS: ThemeField[] = [
  'primaryColor', 'lightColor', 'darkColor', 'backgroundColorLight', 'backgroundColorDark',
  'font', 'headingFont', 'codeFont', 'logoLight', 'logoDark', 'favicon', 'faviconLight', 'faviconDark', 'backgroundImage', 'mode', 'codeTheme', 'logoHref',
]

/**
 * Settings → Branding. Doxbrix stores the theme in `docs.json`, which the
 * preview re-reads on every request, so a save shows in the preview frame
 * below without a build. Other generators are pointed at their own config.
 */
export function BrandingPanel({ act, onError, previewUrl, onPreviewStart }: {
  act: Action
  onError: (error: string) => void
  previewUrl?: string
  onPreviewStart: () => Promise<string | undefined>
}) {
  const [branding, setBranding] = useState<Branding>()
  const [form, setForm] = useState<Form>()
  const [picker, setPicker] = useState<ThemeField>()
  const [saving, setSaving] = useState(false)
  const [frameNonce, setFrameNonce] = useState(0)
  const [frameUrl, setFrameUrl] = useState(previewUrl)

  const load = async () => {
    try {
      const next = await api<Branding>('/api/branding')
      setBranding(next)
      setForm(formFrom(next))
    } catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)) }
  }
  useEffect(() => { void load() }, [])
  useEffect(() => {
    if (frameUrl || !branding?.editable) return
    void onPreviewStart().then((url) => { if (url) setFrameUrl(url) })
  }, [branding?.editable, frameUrl])

  if (!branding || !form) return <Panel title="Branding" description="Logo, colours, and fonts for the published site."><div class="page-list-empty"><span class="spinner" />Loading branding…</div></Panel>
  if (!branding.editable) {
    return <Panel title="Branding" description="Logo, colours, and fonts for the published site.">
      <Note>{branding.reason}</Note>
      {branding.configFile && <p class="branding-config-hint">Theme configuration: <code>{branding.configFile}</code></p>}
    </Panel>
  }

  const saved = formFrom(branding)
  const changed = (Object.keys(form) as Array<keyof Form>).filter((key) => form[key] !== saved[key])
  const set = (field: keyof Form, value: string) => setForm({ ...form, [field]: value })
  const save = async () => {
    if (changed.length === 0) return
    setSaving(true)
    try {
      const theme: Partial<Record<ThemeField, string | null>> = {}
      for (const key of changed) if (key !== 'name' && key !== 'description') theme[key] = form[key] || null
      const body = {
        fingerprint: branding.fingerprint,
        ...(changed.includes('name') || changed.includes('description') ? { site: { name: form.name, description: form.description } } : {}),
        ...(Object.keys(theme).length ? { theme } : {}),
      }
      const next = await act(() => put<Branding>('/api/branding', body), 'Branding saved', false)
      if (next) {
        setBranding(next)
        setForm(formFrom(next))
        setFrameNonce((value) => value + 1)
      }
    } finally { setSaving(false) }
  }
  const reset = () => setForm(saved)
  const colorField = (field: ThemeField, label: string, hint: string) => <Field label={label} hint={hint}>
    <span class="color-field">
      <input type="color" aria-label={`${label} swatch`} value={/^#[0-9a-f]{6}$/i.test(form[field]) ? form[field] : (DEFAULTS[field] ?? DEFAULTS.primaryColor!)} onInput={(event) => set(field, event.currentTarget.value)} />
      <Input aria-label={label} value={form[field]} placeholder={DEFAULTS[field] ?? 'Inherit'} maxlength={7} onInput={(event) => set(field, event.currentTarget.value)} />
      {form[field] && <button type="button" class="color-clear" aria-label={`Clear ${label}`} onClick={() => set(field, '')}><Icon name="close" size={12} /></button>}
    </span>
  </Field>
  const assetField = (field: ThemeField, label: string, hint: string) => <Field label={label} hint={hint}>
    <span class="asset-field">
      {form[field] && /^\//.test(form[field]) && <img class="asset-field-thumb" src={assetThumb(branding, form[field])} alt="" />}
      <Input aria-label={label} value={form[field]} placeholder="/assets/logo.svg or https://…" onInput={(event) => set(field, event.currentTarget.value)} />
      <Button size="sm" onClick={() => setPicker(field)}>Choose…</Button>
      {form[field] && <button type="button" class="color-clear" aria-label={`Clear ${label}`} onClick={() => set(field, '')}><Icon name="close" size={12} /></button>}
    </span>
  </Field>

  return <>
    {picker && <AssetPicker act={act} title={`Choose the ${labelFor(picker).toLowerCase()}`} onClose={() => setPicker(undefined)} onPick={(asset) => { set(picker, asset.publicPath); setPicker(undefined) }} />}
    <Panel title="Branding" description="Logo, colours, and fonts for the published site. Changes show in the preview below without an agent run." actions={<><Button size="sm" tone="ghost" disabled={changed.length === 0 || saving} onClick={reset}>Discard</Button><Button size="sm" tone="primary" busy={saving} disabled={changed.length === 0} onClick={() => void save()}>Save branding</Button></>}>
      <div class="branding-grid">
        <section class="branding-section">
          <h3>Identity</h3>
          <div class="form-grid">
            <Field label="Site name"><Input value={form.name} onInput={(event) => set('name', event.currentTarget.value)} /></Field>
            <Field label="Site description" hint="Used for social previews and search results"><Input value={form.description} onInput={(event) => set('description', event.currentTarget.value)} /></Field>
            {assetField('logoLight', 'Logo (light mode)', 'SVG or PNG. Shown in the top bar.')}
            {assetField('logoDark', 'Logo (dark mode)', 'Optional. Falls back to the light logo.')}
            {assetField('favicon', 'Favicon', 'PNG, ICO, or SVG.')}
            <Field label="Logo link" hint="Where the logo points. Defaults to the first page."><Input value={form.logoHref} placeholder="/ or https://example.com" onInput={(event) => set('logoHref', event.currentTarget.value)} /></Field>
          </div>
        </section>
        <section class="branding-section">
          <h3>Colours</h3>
          <div class="form-grid">
            {colorField('primaryColor', 'Primary colour', 'Links, buttons, and the active navigation item.')}
            {colorField('lightColor', 'Accent in light mode', 'Optional override of the primary colour on light backgrounds.')}
            {colorField('darkColor', 'Accent in dark mode', 'Optional override of the primary colour on dark backgrounds.')}
            {colorField('backgroundColorLight', 'Light background', 'Page background in light mode.')}
            {colorField('backgroundColorDark', 'Dark background', 'Page background in dark mode.')}
            <Field label="Default colour mode"><Select value={form.mode || 'system'} onChange={(event) => set('mode', event.currentTarget.value)}><option value="system">Follow the reader's system</option><option value="light">Light</option><option value="dark">Dark</option></Select></Field>
            <Field label="Code block theme"><Select value={form.codeTheme || 'auto'} onChange={(event) => set('codeTheme', event.currentTarget.value)}><option value="auto">Match colour mode</option><option value="light">Always light</option><option value="dark">Always dark</option></Select></Field>
          </div>
        </section>
        <section class="branding-section">
          <h3>Fonts</h3>
          <div class="form-grid">
            <Field label="Body font" hint="Google Fonts families load automatically; others need a font source in docs.json."><Input list="branding-fonts" value={form.font} placeholder="Inter" onInput={(event) => set('font', event.currentTarget.value)} /></Field>
            <Field label="Heading font" hint="Optional. Defaults to the body font."><Input list="branding-fonts" value={form.headingFont} placeholder="Same as body" onInput={(event) => set('headingFont', event.currentTarget.value)} /></Field>
            <Field label="Code font"><Input list="branding-code-fonts" value={form.codeFont} placeholder="ui-monospace" onInput={(event) => set('codeFont', event.currentTarget.value)} /></Field>
          </div>
          <datalist id="branding-fonts">{FONT_SUGGESTIONS.map((font) => <option key={font} value={font} />)}</datalist>
          <datalist id="branding-code-fonts">{CODE_FONT_SUGGESTIONS.map((font) => <option key={font} value={font} />)}</datalist>
        </section>
      </div>
      {changed.length > 0 && <Note>Unsaved changes: {changed.map(labelFor).join(', ')}. Save to see them in the preview.</Note>}
      <p class="branding-config-hint">Stored in <code>{branding.configFile}</code>.</p>
    </Panel>
    <Panel title="Live preview" description="The site as readers see it, with the saved branding." flush>
      <div class="branding-preview">
        {frameUrl
          ? <iframe key={`${frameUrl}:${frameNonce}`} title="Branding preview" src={`${frameUrl}/?embed=page`} />
          : <div class="preview-placeholder"><span class="spinner" /><strong>Preview is starting…</strong></div>}
      </div>
    </Panel>
  </>
}

function assetThumb(branding: Branding, publicPath: string): string {
  const asset = branding.assets.find((entry) => entry.publicPath === publicPath)
  return asset ? assetFileUrl({ path: asset.path, modifiedAt: '' }) : ''
}

function labelFor(field: keyof Form): string {
  const labels: Record<string, string> = {
    name: 'site name', description: 'site description', primaryColor: 'primary colour', lightColor: 'light accent', darkColor: 'dark accent',
    backgroundColorLight: 'light background', backgroundColorDark: 'dark background', font: 'body font', headingFont: 'heading font', codeFont: 'code font',
    logoLight: 'light logo', logoDark: 'dark logo', favicon: 'favicon', faviconLight: 'light favicon', faviconDark: 'dark favicon', backgroundImage: 'background image',
    mode: 'colour mode', codeTheme: 'code theme', logoHref: 'logo link',
  }
  return labels[field] ?? field
}
