import { join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  captureSlug,
  isPrivateAddress,
  resolveCaptureUrls,
  toolsDir,
} from './capture.js'

const references = [{ url: 'https://docs.example.com/' }]

afterEach(() => {
  delete process.env.DOXLOOP_TOOLS_DIR
})

describe('capture URL resolution', () => {
  test('defaults to the configured design references', () => {
    expect(resolveCaptureUrls(references, [])).toEqual(['https://docs.example.com/'])
  })

  test('accepts same-origin pages and strips fragments', () => {
    expect(
      resolveCaptureUrls(references, ['https://docs.example.com/guides/start#install']),
    ).toEqual(['https://docs.example.com/guides/start'])
  })

  test('rejects origins that are not configured design references', () => {
    expect(() => resolveCaptureUrls(references, ['https://other.example.com/'])).toThrow(
      /not the origin of a configured design reference/,
    )
  })

  test('rejects more than three pages per origin', () => {
    const urls = ['/a', '/b', '/c', '/d'].map((path) => `https://docs.example.com${path}`)
    expect(() => resolveCaptureUrls(references, urls)).toThrow(/more than 3 pages/)
  })

  test('requires a configured design reference', () => {
    expect(() => resolveCaptureUrls([], [])).toThrow(/No design reference is configured/)
  })
})

describe('capture output naming', () => {
  test('derives a filesystem-safe slug from host and path', () => {
    expect(captureSlug('https://docs.example.com/guides/getting-started/')).toBe(
      'docs-example-com-guides-getting-started',
    )
    expect(captureSlug('https://docs.example.com/')).toBe('docs-example-com')
  })
})

describe('tools directory', () => {
  test('honors the DOXLOOP_TOOLS_DIR override', () => {
    process.env.DOXLOOP_TOOLS_DIR = join('/tmp', 'doxloop-tools-test')
    expect(toolsDir()).toBe(join('/tmp', 'doxloop-tools-test'))
  })
})

describe('capture network boundary', () => {
  test('classifies private and public addresses', () => {
    expect(isPrivateAddress('127.0.0.1')).toBe(true)
    expect(isPrivateAddress('10.2.3.4')).toBe(true)
    expect(isPrivateAddress('169.254.1.2')).toBe(true)
    expect(isPrivateAddress('192.168.1.2')).toBe(true)
    expect(isPrivateAddress('::1')).toBe(true)
    expect(isPrivateAddress('fd00::1')).toBe(true)
    expect(isPrivateAddress('8.8.8.8')).toBe(false)
    expect(isPrivateAddress('2606:4700:4700::1111')).toBe(false)
  })
})
