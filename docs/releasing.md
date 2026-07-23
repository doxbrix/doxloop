# Releasing Doxloop

Doxloop releases are published interactively from a maintainer's machine. The
release command performs versioning, changelog promotion, validation, npm
publishing, Git commit and tag creation, pushing, and GitHub Release creation.

## Prerequisites

- Start on `main`, with local `main` matching `origin/main`.
- Install the Node.js and pnpm versions required by `package.json`.
- Authenticate the writable `doxbrix` GitHub account with `gh auth login` once.
  The release command selects that account automatically and configures Git to
  use its GitHub CLI credential.
- Have npm publish access to `@doxbrix/doxloop` and any modified generator
  packages, with 2FA/WebAuthn configured.

Preview the next patch release without changing files or publishing:

```bash
pnpm release:local --dry-run
```

Publish the next patch release:

```bash
pnpm release:local
```

Choose another semantic-version increment or an exact version:

```bash
pnpm release:local minor
pnpm release:local major
pnpm release:local 0.2.0
```

The command shows every package it will publish and every uncommitted file that
will enter the release commit. It requires typing the exact target version
before it changes files. If there is no active npm session, it starts
`npm login`. During each `npm publish`, complete npm's interactive 2FA or
WebAuthn prompt.

If publishing or GitHub Release creation fails after the release commit and tag
are created, fix the reported issue and rerun `pnpm release:local`. The command
detects the prepared tag, skips work already completed, and resumes the release.

The root package is always released. The command also compares each generator
package with its currently published source revision. Modified or unpublished
generators are assigned the same target version as the root package, their core
peer range is updated when necessary, and they are built and published after
the root package. Unchanged generators keep their existing versions and are
skipped. A dry run lists the exact package set without changing versions or
publishing.
