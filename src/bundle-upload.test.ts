import { createHash } from 'node:crypto'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { pushDeploymentBundle } from './bundle-upload.js'

const UPLOAD_ID = '4f0d5c1e-7a1b-4c1d-9a55-111111111111'
const report = { result: { spaces: 1, pagesCreated: 1, pagesUpdated: 0, navItems: 1, warnings: [] } }

function largeBundle() {
  const image = Buffer.alloc(4 * 1024 * 1024, 7)
  return {
    image,
    bundle: {
      manifest: { version: 1, spaces: [] },
      basePath: '',
      pages: [{ path: 'index.mdx', markdown: '# Overview\n\n![Screen](images/screen.png)\n' }],
      media: [
        { path: 'images/screen.png', base64: image.toString('base64') },
        { path: 'images/logo.svg', base64: Buffer.from('<svg/>').toString('base64') },
      ],
    },
  }
}

describe('pushDeploymentBundle', () => {
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
  })

  test('sends small bundles in a single request', async () => {
    vi.stubEnv('DOXLOOP_TOKEN', 'dxb_test')
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json(report))
    await pushDeploymentBundle(
      'docs',
      { manifest: {}, basePath: '', pages: [{ path: 'index.mdx', markdown: '# Hi' }], media: [] },
      { publish: true, replace: true },
      'https://doxbrix.test',
    )
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    expect(String(fetchSpy.mock.calls[0]![0])).toBe('https://doxbrix.test/api/v1/projects/docs/bundle')
    expect(JSON.parse(String(fetchSpy.mock.calls[0]![1]?.body))).toMatchObject({ publish: true, pages: [{ path: 'index.mdx' }] })
  })

  test('uploads large bundles to storage and commits them by upload id', async () => {
    vi.stubEnv('DOXLOOP_TOKEN', 'dxb_test')
    const { image, bundle } = largeBundle()
    const calls: Array<{ url: string; init?: RequestInit }> = []
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = String(input)
      calls.push({ url, init })
      if (url.startsWith('https://s3.test/')) return new Response(null, { status: 200 })
      if (url.endsWith('/bundle/uploads')) {
        return Response.json({
          uploadId: UPLOAD_ID,
          bundle: { upload: { url: 'https://s3.test/bundle', method: 'PUT', headers: { 'x-amz-checksum-sha256': 'b' } } },
          media: [
            { path: 'images/screen.png', status: 'upload', upload: { url: 'https://s3.test/screen', method: 'PUT', headers: {} } },
            { path: 'images/logo.svg', status: 'exists' },
          ],
        }, { status: 201 })
      }
      return Response.json(report)
    })

    await pushDeploymentBundle('docs', bundle, { publish: true, replace: true }, 'https://doxbrix.test')

    expect(calls.map((call) => call.url)).toEqual([
      'https://doxbrix.test/api/v1/projects/docs/bundle/uploads',
      'https://s3.test/screen',
      'https://s3.test/bundle',
      'https://doxbrix.test/api/v1/projects/docs/bundle',
    ])
    const reserve = JSON.parse(String(calls[0]!.init?.body))
    expect(reserve.media[0]).toEqual({
      path: 'images/screen.png',
      bytes: image.length,
      sha256: createHash('sha256').update(image).digest('hex'),
    })
    // Storage uploads never carry the Doxbrix token.
    for (const call of calls.slice(1, 3)) {
      expect(new Headers(call.init?.headers).has('Authorization')).toBe(false)
    }
    const staged = JSON.parse(Buffer.from(calls[2]!.init?.body as Buffer).toString('utf8'))
    expect(staged.media).toBeUndefined()
    expect(staged.mediaRefs.map((ref: { path: string }) => ref.path)).toEqual(['images/screen.png', 'images/logo.svg'])
    expect(JSON.parse(String(calls[3]!.init?.body))).toEqual({ uploadId: UPLOAD_ID, publish: true, replace: true })
  })

  test('explains the size limit when Doxbrix does not support staged uploads', async () => {
    vi.stubEnv('DOXLOOP_TOKEN', 'dxb_test')
    const { bundle } = largeBundle()
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(null, { status: 404 }))
    await expect(
      pushDeploymentBundle('docs', bundle, { publish: true, replace: true }, 'https://doxbrix.test'),
    ).rejects.toThrow('accepts at most 4.5 MB in one deployment')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
