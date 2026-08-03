import type { ComponentChildren, JSX } from 'preact'
import { Icon } from './icons'

/**
 * The shared surface for every screen: a bordered white panel with an optional
 * header row. Panels carry the whole page structure, so section titles stay one
 * size and one weight across the product.
 */
export function Panel(props: {
  title?: string
  description?: string
  icon?: string
  actions?: ComponentChildren
  footer?: ComponentChildren
  children: ComponentChildren
  flush?: boolean
  class?: string
}) {
  return <section class={`panel ${props.class ?? ''}`}>
    {(props.title || props.actions) && <header class="panel-head">
      {props.icon && <span class="panel-icon"><Icon name={props.icon} size={17} /></span>}
      <div class="panel-title">{props.title && <h2>{props.title}</h2>}{props.description && <p>{props.description}</p>}</div>
      {props.actions && <div class="panel-actions">{props.actions}</div>}
    </header>}
    <div class={`panel-body ${props.flush ? 'flush' : ''}`}>{props.children}</div>
    {props.footer && <footer class="panel-foot">{props.footer}</footer>}
  </section>
}

export function PageHeader({ title, description, icon, actions, meta }: {
  title: string
  description?: string
  icon?: string
  actions?: ComponentChildren
  meta?: ComponentChildren
}) {
  return <header class="page-head">
    {icon && <span class="page-head-icon"><Icon name={icon} size={30} /></span>}
    <div class="page-head-copy"><h1>{title}</h1>{description && <p>{description}</p>}{meta && <div class="page-meta">{meta}</div>}</div>
    {actions && <div class="page-head-actions">{actions}</div>}
  </header>
}

export function Tabs<T extends string>({ value, onChange, items }: {
  value: T
  onChange: (value: T) => void
  items: ReadonlyArray<readonly [T, string]>
}) {
  return <div class="tabs" role="tablist">{items.map(([id, label]) =>
    <button key={id} role="tab" aria-selected={value === id} class={value === id ? 'active' : ''} onClick={() => onChange(id)}>{label}</button>)}</div>
}

export function Button(props: JSX.ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: 'primary' | 'secondary' | 'danger' | 'ghost' | 'link'
  size?: 'sm' | 'md'
  icon?: string
  busy?: boolean
}) {
  const { tone = 'secondary', size = 'md', icon, busy, children, class: className, ...button } = props
  return <button {...button} class={`btn ${tone} ${size} ${className ?? ''}`} disabled={Boolean(button.disabled || busy)} aria-busy={busy}>
    {busy ? <span class="spinner" /> : icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
    {busy ? 'Working…' : children}
  </button>
}

/**
 * Stat tiles double as the page summary. They keep the label above the value so
 * a row of them scans as a single line of numbers.
 */
export function Stat({ label, value, detail, icon, tone, active, onClick }: {
  label: string
  value: ComponentChildren
  detail?: string
  icon?: string
  tone?: 'good' | 'warn' | 'bad'
  active?: boolean
  onClick?: () => void
}) {
  const content = <>
    {icon && <span class="stat-icon"><Icon name={icon} size={19} /></span>}
    <span class="stat-copy"><span class="stat-label">{label}</span><strong class={`stat-value ${tone ?? ''}`}>{value}</strong>{detail && <small>{detail}</small>}</span>
  </>
  const className = `stat ${icon ? 'with-icon' : ''} ${active ? 'active' : ''}`
  return onClick
    ? <button type="button" class={className} onClick={onClick}>{content}</button>
    : <div class={className}>{content}</div>
}

export function Badge({ tone = 'neutral', icon, children }: { tone?: string; icon?: string; children: ComponentChildren }) {
  return <span class={`badge ${tone}`}>{icon && <Icon name={icon} size={12} />}{children}</span>
}

export function Field(props: { label: string; hint?: string; children: ComponentChildren; wide?: boolean }) {
  return <label class={`field ${props.wide ? 'wide' : ''}`}>
    <span class="field-label">{props.label}</span>
    {props.children}
    {props.hint && <small>{props.hint}</small>}
  </label>
}

export function Input(props: JSX.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} class={`input ${props.class ?? ''}`} />
}

export function Select({ icon, ...props }: JSX.SelectHTMLAttributes<HTMLSelectElement> & { icon?: string }) {
  return <span class={`select-wrap ${icon ? 'with-icon' : ''}`}>
    {icon && <Icon name={icon} size={15} class="lead-icon" />}
    <select {...props} class={`input ${props.class ?? ''}`} />
    <Icon name="chevronDown" size={14} />
  </span>
}

/**
 * A free-text field that carries a picker affordance: the model name must stay
 * typeable, so this is an input with a datalist wearing the select's chevron.
 */
export function Combo({ children, ...props }: JSX.InputHTMLAttributes<HTMLInputElement> & { children?: ComponentChildren }) {
  return <span class="select-wrap combo"><input {...props} class={`input ${props.class ?? ''}`} /><Icon name="chevronDown" size={14} />{children}</span>
}

export function Textarea(props: JSX.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} class={`input textarea ${props.class ?? ''}`} />
}

export function Toggle({ checked, disabled, onChange, label }: {
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  label: string
}) {
  return <label class="toggle">
    <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.currentTarget.checked)} />
    <span class="toggle-track" /><span class="toggle-text">{label}</span>
  </label>
}

/** Radio group rendered as bordered cards; used wherever a mode is chosen. */
export function Options<T extends string>({ value, onChange, items, columns }: {
  value: T
  onChange: (value: T) => void
  items: ReadonlyArray<readonly [T, string, string] | readonly [T, string, string, string]>
  columns?: number
}) {
  return <div class="options" style={columns ? `--option-columns:${columns}` : undefined}>{items.map(([id, label, detail, icon]) =>
    <button key={id} type="button" class={`option ${value === id ? 'selected' : ''}`} aria-pressed={value === id} onClick={() => onChange(id)}>
      <span class="option-check"><Icon name="check" size={12} /></span>
      <span class="option-head">{icon && <Icon name={icon} size={17} />}<strong>{label}</strong></span>
      <small>{detail}</small>
    </button>)}</div>
}

export function Segmented<T extends string>({ value, onChange, items }: {
  value: T
  onChange: (value: T) => void
  items: ReadonlyArray<readonly [T, string]>
}) {
  return <div class="segmented">{items.map(([id, label]) =>
    <button key={id} type="button" class={value === id ? 'active' : ''} aria-pressed={value === id} onClick={() => onChange(id)}>{label}</button>)}</div>
}

export function Empty({ title, detail, icon = 'file', action }: { title: string; detail?: string; icon?: string; action?: ComponentChildren }) {
  return <div class="empty"><span class="empty-icon"><Icon name={icon} size={20} /></span><strong>{title}</strong>{detail && <p>{detail}</p>}{action}</div>
}

export function Note({ tone = 'info', children }: { tone?: 'info' | 'warn' | 'bad'; children: ComponentChildren }) {
  return <p class={`note ${tone}`}><Icon name={tone === 'info' ? 'shield' : 'alert'} size={14} />{children}</p>
}

export function Table({ head, children, class: className }: { head: ComponentChildren; children: ComponentChildren; class?: string }) {
  return <div class={`table-wrap ${className ?? ''}`}><table class="table"><thead><tr>{head}</tr></thead><tbody>{children}</tbody></table></div>
}

export function KeyValues({ items }: { items: Array<readonly [string, ComponentChildren]> }) {
  return <dl class="keyvalues">{items.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
}

export function Lines({ value, onInput, placeholder }: { value: string[]; onInput: (value: string[]) => void; placeholder?: string }) {
  return <Textarea class="mono-input" rows={5} value={value.join('\n')} placeholder={placeholder} onInput={(event) => onInput(event.currentTarget.value.split('\n').map((item) => item.trim()).filter(Boolean))} />
}

const JOB_TONE: Record<string, string> = { running: 'info', succeeded: 'good', failed: 'bad', cancelled: 'neutral' }
const JOB_ICON: Record<string, string> = { running: 'refresh', succeeded: 'check', failed: 'alert', cancelled: 'minus' }

/**
 * Activity is a table first and a log second: the row answers what happened and
 * when, and the output stays folded until someone asks for it.
 */
export function JobTable({ jobs, onCancel }: {
  jobs: Array<{ id: string; type: string; status: string; lines: string[]; startedAt: string }>
  onCancel: (id: string) => void
}) {
  if (jobs.length === 0) return <Empty icon="clock" title="No activity yet" detail="Runs started from this workspace appear here." />
  return <Table class="job-table" head={<><th>Task</th><th>Status</th><th>Started</th><th class="right" /></>}>
    {jobs.map((job) => <tr key={job.id} class="job-row">
      <td>
        <div class="job-name"><Icon name={JOB_ICON[job.status] ?? 'clock'} size={14} class={job.status === 'running' ? 'spin' : ''} /><span>{job.type.replaceAll(':', ' · ')}</span></div>
        {job.lines.length > 0 && <details class="job-output"><summary>{job.lines.length} recent output line{job.lines.length === 1 ? '' : 's'}</summary><pre class="terminal">{job.lines.join('\n')}</pre><a class="job-full-log" href={`/api/jobs/${job.id}/log`} target="_blank" rel="noreferrer">Open full log</a></details>}
      </td>
      <td><Badge tone={JOB_TONE[job.status] ?? 'neutral'}>{job.status}</Badge></td>
      <td class="muted-cell">{timeText(job.startedAt)}</td>
      <td class="right">{job.status === 'running' && <Button size="sm" onClick={() => onCancel(job.id)}>Cancel</Button>}</td>
    </tr>)}
  </Table>
}

export function timeText(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

export function splitComma(value: string): string[] {
  return value.split(',').map((item) => item.trim()).filter(Boolean)
}

export function termText(value: Record<string, string>): string {
  return Object.entries(value).map(([term, replacement]) => `${term} = ${replacement}`).join('\n')
}

export function parseTerms(value: string): Record<string, string> {
  const terms: Record<string, string> = {}
  for (const line of value.split('\n')) {
    const [key, ...rest] = line.split('=')
    if (key?.trim() && rest.join('=').trim()) terms[key.trim()] = rest.join('=').trim()
  }
  return terms
}
