import { createHash } from 'node:crypto'
import { authenticatedRequest, authenticatedRequestOptional } from './auth.js'
import { DoxloopError } from './errors.js'

/**
 * Doxbrix runs on Vercel, which rejects function request bodies over 4.5 MB
 * before the API sees them (a bare `413 FUNCTION_PAYLOAD_TOO_LARGE`). Bundles
 * above this threshold are uploaded straight to storage through presigned URLs
 * and committed by `uploadId`; smaller ones stay a single request, which every
 * Doxbrix version accepts.
 */
export const INLINE_BUNDLE_LIMIT_BYTES = 3.5 * 1024 * 1024
const PLATFORM_BODY_LIMIT_BYTES = 4.5 * 1024 * 1024
const UPLOAD_CONCURRENCY = 4
const UPLOAD_ATTEMPTS = 3

export interface PushableBundle {
  manifest: unknown
  basePath: string
  pages: Array<{ path: string; markdown: string }>
  media: Array<{ path: string; base64: string }>
  verification?: unknown
}

interface PresignedUpload {
  url: string
  method: 'PUT'
  headers: Record<string, string>
}

interface UploadReservation {
  uploadId: string | null
  bundle: { upload: PresignedUpload } | null
  media: Array<
    | { path: string; status: 'upload'; upload: PresignedUpload }
    | { path: string; status: 'exists' }
    | { path: string; status: 'skipped'; reason: string }
  >
}

export async function pushDeploymentBundle<T>(
  slug: string,
  bundle: PushableBundle,
  options: { publish: boolean; replace: boolean },
  apiUrl?: string,
): Promise<T> {
  const path = `/api/v1/projects/${encodeURIComponent(slug)}/bundle`
  const inline = JSON.stringify({ ...bundle, ...options })
  const inlineBytes = Buffer.byteLength(inline)
  const postInline = () => authenticatedRequest<T>(
    path,
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: inline },
    apiUrl,
  )
  if (inlineBytes <= INLINE_BUNDLE_LIMIT_BYTES) return postInline()

  const media = bundle.media.map((file) => {
    const data = Buffer.from(file.base64, 'base64')
    return { path: file.path, data, sha256: sha256Hex(data) }
  })
  const staged = Buffer.from(JSON.stringify({
    manifest: bundle.manifest,
    basePath: bundle.basePath,
    pages: bundle.pages,
    ...(bundle.verification === undefined ? {} : { verification: bundle.verification }),
    mediaRefs: media.map(({ path: mediaPath, sha256 }) => ({ path: mediaPath, sha256 })),
  }))

  const reservation = await authenticatedRequestOptional<UploadReservation>(
    `${path}/uploads`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        bundle: { bytes: staged.length, sha256: sha256Hex(staged) },
        media: media.map(({ path: mediaPath, data, sha256 }) => ({ path: mediaPath, bytes: data.length, sha256 })),
      }),
    },
    apiUrl,
  )
  if (!reservation) {
    // This Doxbrix predates staged uploads, so the single request is all it takes.
    if (inlineBytes > PLATFORM_BODY_LIMIT_BYTES) {
      throw new DoxloopError(
        `This deployment is ${formatMiB(inlineBytes)}, but this Doxbrix server accepts at most 4.5 MB in one deployment. Update Doxbrix, or reduce the size of images in the documentation.`,
      )
    }
    return postInline()
  }
  if (!reservation.uploadId || !reservation.bundle) {
    throw new DoxloopError('Doxbrix did not return an upload location for the deployment bundle.')
  }

  const dataByPath = new Map(media.map((file) => [file.path, file.data]))
  const uploads = reservation.media.flatMap((file) =>
    file.status === 'upload' ? [{ upload: file.upload, data: dataByPath.get(file.path)!, label: file.path }] : [])
  let next = 0
  const worker = async () => {
    while (next < uploads.length) {
      const item = uploads[next++]!
      await putPresigned(item.upload, item.data, item.label)
    }
  }
  await Promise.all(Array.from({ length: Math.min(UPLOAD_CONCURRENCY, uploads.length) }, () => worker()))
  await putPresigned(reservation.bundle.upload, staged, 'deployment bundle')

  return authenticatedRequest<T>(
    path,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: reservation.uploadId, ...options }),
    },
    apiUrl,
  )
}

/** PUT bytes to a presigned storage URL. The Doxbrix token is never sent here. */
async function putPresigned(upload: PresignedUpload, data: Buffer, label: string): Promise<void> {
  let failure = ''
  for (let attempt = 1; attempt <= UPLOAD_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 2)))
    try {
      const response = await fetch(upload.url, {
        method: upload.method,
        headers: upload.headers,
        body: data as unknown as BodyInit,
        redirect: 'error',
      })
      if (response.ok) return
      failure = `${response.status} ${response.statusText}`.trim()
      if (response.status < 500) break
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
    }
  }
  throw new DoxloopError(`Upload of ${label} failed: ${failure}`)
}

function sha256Hex(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex')
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
