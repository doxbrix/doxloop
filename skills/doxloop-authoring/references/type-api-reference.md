# API-reference playbook

Use for a supported public programmatic contract. Pair it with getting-started
and task guidance when readers must learn or combine operations.

## Declare the reference boundary

Name the API, version or stability boundary, environment, and operations included.
Exclude internal, experimental, generated-only, or unreachable interfaces unless
the product explicitly supports them. Use the generator's native API-reference
contract when available.

## Cover every operation consistently

Document, when supported:

- method or operation name, path, purpose, and authorization;
- content types, headers, path, query, cookie, and body parameters;
- type, format, requiredness, default, allowed values, constraints, and semantics;
- request examples using safe realistic data;
- success status, headers, body schema, field meaning, and example;
- error statuses, error body, cause, retryability, and reader action;
- pagination, filtering, sorting, expansion, idempotency, and concurrency behavior;
- permissions, limits, side effects, asynchronous state, and related events.

Document reusable schemas once when that improves consistency, but keep operation-
specific meaning next to the operation. Distinguish absent, null, empty, zero,
and default values when the contract does.

## Reconcile evidence

Compare specifications, public route types, validation schemas, tests, and
implementation. Report contradictions rather than silently choosing convenient
values. A generated specification may establish shape but not operational
guarantees; tests may demonstrate cases without defining the entire contract.

## Standard navigation

Promote `API reference` to top navigation only when it is a substantial primary
surface. Use this left-navigation block:

```text
API overview
  Base URLs and environments
  Authentication
  Request conventions
  Response conventions
  Versioning
Resources
  Resource groups and operations
Data models
Common behavior
  Pagination, filtering, and sorting
  Idempotency and concurrency
  Limits
Errors
Events and webhooks
```

Group operations by reader-visible resources, not implementation controllers.

## Senior quality gate

Coverage is uniform across the declared public surface; required and optional
values are unambiguous; examples conform to schemas; errors lead to a supported
action; and no material contract fact must be inferred from a sample alone.
