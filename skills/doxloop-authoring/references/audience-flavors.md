# Audience flavor

Apply audience as a modifier to each selected domain and documentation-type
template. Do not build a generic audience-only documentation set.

## Adapt on six axes

For every page, decide:

1. **Job**: the observable outcome this reader owns.
2. **Assumed knowledge**: concepts that may be used without explanation.
3. **Control surface**: UI, API, SDK, CLI, configuration, or operational tool.
4. **Decision depth**: choices and tradeoffs the reader must understand.
5. **Risk**: mistakes the reader can cause and safeguards they need before acting.
6. **Evidence shape**: examples, screenshots, schemas, commands, or runbook checks
   that best prove the task.

## Flavor profiles

### End users

Lead with goals and visible product language. Minimize implementation detail.
State access requirements, exact UI labels, expected state changes, reversible
recovery, and where to get help. Use screenshots only when they reduce ambiguity.

### Application developers

Lead with a runnable first success and production integration path. Include
authentication, copyable examples, types or schemas, errors, limits, test
strategy, and debugging signals. Explain concepts only when they change code.

### Integration engineers and partners

Emphasize contract boundaries, environment setup, identifiers, mapping,
compatibility, delivery semantics, failure recovery, observability, and joint
ownership. Make prerequisites and handoff responsibilities explicit.

### Administrators

Emphasize scope of effect, required role, defaults, policy interactions,
identity lifecycle, configuration impact, auditability, safe rollback, and
delegation. Separate organization-wide changes from per-user actions.

### Platform engineers

Emphasize repeatability, configuration as code when supported, dependencies,
environments, security boundaries, scaling, observability, upgrade strategy,
and failure domains. Prefer deterministic commands and verification checks.

### Operators and SREs

Organize around service state, signals, thresholds supported by evidence,
diagnostic sequence, mitigation, rollback, recovery verification, and
escalation evidence. Distinguish routine operations from incident procedures.

### Security and compliance reviewers

Describe public trust boundaries, authentication and authorization behavior,
credential handling, data flows, audit evidence, retention controls, and known
limitations. Never turn code inspection into an unsupported compliance claim.

### Support teams

Start from observable symptoms. Provide safe questions, diagnostics, decision
branches, supported recovery, evidence to collect, and escalation conditions.
Avoid internal implementation detail that does not help resolution.

### Evaluators and technical leaders

Explain capabilities, fit, constraints, operating model, integration boundary,
and adoption path. Support claims with verified behavior. Avoid marketing
superlatives, exhaustive low-level reference, and unverified roadmap language.

### Contributors and maintainers

Emphasize local setup, architectural boundaries, code ownership, tests,
conventions, validation, safe change workflow, and review expectations. Keep
internal contributor content separate from customer-facing product docs.

## Mixed audiences

Do not write every page for everyone. Assign a primary reader to each journey.
Share stable concepts and reference when their purpose is identical; separate
procedures when permissions, tools, risks, or success criteria differ. Label
the intended reader in navigation or the opening when ambiguity would cause
errors.

## Apply the persisted brief

Use `primaryAudience`, `experienceLevel`, priority outcomes, terminology,
locale, tone, and exclusions as constraints. A user instruction may refine or
change them during create; update and review preserve them unless the user
explicitly changes the brief or verified behavior contradicts it.
