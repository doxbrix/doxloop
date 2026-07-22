# Migration-and-release playbook

Use when readers must understand a defined release or move safely between
versions, interfaces, schemas, configurations, or deployment models.

## Build from a verified change inventory

Classify reader-visible changes as added, changed, fixed, deprecated, removed,
security-relevant, or operational. For each change, identify affected readers,
old behavior, new behavior, required action, compatibility, timing, and evidence.
Do not convert commit messages directly into release claims.

## Migration procedure

Include:

- supported source and target versions;
- who must migrate and who is unaffected;
- prerequisites, backups, permissions, capacity, and downtime when evidenced;
- deprecated or removed behavior and supported replacement;
- ordered code, data, configuration, or operational changes;
- compatibility window and mixed-version behavior when supported;
- verification of behavior and data after migration;
- rollback or roll-forward conditions supported by the product;
- cleanup and next-version considerations.

Separate upgrade mechanics from application or integration changes when
different owners perform them. Give reusable transformations or mapping tables
for repeated renamed fields, flags, endpoints, or states.

## Release notes

Lead with reader impact and action. Group changes consistently; link to updated
guidance; distinguish breaking changes from new optional capability; and avoid
internal implementation detail, issue-list dumps, and marketing language.

## Standard navigation

Promote `Release notes` when maintained. Keep actionable migration ahead of
chronology:

```text
Release overview
Supported versions
What's new
Breaking changes
Migration guides
  Choose a path
  Prepare
  Migrate
  Verify
  Roll back or roll forward
Deprecations
Compatibility
Release notes
  Versions, newest first
```

For versioned sites, link each source version directly to its supported target
migration instead of making readers infer a multi-hop path.

## Senior quality gate

An affected reader can determine whether action is required, execute the change
in the correct order, verify compatibility and outcome, and recover using only
supported paths. Unaffected readers are not alarmed by ambiguous scope.
