# Evidence and example standard

Use this standard whenever documentation states product behavior or contains a
command, request, configuration, or code sample.

## Track claim status

Classify material while researching:

- **Verified by execution**: a safe local command or example completed and its
  observable result matched the documentation.
- **Verified by source**: a public interface, schema, test, or fixture directly
  supports the claim.
- **Inferred**: several sources support the conclusion, but no public contract
  states it directly.
- **Unverified**: the available evidence cannot establish the behavior.

Publish verified claims. Include an inference only when it is necessary, label
the uncertainty, and avoid promising unsupported behavior. Do not publish an
unverified claim as fact.

Keep a working evidence map from each planned page or public capability to the
configured source file, schema, test, fixture, or safe execution that supports
it. Use configured source names and relative paths in working notes. Never copy
local absolute paths into reader-facing documentation or deployment content.

## Build trustworthy examples

For every example:

1. Define what the reader will accomplish.
2. State required versions, permissions, setup, files, and environment.
3. Use the smallest realistic input that demonstrates the supported behavior.
4. Use exact public names, flags, keys, types, and values.
5. Use visibly fake credentials and reserved example domains where needed.
6. Show the command, request, configuration, or code in a copyable form.
7. Show the expected output or explain the observable success condition.
8. Include cleanup when the example creates billable, persistent, or sensitive
   resources.
9. Verify the example safely by execution when possible; otherwise verify every
   material detail against public source and tests.

Keep example output short and stable. Replace volatile IDs, timestamps, and
paths with clearly marked placeholders without changing their required shape.
Never place a placeholder where a literal value is required without explaining
how the reader obtains it.

## Protect readers and source

- Never use or reveal real credentials, tokens, personal data, internal hosts,
  private identifiers, or unpublished endpoints.
- Do not run destructive, billable, privileged, or remote actions solely to
  verify documentation without explicit user approval.
- Explain security consequences before a risky action.
- Prefer least-privilege permissions in examples.
- Do not recommend disabling security controls as a generic fix.
- Do not copy implementation details into reference material when the public
  contract provides the correct reader-facing description.

## Cover specialized public interfaces

For CLI reference, verify commands, arguments, flags, defaults, environment
behavior, output, exit behavior, and failure cases.

For API reference, prefer the project's declared OpenAPI or equivalent schema.
Cover authentication, methods and paths, parameters, request and response
shapes, status or error behavior, limits, and one verified example. Follow the
version of the interface description present in the configured source.

For configuration reference, verify keys, types, defaults, allowed values,
precedence, restart or reload behavior, security implications, and examples.
