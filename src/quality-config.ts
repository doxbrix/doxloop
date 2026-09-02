import { join } from 'node:path'
import { pathExists, readJson } from './fs.js'
import { DoxloopError } from './errors.js'
import type { QualityConfig } from './types.js'

export const QUALITY_CONFIG_FILE = join('.doxloop', 'quality.json')

export const DEFAULT_QUALITY_CONFIG: QualityConfig = {
  schemaVersion: 1,
  links: { mode: 'online', allowHosts: [], ignore: [], timeoutMs: 8_000, retries: 2, cacheHours: 24 },
  examples: { enabled: false },
  rendered: {
    enabled: false,
    routes: ['/'],
    viewports: [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ],
    themes: ['light', 'dark'],
    maximumDiffRatio: 0.001,
  },
  lint: { maximumTitleLength: 72, maximumNavigationLabelLength: 42 },
  readerVerification: { enabled: false },
  suppressions: [],
  ratchet: { enabled: false, baselineFile: '.doxloop/quality-baseline.json' },
}

export async function loadQualityConfig(root: string): Promise<QualityConfig> {
  const path = join(root, QUALITY_CONFIG_FILE)
  if (!(await pathExists(path))) return structuredClone(DEFAULT_QUALITY_CONFIG)
  const input = await readJson<unknown>(path)
  if (!isQualityConfig(input)) throw new DoxloopError(`${QUALITY_CONFIG_FILE} has an unsupported format.`)
  return {
    schemaVersion: 1,
    links: { ...DEFAULT_QUALITY_CONFIG.links, ...input.links },
    examples: { ...DEFAULT_QUALITY_CONFIG.examples, ...input.examples },
    rendered: { ...DEFAULT_QUALITY_CONFIG.rendered, ...input.rendered },
    lint: { ...DEFAULT_QUALITY_CONFIG.lint, ...input.lint },
    readerVerification: { ...DEFAULT_QUALITY_CONFIG.readerVerification, ...input.readerVerification },
    suppressions: input.suppressions ?? [],
    ratchet: { ...DEFAULT_QUALITY_CONFIG.ratchet, ...input.ratchet },
  }
}

function isQualityConfig(value: unknown): value is QualityConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const config = value as Partial<QualityConfig>
  if (config.schemaVersion !== 1) return false
  if (config.links) {
    if (!object(config.links)) return false
    if (config.links.mode !== undefined && !['online', 'offline'].includes(config.links.mode)) return false
    if (!textList(config.links.allowHosts) || !textList(config.links.ignore)) return false
    if (!bounded(config.links.timeoutMs, 500, 60_000) || !bounded(config.links.retries, 0, 5) || !bounded(config.links.cacheHours, 1, 720)) return false
  }
  if (config.examples && (!object(config.examples) || !optionalBoolean(config.examples.enabled))) return false
  if (config.readerVerification && (!object(config.readerVerification) || !optionalBoolean(config.readerVerification.enabled))) return false
  if (config.suppressions !== undefined && (!Array.isArray(config.suppressions) || !config.suppressions.every((item) => object(item) && typeof item.code === 'string' && item.code.trim() !== '' && typeof item.reason === 'string' && item.reason.trim() !== '' && (item.file === undefined || typeof item.file === 'string') && (item.expires === undefined || typeof item.expires === 'string' && !Number.isNaN(Date.parse(item.expires)))))) return false
  if (config.ratchet && (!object(config.ratchet) || !optionalBoolean(config.ratchet.enabled) || (config.ratchet.baselineFile !== undefined && typeof config.ratchet.baselineFile !== 'string'))) return false
  if (config.rendered) {
    if (!object(config.rendered) || !optionalBoolean(config.rendered.enabled) || !textList(config.rendered.routes)) return false
    if (config.rendered.viewports !== undefined && (!Array.isArray(config.rendered.viewports) || !config.rendered.viewports.every((item) => object(item) && typeof item.name === 'string' && bounded(item.width, 320, 3840) && bounded(item.height, 320, 2160)))) return false
    if (config.rendered.themes !== undefined && (!Array.isArray(config.rendered.themes) || !config.rendered.themes.every((item) => item === 'light' || item === 'dark'))) return false
    if (config.rendered.maximumDiffRatio !== undefined && (typeof config.rendered.maximumDiffRatio !== 'number' || config.rendered.maximumDiffRatio < 0 || config.rendered.maximumDiffRatio > 1)) return false
  }
  if (config.lint && (!object(config.lint) || !bounded(config.lint.maximumTitleLength, 20, 200) || !bounded(config.lint.maximumNavigationLabelLength, 10, 120))) return false
  return true
}

function object(value: unknown): value is Record<string, any> { return !!value && typeof value === 'object' && !Array.isArray(value) }
function textList(value: unknown): boolean { return value === undefined || (Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '')) }
function bounded(value: unknown, minimum: number, maximum: number): boolean { return value === undefined || (Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum) }
function optionalBoolean(value: unknown): boolean { return value === undefined || typeof value === 'boolean' }
