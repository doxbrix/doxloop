<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/doxloop-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/doxloop-logo-light.png">
    <img src="assets/brand/doxloop-logo-light.png" alt="Doxloop" width="560">
  </picture>
</p>

<h1 align="center">Doxloop</h1>

[![npm version](https://img.shields.io/npm/v/@doxbrix/doxloop.svg)](https://www.npmjs.com/package/@doxbrix/doxloop)
[![license](https://img.shields.io/badge/license-proprietary-red.svg)](./LICENSE)
[![node](https://img.shields.io/node/v/@doxbrix/doxloop.svg)](https://nodejs.org)

**Create professional product documentation from your source code with the
coding agent you already use.**

Doxloop is a local-first documentation CLI for Codex, Claude Code, and Gemini.
It gives your agent a structured authoring workflow, generator-specific format
knowledge, and quality checks so it can research your product and produce
accurate, maintainable documentation.

From a directory that contains your product, one command creates a separate
documentation project and starts the complete authoring workflow:

```bash
doxloop create --source ./my-product --output ./my-docs
```

The agent studies your product, proposes the right documentation set, confirms
important reader decisions, and creates the pages, navigation, examples, and
theme in `my-docs`. The product source is read-only evidence; it is never changed
or included in documentation deployment.

## Why Doxloop?

- **Grounded in your product.** The agent researches configured source code,
  public interfaces, tests, examples, and configuration instead of inventing
  product behavior.
- **Complete documentation planning.** Before editing, it identifies likely
  readers, important workflows, and the documentation types supported by the
  source.
- **Professional authoring standards.** Pages follow consistent editorial,
  accessibility, information-architecture, example, and verification rules.
- **Generator-native output.** Doxloop creates the correct navigation,
  frontmatter, components, configuration, and page format for the selected
  generator.
- **Consistent future updates.** Reader, scope, terminology, tone, and
  accessibility decisions are saved with the project and reused by later runs.
- **Focused maintenance.** Doxloop tracks the source revision used for the last
  independently validated documentation run, including committed and
  uncommitted source content, and directs the agent to relevant changes.
- **Local control.** Source inspection, authoring, validation, and preview happen
  locally. Publishing is always a separate command.

## Requirements

- Node.js 20.12 or later
- For automatic agent launch, at least one supported agent CLI on `PATH`:
  [Codex](https://developers.openai.com/codex/cli),
  [Claude Code](https://claude.com/claude-code), or
  [Gemini CLI](https://github.com/google-gemini/gemini-cli)

If you prefer to work in an IDE or desktop agent, use `--print` to generate the
prepared prompt and paste it into a local agent session.

## Documentation

Jump directly to:

- [Quickstart](#quickstart)
- [Documentation requests and expert templates](#describe-the-documentation-you-want)
- [Application guide screenshots](#add-application-guide-screenshots)
- [Agent selection and compatibility](#choose-an-agent)
- [Updates and source synchronization](#keep-documentation-current)
- [Independent documentation review](#review-documentation)
- [Design references](#use-a-design-reference)
- [Generator selection](#choose-a-generator)
- [Project structure](#how-doxloop-works)
- [Validation and preview](#validate-and-preview)
- [Troubleshooting](#troubleshooting)
- [Free deployment with Doxbrix](#deploy-for-free-with-doxbrix)
- [Security](#security)

## Quickstart

Install Doxloop:

```bash
npm install --global @doxbrix/doxloop
```

Create the documentation as a separate sibling project:

```bash
doxloop create --source ./my-product --output ./my-docs
```

That single command starts the agent and the complete Doxloop authoring
workflow. The agent:

1. researches the configured product source;
2. identifies the readers, public capabilities, and important workflows;
3. proposes a prioritized documentation plan;
4. asks once for any decisions that cannot be resolved from the request or
   source;
5. saves the confirmed documentation brief;
6. creates or improves the complete agreed documentation set;
7. adds every reader-facing page to generator-native navigation; and
8. verifies the result against Doxloop's quality requirements.

Preview and validate the result:

```bash
cd my-docs
doxloop preview --open
doxloop test
```

The product and documentation projects must be separate directories:

```text
workspace/
├── my-product/  # read-only product source; never deployed
└── my-docs/     # documentation project and deployment boundary
```

The generated documentation remains ordinary Markdown, MDX, reStructuredText,
Markdoc, or HTML—depending on the selected generator—so you can review, edit,
and version it like any other project.

## Describe the documentation you want

Pass additional instructions directly to `doxloop create`:

```bash
doxloop create "Write for platform engineers. Include installation, Kubernetes deployment, authentication, a production-readiness checklist, and troubleshooting."
```

The request can describe the audience, outcomes, required pages, priorities,
terminology, tone, or meaningful exclusions. For example:

```bash
doxloop create "Create a concise quickstart for application developers, followed by complete API reference documentation."
```

```bash
doxloop create "Prioritize self-hosted deployment and administration. Do not document internal APIs."
```

These instructions work alongside evidence found in the product source. Durable
decisions are saved in `.doxloop/project.json` and reused during future updates
and reviews.

### Expert templates are selected automatically

Doxloop does not require users to choose a preset. During discovery, the agent
infers the most relevant domain expertise and documentation-type playbooks from
the configured source, existing pages, persisted brief, and current request. It
then applies the audience inside that combination to adjust depth, terminology,
examples, risk guidance, and navigation.

For new or restructured sites, the agent also composes navigation from a shared
professional frame, the selected documentation-type blocks, domain-specific
overlays, and audience ordering. It presents a top-navigation and left-navigation
outline before authoring, removes unsupported or duplicate destinations, and
translates the result into the selected generator's native navigation system.

For example, this request combines payments-domain expertise, a developer-portal
playbook, and application-developer audience flavor:

```bash
doxloop create "Create complete integration documentation for application developers using our payments API."
```

This request combines SaaS-domain expertise, an administrator-guide playbook,
and workspace-administrator flavor:

```bash
doxloop create "Create a task-oriented guide for workspace administrators, including onboarding, roles, security settings, and recovery."
```

Users can also transform existing documentation through the normal update
workflow:

```bash
doxloop update "Restructure the existing documentation as an administrator guide. Preserve verified content, remove duplication, and make configuration effects explicit."
```

The agent states the inferred expertise profile in its discovery summary. It
asks only when competing profiles would materially change the reader, scope, or
outcomes. Template checklists guide investigation but never establish product
facts; every included capability still requires configured source evidence.

### Add application guide screenshots

Ask for screenshots directly in the authoring request:

```bash
doxloop create "Create an onboarding guide with screenshots. Highlight the control used in each important step."
```

Or require screenshots independently of the request wording:

```bash
doxloop create --screenshots "Create an onboarding guide."
doxloop update --screenshots "Refresh the billing workflow guide."
```

Use `--no-screenshots` to suppress capture for a run. Screenshot capture is
integrated into create and update; it does not change `doxloop capture`, which
continues to collect ignored evidence from external design references.

Configure an application surface in `.doxloop/project.json` when Doxloop should
start or connect to a local test application:

```json
{
  "application": {
    "baseUrl": "http://localhost:3000/",
    "source": "product",
    "startCommand": "npm run dev",
    "readyPath": "/health",
    "screenshots": {
      "policy": "requested",
      "viewport": { "width": 1440, "height": 900 },
      "highlight": true
    }
  }
}
```

Guide screenshots are saved as committed, generator-native documentation
assets and inserted beside the step they illustrate. When highlighting is
enabled, the authoring workflow adds a temporary high-contrast focus ring and
numbered marker before capture; the annotation is baked into the image without
modifying application source.

## Choose an agent

Doxloop selects the first supported agent found on `PATH`. Choose one
explicitly when needed:

```bash
doxloop create --agent codex
doxloop create --agent claude
doxloop create --agent gemini
```

You can also select a model:

```bash
doxloop create --agent claude --model <model-name>
```

For Codex, set the reasoning effort for the run:

```bash
doxloop create --agent codex --reasoning high
```

Supported reasoning values are `minimal`, `low`, `medium`, `high`, and `xhigh`.

To use the prepared workflow in a local IDE or desktop agent without asking
Doxloop to start a CLI:

```bash
doxloop create --print
```

Paste the printed prompt into an agent session opened at the Doxloop project
root. Project skills are installed under `.agents/skills` for Codex and Gemini,
and `.claude/skills` for Claude Code.

> **Note:** `--print` prepares the prompt but cannot observe when the external
> agent finishes, so it does not record a new synchronization baseline. Use the
> Doxloop-launched CLI workflow when automatic source-change tracking is
> required.

## Keep documentation current

After the product changes, run:

```bash
doxloop update
```

Doxloop compares the product source with the recorded synchronization baseline,
includes committed and uncommitted changes in the agent prompt, and directs the
agent to update affected reader-visible documentation.

Add instructions when an update needs special handling:

```bash
doxloop update "Document webhook retries and remove the legacy import workflow."
```

The synchronization baseline is stored in `.doxloop/sync-state.json`. Commit
this file when a team should share the same documentation update point.

## Review documentation

Run an independent, read-only documentation review:

```bash
doxloop review
```

The agent reports prioritized findings for:

- accuracy and source evidence;
- reader workflows and coverage;
- information architecture and navigation;
- examples and reference depth;
- editorial quality and terminology;
- accessibility and presentation; and
- maintainability and release readiness.

`doxloop review` does not edit documentation files.
Supported agents run review in their read-only or plan mode.

## Use a design reference

Doxloop can adapt the information architecture and design language of a public
documentation site while keeping your product's identity and content separate:

```bash
doxloop init my-docs \
  --source product=../my-product \
  --reference https://docs.example.com/
```

You can also add a reference while creating documentation:

```bash
doxloop create \
  --reference https://docs.example.com/ \
  "Use this site as an information-architecture and presentation reference."
```

The authoring workflow inspects a bounded set of representative pages and
captures layout, typography, color, navigation, and component patterns. It does
not use the reference site's product claims, examples, names, or navigation
labels as evidence for your product.

When the selected agent has no browser capability, capture measured local
evidence with:

```bash
doxloop capture
```

Doxloop installs a managed Playwright and Chromium environment on first use,
then saves screenshots and measured styles under
`.doxloop/cache/reference/`. Capture is limited to configured reference
origins.

## Choose a generator

Doxbrix is the default generator and is included in the core package. Additional
generators are installed as independent packages so each project carries only
the integration it uses.

| Generator | Package | Source format | Build output |
| --- | --- | --- | --- |
| Doxbrix | Included | Markdown and Doxbrix MDX | Doxbrix bundle |
| Docusaurus | `@doxbrix/doxloop-generator-docusaurus` | Markdown and MDX | `build/` |
| MkDocs Material | `@doxbrix/doxloop-generator-mkdocs` | Material Markdown | `site/` |
| Sphinx | `@doxbrix/doxloop-generator-sphinx` | reStructuredText | `_build/html/` |
| Hugo | `@doxbrix/doxloop-generator-hugo` | Markdown | `public/` |
| VitePress | `@doxbrix/doxloop-generator-vitepress` | Markdown | `docs/.vitepress/dist/` |
| Markdoc | `@doxbrix/doxloop-generator-markdoc` | Markdoc | `dist/` |
| Nextra | `@doxbrix/doxloop-generator-nextra` | MDX | `out/` |
| Starlight | `@doxbrix/doxloop-generator-starlight` | Markdown and MDX | `dist/` |
| Jekyll | `@doxbrix/doxloop-generator-jekyll` | Markdown and Liquid | `_site/` |
| Static HTML | `@doxbrix/doxloop-generator-static` | HTML | `site/` |

To start a project with an external generator, install the core package and its
generator package locally:

```bash
mkdir my-docs
cd my-docs
npm init --yes
npm install --save-dev \
  @doxbrix/doxloop \
  @doxbrix/doxloop-generator-mkdocs

npx doxloop init . \
  --source product=../my-product \
  --generator mkdocs

npx doxloop create
```

Inspect and manage generator packages with:

```bash
doxloop generator list
doxloop generator add mkdocs
doxloop generator info mkdocs
doxloop generator doctor
```

`generator add` installs support; it does not convert the current project or
change its selected generator. To change generators, create or initialize a
project with the new generator, carry over the confirmed documentation brief
and source bindings, translate the content and navigation, then run
`doxloop test` and the new generator's strict build before changing public
URLs.

`doxloop preview` uses the selected generator's native development workflow.
Run `doxloop generator info <generator>` to see its build command and output
directory.

## How Doxloop works

`doxloop init` creates a documentation project and installs two project-local
skills:

| Skill | Responsibility |
| --- | --- |
| `doxloop-authoring` | Discovery, consultation, coverage planning, evidence, editorial quality, accessibility, maintenance, and review |
| `doxloop-<generator>` | Native files, navigation, frontmatter, components, configuration, theme, preview, and generator-specific validation |

The project keeps the authoring context needed for consistent future work:

```text
my-docs/
├── .doxloop/
│   ├── project.json       # sources, generator, design references, and editorial brief
│   ├── sync-state.json    # last successful source synchronization
│   └── last-run.json      # ignored local validation receipt
├── .agents/skills/        # Codex and Gemini project skills
├── .claude/skills/        # Claude Code project skills
└── docs/                  # documentation content for the default generator
```

Manage installed skills with:

```bash
doxloop agent status
doxloop agent setup
doxloop agent update
```

## Validate and preview

Check the project at any time:

```bash
doxloop status
doxloop test
doxloop preview --open
```

- `status` summarizes the generator, pages, sources, references, errors, and
  warnings.
- `test` validates the documentation structure, navigation, links, metadata,
  code fences, and supported generator conventions.
- `preview` starts the selected generator's local preview with live reload where
  supported.

Use `doxloop test --format json` or `doxloop status --format json` in
automation.

## Troubleshooting

Run `doxloop doctor` inside an existing documentation project to check the
project configuration, source paths, selected agent, installed skills,
generator readiness, authentication, and documentation structure. Before a
project exists, provide the intended locations explicitly:

```bash
doxloop doctor --source ./my-product --output ./my-docs
```

Useful recovery commands include:

```bash
doxloop agent setup
doxloop agent update
doxloop generator doctor
doxloop login
doxloop preview --port 4400 --open
```

If validation fails, run `doxloop test`, resolve every reported error, and run
the selected generator's strict build. If deployment authentication fails,
sign in again with `doxloop login`; Doxbrix API URLs must use HTTPS and Doxbrix
tokens start with `dxb_`.

## Deploy for free with Doxbrix

[Doxbrix](https://www.doxbrix.com/) is the hosted documentation platform that
works with Doxloop. Doxloop handles source-grounded authoring, maintenance,
validation, and preview on your machine. Doxbrix makes your documentation
agentic by adding an Ask AI feature to your published docs by default.

Publishing is separate from authoring, and **you can deploy a project for free
on Doxbrix**. Paid plans are optional and add higher limits and additional
platform features. You can also build your documentation with a supported
external generator and deploy its static output to your preferred hosting
provider.

Create a free Doxbrix account at
[app.doxbrix.com/sign-up](https://app.doxbrix.com/sign-up), then:

```bash
doxloop login
doxloop deploy --dry-run
doxloop deploy
```

For the native Doxbrix generator, `deploy --dry-run` validates and summarizes the
documentation bundle. For Docusaurus, MkDocs, Sphinx, Hugo, VitePress, Markdoc,
Nextra, Starlight, Jekyll, and static HTML, it runs the configured build locally
and validates/packages the generated static output. `deploy` then creates or
reuses a compatible Connected Docs project, uploads the checksum-bound artifact,
and waits for Doxbrix indexing and deployment. Only the documentation bundle or
generated site is uploaded; configured product source directories are not part
of the deployment.

Doxloop never installs dependencies during deploy. Install them first and make
sure the generator build works locally. Only the generator's declared output
directory is traversed (product source directories are not collected separately),
Doxloop credentials are removed from the build environment, source maps are omitted,
and likely secret files or symbolic links stop deployment.

## Command reference

| Command | Purpose |
| --- | --- |
| `doxloop init` | Create a documentation project |
| `doxloop create` | Research the product and generate documentation |
| `doxloop update` | Update documentation after product changes |
| `doxloop review` | Run a read-only professional quality review |
| `doxloop status` | Summarize the project and validation state |
| `doxloop test` | Validate documentation |
| `doxloop preview` | Start the local documentation preview |
| `doxloop capture` | Capture design-reference screenshots and styles |
| `doxloop agent` | Manage project-local authoring skills |
| `doxloop generator` | Manage generator packages |
| `doxloop login` | Sign in to Doxbrix |
| `doxloop logout` | Remove the local Doxbrix token |
| `doxloop whoami` | Show the current Doxbrix account |
| `doxloop deploy` | Publish a native bundle or locally-built static site to Doxbrix |

Run `doxloop <command> --help` for complete command options.

## Security

- The authoring workflow treats configured product sources as its evidence
  boundary. The coding agent retains the filesystem permissions granted by its
  host; this is a policy boundary rather than an operating-system sandbox.
- Authoring, validation, preview, and design-reference capture run locally.
- The authoring workflow prohibits reading credential files or publishing as
  part of documentation creation.
- Source files and external pages are treated as untrusted evidence rather than
  instructions.
- Documentation content directories must remain inside the project and cannot
  contain symbolic links.
- Deployment is restricted to documentation pages, permitted media, and the
  selected generator's manifest.
- Doxbrix credentials are stored in the user's configuration directory with
  user-only permissions where the operating system supports them.
- Deployment uploads only the native documentation bundle or the selected
  external generator's validated static output. It does not upload configured
  product source directories.

## License

[Doxloop Proprietary Software License](./LICENSE). You may download, install,
and run unmodified copies for lawful personal or commercial purposes. Copying,
modification, incorporation into other products, and redistribution are not
permitted without explicit written permission from Doxbrix.
