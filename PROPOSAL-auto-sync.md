# Proposal: automatic documentation sync

Design note, not shipped documentation. Goal: make "documentation that never
goes stale" the default outcome of using Doxloop, and make Doxloop the tool the
development community reaches for first.

## 1. Where Doxloop is today

What already exists and is good:

- `.doxloop/sync-state.json` records, per source, the HEAD commit plus a
  content fingerprint of tracked and untracked non-ignored files
  ([src/sync.ts:225](src/sync.ts:225)). The fingerprint correctly stops a dirty
  tree from being reported again after it is committed.
- `collectSourceChanges` classifies each source as `changed`, `unchanged`,
  `no-baseline`, `baseline-lost`, `not-git`, `missing-path`, `spec-changed`,
  `spec-unchanged`, or `spec-remote` ([src/sync.ts:64](src/sync.ts:64)).
- `formatSourceChanges` turns that into an agent-readable change inventory that
  `update` injects into the prompt ([src/author.ts:57](src/author.ts:57)).
- The baseline advances only when the agent exits 0 **and** `validateProject`
  reports zero errors ([src/author.ts:115](src/author.ts:115)). This is the
  right safety property and every automation below must preserve it.
- `doxloop test --format json` and `doxloop status --format json` already give
  machines a validation surface.

### The five gaps that block automation

**G1 — There is no non-interactive authoring path.**
`agentArguments` runs create/update as an interactive TUI for all three agents;
only `review` is headless (`codex exec --sandbox read-only`,
`claude --print --permission-mode plan`, `gemini --approval-mode plan`)
([src/author.ts:192](src/author.ts:192)). `docs/ci-and-automation.md` therefore
has to say agent authoring is optional. Nothing can run `doxloop update` from a
git hook, a watcher, or CI today. This is the single largest blocker.

**G2 — Change tracking is repo-level, not page-level.**
One commit and one whole-repo hash per source. There is no page→source
provenance anywhere in `.doxloop/`, so Doxloop cannot answer "which pages are
stale?" without paying for a full agent run. Every `update` re-derives the
mapping from scratch.

**G3 — No relevance filter.**
A lockfile bump, a test refactor, and a breaking API rename all produce the
identical `changed` verdict. The skill correctly tells the agent to make no edit
when a change is internal ([skills/doxloop-authoring/SKILL.md:294](skills/doxloop-authoring/SKILL.md:294)),
but that conclusion costs a full model run every time. Automation that burns
tokens on lockfile bumps will be switched off within a week.

**G4 — No trigger surface.**
No `watch`, no git-hook installer, no GitHub Action, no scheduled drift check,
no exit-code-only staleness check. `chokidar` is already a dependency but is
used only by `preview` ([src/preview.ts:193](src/preview.ts:193)).

**G5 — No delivery path.**
Even if an agent ran headlessly, there is no way to land the result as a
reviewable docs pull request. The docs project is a sibling directory, so the
automation has to know which product commit triggered it and how to push.

Two smaller defects worth fixing regardless:

- Remote OpenAPI specs are never fingerprinted — `isSpecUrl` short-circuits to
  `spec-remote` ([src/sync.ts:122](src/sync.ts:122)), so a hosted spec can never
  be *detected* as changed, only re-fetched by the agent on every run.
- `sourceContentFingerprint` reads the full content of every non-ignored file in
  the product repo on every `update`. On a large monorepo this is seconds of
  I/O per invocation, and it has no include/exclude configuration.

## 2. The spine: six layers

Provenance → relevance → headless authoring → triggers → delivery → trust.
Each layer is independently useful; each one makes the next cheaper.

### Layer 1 — Provenance: make staleness computable without a model

Add `.doxloop/evidence-map.json`, committed, generator-neutral (frontmatter is
not viable — Sphinx RST and static HTML have none):

```json
{
  "schemaVersion": 1,
  "pages": {
    "docs/guides/authentication.md": {
      "sources": [
        { "source": "product", "paths": ["src/auth.ts", "src/session.ts"] },
        { "source": "api", "operations": ["POST /oauth/token"] }
      ],
      "verifiedAt": { "product": "9f2c1ab...", "api": "sha256:..." },
      "confidence": "verified",
      "claims": ["Tokens expire after 3600s", "Refresh requires offline_access"]
    }
  }
}
```

The agent already builds a coverage plan
([SKILL.md:194](skills/doxloop-authoring/SKILL.md:194)); the Finish step
([SKILL.md:364](skills/doxloop-authoring/SKILL.md:364)) gains one instruction:
write the evidence map for every page it touched. Add a validation rule so a
page with no entry is a warning, not silently untracked.

What this unlocks immediately:

- `doxloop check` answers "which pages are stale?" deterministically, with zero
  model cost, by intersecting changed files with page source globs.
- `update` prompts shrink from "40 files changed, go figure it out" to
  "these 3 files changed; pages A, B, C claim behavior from them". Runs get
  faster, cheaper, and far more accurate.
- Per-page CI annotations become possible ("this PR changes `src/auth.ts`, which
  `guides/authentication.md` documents").
- The docs site can render "Verified against v2.4.1" per page.

### Layer 2 — Relevance: never wake the agent for noise

Extend `project.json` with a `sync` block:

```json
"sync": {
  "watch": ["src/**", "openapi.yaml", "README.md"],
  "ignore": ["**/*.test.ts", "**/__snapshots__/**", "*.lock", "CHANGELOG.md"],
  "mode": "propose",
  "budget": { "maxPages": 25, "maxMinutes": 15 }
}
```

Then run a deterministic pre-pass before any agent starts: if every changed path
matches `ignore`, or matches no page in the evidence map, exit `0` with
"no reader-visible impact" and advance the baseline without a model run. Use the
same globs to scope `sourceContentFingerprint`, which fixes the O(repo) cost.

Optional second pre-pass, still model-free and high value for API products:
diff the OpenAPI document structurally (added/removed/changed operations,
parameters, schemas, status codes) and pass only that delta. For a spec-driven
project this makes most updates near-instant.

### Layer 3 — Headless authoring

Give create/update the same treatment `review` already has. Add
`--non-interactive` (implied by `--yes` in a non-TTY):

| Agent  | Headless authoring invocation |
| ------ | ----------------------------- |
| Codex  | `codex exec --sandbox workspace-write --cd <docs-root>` |
| Claude | `claude -p --permission-mode acceptEdits --add-dir <docs-root> --max-turns N` |
| Gemini | non-interactive prompt with an approval mode that permits writes |

Non-negotiable guardrails, because the prompt text alone is not a boundary:

- the write sandbox is the docs root, enforced by the agent's own flags, not by
  instruction ([src/author.ts:292](src/author.ts:292) states the rule; the
  sandbox must enforce it);
- turn and wall-clock budget, so a confused run cannot spin;
- the existing rule stands — validation must pass or the baseline is not
  recorded and nothing is delivered;
- automation never calls `deploy`. Publishing stays a separate, human command.

Authoring keeps using the developer's own installed, already-signed-in agent
CLI. Doxloop must never accept, store, or require a model API key: the agent
subscription is the user's, credentials stay with the agent CLI, and Doxloop
stays a credential-free tool. Headless here means "no TTY required", not
"no login required".

That constraint decides the entire trigger design in Layer 4.

### Layer 4 — Triggers: detection is portable, authoring is local

Because authoring needs a signed-in agent CLI, the two halves of the loop run in
different places:

| Half | Needs an agent? | Where it can run |
| --- | --- | --- |
| Detection (`check`) | No — pure git and file comparison | Anywhere, including hosted CI, with no credentials |
| Authoring (`update`) | Yes | Only where an agent CLI is signed in — a developer machine or a self-hosted runner |

Entry points, ordered from lowest to highest commitment:

1. **`doxloop check`** — agent-free. Exits `0` when fresh, `1` when stale.
   `--format json` lists stale pages, the commits that made them stale, and the
   files responsible. Safe in hosted CI because it needs no agent and no model
   credentials — only read access to both repositories.
2. **`doxloop hooks install`** — `post-merge` / `post-commit` hook running
   `check` only. It must print, never block; a docs tool that fails commits gets
   uninstalled.
3. **`doxloop watch`** — local, `chokidar` is already a dependency. Debounced;
   respects `sync.mode`: `check` prints a nudge, `propose` prepares a branch,
   `auto` runs the update. Pairs naturally with `preview`.
4. **`doxloop schedule install`** — the answer to "run it daily at 09:00". It
   registers a local scheduled job using the platform's own scheduler (launchd
   on macOS, systemd timer or cron on Linux, Task Scheduler on Windows) that
   runs the full check-then-update cycle with the developer's signed-in agent.
   Doxloop writes and loads the job; the user never edits a plist or crontab.
5. **Self-hosted runner on a shared machine** — for teams that want hands-off
   sync. A GitHub or GitLab runner on a machine where the agent CLI is signed in
   gives event-driven triggers while keeping credentials on hardware the team
   controls. Documented pattern, not a product dependency.
6. **Scheduled remote-spec drift check** — fetch remote OpenAPI specs and hash
   them (fixing the `spec-remote` gap). This is the case where documentation
   goes stale with no commit anywhere.

A hosted GitHub Action can therefore run `check` and annotate a product pull
request, but it can never author. Any design that assumes hosted authoring is
wrong for this product.

### Layer 5 — Delivery: default to a pull request, never a silent rewrite

`propose` should be the default mode everywhere. The generated docs PR body is
assembled from data Doxloop already has:

- source commits and files that triggered the run;
- pages changed, with the claim each change corrects;
- `doxloop test` results and warning count;
- pages the agent could not verify, flagged for a human.

Auto-merge is available but opt-in and never the default. `deploy` remains a
separate command with its own confirmation — that existing boundary is a
selling point, not an obstacle.

### Layer 6 — Trust: make uncertainty visible instead of guessing

- `confidence` per page in the evidence map: `verified` (agent read the source),
  `inferred`, `needs-human`. `needs-human` becomes a `doxloop test` warning.
- A page whose sources changed but that the agent chose not to edit records
  *why* — so the next run does not re-litigate the same decision.
- Staleness budget: `doxloop check --max-age 30d` fails when a page has not been
  verified against any commit in a month, even if nothing obviously changed.
- Never let automation delete pages. Removal is proposed, never applied.

## 3. Suggested build order

| Phase | Ships | Why first |
| --- | --- | --- |
| 1 | `doxloop check`, `sync.watch`/`sync.ignore`, scoped fingerprint, remote-spec hashing | Agent-free, zero-risk, immediately useful in any CI, fixes two real defects |
| 2 | Evidence map + skill Finish step + validation rule | Everything precise depends on provenance |
| 3 | Headless create/update with sandbox and budget guardrails | Unblocks every trigger |
| 4 | `doxloop watch`, `doxloop hooks install` | Local loop; low-stakes place to earn trust |
| 5 | `doxloop schedule install` (local scheduler) + a credential-free `check` Action | The adoption moment: unattended sync without ever holding a credential |
| 6 | Scheduled remote-spec drift, confidence surfacing, staleness budget | Long-tail freshness |

Phase 1 alone changes the pitch from "docs you generate" to "docs that tell you
when they are wrong". That claim is worth more than any authoring feature.

## 4. Separate improvements worth making

Ranked by impact on becoming the community default.

Docs and source stay in separate repositories. That decision is settled and
every design above assumes it.

**A. Monorepo support.**
`sources` is already an array, but nothing maps a source to a docs section. Let
each source declare a docs subtree or Doxbrix space, so one docs project can
serve five packages and `check` can report staleness per package.

**B. `doxloop test --fix`.**
Many validation codes are mechanically fixable (missing code-fence language,
heading order, weak link text, empty alt confirmation)
([src/validation.ts:731](src/validation.ts:731)). Auto-fixing them removes a
whole class of agent round-trips.

**C. Run economics in `last-run.json`.**
Record duration, turns, token usage, and cost alongside the existing receipt
([src/author.ts:141](src/author.ts:141)). Nobody enables automatic model runs
they cannot budget, and `doxloop status` showing "last sync: 4m, ~$0.31" makes
the value obvious.

**D. Ship an MCP server.**
`doxloop-mcp` exposing `check`, `status`, `test`, `update`, `preview` lets any
MCP-capable agent (including ones Doxloop does not bundle) drive the workflow
without the project-local skill install. Cheap to build, wide reach.

**E. Zero-install first run.**
`npx @doxbrix/doxloop init` should be the README's first line, and a
`doxloop demo` that documents a bundled fixture in under a minute gives people a
result before they commit anything.

**F. Stable validation codes.**
Document the `doxloop test` issue codes as a stable contract so teams can
baseline and ratchet them, the way linters are adopted.

**G. Docs coverage metric.**
`doxloop check` can report the share of public surface (exported symbols, CLI
commands, OpenAPI operations) with at least one documenting page. A visible
coverage number drives the same behavior test coverage does — and it is the
metric a team lead needs to justify adopting the tool.
