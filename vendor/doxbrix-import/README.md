# Doxbrix conversion engine

These SDK conversion modules, CLI file-import helpers, and SDK regression tests
are copied unchanged from the Doxbrix 0.1.4 source supplied for this integration.
`UPSTREAM.json` records the source revision and SHA-256 of every copied file.
The working-tree file hashes identify the exact snapshot, including changes
that may not have been committed at that revision.

Do not implement a second Mintlify transformer here. Refresh these files together
from upstream and run both the original regression suite and Doxloop's import
integration tests. The wrapper in `src/mintlify-import.ts` owns source selection,
safe remote fetching, staging, reporting, and Doxloop project adoption.

The engine compiles separately with its original optional-property semantics;
Doxloop consumes the generated JavaScript and declarations. `build:importer`
runs before core compilation and typechecking. Built files and the Apache-2.0
license ship with Doxloop; no separately installed CLI or local checkout is needed.
