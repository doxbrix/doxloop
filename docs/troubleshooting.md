# Troubleshoot Doxloop

## Check the complete setup

Inside an existing documentation project, run:

```bash
doxloop doctor
```

Before creating a new project, check the proposed sibling directories:

```bash
doxloop doctor --source ./my-product --output ./my-docs
```

Doctor checks the Node.js version, product-source boundary, selected agent and
authentication, project skills, generator readiness, and documentation
validation, plus the default preview port. It exits with code 1 when a required
check fails.

## No supported agent is available

Install Codex, Claude Code, or Gemini CLI and confirm its executable is on
`PATH`. Alternatively:

```bash
doxloop create --print
```

Paste the prompt into an agent session opened at the project root.

## An installed skill is modified

Doxloop does not overwrite local skill changes automatically.

```bash
doxloop agent status
doxloop agent update
```

Review the diff before replacing intentional customizations.

## An external generator cannot load

Install both core and the selected generator package in the documentation
project. Then run:

```bash
doxloop generator doctor
```

Native generators may also require Python, Ruby, Hugo, or Node dependencies.
The doctor output reports the expected build command.

## Create exits but synchronization is not recorded

Doxloop withholds the baseline when validation fails or the create brief lacks
`primaryAudience` or `priorityOutcomes`. Run `doxloop test`, resolve every
error, and rerun create or update.

## Capture blocks a URL

Capture rejects unconfigured origins, cross-origin navigation, and private
network destinations. Add the intended public origin with `--reference`. For a
trusted local reference only:

```bash
DOXLOOP_ALLOW_PRIVATE_REFERENCES=1 doxloop capture http://localhost:3000/
```

## Guide screenshots are missing

Application guide screenshots are created during `doxloop create` or
`doxloop update`, not by design-reference capture. Ask for screenshots in the
request or pass `--screenshots`. Configure `application.baseUrl` and, when
Doxloop should start the application, a configured source name plus
`startCommand` in `.doxloop/project.json`.

If the selected agent has no browser capability, the application is unreachable,
or authentication and safe test data are unavailable, Doxloop keeps the text
guide complete and omits broken image links. Establish a non-production browser
session or local fixture and rerun the affected update. Never provide production
credentials or customer data for screenshot capture.

## API requests fail

Confirm the API URL uses HTTPS, the token starts with `dxb_`, and the endpoint
does not redirect. HTTP is accepted only for loopback development. Prefer
`doxloop login` to refresh credentials.

## Preview port is occupied

Choose another port:

```bash
doxloop preview --port 4400 --open
```

## Validation and native builds disagree

`doxloop test` performs fast project and content checks; the native build is the
final generator parser. Run both and treat either failure as blocking.
