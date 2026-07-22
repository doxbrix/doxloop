# Integration-guide playbook

Use for a bounded connection between the documented product and another named
system, protocol, platform, or workflow.

## Define the integration contract

Identify both systems, supported versions, direction of control and data,
prerequisites, authentication on each side, object mapping, trigger, delivery
semantics, ownership, and completion. State which system is authoritative for
each shared field or state when evidence supports it.

## Build the guide

1. Explain supported outcome, topology, and limitations.
2. List access, versions, network, credentials, and test-data prerequisites.
3. Configure the provider side and verify access.
4. Configure the consumer side and verify the connection.
5. Map identifiers, fields, states, or events explicitly.
6. Run one safe end-to-end test.
7. Verify results in both systems.
8. Cover retries, duplicates, partial failure, monitoring, and disablement when supported.

Use a mapping table only when several exact fields or states require comparison.
Keep provider-specific terminology distinct from product terminology. Show
secret-handling boundaries without exposing credential values.

## Operational ownership

Document who rotates credentials, responds to failure, replays or reconciles
data, upgrades either side, and collects escalation evidence when public behavior
defines those responsibilities. State sandbox or test-environment differences.

## Standard navigation

Promote `Integrations` when the product maintains several integrations. For one
integration, contribute this block under Guides or Integrations:

```text
Integration overview
Prerequisites
How the integration works
Configure the integration
Data and object mapping
Integration workflows
Test the integration
Operate the integration
Maintain or remove it
Troubleshooting
```

For an integration catalog, repeat the bounded block per provider while sharing
common authentication, event, and troubleshooting concepts where identical.

## Senior quality gate

A qualified integrator can establish the connection, prove end-to-end behavior,
understand mapping and ownership, detect failure, and disable or recover the
integration without duplicates, silent loss, or unsupported assumptions.
