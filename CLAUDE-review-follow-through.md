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
- [x] Real generation quality benchmark and baseline; actual container execution; hosted CI evidence.

Licensing is excluded at the user's request.

## Evidence so far

- Hosted unit suite: 694 passed across 89 files; three additional pull-request impact script tests pass separately.
- Browser suite: all 45 passed, including real-server comments, search, audit, bulk undo, and collection creation.
- Both representative existing generators passed six native builds, including versions/locales and undo.
- Real digest-pinned Python container check passed.
- Package audit: zero source maps or marketing/social assets in the tarball.
- Full typecheck, skill validation, and source-boundary checks passed.
- The repeat real generation benchmark completed planning/generation/acceptance and scored 62/100 (floor 60), with zero quality failures and 19 warnings. Both review and generation observations are recorded separately in the benchmark baseline.
- The implementation is published on `codex/claude-review-follow-through`. Hosted CI run [34030432814](https://github.com/doxbrix/doxloop/actions/runs/34030432814) passed all 14 jobs on commit `7fa8de2`: unit/typecheck/skills, browser E2E, existing-site round trips, the real container check, and all ten external generators. A subsequent PR-impact edge-case fix passes all three focused script tests and will receive the same hosted checks. Licensing files are unchanged.

Implementation boundaries and usage are documented in [review workflows](docs/review-workflows.md).

## Concrete bug coverage

- Social images resolve native public asset roots and must be actual files.
- Navigation duplicate detection is scoped to each Doxbrix space.
- Coverage resolution IDs are accepted; current verification is distinct from planned coverage.
- Literal HTML/RST links are checked; dynamic/native cross-references require native builds.
- Deployment dry runs preserve existing outputs; branch guards and conflict-safe rollback protect publication.
- Monitoring locks, budget reservations, log rotation, sign-in checks, pending-run deduplication, and elapsed interval gates cover unattended runs.
- Never-verified pages do not repeatedly trigger authoring through an infinite-age loop.
- Run-local failure details prevent cross-attribution; screenshot review notes remain visible after zero captures.
- Python execution has a real enforced container boundary; empty rendered results include every quality category.
- Pull-request impact handles root-level recursive globs and whole-file specification sources, and explicitly reports remote sources as unavailable.
