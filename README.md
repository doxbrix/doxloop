<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/doxloop-logo-dark.png">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/doxloop-logo-light.png">
    <img src="assets/brand/doxloop-logo-light.png" alt="Doxloop" width="560">
  </picture>
</p>

<h1 align="center">Documentation your coding agent can actually ship</h1>

<p align="center">
  Turn source code or an API specification into a polished, validated documentation site<br>
  with Codex, Claude Code, or Gemini.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@doxbrix/doxloop"><img alt="npm version" src="https://img.shields.io/npm/v/@doxbrix/doxloop.svg"></a>
  <a href="https://nodejs.org"><img alt="Node.js version" src="https://img.shields.io/node/v/@doxbrix/doxloop.svg"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-proprietary-red.svg"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#real-examples">Real examples</a> ·
  <a href="#use-doxloop-in-vs-code-codex-or-claude">Editor and agent apps</a> ·
  <a href="#everyday-workflow">Commands</a> ·
  <a href="#guides">Guides</a>
</p>

```mermaid
flowchart LR
    A["Source code<br>or OpenAPI"] --> B["Doxloop +<br>your coding agent"]
    B --> C["Structured<br>documentation"]
    C --> D["Preview, validate,<br>and publish"]
```

Doxloop gives your coding agent a repeatable documentation workflow: inspect
the source, identify the audience, plan the content, write generator-native
pages, build navigation, and validate the result. Your product source stays
separate from the generated documentation project.

## Quickstart

### 1. Install

Requires Node.js 20.12 or later.

```bash
npm install --global @doxbrix/doxloop
```

### 2. Set up the documentation project

Run this from your product directory:

```bash
doxloop init
```

Doxloop detects the product repository and guides you through the project
location, product evidence, site title, and generator. It shows a complete
summary before creating anything. Product code and documentation are kept in
separate sibling directories.

Documenting an API without a product checkout? Run the same command in the
directory where you want to work, then choose **API specification** and enter
the OpenAPI file or URL when asked.

### 3. Create the documentation

```bash
cd ../my-product-docs
doxloop create
```

`create` asks what readers need and which agent to use, shows all supported
choices, and automatically installs Codex, Claude Code, or Gemini with npm when
you select a missing agent. It shows an authoring summary and starts the agent
only after confirmation. Press Enter at the documentation request to let the
agent recommend a complete, evidence-backed plan.

### 4. Preview and validate

```bash
doxloop preview --open
doxloop test
```

Your source and docs remain separate:

```text
workspace/
├── my-product/       ← read-only source evidence
└── my-product-docs/  ← editable and deployable documentation
```

From then on, the everyday workflow is deliberately short:

```bash
doxloop update
doxloop deploy
doxloop settings
```

No configuration flags are required for interactive use. Advanced flags remain
available as optional one-run overrides for scripts and CI.

## Real examples

### Lodash developer docs from the CLI

From the [Lodash](https://github.com/lodash/lodash) source directory:

```bash
doxloop init
cd ../lodash-docs
doxloop create
```

At the `create` prompt, request developer documentation with a quickstart,
class and function reference, and a simple example for every function. Choose
Claude Code when Doxloop asks which agent to use. If it is missing, Doxloop
installs it before the run. That choice can be remembered for later updates.

**Generated documentation:** <https://apps-lodash-docs.sites.doxbrix.com/>

### Petstore API docs from VS Code with Codex

First, initialize a documentation project. Use `petstore-docs` as the project
directory, choose **API specification**, and enter
`https://petstore3.swagger.io/api/v3/openapi.json` when asked:

```bash
doxloop init
cd petstore-docs
code .
```

Then give Codex this prompt:

> Using Doxloop authoring, create API documentation for this OpenAPI document:
> https://petstore3.swagger.io/api/v3/openapi.json

Because `doxloop init` installs the Doxloop authoring skills inside the project,
Codex can inspect the OpenAPI document and create the pages, endpoint reference,
examples, and navigation directly in the opened folder.

**Generated documentation:** <https://apps-pet-store.sites.doxbrix.com/>

When it finishes:

Run `doxloop preview --open` and `doxloop test` when it finishes.

## Use Doxloop in VS Code, Codex, or Claude

Prefer working in Visual Studio Code, the Codex app, Claude Code, or another
local agent experience? Initialize the project first:

```bash
doxloop init
```

Then open the generated folder where you want to work:

| Where | Open the project |
| --- | --- |
| VS Code with Codex | `code ../my-product-docs` |
| Codex app | Open the generated documentation folder |
| Claude Code | `cd ../my-product-docs && claude` |

Ask the agent to use Doxloop authoring:

```text
Use Doxloop authoring to create developer documentation for this project.
Start with a five-minute quickstart, then add task guides and API reference.
```

`doxloop init` installs project-local skills for the supported agent
ecosystems:

| Agent experience | Installed skills |
| --- | --- |
| Codex and Gemini | `.agents/skills/` |
| Claude Code | `.claude/skills/` |

If an editor does not load project skills automatically, prepare a complete
prompt and paste it into the agent session:

```bash
doxloop create --print \
  "Create developer documentation with a quickstart and API reference."
```

> `--print` cannot record when the external agent finishes. Use a
> Doxloop-launched CLI agent when automatic source-change tracking is important.

## What Doxloop handles

| Capability | What you get |
| --- | --- |
| 🔎 **Source-grounded research** | Uses code, public interfaces, tests, examples, and configuration as evidence. |
| 🧭 **Documentation planning** | Identifies readers, important workflows, page coverage, and navigation before writing. |
| ✍️ **Generator-native output** | Creates the right Markdown, MDX, configuration, components, and theme for the selected generator. |
| ✅ **Built-in quality checks** | Validates pages, navigation, links, metadata, code fences, and generator conventions. |
| 🔄 **Focused updates** | Tracks the source revision and directs the agent to documentation affected by product changes. |
| 🔐 **Local-first control** | Keeps authoring, validation, and preview local; publishing is always a separate command. |

## Everyday workflow

| Goal | Command |
| --- | --- |
| Create a docs project | `doxloop init` |
| Generate documentation | `doxloop create` |
| Update docs after code changes | `doxloop update` |
| View or change project settings | `doxloop settings` |
| Run a read-only quality review | `doxloop review` |
| Preview locally | `doxloop preview --open` |
| Validate the project | `doxloop test` |
| Check setup and agent readiness | `doxloop doctor` |
| See project status | `doxloop status` |
| Deploy using saved settings | `doxloop deploy` |

Run `doxloop <command> --help` for every option.

### Change project settings

Use one settings command instead of editing `.doxloop/project.json` or
remembering configuration flags:

```bash
doxloop settings
```

The interactive settings menu manages:

- product source directories and OpenAPI specifications;
- the site title and default authoring agent;
- audience, locale, tone, and reader outcomes;
- design references and application screenshot behavior; and
- hosted project name, slug, visibility, and Doxbrix destination.

Generator changes are intentionally not performed in place because changing
frameworks can overwrite generator-native files. Create a new project with
`doxloop init` when migrating generators.

### Optional automation overrides

Interactive users do not need flags. Scripts can still override saved settings
for one run:

```bash
doxloop create --agent codex --reasoning high
doxloop create --agent claude --model <model-name>
doxloop create --agent gemini
```

### Ask for exactly what you need

```bash
doxloop create \
  "Write for platform engineers. Include installation, Kubernetes deployment, authentication, a production-readiness checklist, and troubleshooting."
```

```bash
doxloop update \
  "Document webhook retries and remove the legacy import workflow."
```

You can describe the audience, desired outcomes, required pages, tone,
priorities, or exclusions in plain language.

## Preview, test, and publish

Authoring never publishes automatically.

```bash
doxloop status
doxloop test
doxloop preview --open
```

To deploy through [Doxbrix](https://www.doxbrix.com/):

```bash
doxloop deploy
```

`deploy` validates the documentation, shows the exact name, slug, destination,
visibility, page count, and warnings, then asks once before uploading. It offers
sign-in after you approve the summary. Deployments are private by default.

Use `doxloop settings` to change visibility or the hosted address. A public
deployment always shows a default-no warning in an interactive terminal. For
CI, the explicit combination `doxloop deploy --public --yes` runs without
prompts.

## Supported generators

Doxbrix is built in and selected by default. External generators use a separate
adapter package, so each documentation project installs only what it needs.

| Generator | Package | Source format | Build output |
| --- | --- | --- | --- |
| **Doxbrix** | Included | Markdown and Doxbrix MDX | Doxbrix bundle |
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

Choose a generator during `doxloop init`. Doxbrix is the recommended first
choice and needs no extra installation. Selecting another framework opens a
second list and Doxloop offers to install its adapter package. The
[public generator guide](https://doxloop.sites.doxbrix.com/generators) covers
installation, selection, inspection, removal, and migration.

## Guides

| Author and maintain | Configure and extend | Operate safely |
| --- | --- | --- |
| [Create documentation](https://doxloop.sites.doxbrix.com/create) | [Project configuration](https://doxloop.sites.doxbrix.com/project-configuration) | [Troubleshooting](https://doxloop.sites.doxbrix.com/troubleshooting) |
| [Update documentation](https://doxloop.sites.doxbrix.com/update) | [Generators](https://doxloop.sites.doxbrix.com/generators) | [Security](https://doxloop.sites.doxbrix.com/security) |
| [Agent compatibility](https://doxloop.sites.doxbrix.com/agent-compatibility) | [CLI reference](https://doxloop.sites.doxbrix.com/cli) | [CI and automation](https://doxloop.sites.doxbrix.com/ci-automation) |
| [Review documentation](https://doxloop.sites.doxbrix.com/review) | [Guide screenshots](https://doxloop.sites.doxbrix.com/guide-screenshots) | [Publish documentation](https://doxloop.sites.doxbrix.com/publish) |

Browse all documentation at <https://doxloop.sites.doxbrix.com/>.

## License

[Doxloop Proprietary Software License](./LICENSE). You may download, install,
and run unmodified copies for lawful personal or commercial purposes. Copying,
modification, incorporation into other products, and redistribution are not
permitted without explicit written permission from Doxbrix.
