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
  with Codex, Claude Code, or Gemini, from one local control center.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@doxbrix/doxloop"><img alt="npm version" src="https://img.shields.io/npm/v/@doxbrix/doxloop.svg"></a>
  <a href="https://nodejs.org"><img alt="Node.js version" src="https://img.shields.io/node/v/@doxbrix/doxloop.svg"></a>
  <a href="./LICENSE"><img alt="License" src="https://img.shields.io/badge/license-proprietary-red.svg"></a>
</p>

<p align="center">
  <a href="#quickstart">Quickstart</a> ·
  <a href="#real-examples">Real examples</a> ·
  <a href="#the-workspace">The workspace</a> ·
  <a href="#keep-documentation-current">Monitoring</a> ·
  <a href="#review-what-changed-and-why">Review</a> ·
  <a href="#guides">Guides</a>
</p>

```mermaid
flowchart LR
    A["Source code<br>or OpenAPI"] --> B["Doxloop +<br>your coding agent"]
    B --> C["Plan, write,<br>and review"]
    C --> D["Preview, validate,<br>and deploy"]
```

Doxloop is a local, browser-based control center for documentation. You connect
the sources that describe your product, describe what readers should be able to
do, and approve a documentation plan. Your coding agent researches the evidence
and writes generator-native pages into an isolated proposal. You review every
change, accept what is right, preview the site, and deploy it, all from the same
window. Product source stays read-only and separate from the documentation
project.

## Quickstart

### 1. Install

Doxloop requires Node.js 22.13 or later. Install Google Chrome for application screenshots and sign-in capture; text-only authoring does not need a browser.

Try the bundled demo first, without an agent or a model charge:

```sh
npx @doxbrix/doxloop demo
```

Then adopt an existing documentation folder in the setup wizard, or create a new project. Run the read-only documentation audit before requesting an update. Start with the five-page preset: review the plan and its page, screenshot, and time caps before generation. Planning and writing are separate agent runs; each may take several minutes and uses your agent subscription or billing. Doxloop reports observed durations when comparable completed runs exist; a time cap is not a price quote.

```bash
npm install --global @doxbrix/doxloop
```

### 2. Open the control center

Open a terminal in the folder where you want the documentation project to be
created. That is usually the parent folder of your product checkout, so the
product and its documentation become sibling directories. Then start Doxloop:

```bash
doxloop ui
```

This is the only command you need. It starts a loopback-only server on
`http://127.0.0.1:4317` and opens your browser. Everything else happens in the
browser. When no documentation project exists yet, Doxloop opens the setup
wizard. When one exists, it opens the workspace for that project.

Already have a documentation site? The wizard's first step offers **Use
existing documentation folder**, which adopts a Docusaurus, MkDocs, Hugo,
Sphinx, VitePress, Starlight, Nextra, Markdoc, Jekyll, or Doxbrix site as it
is: Doxloop reads the site's configuration, lists its pages, and changes none
of them. Every project you open is remembered, and the project switcher in the
sidebar moves between them.

### 3. Set up the workspace

The wizard walks through five steps and creates nothing until the last one.

1. **Workspace.** Choose **Start new** and enter a folder name for the
   documentation project and the title readers will see, or choose **Use
   existing documentation folder** to adopt a site you already have.
2. **Sources.** Choose **Add source**, then **Source code** for a local folder
   or a Git repository, or **OpenAPI spec** to upload a file or paste a public
   URL. Private repositories accept a username and a personal access token that
   is held in memory for the session and never written to the project.
3. **Tools.** Pick the documentation generator (Doxbrix is recommended and
   needs no installation), the coding assistant (Codex, Claude Code, or
   Gemini), and optionally the model. If the assistant is not installed,
   Doxloop installs it for you. Answer **Add product screenshots?** to let
   Doxloop capture images from a running local or test application.
4. **Guidance.** Describe what readers should be able to do, choose the
   documentation depth (Comprehensive is recommended; the page count comes
   from your sources, not from the depth), add audiences, and open **Advanced
   planning preferences** for examples, locale, terminology, exclusions,
   accessibility target, and how the planner should handle questions.
5. **Review.** Check the summary and choose **Create documentation plan**.

Doxloop then downloads read-only snapshots of any remote sources, installs the
project-local authoring skills for the selected assistant, and starts a
read-only planning run. The planner researches your sources and proposes a
page structure. Nothing is written until you approve it.

### 4. Approve the plan and generate

The plan opens on the **Create** page. Answer anything under **Needs your
decision**, adjust the **Documentation brief**, and edit the **Documentation
structure**: add, reorder, remove, or defer pages, and open any page to change
its purpose, priority, section, or screenshot treatment. Ask for changes in
plain language under **Want to change the plan?** and a new plan version comes
back. When it looks right, choose **Approve & generate**.

Generation runs in an isolated workspace while **Live activity** shows each
stage. You can stop it at any time. When it finishes, the result is a proposal
and the documentation project is still unchanged.

### 5. Review, preview, and deploy

1. Open **Review** to compare the current and proposed versions of every file.
   Accept one change, one file, or everything, or ask the agent to revise a
   specific file.
2. Choose **Preview docs** in the top bar to open the rendered site locally.
3. Open **Deploy**, sign in with your browser, run a **Dry run** if you want to
   validate and build without uploading, and choose **Deploy to Doxbrix**.

Your source and docs remain separate:

```text
workspace/
├── my-product/       ← read-only source evidence
└── my-product-docs/  ← editable and deployable documentation
```

From then on, every update follows the same loop: describe the change on the
**Update** page, approve the plan, review the proposal, preview, and deploy.

## Real examples

### Lodash developer docs from a local checkout

With the [Lodash](https://github.com/lodash/lodash) repository checked out,
open a terminal in its parent folder and run `doxloop ui`. In the wizard:

1. Name the workspace `lodash-docs`.
2. Add a **Source code** source, choose **Local folder**, and browse to the
   Lodash checkout.
3. Choose **Doxbrix** as the generator and **Claude Code** as the coding
   assistant. Doxloop installs it if it is missing.
4. Under **Guidance**, ask for developer documentation with a quickstart, a
   class and function reference, and a simple example for every function.
5. Choose **Create documentation plan**, approve the plan, and review the
   proposal.

**Generated documentation:** <https://apps-lodash-docs.sites.doxbrix.com/>

### Petstore API docs from an OpenAPI URL

No product checkout is needed. Run `doxloop ui` in any folder and, in the
wizard:

1. Name the workspace `petstore-docs`.
2. Add an **OpenAPI spec** source, choose **From URL**, and enter
   `https://petstore3.swagger.io/api/v3/openapi.json`.
3. Choose **Codex** as the coding assistant.
4. Under **Guidance**, ask for API documentation with an endpoint reference and
   request examples.
5. Choose **Create documentation plan**, approve the plan, review the proposal,
   and open **Preview docs**.

**Generated documentation:** <https://apps-pet-store.sites.doxbrix.com/>

## What Doxloop handles

| Capability | What you get |
| --- | --- |
| 🔎 **Source-grounded research** | Uses code, public interfaces, tests, examples, configuration, and OpenAPI documents as evidence. |
| 🧭 **Plan before writing** | Proposes readers, page coverage, and navigation as an editable plan that you approve before anything is written. |
| ✍️ **Generator-native output** | Creates the right Markdown, MDX, configuration, components, and theme for the selected generator. |
| ✅ **Built-in quality checks** | Validates pages, navigation, links, metadata, code fences, page depth, and generator conventions on every proposal and before every deploy. |
| 🔍 **Reviewable proposals** | Every run lands in an isolated proposal with rendered and source comparisons, per-change acceptance, rationale, and evidence. |
| 📊 **Coverage by surface** | Shows which discovered product surfaces have documentation evidence and lets you resolve gaps. |
| ⚙️ **Monitoring** | Polls the source repository on a local schedule and drafts a proposal when documentation goes stale. |
| 📸 **Guide screenshots** | Gives the agent a scoped browser, verifies every PNG, and embeds images beside the steps they explain. |
| 🔐 **Local-first control** | Keeps authoring, validation, and preview on your machine. Deploying is a separate confirmed action and credentials never reach the browser. |

## The workspace

Every page has a stable URL, so browser back and forward work as expected. The
left navigation shows:

| Page | What you do there |
| --- | --- |
| **Overview** | Follow the loop from sources through plan, write, review, and deploy. See what needs your review, overall coverage, the published address, and recent activity. |
| **Sources** | Connect and test local folders, Git repositories, and OpenAPI specifications. Set documentation ownership per source, review coverage by surface, resolve gaps, and configure **Monitoring**. |
| **Create** or **Update** | Describe what readers need, choose the planning agent, model, and screenshot behaviour, review and edit the plan, and approve generation. The page also keeps the **Update history** of every request. |
| **Pages** | Browse every page by navigation section, preview it, edit its metadata, and describe a focused agent edit. Review the rendered and source changes before accepting, rejecting, refining, or undoing them. The **Navigation** view arranges the sidebar and **Images & files** manages uploads and alt text. |
| **Review** | Inspect each proposal file by file, read why each change was made, accept changes at any granularity, ask the agent to revise, and optionally prepare a pull request branch. |
| **Deploy** | Export a static folder/zip or publish to Doxbrix, GitHub Pages, Netlify, or Vercel, with target-specific settings and **Deployment history**. |
| **Settings** | Change the site title, default agent, audience and voice, terminology and the generated glossary, application screenshot settings, branding (logo, colours, fonts), and see the active generator. |

**Preview docs** in the top bar starts a local preview of the current
documentation and opens it in a new tab. The project name at the top of the
sidebar is the **project switcher**: it lists the projects you opened recently,
opens any folder, imports an existing documentation site, or starts the setup
wizard for a new project. **New documentation project** at the bottom of the
sidebar opens the same wizard.

### Work with more than one project

Doxloop shows one project at a time and remembers every project it has opened.
Open the project switcher and pick a recent project to move to it in one click;
both stay in the list. **Open folder…** opens a folder that is already a
Doxloop project, or offers to import it when it only holds a documentation
site. **Import existing documentation…** asks for the folder, shows the
detected generator, content directory, page count, and the first pages, lets
you correct any of them, and then adopts the folder: Doxloop writes its own
project file, an evidence map that marks every page as not yet verified, and
the agent skills, and runs a read-only discovery pass. No page is modified.
Sites built with a generator other than Doxbrix need that generator's Doxloop
package; the import dialog offers to add it to the folder's `package.json`.

Switching is refused while a plan, generation, edit, or deployment is running
in the current project; a local preview is stopped, because it serves the
project that started it.

### Edit a page

Run `doxloop ui`, open **Pages**, and select one or more existing pages. Tell
the agent what should change, optionally allow related navigation or image
updates, and wait for the isolated proposal. The live documentation remains
unchanged until you compare the rendered and source versions and choose
**Accept**; you can also **Reject**, **Refine**, or **Undo** the edit.

Some changes need no agent at all. **Page metadata** under the page header
edits the title, description, sidebar icon, canonical URL, and social image
directly, with validation and rollback. **Insert an image…** in the composer
picks or uploads an image and adds it to the instruction.

### Arrange the navigation

Open **Pages → Navigation**. Drag rows to reorder pages, drop them into a
section to group them, or use Alt with the arrow keys; select a row to rename
its label, choose an icon, or hide it. Pages that exist but are not in the
sidebar are listed under **Add page**. **Save navigation** validates the tree,
writes it to the generator's own file (`docs.json` for Doxbrix, the `nav` list
in `mkdocs.yml` for MkDocs), and reloads the preview beside the editor.
Generators whose navigation lives in code are named instead of edited. The
same editor appears in plan review, where it arranges the sections of a
proposed plan.

### Brand the site

Open **Settings → Branding**. For Doxbrix sites, choose the logo and favicon
from the project's images (or upload them), set the primary colour and the
light and dark accents and backgrounds, pick the colour mode and code theme,
and name the body, heading, and code fonts. The preview below reloads on save.
Other generators keep their theme in their own configuration file, which the
panel names.

### Manage images and files

Open **Pages → Images & files**. Upload or drop images and files into the
generator's asset directory, see which pages embed each one, edit the alt text
across all of them at once, replace a file in place, or delete one that no page
uses. Screenshots in a proposal that is still under review can be replaced from
the capture gallery before you accept it.

### Write release notes

When a connected source is a Git checkout, the **Update** page offers
**Release notes** beside the usual documentation request. Choose the
repository, the version label, and the two refs that bound the release;
Doxloop reads the commits, changed files, and the matching changelog section
between them and gives the planner that inventory as the only evidence for the
release page.

### Generate a glossary

Under **Settings → Audience and voice**, terminology is edited as term and
definition rows. **Generate glossary page** writes a glossary page from those
rows in the generator's format, adds it to the navigation, and records it in
the evidence map, so the vocabulary the team curates is visible to readers
without an agent run.

### Change project settings

Open **Settings** instead of editing `.doxloop/project.json` by hand. Its five
sections manage:

- **General**: site title and the default documentation agent;
- **Audience and voice**: primary audience, audiences, experience level,
  locale, accessibility target, tone, priority outcomes, preferred examples,
  design direction, terminology and the generated glossary page, exclusions,
  and standing instructions;
- **Visual evidence**: the safe application URL, ready path, starting route,
  sign-in route, screenshot policy, viewport, capture workflow guidance, a
  **Test application** check, and **Application sign-in** for login-protected
  apps: record a signed-in browser session from a Chrome window Doxloop opens,
  or save a test account's credentials that the capture server types for the
  agent;
- **Branding**: logo, favicon, colours, colour mode, and fonts for Doxbrix
  sites, or the theme file to edit for other generators; and
- **Generator**: the generator selected for this workspace.

Generator changes are intentionally not performed in place because changing
frameworks can overwrite generator-native files. Start a new documentation
project when migrating generators.

### Ask for exactly what you need

The request box on the **Create** and **Update** pages accepts plain language.
Describe the audience, desired outcomes, required pages, tone, priorities, or
exclusions, for example:

> Write for platform engineers. Include installation, Kubernetes deployment,
> authentication, a production-readiness checklist, and troubleshooting.

> Document webhook retries and remove the legacy import workflow.

Choose a starting scope, optionally set **Minimum pages to write** when the
existing documentation is thin, and decide whether the planner should ask you
questions in review, use recommendations, or always wait for answers.

## Keep documentation current

Documentation goes stale because nothing reports it. Doxloop records the
sources behind every page in `.doxloop/evidence-map.json`, so it can name the
individual pages a later change made stale rather than only reporting that a
source changed.

Open **Sources** and choose **Monitoring** to configure it:

1. Enter the **Product branch** to follow.
2. Choose a **Schedule**: daily, weekdays, weekly, monthly, or a custom
   interval in minutes or hours. Times use your device timezone.
3. Optionally open **Advanced watch scope and budgets** to set watched and
   ignored paths, the maximum agent minutes and runs per day, a maximum
   Claude spend per run, and how old verified evidence may become before it
   is re-verified.
4. Choose **Save and install**.

Doxloop installs a local scheduled job that checks every connected source. A
Git repository source is checked through the provider's read-only API; when
the commit changed, that exact commit is downloaded as isolated evidence. A
local folder is checked in place: a Git checkout by its HEAD commit and
working tree, any other folder by comparing its files with the content
recorded at the last sync. When documentation went stale, the job drafts a
proposal under **Review**. Monitoring never modifies the product source, never
fetches or pulls into a checkout, never installs repository hooks, never needs
a model API key, and never publishes. Choose **Check now** to run a cycle
immediately; the result appears as a notice in the control center and under
**Recent activity**. **Disable** removes the schedule while keeping the
settings.

Lock files and snapshots are ignored by default. Test files are not, because
the authoring workflow reads tests as evidence of supported behaviour.

## Review what changed and why

The **Review** page keeps the full review in one place:

1. The proposal list shows what is waiting, why it was drafted, and its status.
2. **Changed files** switches between every documentation and supporting-file
   change, with search.
3. **Diff layout** switches between side-by-side and stacked comparisons of the
   rendered pages, and the source view shows line-level context with an
   **Accept change** button on each individual change.
4. **Why this change** shows the supporting evidence, reader-facing claims,
   affected public interfaces, assumptions to verify, and validation results.
5. **Accept change**, **Accept file**, and **Accept all** apply the selection.
   **Ask agent to revise** regenerates only the selected scope and supersedes
   the earlier proposal. Applied page files link back to **Pages** for a new
   agent-driven edit.
6. **Preview documentation** renders the proposal, **Prepare PR branch**
   stages the accepted result in a Git branch, and **Push & create PR** opens
   a pull request.

Every accepted selection is checked against the original file fingerprint and
validated before it is written. A local edit made while review is pending
causes a visible conflict instead of an overwrite. Partial acceptance applies
only the selected changes and keeps the proposal pending. Rejected proposals
never change the documentation.

Doxloop also keeps a local record of what it was asked to do and what happened.
**Update history** on the Create and Update pages lists each request, its
outcome, and the pages it touched. **Deployment history** on the Deploy page
lists every deployment, including the ones that failed. The record lives in
`.doxloop/doxloop.db`, which is added to `.gitignore` automatically and is
readable only by its owner. Agent transcripts are not recorded.

## Preview, validate, and deploy

Doxloop validates pages, navigation, links, metadata, code fences, and page
depth every time it creates a proposal, and again before every dry run and
deployment. Validation errors stop a deployment; warnings are reported.

Choose **Preview docs** at any time to open the local site. Then open
**Deploy**:

1. Select Doxbrix, GitHub Pages, Netlify, or Vercel and save its settings.
   Netlify and Vercel tokens are stored outside the project; GitHub Pages uses
   the repository's existing `origin` remote.
2. Choose **Dry run** to validate, build, and leave a timestamped zip in
   `.doxloop/exports` without uploading.
3. Choose **Export folder + zip** for self-hosting, or deploy to the selected
   target. Doxbrix deployments can be private or public.

The same export is available from the command line:

```bash
doxloop export --out ./site-export --zip
doxloop deploy --target github-pages --base-path /my-repository
```

Authoring never publishes automatically, and configured product sources are
never included in a deployment.

## Supported generators

Doxbrix is built in and selected by default. External generators use a separate
adapter package that Doxloop installs into the documentation project when you
choose the generator in the setup wizard.

| Generator | Tier | Needs | Package | Source format | Build output |
| --- | --- | --- | --- | --- | --- |
| **Doxbrix** | Full | Nothing extra | Included | Markdown and Doxbrix MDX | Static `build/` plus Doxbrix bundle |
| Docusaurus | Full | Node.js 22.13+ | `@doxbrix/doxloop-generator-docusaurus` | Markdown and MDX | `build/` |
| MkDocs Material | Full | Python 3.9+ | `@doxbrix/doxloop-generator-mkdocs` | Material Markdown | `site/` |
| Sphinx | Supported | Python 3.9+ | `@doxbrix/doxloop-generator-sphinx` | reStructuredText | `_build/html/` |
| Hugo | Supported | Hugo | `@doxbrix/doxloop-generator-hugo` | Markdown | `public/` |
| VitePress | Supported | Node.js 22.13+ | `@doxbrix/doxloop-generator-vitepress` | Markdown | `docs/.vitepress/dist/` |
| Starlight | Supported | Node.js 22.13+ | `@doxbrix/doxloop-generator-starlight` | Markdown and MDX | `dist/` |
| Markdoc | Basic | Node.js 22.13+ | `@doxbrix/doxloop-generator-markdoc` | Markdoc | `dist/` |
| Nextra | Basic | Node.js 22.13+ | `@doxbrix/doxloop-generator-nextra` | MDX | `out/` |
| Jekyll | Basic | Ruby + Bundler | `@doxbrix/doxloop-generator-jekyll` | Markdown and Liquid | `_site/` |
| Static HTML | Basic | Node.js 22.13+ | `@doxbrix/doxloop-generator-static` | HTML | `site/` |

The tier describes Doxloop's adapter, not the framework. **Full** generators
have their navigation, components, and diagrams validated and documented and
are built end to end in CI. **Supported** generators validate nested
navigation wherever the configuration can be read and report "navigation not
verified" instead of guessing when it cannot. **Basic** generators scaffold,
preview, and build, with navigation checks limited to the files the scaffold
owns. The wizard's **Tools** step shows the tier beside each generator and
checks that the required toolchain is installed before the project is created.
Doxbrix is the recommended first choice. The
[public generator guide](https://doxloop.sites.doxbrix.com/generators) covers
selection, native build requirements, and migration.

## Guides

| Author and maintain | Configure and extend | Operate safely |
| --- | --- | --- |
| [Create documentation](https://doxloop.sites.doxbrix.com/create) | [Project configuration](https://doxloop.sites.doxbrix.com/project-configuration) | [Troubleshooting](https://doxloop.sites.doxbrix.com/troubleshooting) |
| [Update documentation](https://doxloop.sites.doxbrix.com/update) | [Generators](https://doxloop.sites.doxbrix.com/generators) | [Security](https://doxloop.sites.doxbrix.com/security) |
| [Review documentation](https://doxloop.sites.doxbrix.com/review) | [Agent compatibility](https://doxloop.sites.doxbrix.com/agent-compatibility) | [Automation and CI](https://doxloop.sites.doxbrix.com/ci-automation) |
| [Guide screenshots](https://doxloop.sites.doxbrix.com/guide-screenshots) | [Publish documentation](https://doxloop.sites.doxbrix.com/publish) | |

Browse all documentation at <https://doxloop.sites.doxbrix.com/>.

## License

[Doxloop Proprietary Software License](./LICENSE). You may download, install,
and run unmodified copies for lawful personal or commercial purposes. Copying,
modification, incorporation into other products, and redistribution are not
permitted without explicit written permission from Doxbrix.

### Direct page editing and bounded runs

In **Pages**, open **Edit text directly** to edit Markdown/MDX, preview a draft,
compare it with the saved version, and save without an agent. Browser drafts
survive reloads. A fingerprint conflict keeps your draft and prevents an
overwrite. Saves normally mark evidence for review; preserve verification only
when the change is wording alone. Direct edits have persistent undo in
**Manage pages → Recent direct edits**. Undo refuses to replace newer changes.

**Manage pages** creates, moves and deletes pages while updating navigation,
links and evidence in one validated transaction. Moves preserve or redirect
old URLs; deletion requires a replacement when other pages link to the target.
Doxbrix, MkDocs and autogenerated Docusaurus navigation are supported directly;
custom coded navigation requires a reviewed agent proposal. Unsupported native
formats are reported before any files change.

Proposal review supports direct text edits, per-file and per-change rejection
with reasons, and mixed accept/reject decisions. Rejecting remaining changes
keeps already accepted work. A fully decided mixed proposal can be undone;
rejected changes do not advance the source freshness baseline.

New UI runs default to a small first batch: five pages, no screenshots and
15 minutes per authoring attempt. **Run limits** and the plan review expose
maximum pages, screenshot artifacts and minutes. Approval refuses oversized
plans; mark extra pages **Later** or raise the limits explicitly. Generated
proposals outside the approved page scope or artifact limits remain in the
recovery workspace. The timer bounds each attempt; retries consume another
attempt. Planned coverage earns no documented-page credit.

Monitoring coordinates scheduled and manual authoring across processes,
reserves daily starts in a persistent ledger, and pauses while a proposal
needs review. Scheduled authoring requires verified agent sign-in. Monitoring
logs rotate at 1 MiB, retaining one previous file; rotation does not reset the
budget.

GitHub Pages publishing permits `gh-pages` or `doxloop-pages/<name>`, rejects
the checked-out source branch, and only updates existing branches marked as
Doxloop deployments. Each update preserves deployment history and protects
against concurrent remote changes. Use a fresh `doxloop-pages/<name>` for a
legacy branch without the ownership marker.

See [editing, auditing, versions, and review workflows](docs/review-workflows.md) for comments, bulk operations, read-only imports, reader verification, and the hosted pull-request impact check.
