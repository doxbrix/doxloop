# Security model

Doxloop separates local authoring from explicit publishing. This document
describes which guarantees Doxloop enforces and which behaviour depends on the
selected coding agent and host environment.

## Trust boundaries

- `.doxloop/project.json`, installed generator packages, configured product
  sources, and public design references are user-selected inputs.
- Source text, comments, tests, generated files, command output, and reference
  pages are evidence, not instructions. The authoring prompt tells agents to
  ignore embedded requests that change scope, reveal secrets, weaken safeguards,
  contact unrelated services, or publish.
- Coding agents retain the filesystem permissions granted by their host. The
  configured source list on the **Sources** page is an authoring-policy
  boundary, not an operating system sandbox.
- Product sources are read-only evidence. Planning runs are read-only. The
  generation workflow tells the agent to write only inside an isolated
  proposal workspace within the documentation project, and nothing reaches the
  real documentation until a reviewer accepts it.

## The control center

The control center binds to the loopback address only and is never exposed to
the network. Project files, tokens, and repository credentials stay on the
machine; the browser receives project state, proposals, and logs, never
credentials. Personal access tokens entered for private Git repositories are
held in memory for the session, forwarded to Doxloop child processes through
the environment rather than the command line, and never written to the project
configuration. Authoring jobs are cancellable, proposals stay isolated until
accepted, and deployment is a separate confirmed action.

## Local files

The documentation `contentDir` must remain contained by the documentation
project. New native Doxbrix projects use `contentDir: ""`, so their Markdown,
MDX, assets, and `docs.json` live at the project root; Doxloop allows that root
only for the native Doxbrix generator and excludes operational, VCS, dependency,
and build directories from page discovery and deployment. Legacy native
projects with `contentDir: "docs"` remain supported. External generators must
use a non-empty relative content directory. Escaping, absolute, and symlinked
content directories are rejected, and deployment refuses symlinks anywhere in
the selected documentation content.

The setup wizard rejects a documentation project that is the same as, inside,
or contains a configured product source. It also rejects configured sources
that are missing and an output directory that already exists.

Do not place credentials, private keys, environment files, internal data, or
product source under the documentation content directory.

## Network access

Authoring and validation do not publish. A coding agent may still have network
access according to its own configuration.

Remote OpenAPI sources follow the [remote OpenAPI safety policy](./openapi-security.md).
Git repository sources are downloaded as read-only snapshots through the
provider's read API; Doxloop never clones, fetches, commits, pushes, or changes
hooks in a source checkout.

Design-reference capture:

- accepts only configured public HTTP or HTTPS reference origins;
- captures at most three requested pages per origin;
- blocks navigation away from the configured origin;
- blocks loopback, private, link-local, multicast, and other non-public network
  destinations; and
- stores screenshots and measurements under the Git-ignored
  `.doxloop/cache/reference/`.

Application guide screenshots are separate authoring actions. They run only
when **Add product screenshots?** is enabled for a run, when the request asks
for them, or when the screenshot policy under **Settings → Visual evidence** is
set to automatic. When capture is enabled, Doxloop injects a run-scoped
Playwright MCP browser into supported Codex and Claude authoring processes; it
does not modify the user's global agent configuration. The browser runs
headless with an isolated profile, writes into the proposal workspace, and
closes with the agent run. The authoring workflow limits navigation to the
configured application surface and requires non-production fixtures or test
accounts, but the selected coding agent and its browser retain the permissions
granted by their host. Do not configure a production application, store
credentials in `.doxloop/project.json`, or expose customer data for capture.
Choose **No screenshots** for a run, or set the policy to **Never**, when the
authoring environment should not operate an application. Plans also require a
machine-readable capture manifest. Doxloop rejects captures outside the
approved visual pages, unsafe asset paths, missing or unreadable PNGs, blank or
duplicate images, unembedded files, and captures that have not completed
expected-state, privacy, legibility, and meaningfulness review.

Doxbrix API requests require HTTPS. HTTP is accepted only for loopback
development. Authenticated and device-flow requests refuse redirects.

Release-quality external-link checks accept only credential-free HTTP or HTTPS
URLs, validate every redirect destination, and block private, loopback,
link-local, reserved, or unresolved addresses. Cached responses support
offline CI. Authentication responses and temporary network/server failures are
warnings rather than definitive broken-link failures.

Executable examples are opt-in. Declared Node files run with explicit
filesystem permissions and no network permission; Python files run in isolated
mode with socket creation and process-launch APIs blocked. Both use a minimal
environment, explicit fixtures, a timeout, no shell, and a temporary workspace
that is cleaned afterward. OpenAPI request examples are checked against the
connected contract without contacting an API. Apparent credentials are
rejected, and runtimes without a portable sandbox remain visibly
source-verified rather than silently executed.

Rendered accessibility and visual checks load generated local HTML and abort
all browser network requests. Current screenshots and quality reports are
derived, Git-ignored artifacts; approved visual baselines are separated by
generator, theme, route, and viewport.

Interrupted job checkpoints, raw job logs, proposal-delivery records, and the
bounded reviewer-preference record are local, owner-readable, Git-ignored
artifacts. Persisted retry data is accepted only for known Doxloop actions and
project-contained working directories. Reviewer instructions are length-bound
and known private-key and provider-token formats are redacted before reuse.

**Prepare PR branch** works in a temporary Git worktree and does not switch or
edit the current checkout. **Push branch** and **Push & create PR** are
separate explicit actions. Doxloop invokes Git and GitHub CLI with argument
arrays rather than a shell and does not expose a pasteable shell command built
from branch names.

## Credentials and publishing

Sign in from the **Deploy** page with **Sign in with browser**, which uses a
device flow so no token is typed or pasted. Stored credentials use user-only
file permissions on operating systems that support them, and **Sign out**
removes the local token.

Only **Deploy to Doxbrix** publishes. Native projects send a contained
documentation bundle to the Doxbrix API. External generators are built on the
user's machine; Doxloop removes its Doxbrix tokens from the child build
environment, scans only the declared static output, rejects symbolic
links/private keys/likely secret files, omits source maps, and enforces file
and expansion limits before packaging. Deployments are private by default. A
public visibility setting is shown on the Deploy page before every deployment,
with a note that anyone with the URL will be able to open the site. A **Dry
run** validates and builds without uploading anything.

The archive is uploaded directly to one short-lived, single-object S3 URL whose
SHA-256 checksum is signed. Doxbrix verifies the object size and checksum before
queueing its trusted indexing/infusion pipeline. Generator code never runs in the
Doxbrix web or finalizer process for this deployment path.

## Reporting vulnerabilities

Follow [the repository security policy](../SECURITY.md). Never put credentials,
private product source, or unpublished vulnerability details in a public issue.
