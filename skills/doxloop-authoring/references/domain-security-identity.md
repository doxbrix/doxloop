# Security and identity expertise

Use when identity, authentication, authorization, policy, secrets, audit, or
security operations are primary reader-visible capabilities.

## Think like a senior security documentation lead

Describe trust boundaries and authority precisely. Distinguish identity proof,
authentication, session establishment, authorization, policy evaluation,
credential lifecycle, and auditing. State actor, resource, scope, decision, and
observable result for every sensitive workflow.

## Investigate

- identity types, directories, federation, enrollment, verification, and recovery;
- authentication factors, protocols, sessions, expiry, revocation, and step-up behavior;
- roles, permissions, scopes, policy evaluation, inheritance, and deny/allow precedence;
- service accounts, API credentials, keys, certificates, secrets, and rotation;
- provisioning and deprovisioning, ownership transfer, break-glass paths, and lockout;
- audit events, timestamps, actors, targets, retention, export, and integrity claims;
- alerts, detections, incident states, containment, recovery, and evidence collection;
- public data flows, storage boundaries, logging, redaction, and administrative access;
- supported security configuration, defaults, limitations, and compatibility.

## Design coverage

Put secure setup and least-authority guidance before convenient shortcuts. State
the role and scope required for every administrative action. Explain default
behavior, propagation, revocation timing, recovery, and audit evidence where
supported. Separate end-user access recovery from administrator incident actions.

Use fictional identities and redacted tokens. Never include executable examples
that weaken verification, bypass authorization, disable protection without
context, or expose credentials. Explain risk before consequential configuration.

## Navigation overlay

Insert supported destinations by the identity and authority lifecycle:

```text
Identities and directories
Authentication and recovery
Sessions and factors
Roles, permissions, and policy
Service accounts and credentials
Provisioning and deprovisioning
Audit events and reporting
Alerts, incidents, and recovery
```

Place secure setup, authority boundaries, and lockout recovery before convenient
administrative shortcuts.

## Never assume

Do not claim zero trust, least privilege, encryption properties, tamper-proof
auditing, protocol conformance, certification, compliance, breach prevention,
revocation latency, or secure defaults without authoritative evidence. Do not
publish internal detection logic or sensitive architecture without a reader need.

## Senior quality gate

A reader must understand who can perform each sensitive action, what authority
is granted, where credentials live, how access is revoked and verified, what is
audited, and how to recover from supported lockout or compromise scenarios.
