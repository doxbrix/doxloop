# Data-platform expertise

Use when the product ingests, stores, transforms, queries, serves, governs, or
observes data through connectors, pipelines, warehouses, lakes, catalogs, or BI.

## Think like a senior data-platform documentation architect

Trace data from source to consumer. For each stage, identify ownership, schema,
freshness, quality, state, failure, replay, and observability. Separate control
plane configuration from data plane movement when the product exposes both.

## Investigate

- connectors, credentials, network prerequisites, source and destination support;
- datasets, namespaces, schemas, types, identifiers, and evolution behavior;
- full, incremental, CDC, batch, streaming, checkpoint, and watermark semantics;
- transformation ordering, dependencies, materialization, and execution state;
- scheduling, concurrency, retries, backfill, replay, and partial-failure handling;
- quality checks, freshness, lineage, metadata, ownership, and alerting;
- query behavior, partitioning, limits, caching, exports, and downstream contracts;
- access control, secrets, sensitive data, retention, deletion, and audit evidence;
- environment promotion, versioning, compatibility, cost or usage signals.

## Design coverage

Start with one bounded source-to-result path and show how to verify records,
schema, and freshness. Use concepts for execution state, incremental behavior,
schema evolution, lineage, and failure domains. Give operators runbooks for
stalled, late, rejected, duplicated, or incomplete data only when diagnostics
and recovery are evidenced.

Document who owns schema changes and how downstream compatibility is checked.
Make destructive reprocessing, replacement, truncation, or backfill behavior
explicit before steps that can duplicate or lose data.

## Navigation overlay

Insert supported destinations following data flow:

```text
Connectors and credentials
Datasets, schemas, and types
Pipelines and execution
Transformations and dependencies
Incremental processing and backfill
Data quality, freshness, and lineage
Query and delivery
Monitoring and recovery
```

Order navigation from source to consumer; keep control-plane configuration and
data-plane behavior distinct when readers operate them differently.

## Never assume

Do not infer exactly-once delivery, ordering, transactional boundaries, zero
data loss, freshness, automatic schema compatibility, encryption, retention,
lineage completeness, or recovery guarantees. A successful job status does not
necessarily prove complete or correct data unless the product defines it so.

## Senior quality gate

A reader must be able to configure a supported flow, validate data correctness
and freshness, understand schema and execution semantics, diagnose evidenced
failure states, and recover without accidental duplication or loss.
