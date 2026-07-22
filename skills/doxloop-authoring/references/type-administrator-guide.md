# Administrator-guide playbook

Use when readers configure shared scope, identities, access, policy, lifecycle,
or organization-wide behavior.

## Separate authority from ordinary use

Define administrator roles, delegated authority, managed scope, and boundaries
before procedures. Separate initial setup, routine administration, governance,
security, billing, lifecycle, and recovery when the product supports them.

## Expected coverage

- administrative access and safe first setup;
- organization, workspace, project, or environment lifecycle;
- member onboarding, offboarding, ownership, roles, and permissions;
- authentication, federation, credentials, and session policy;
- defaults, inheritance, precedence, propagation, and exceptions;
- shared feature configuration and integrations;
- plans, quotas, billing, or licensing when administrator-visible;
- audit, reporting, export, retention, deletion, and support evidence;
- change verification, rollback, lockout recovery, and escalation.

For each action, state the required role, affected scope, prerequisites,
propagation or restart behavior, consequences, verification, and supported
reversal. Put destructive or organization-wide effects before the final action.

## Governance lens

Explain how administrators can review effective configuration, detect drift or
exceptions, transfer ownership, and prove a change took effect when those
capabilities exist. Do not convert generic recommendations into product guarantees.

## Standard navigation

Promote `Administration` only when it is a substantial independent surface. Use:

```text
Administrator overview
Initial setup
Users and access
Authentication
Security and policy
Product configuration
Integrations
Plans and usage
Data management
Administration operations
Troubleshooting
```

Order setup, lockout prevention, and access control before lower-risk feature
settings. Omit SSO, billing, audit, or retention destinations without evidence.

## Senior quality gate

An administrator can establish a safe baseline, delegate access, predict the
scope of a change, verify effective state, avoid lockout, and recover from
evidenced configuration failures without relying on hidden superuser knowledge.
