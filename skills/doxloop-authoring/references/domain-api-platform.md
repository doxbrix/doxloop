# API platform expertise

Use when a public API is the product or a primary integration surface. Combine
with a more specific business domain when the API represents payments,
commerce, identity, data, or infrastructure.

## Think like a senior API documentation lead

Document the integration lifecycle, not only endpoints: obtain access, select an
environment, form a valid request, identify resources, handle asynchronous
state, recover from failure, test safely, observe production behavior, and
upgrade without contract surprises.

## Investigate

- base URLs, environments, media types, version negotiation, and transport;
- authentication methods, credential scopes, rotation, and test credentials;
- resource identifiers, ownership, lifecycle states, and concurrency behavior;
- request headers, validation, defaults, pagination, filtering, sorting, and search;
- response envelopes, nullability, timestamps, money, units, and unknown fields;
- error schema, status mapping, retryability, idempotency, and correlation IDs;
- synchronous versus asynchronous operations, polling, events, and webhooks;
- rate or usage limits, quotas, batching, caching, and timeout behavior;
- compatibility, deprecation, changelog, SDK, and specification sources.

## Design coverage

Give developers a verified first call before exhaustive reference. Use concepts
to explain authentication, resource relationships, state transitions, delivery
semantics, and error strategy. Keep task guides for multi-operation outcomes and
reference pages for lookup. Use one consistent endpoint contract across the
declared public surface.

Examples must use safe placeholders, show the complete required request, include
an expected response or observable result, and demonstrate error handling where
production correctness depends on it. Prefer the product's canonical language
or protocol examples; do not manufacture SDKs.

## Navigation overlay

Insert supported destinations into Developer portal, Guides, Concepts, and
Reference:

```text
Environments and authentication
Resources and lifecycle
Common integration workflows
Pagination, idempotency, and concurrency
Events and webhooks
Errors and limits
Testing and production readiness
Versioning and deprecations
```

Keep exact operations in API reference and multi-operation outcomes in Guides.

## Never assume

Do not invent rate limits, retry rules, idempotency guarantees, ordering,
exactly-once delivery, field stability, authentication scopes, sandbox parity,
version lifetime, or backward compatibility. An OpenAPI file is strong contract
evidence but may not prove operational limits or delivery semantics.

## Senior quality gate

A developer must be able to make a valid first request, understand the core
resource model, implement supported failure handling, and locate every contract
element promised by the reference scope without reverse-engineering examples.
