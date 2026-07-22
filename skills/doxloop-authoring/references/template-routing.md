# Expert template routing

Use this reference after initial product discovery and before proposing coverage.
Templates are investigation and authoring playbooks, never evidence about the
configured product.

## Compose the expertise profile

Build one profile from:

1. one primary domain template when evidence supports a meaningful match;
2. at most one adjacent domain template when a distinct public capability needs
   it;
3. every documentation-type template needed for the agreed reader outcomes;
4. audience flavor applied inside each selected domain/type combination; and
5. the persisted brief and current user request.

Do not treat audience as an independent documentation template. Audience changes
depth, vocabulary, prerequisites, examples, risk emphasis, and navigation order
inside a domain/type plan. When two audiences have materially different jobs,
create separate journeys or sections instead of averaging them into vague copy.
If no specialized domain matches, use the product evidence and relevant
documentation-type playbooks without forcing a domain label.

## Select without forcing a preset

- Infer templates from configured source evidence, existing pages, the persisted
  brief, and the user's words.
- Do not ask the user to choose a template or know a template identifier.
- When the match is clear, apply it and state the selected expertise profile in
  the discovery summary.
- When two choices would materially change scope, audience, or outcomes, include
  that decision in the single consolidated consultation already required for
  create work.
- A named template in the request is a strong intent signal, not permission to
  invent unsupported capabilities.
- Preserve selected outcomes and audience decisions in the documentation brief;
  do not persist template identifiers as permanent requirements.

## Domain routing signals

| Primary domain | Strong evidence signals |
| --- | --- |
| SaaS application | workspaces or tenants, memberships, roles, subscriptions, browser workflows |
| API platform | public routes or specifications, credentials, request/response contracts, quotas |
| Developer library | package exports, public types, runtime requirements, library contract tests |
| CLI tool | command parser, help output, flags, stdout/stderr, exit contracts |
| Payments and fintech | payment intents or charges, settlement, refunds, disputes, signed events |
| E-commerce | catalog, cart, order, inventory, fulfillment, returns |
| AI and machine learning | model or agent interfaces, inference, prompts, evaluations, model limits |
| Data platform | connectors, schemas, pipelines, transformations, lineage, data quality |
| Security and identity | identities, authentication factors, authorization policy, audit events |
| Infrastructure and DevOps | provisioning, environments, deployment, health, observability, recovery |

Choose the most specific supported domain. For example, a payment API uses the
payments domain as primary and the API-platform domain as adjacent. A SaaS
product with ordinary REST endpoints remains SaaS-primary unless developers are
the confirmed primary readers and the API is the main product.

## Documentation-type routing signals

| Type playbook | Select when readers need to |
| --- | --- |
| Getting started | reach a first meaningful result from a clean state |
| Developer portal | integrate across onboarding, concepts, tasks, and reference |
| API reference | look up a supported programmatic contract consistently |
| SDK guide | install and use a language library correctly |
| CLI manual | discover and automate supported commands and options |
| User guide | complete recurring product tasks through a UI or user-facing workflow |
| Administrator guide | configure shared settings, identities, roles, policy, or lifecycle |
| Integration guide | connect the product to another bounded system |
| Deployment and operations | deploy, observe, maintain, upgrade, and recover a running system |
| Troubleshooting knowledge base | diagnose observable symptoms and apply verified recovery |
| Migration and release | move between versions or act on release-visible change |
| Architecture and concepts | make correct decisions using stable public mental models |

Read only the selected domain and documentation-type files. Do not load the
whole catalog merely because it exists.

## Resolve overlap

- Domain templates own domain risk, lifecycle, state, and practitioner concerns.
- Type templates own reader journey, page architecture, procedural contract,
  and reference completeness.
- The audience-flavor reference owns adaptation within the selected combination.
- The navigation-architecture reference owns the common site frame, type-block
  composition, domain overlays, audience ordering, and navigation quality gate.
- The generator skill owns syntax, components, navigation files, and rendering.
- Product evidence overrides every template suggestion.

If a suggested topic has no reader need or supporting evidence, omit it. If
source evidence reveals a material capability not named by a template, document
it according to the agreed scope rather than constraining coverage to the
template.
