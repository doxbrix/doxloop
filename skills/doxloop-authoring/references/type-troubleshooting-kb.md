# Troubleshooting knowledge-base playbook

Use when source evidence supports reliable diagnosis from observable symptoms.
Do not create speculative fix lists.

## Write from symptom to resolution

Title each article with the observable symptom or failed outcome. Start with the
scope and safety impact, then use this sequence:

1. confirm the symptom and affected scope;
2. collect the least invasive diagnostic evidence;
3. check likely causes in a discriminating order;
4. apply one supported recovery at a time;
5. verify restoration of the original outcome;
6. collect escalation evidence when recovery fails.

Use decision tables or branches only when a signal clearly distinguishes the
next action. Put destructive, security-sensitive, or data-changing recovery
behind prerequisites, warnings, backup, and explicit target checks.

## Evidence sources

Prefer documented errors, public diagnostics, contract tests, support fixtures,
health endpoints, logs, exit behavior, and reproducible failure tests. Error text
alone may be unstable; pair it with an error code, state, or reader-observable
condition when available.

## Avoid weak articles

Do not tell readers to retry, restart, reinstall, clear caches, delete state,
disable security, or contact support unless evidence establishes when and why.
Do not list many plausible causes without a way to distinguish them. Never ask
readers to publish secrets or personal data in diagnostic output.

## Standard navigation

Promote `Troubleshooting` only when the knowledge base is a major destination.
Organize the left navigation by observable symptom family:

```text
Troubleshooting overview
Collect diagnostics
Installation problems
Authentication and access problems
Configuration problems
Connectivity problems
Workflow problems
Integration problems
Performance or capacity problems
Error reference
Recovery
Get support
```

Omit unsupported families. Put individual articles under the symptom a reader
would recognize, not the internal component suspected of causing it.

## Senior quality gate

The article lets a reader recognize that it applies, diagnose safely, choose a
supported recovery based on evidence, verify success, and escalate with useful
redacted information when the issue remains.
