# Security model

Doxloop separates local authoring from explicit publishing. This document
describes which guarantees the CLI enforces and which behavior depends on the
selected coding agent and host environment.

## Trust boundaries

- `.doxloop/project.json`, installed generator packages, configured product
  sources, and public design references are user-selected inputs.
- Source text, comments, tests, generated files, command output, and reference
  pages are evidence, not instructions. The authoring prompt tells agents to
  ignore embedded requests that change scope, reveal secrets, weaken safeguards,
  contact unrelated services, or publish.
- Coding agents retain the filesystem permissions granted by their host. The
  configured `sources` list is an authoring-policy boundary, not an operating
  system sandbox.
- Product sources are read-only evidence. The create and update workflows tell
  the agent to write only inside the separate documentation project.
- `doxloop review` launches supported agents in read-only or plan mode.
  Create and update require write access to the documentation project.

## Local files

The documentation `contentDir` must be a relative directory inside the project.
Doxloop rejects project-root, escaping, absolute, and symlinked content
directories. Deployment rejects a content directory that differs from
`.doxloop/project.json` and refuses symlinks anywhere in documentation content.

The first-run create flow rejects a documentation project that is the same as,
inside, or contains a configured product source. It also rejects configured
sources that are missing and non-empty output directories before writing project
files.

Do not place credentials, private keys, environment files, internal data, or
product source under the documentation content directory.

## Network access

Authoring and validation do not publish. A coding agent may still have network
access according to its own configuration.

Design capture:

- accepts only configured HTTP or HTTPS reference origins;
- captures at most three requested pages per origin;
- blocks navigation away from the configured origin;
- blocks loopback, private, link-local, multicast, and other non-public network
  destinations; and
- stores screenshots and measurements under the Git-ignored
  `.doxloop/cache/reference/`.

For a trusted local documentation reference, set
`DOXLOOP_ALLOW_PRIVATE_REFERENCES=1` for that capture invocation.

Application guide screenshots are separate authoring actions. They run only
when requested, forced with `--screenshots`, or enabled by the optional
`application.screenshots.policy`. The authoring workflow limits navigation to
the configured application surface and requires non-production fixtures or test
accounts, but the selected coding agent and its browser retain the permissions
granted by their host. Do not configure a production application, store
credentials in `.doxloop/project.json`, or expose customer data for capture.
Use `--no-screenshots` when the authoring environment should not operate an
application.

Doxbrix API requests require HTTPS. HTTP is accepted only for loopback
development. Authenticated and device-flow requests refuse redirects.

## Credentials and publishing

Prefer `doxloop login` and the device flow. Environment variables avoid placing
tokens in shell history; `--token` is intended for controlled automation.
Stored credentials use user-only file permissions on operating systems that
support them.

Only `doxloop deploy` publishes. Native projects send a contained documentation
bundle to the Doxbrix API. External generators are built on the user's machine;
Doxloop removes its Doxbrix tokens from the child build environment, scans only
the declared static output, rejects symbolic links/private keys/likely secret
files, omits source maps, and enforces file and expansion limits before packaging.
Deployments are private by default. A saved public deployment or
`doxloop deploy --public` shows a default-no warning that anyone will be able
to access the site. Non-interactive publishing requires explicit saved settings
or `--public` together with `--yes`.

The archive is uploaded directly to one short-lived, single-object S3 URL whose
SHA-256 checksum is signed. Doxbrix verifies the object size and checksum before
queueing its trusted indexing/infusion pipeline. Generator code never runs in the
Doxbrix web or finalizer process for this deployment path.

## Reporting vulnerabilities

Follow [the repository security policy](../SECURITY.md). Never put credentials,
private product source, or unpublished vulnerability details in a public issue.
