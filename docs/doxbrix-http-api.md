# Doxbrix HTTP API used by Doxloop

This document is the integration boundary between the public Doxloop CLI and
the Doxbrix platform. Doxloop calls these endpoints directly and does not
depend on server source code or a server-side SDK.

The default base URL is `https://app.doxbrix.com`. It can be replaced with
`DOXLOOP_API_URL` or `--api-url`. All requests and responses use JSON.
Authenticated requests send `Authorization: Bearer dxb_…` with a Doxbrix
Personal Access Token. Redirects are refused so bearer credentials are never
forwarded to another destination. Alternate API URLs must use HTTPS; HTTP is
accepted only for loopback development.

## Device authorization

Start authorization:

```http
POST /api/v1/auth/device/start
Content-Type: application/json

{"name":"doxloop @ hostname","scopes":["docs:read","docs:write","project:read","project:admin"]}
```

Successful response:

```json
{
  "deviceCode": "opaque-device-code",
  "userCode": "ABCD-EFGH",
  "verificationUri": "https://app.doxbrix.com/activate",
  "expiresIn": 600,
  "interval": 5
}
```

Poll for completion:

```http
POST /api/v1/auth/device/poll
Content-Type: application/json

{"deviceCode":"opaque-device-code"}
```

The response is one of:

```json
{"status":"pending"}
{"status":"approved","token":"dxb_opaque-access-token"}
{"status":"expired"}
```

Tokens can also be created manually in the Doxbrix web app and passed with
`doxloop login --token dxb_…` or the `DOXLOOP_TOKEN`/`DOXBRIX_TOKEN`
environment variables. Doxloop verifies a token against `/api/v1/me` before
storing it. Prefer the device flow or environment variables so a token does not
remain in shell history.

## Current account

```http
GET /api/v1/me
Authorization: Bearer dxb_…
```

Response:

```json
{"id":"account-id","email":"user@example.com","name":"Example User"}
```

`name` may be `null`.

## Projects

Fetch a project by id or slug (`404` when it does not exist):

```http
GET /api/v1/projects/{idOrSlug}
Authorization: Bearer dxb_…
```

```json
{"project":{"id":"project-id","name":"Example documentation","slug":"example-documentation"}}
```

Create a project:

```http
POST /api/v1/projects
Authorization: Bearer dxb_…
Content-Type: application/json

{"name":"Example documentation","slug":"example-documentation","visibility":"private","seedTemplate":false}
```

The response uses the same `{"project":{…}}` envelope. Doxloop explicitly sends
`visibility: "private"` unless the user confirms `doxloop deploy --public`.
API-created projects default to `seedTemplate: false` so the following bundle
is their only documentation structure. Pass `true` only when the Doxbrix web
starter spaces and pages are wanted.

## Push a documentation bundle

```http
POST /api/v1/projects/{idOrSlug}/bundle
Authorization: Bearer dxb_…
Content-Type: application/json
```

The request body is:

```json
{
  "manifest": { "version": 1, "spaces": [] },
  "basePath": "docs",
  "pages": [
    {"path": "index.mdx", "markdown": "---\ntitle: Welcome\n---\n\n# Welcome"}
  ],
  "media": [
    {"path": "assets/logo.svg", "base64": "…"}
  ],
  "publish": true
}
```

`manifest` is the parsed `docs.json` object. Page and media paths are relative
to the documentation directory. Media content is base64-encoded. The server
converts markdown to blocks and materializes spaces, navigation, and pages.
Only the manifest and files under the configured documentation directory may
be represented in the payload; configured product-source directories must
never be included.

This endpoint is the native Doxbrix generator boundary. Do not send external
generator output to it; use the artifact deployment API below.

Successful response:

```json
{
  "result": {
    "spaces": 1,
    "pagesCreated": 2,
    "pagesUpdated": 0,
    "navItems": 3,
    "warnings": []
  },
  "dryRun": false
}
```

## Deploy a locally-built static artifact

Create the project with its producing generator:

```json
{
  "name": "Example documentation",
  "slug": "example-documentation",
  "visibility": "private",
  "connectedArtifact": { "generator": "docusaurus" }
}
```

When reusing a project, Doxloop sets the requested visibility with
`PATCH /api/v1/projects/{idOrSlug}/settings` before publishing.

Reserve an upload by sending the ZIP byte length and lowercase/uppercase SHA-256
hex digest to `POST /api/v1/projects/{idOrSlug}/deployments`. PUT the exact ZIP
bytes to the returned `deployment.upload.url` with every returned header, then
call `POST /api/v1/projects/{idOrSlug}/deployments/{buildId}/complete`.
Doxbrix rejects missing, expired, size-mismatched, or checksum-mismatched objects.

Poll `GET /api/v1/projects/{idOrSlug}/deployments/{buildId}` until `status` is
`ready` or `failed`. A ready response includes `hostedUrl`, file/page counts, and
the generator retained for finalization.

## Errors

Error responses use:

```json
{"error":{"code":"machine-readable-code","message":"Human-readable message"}}
```

Doxloop also accepts `{"error":"message"}` and `{"message":"message"}` shapes.
