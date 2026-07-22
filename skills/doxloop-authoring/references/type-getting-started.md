# Getting-started playbook

Use when a reader needs a controlled path from a clean state to first meaningful
value. This playbook can produce an installation page, quickstart, or short
onboarding sequence depending on complexity.

## Define first success

Choose an outcome that proves the product is working for the primary reader—not
merely that files were installed or a process started. Bound the path to one
supported environment and the minimum required decisions. Move optional branches
after success.

## Build the path

1. State the result and expected time or effort only when evidenced.
2. List supported prerequisites and required access.
3. Install or connect using the canonical supported method.
4. Configure only values needed for this path, using safe placeholders.
5. Perform the smallest complete workflow.
6. Show the observable success result.
7. Give recovery for evidenced common failures.
8. Link to the next task, concept, and reference needed for real use.

Explain each new concept only at the moment it becomes necessary. Keep commands
and code complete enough to run. When setup differs materially by platform,
runtime, role, or deployment model, choose a declared primary path and link to
verified alternatives rather than interleaving every branch.

## Evidence and verification

Trace prerequisites to package or platform metadata, steps to public interfaces,
and expected results to tests, fixtures, or safe execution. Test from a clean or
representative state when feasible. Do not call a path quick if it omits required
security, cleanup, or initialization.

## Standard navigation

Contribute this block under Documentation:

```text
Getting started
  Overview
  Prerequisites
  Installation or access
  Initial configuration
  Quickstart
  Verify the result
  Next steps
```

For a compact site, keep Overview at the site root and flatten the remaining
pages when the group would contain fewer than two useful destinations.

## Senior quality gate

A qualified new reader can follow the path without hidden knowledge, recognize
success, recover from supported setup failures, and understand where to go next.
The path leaves no unsafe credential, sample data, or process state unexplained.
