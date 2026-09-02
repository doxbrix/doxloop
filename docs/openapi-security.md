# Remote OpenAPI safety policy

Doxloop treats remote OpenAPI URLs as untrusted input. Connection tests on the
**Sources** page, discovery and planning, coverage, and monitoring checks all
use the same versioned OpenAPI connector and enforce these controls:

- only HTTP and HTTPS URLs without embedded credentials are accepted;
- localhost, `.local` names, private, loopback, link-local, multicast, and
  reserved IP ranges are rejected after DNS resolution on every redirect;
- redirects are handled manually and limited to three;
- requests time out after 15 seconds and response bodies are limited to 5 MB;
- JSON, YAML, plain-text, or octet-stream responses are accepted only when the
  payload parses as a valid OpenAPI 3.x or Swagger 2.0 document; other content
  types require a `.json`, `.yaml`, or `.yml` URL path;
- HTTP credentials are never persisted. Private specifications should use a
  public, credential-free, or deliberately short-lived pre-signed URL, or be
  uploaded as a file from the **Add source** dialog;
- ETag and Last-Modified validators are retained in the local, mode-0600 cache.
  Cached specification bodies stay under `.doxloop/cache/` and are excluded
  from proposals and deployments.

Structural snapshots hash operations, parameters, request bodies, responses,
security, examples, schemas, and security schemes. A remote change therefore
marks only evidence-mapped operations and schemas stale instead of treating the
entire specification as an opaque file.
