# Developer-portal playbook

Use when developers need an integrated documentation experience spanning
onboarding, concepts, implementation tasks, contract reference, and production
operation of an API, SDK, extension platform, or developer tool.

## Architect the journey

Organize around developer maturity:

1. evaluate fit and prerequisites;
2. obtain access and reach first success;
3. understand the minimum domain and resource model;
4. complete common end-to-end integrations;
5. look up exact contracts;
6. test, debug, secure, observe, and ship;
7. maintain compatibility and migrate.

Do not make the landing page a feature inventory. Route readers by their next
job. Keep task guides outcome-based and reference exhaustive within its declared
scope. Cross-link concepts at the decision point rather than duplicating them.

## Expected coverage

Select evidence-backed modules for environments, credentials, first request or
program, core resources, common workflows, errors, limits, events, test strategy,
security, observability, compatibility, changelog, and support. Include SDK or
CLI material only when those surfaces are supported.

Use consistent examples, identifiers, fictional data, and terminology across
the portal. Evolve a small canonical scenario from quickstart through advanced
guides so readers can transfer understanding without copying one oversized sample.

## Production-readiness lens

Where supported, cover credential lifecycle, retries, idempotency, timeouts,
concurrency, pagination, asynchronous state, logging and correlation, sandbox
differences, versioning, and safe failure. Do not label an integration
production-ready when these concerns are unknown.

## Standard navigation

Promote substantial API, SDK, or changelog surfaces to top navigation. Use this
left-navigation order:

```text
Overview
Getting started
Core concepts
Developer guides
SDKs
API reference
Events and webhooks
Errors and limits
Testing
Production readiness
Troubleshooting
Migration guides
Changelog
```

Omit unsupported surfaces and merge SDKs or API reference into a single
Reference group when they are small.

## Senior quality gate

A developer can assess fit, reach first success, build the primary supported
integration, locate a consistent contract, and prepare for evidenced production
failure and change without reverse-engineering the source.
