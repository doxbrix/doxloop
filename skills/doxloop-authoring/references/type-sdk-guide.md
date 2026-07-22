# SDK-guide playbook

Use when a supported language SDK or client library needs onboarding, idiomatic
task guidance, and public-symbol reference.

## Design for the language ecosystem

Follow the package manager, import style, naming, async model, error conventions,
resource management, and code-formatting norms evidenced by the SDK. Do not
transliterate examples mechanically between languages; verify each SDK surface.

## Expected coverage

- supported language and runtime versions;
- installation and version selection;
- client construction, configuration, authentication, and cleanup;
- a complete first call and expected typed result;
- core resource or service groupings;
- common workflows with idiomatic examples;
- pagination, streaming, async, cancellation, retries, and timeouts when supported;
- exception or result-error hierarchy and recovery;
- test doubles, sandbox use, logging, and debugging when public;
- public classes, functions, methods, properties, types, defaults, and deprecations;
- upgrade and compatibility guidance.

Explain server behavior in shared concepts and SDK behavior in language-specific
guides. Keep cross-language examples semantically aligned without hiding real
differences.

## Example discipline

Compile or execute examples when safe. Include imports, credential placeholders,
initialization, awaited operations, disposal, and error handling required for
correctness. Use one coherent sample domain and avoid global mutable state unless
the supported API requires it.

## Standard navigation

Promote `SDKs` when several maintained language SDKs exist. Use this block:

```text
SDK overview
Getting started
  Install the SDK
  Configure credentials
  Initialize the client
  Make the first call
SDK guides
Language SDKs
SDK reference
Testing and debugging
Compatibility and upgrades
Release notes
```

Create a separate language subtree only when its lifecycle or behavior differs
materially; otherwise keep shared concepts outside language-specific reference.

## Senior quality gate

A developer can install the correct version, initialize the client safely, use
idiomatic types and lifecycle, handle supported failures, and locate the stable
public SDK surface without consulting implementation code.
