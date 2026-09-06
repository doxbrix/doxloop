# Claude review follow-through

Scope: all non-licensing recommendations in the 6 September review. Preserve pre-existing work. This file records implementation and evidence separately; unchecked items remain outstanding.

- [x] HTML/RST internal and external links; complete quality categories; starter onboarding status; dry-run isolation.
- [x] Scheduling semantics, per-run failure detail, zero-capture review notes.
- [x] Packaging and prerequisites; demo-first onboarding; consistent vocabulary and activity navigation.
- [x] Persistent page/hunk comments and scoped agent requests.
- [x] Full-text search with section navigation and preview-to-editor links.
- [x] Reversible bulk metadata, folder review decisions, undo access for every direct write.
- [x] Read-only existing-site audit with evidence backfill; native version/locale support and reader verification controls.
- [x] Measured plan estimates; hosted pull-request stale-page check.
- [x] Regression tests, browser checks, native generator validation, package audit.
- [ ] Real generation quality benchmark and baseline; actual container execution; hosted CI evidence.

Licensing is excluded at the user's request.

## Evidence so far

- Full unit suite: 692 passed; later focused tests cover additional failure paths.
- Browser suite: all 45 passed, including real-server comments, search, audit, bulk undo, and collection creation.
- Both representative existing generators passed six native builds, including versions/locales and undo.
- Real digest-pinned Python container check passed.
- Package audit: zero source maps or marketing/social assets in the tarball.
- Full typecheck, skill validation, and source-boundary checks passed.
- A real generation attempt was blocked for deleting a page approved for update. File-contract instructions and failed-workspace retention were strengthened; the repeat with explicit medium reasoning is running.
- Hosted CI publication and run are pending. Licensing files are unchanged.

Implementation boundaries and usage are documented in [review workflows](docs/review-workflows.md).
