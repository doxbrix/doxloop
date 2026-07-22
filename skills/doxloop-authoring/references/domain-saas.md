# SaaS application expertise

Use for multi-user hosted applications whose reader-visible model includes
accounts, organizations, workspaces, roles, subscriptions, or browser-based
workflows.

## Think like a senior SaaS documentation architect

Model the experience across three layers: individual identity, shared account or
workspace, and service-wide behavior. Identify which actor owns each action,
where settings apply, when changes take effect, and what persists across sessions
or plan changes. Treat onboarding, daily work, administration, and offboarding as
different journeys.

## Investigate

- signup, invitation, authentication, session, password, and recovery flows;
- workspace or organization creation, switching, transfer, suspension, deletion;
- roles, permissions, ownership, approval, and delegation boundaries;
- the product's primary object lifecycle and collaboration behavior;
- configuration scope, defaults, inheritance, and propagation;
- subscription, plan, quota, trial, invoice, or billing behavior when public;
- import, export, retention, deletion, notification, and audit capabilities;
- UI labels, empty states, errors, accessibility labels, and responsive behavior;
- browser, locale, region, or feature-availability commitments supported by evidence.

## Design coverage

Separate getting-started content by actor when setup requires both an owner and
members. Put common daily jobs before rare settings. Give administrators a
bounded administration area rather than mixing organization-wide changes into
end-user pages. Connect plan or permission restrictions to the exact task they
block.

For each workflow, state the required role, starting state, scope of effect,
observable result, and supported reversal. Explain destructive or account-wide
actions before the reader commits them. Document alternative paths only when
they are supported and materially useful.

## Navigation overlay

Insert supported destinations into the selected type blocks:

```text
Workspaces or organizations
Users, groups, roles, and permissions
Authentication and account recovery
Shared configuration and integrations
Plans, usage, and billing
Audit, export, retention, and deletion
```

Place daily user tasks in Guides and organization-wide controls in
Administration. Never merge personal settings with workspace policy merely
because the UI places them near each other.

## Never assume

Do not infer tenant isolation, encryption, backup, regional residency, uptime,
data retention, auditability, SSO, SCIM, regulatory compliance, accessibility
conformance, or subscription entitlements from generic SaaS patterns. Verify
each claim from public interfaces, tests, configuration, policies supplied as
source, or approved product behavior.

## Senior quality gate

A new owner must be able to reach first value; a member must understand their
available work; and an administrator must be able to predict the scope and
consequence of supported configuration changes. Terminology for account,
organization, workspace, project, member, role, and owner must remain exact and
consistent.
