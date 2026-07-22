# Developer library expertise

Use for reusable packages, frameworks, modules, or SDKs consumed from application
code.

## Think like a senior library documentation maintainer

Teach the smallest correct mental model: how the package is installed, imported,
initialized, called, composed, configured, observed, and upgraded. Distinguish
the stable public API from implementation exports and generated internals.

## Investigate

- package metadata, supported runtimes, module formats, peer dependencies, and engines;
- documented entry points, exports maps, public types, generics, and overloads;
- initialization, configuration, defaults, lifecycle, cleanup, and concurrency;
- sync or async behavior, cancellation, streaming, retries, and error types;
- mutability, nullability, ownership, resource use, and thread or process safety;
- framework adapters, plugins, extension points, and compatibility matrices;
- tests and fixtures showing canonical use, edge cases, and failure contracts;
- deprecations, replacement APIs, versioning, and migration evidence.

## Design coverage

Start with a complete minimal program that uses the supported public entry point.
Explain the central abstraction before presenting variants. Organize guides by
developer outcome and reference by the library's public namespace. Show types
when they reduce ambiguity; explain runtime behavior that types cannot express.

Examples must compile or be traceable to contract tests. Include imports,
initialization, cleanup, and error handling needed for correctness. Do not make
snippets deceptively short by hiding essential setup.

## Navigation overlay

Insert supported destinations into Getting started, Guides, Concepts, and
Reference:

```text
Installation and compatibility
Initialization and configuration
Core abstractions and lifecycle
Common usage patterns
Framework adapters and extension points
Public API reference
Errors and debugging
Upgrades and deprecations
```

Organize reference by the stable public namespace, never by source folders.

## Never assume

Do not document every exported symbol as supported. Do not infer browser,
runtime, framework, thread-safety, performance, serialization, or semantic
versioning guarantees without evidence. Do not describe internal classes merely
because they are reachable in source.

## Senior quality gate

A developer must be able to choose the correct entry point, run the first
example, understand object or function lifecycle, handle documented failures,
and locate consistent reference for the declared public surface.
