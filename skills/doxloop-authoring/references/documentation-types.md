# Documentation types and applicability

Use this reference during discovery, planning, and review. Select documentation
types from reader needs and source evidence. Do not create every type by default.
After selecting the relevant types, use the matching expert type playbooks linked
from `SKILL.md` for deeper investigation, structure, and senior quality gates.
Apply audience flavor within the selected domain/type combination rather than
treating audience as its own document template.

## Contract for every page

Give every page one identifiable reader job or reference purpose. Include:

- an outcome-focused title and description;
- the intended outcome in the opening;
- prerequisites before the point where readers need them;
- verified instructions, facts, or examples appropriate to the page type;
- expected results and limitations where they affect completion;
- recovery guidance only when supported by evidence;
- a useful next step or related destination.

Omit a section when it has no reader need. Do not add empty headings to satisfy
a template.

## Foundational pages

### Overview

Explain what the product is, who it serves, its primary outcomes, and how its
major capabilities fit together.

Use when the source exposes more than one reader-visible capability or when a
new reader needs orientation before choosing a workflow.

### Installation

Cover supported installation methods, prerequisites, platform or runtime
requirements, configuration needed before first use, and installation
verification.

Use when package metadata, build files, installers, or tests establish a
supported installation path.

### Quickstart

Lead a new reader through the shortest verified path to a meaningful result.
Show inputs, commands or code, expected output, and the next useful action.

Use for every product that has an executable first-success workflow.

## Learning and task pages

### Tutorial

Teach a complete workflow while introducing concepts in the order the reader
needs them. Tutorials optimize for learning and confidence.

Use when readers must combine multiple capabilities or understand a sequence
before working independently.

Keep the learning path controlled and reproducible. Deliver a meaningful
working result, introduce concepts only when needed, and avoid optional branches
that prevent the learner from knowing whether they succeeded.

### How-to guide

Help an informed reader complete one concrete task. State prerequisites, give
ordered steps, show success, and include evidence-backed recovery guidance.

Use for distinct, repeatable reader jobs supported by public interfaces or
tests.

Assume the reader is already oriented. Address one practical goal, allow
relevant variation, and avoid turning the guide into a lesson or exhaustive
reference.

### Examples and recipes

Provide small, verified solutions for common variants, integrations, or usage
patterns without duplicating full guides.

Use when tests, fixtures, or examples demonstrate multiple useful ways to apply
the same interface.

### User-interface workflow

Guide readers through a stable visible workflow using exact labels, permissions,
states, and outcomes. Use screenshots only when they materially reduce
ambiguity, keep them current, and provide equivalent text instructions.

Use when public UI source, routes, accessible labels, tests, or approved product
captures establish the workflow.

## Understanding pages

### Concept

Explain a mental model, lifecycle, relationship, or design constraint needed to
use the product correctly. Connect the explanation to observable behavior.

Use when readers must make decisions that procedures alone cannot answer.

Explain the mental model, consequences, relationships, and tradeoffs. Connect
each abstraction to reader-observable behavior and link to tasks or reference
instead of embedding long procedures.

### Architecture

Explain reader-relevant components, boundaries, and data or control flow.

Use only when the architecture is public, stable, and necessary for operators,
integrators, or advanced users. Do not expose internal-only implementation.

## Reference pages

### API or SDK reference

Document supported public endpoints, exports, parameters, return values,
errors, authentication requirements, and verified examples.

Use when routes, schemas, public types, generated specifications, or tests
establish a supported programmatic interface.

Define the reference scope and cover it consistently. Include types, required
and optional values, defaults, return or response behavior, errors,
authentication, limits, and verified examples when the interface supports them.

In a Doxbrix project, use the native endpoint contract from
`$doxloop-doxbrix`: one `<ApiEndpoint>` per HTTP operation with nested `<Param>`
and `<Response>` children. Do not flatten endpoint reference into Markdown
tables or generic request and response code blocks.

### CLI reference

Document commands, arguments, flags, defaults, exit behavior, and examples.

Use when the product exposes a command-line interface.

### Configuration reference

Document supported keys, types, defaults, environment behavior, precedence,
constraints, and examples.

Use when configuration schemas, parsers, defaults, or tests provide evidence.

### Data model

Document public resources, fields, relationships, identifiers, lifecycle states,
and invariants needed to use an API, SDK, or integration correctly.

Use when schemas, public types, migrations, or contract tests establish a stable
reader-visible model.

### Events and webhooks

Document event names, delivery and retry behavior, signatures, ordering,
payloads, failure handling, and verified examples.

Use when public event schemas, webhook routes, tests, or retry configuration
provide evidence.

## Operational and lifecycle pages

### Authentication and security

Explain supported authentication flows, permissions, credential handling, and
security boundaries without exposing secrets or internal controls.

Use when readers must authenticate, authorize, or make security-sensitive
choices.

### Deployment and operations

Cover supported deployment, health verification, monitoring, backup, upgrade,
and recovery workflows.

Use for services or applications with evidence-backed operator responsibilities.

### Troubleshooting

Map observable symptoms to likely supported causes, diagnostics, and recovery
steps.

Use when errors, tests, or established behavior support reliable guidance.
Never invent likely fixes.

### Migration and upgrade

Explain reader-visible changes, prerequisites, compatibility concerns, ordered
steps, and verification.

Use when the source contains versioned behavior, deprecations, migrations, or
upgrade tooling.

### Release notes and deprecations

Summarize reader-visible additions, changes, fixes, removals, compatibility, and
required actions for a defined release.

Use when version history, release metadata, migrations, or deprecation markers
provide verified evidence. Do not turn commit messages into unsupported product
claims.

### Support and compatibility

State supported versions, platforms, runtimes, browsers, lifecycle status, and
support boundaries.

Use when package metadata, test matrices, release policy, or public
configuration establishes these commitments.

### Versioned documentation

Maintain separate versions only when multiple product versions are actively
supported and reader-visible behavior differs. Make the selected version clear,
avoid mixing examples across versions, and link migrations between them.

### Glossary

Define domain terms only when several pages depend on the same non-obvious
meaning. Prefer definitions near first use when a standalone glossary would not
improve findability.

## Prioritization

Group proposed pages using:

- **Must have**: required for the primary reader to understand, start, and
  complete the product's main supported workflows.
- **Next**: important for repeated use, broader capabilities, confident
  decisions, or common recovery.
- **Later**: valuable for advanced, less common, or lifecycle-specific needs.

For every proposed page, name its reader, outcome, documentation type, and
supporting source evidence. Omit a type when it has no distinct reader need or
cannot be verified.
