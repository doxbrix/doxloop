# Professional navigation architecture

Use this reference when creating a site, adding a reader journey, restructuring
documentation, or reviewing information architecture. Define a semantic
navigation plan first; then use the selected generator skill to implement it in
native configuration.

## Compose navigation

Build navigation in this order:

1. start with the common site frame;
2. add the blocks from each selected documentation-type playbook;
3. apply the primary and adjacent domain overlays;
4. use audience flavor to change emphasis, ordering, terminology, and depth;
5. remove unsupported, empty, duplicate, or out-of-scope destinations;
6. translate the semantic plan into the generator's top navigation, sidebar,
   menu, toctree, page map, or manifest.

Templates propose reader destinations; configured product evidence determines
whether the destination exists and what it says.

## Common top navigation

Use top navigation for major documentation surfaces, not for every content
group. Keep approximately five primary items and preserve project conventions.

| Slot | Default label | Include when |
| --- | --- | --- |
| Primary | Documentation | always for a documentation site |
| Reference surface | API, SDKs, CLI, or Reference | a substantial maintained lookup surface exists |
| Integration surface | Integrations | integrations are a primary product destination |
| Lifecycle | Release notes | release-visible change is maintained |
| Help | Support | a verified support destination exists |

Search, version, locale, theme, repository, status, and product-dashboard links
are utilities. Place them in generator-native utility controls or secondary
links instead of displacing the primary reader journey. Never invent a support,
status, repository, changelog, or product URL.

Promote at most two product surfaces such as API, SDKs, CLI, Integrations, or
Administration. Keep the rest inside Documentation. Use one stable label for a
destination across desktop, mobile, breadcrumbs, and side navigation.

## Common left-navigation grammar

Order groups by the reader's progression:

```text
Overview

Getting started
  Prerequisites
  Installation or access
  Quickstart
  Next steps

Guides
  Common workflows
  Advanced workflows
  Integrations

Concepts
  Core concepts
  Resource or object lifecycle
  Security or trust model

Reference
  Public interface reference
  Configuration
  Errors and limits

Operations
  Deployment or administration
  Observability
  Backup and recovery

Troubleshooting
  Diagnose problems
  Error reference
  Get support

Releases
  Migration guides
  Deprecations
  Release notes
```

This is a grammar, not a mandatory page tree. Omit a group when no selected
type/domain module contributes a supported reader destination.

## Size the structure

### Compact

Use for one primary workflow and a small public surface. Keep Overview, Getting
started, Guides, Reference, and Troubleshooting as needed. Prefer pages over
single-item groups.

### Standard

Use by default for a product with several workflows. Include distinct Getting
started, Guides, Concepts, Reference, and Troubleshooting groups; add Operations
or Releases when supported.

### Comprehensive

Use when several reader journeys or public surfaces need independent depth.
Create top-level surfaces or spaces only when they have their own overview,
onboarding path, tasks, concepts, reference, and maintenance needs. Avoid one
sidebar that mixes unrelated audiences and becomes difficult to scan.

## Merge type blocks

- Keep one Overview destination for the site or major surface.
- Merge duplicate Getting started groups and order their pages by dependency.
- Put outcome-focused pages under Guides; do not group by source directory.
- Share a concept page only when its mental model is identical for all readers.
- Keep API, SDK, and CLI reference boundaries distinct even if top navigation
  exposes only one `Reference` destination.
- Merge troubleshooting articles by symptom, not by the page that links to them.
- Put migration guides before chronological release notes when readers must act.
- Do not place the same page in primary navigation more than once; cross-link it.

## Apply audience flavor

- Developers see first success, guides, examples, and reference early.
- Administrators see setup, identities, policy, configuration effect, and audit
  before ordinary end-user workflows.
- End users see goal-oriented tasks and personal settings before concepts.
- Platform engineers and operators see architecture, deployment, health,
  observability, change, and recovery early.
- Support readers see symptom-led diagnostics and escalation evidence early.

When audiences have different permissions, tools, risks, or success criteria,
use separate navigation journeys or spaces. Do not create top-level audience
labels merely because several audiences exist.

## Navigation quality gate

- Every reader-facing page is reachable exactly once through primary navigation.
- The primary reader can identify the first step and common jobs without search.
- Labels are 2–5 words where possible, use reader vocabulary, and remain distinct.
- Group order follows task dependency and frequency, not alphabetic filenames.
- Navigation normally stays within three visible levels.
- Empty, speculative, single-item, and duplicate groups are removed.
- Top navigation contains only verified destinations and remains usable at
  narrow widths and keyboard zoom.
- Routes and labels remain stable during updates unless the user requested an
  information-architecture change or the old structure blocks reader success.
- Breadcrumbs, previous/next links, landing-page cards, and side navigation use
  the same hierarchy and terminology where the generator supports them.
