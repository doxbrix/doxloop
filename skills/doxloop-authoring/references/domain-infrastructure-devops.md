# Infrastructure and DevOps expertise

Use when readers provision, deploy, configure, observe, scale, upgrade, or
recover infrastructure, platforms, services, clusters, or developer environments.

## Think like a senior platform documentation architect

Treat an operational procedure as a controlled state transition. Identify
dependencies, authority, desired state, blast radius, health signals, rollback,
and recovery verification. Separate initial deployment, routine operations,
change management, and incident response.

## Investigate

- supported topology, components, dependencies, ports, protocols, and environments;
- installation artifacts, versions, resource requirements, and platform support;
- configuration sources, precedence, secrets, reload or restart behavior;
- provisioning idempotency, state storage, drift, locking, and concurrency;
- health, readiness, metrics, logs, traces, events, and diagnostic bundles;
- scaling, capacity signals, quotas, limits, maintenance, and scheduling;
- upgrades, compatibility, schema or state migration, rollback, and downgrade;
- backup scope, consistency, retention, restore, disaster recovery, and verification;
- high availability, failure domains, traffic handling, and degraded states;
- security boundaries, network access, administrative roles, and audit evidence.

## Design coverage

Give a supported reference deployment, then expose decision points rather than
pretending one topology fits all. Every procedure must include prechecks,
commands or actions, expected signals, abort conditions, rollback when supported,
and post-change verification. Put destructive recovery behind explicit warnings.

Use runbooks for observable incidents and reference pages for configuration and
signals. Keep commands deterministic and scope targets explicitly. Distinguish
development convenience from production guidance.

## Navigation overlay

Insert supported destinations following the operating lifecycle:

```text
Architecture and environments
Provisioning and installation
Configuration and secrets
Deployment and readiness
Observability
Scaling and capacity
Routine maintenance
Upgrade and rollback
Backup, restore, and disaster recovery
Incident diagnostics
```

Put health verification immediately after deployment and recovery procedures.

## Never assume

Do not claim high availability, zero downtime, horizontal scaling, backup
consistency, restore objectives, rollback safety, autoscaling, resource sizing,
or production readiness without evidence. A process starting is not sufficient
health verification.

## Senior quality gate

An operator must be able to deploy the supported topology, verify service
health, understand configuration and failure scope, perform a supported change,
and recover or escalate using observable evidence rather than guesswork.
