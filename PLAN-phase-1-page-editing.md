# Phase 1 implementation guide: agent-driven page editing

Implementation instructions for the engineer or coding agent building Phase 1
of [PLAN-edit-ready.md](PLAN-edit-ready.md). Read this whole document before
writing code. It is written so that a coding agent can execute it without
further context.

**The feature in one sentence.** A user opens the new **Pages** view in the
control center, picks a page, describes in plain language what should change,
and Doxloop's coding agent makes that change in an isolated proposal that the
user reviews as a before-and-after and accepts, rejects, refines, or undoes.
There is no manual text editor. Every edit goes through the agent.

---

## 0. Working rules for the implementer

- **Build and run.** `pnpm install`, `pnpm run build`, then `pnpm run dev ui`
  or `doxloop ui` from a documentation project. The control center serves the
  UI from `dist/`, so UI changes need `pnpm run build:core` and a restart to be
  visible. Unit tests: `pnpm vitest run` (do not use `pnpm test`, which
  triggers a full build first). Typecheck: `pnpm run typecheck`.
- **Match the codebase style.** TypeScript ESM, two-space indent, single
  quotes, no semicolons, `DoxloopError` for every user-facing failure, Preact
  with the existing `Button`, `Panel`, `Note`, `Textarea` components from
  [ui/src/components.tsx](ui/src/components.tsx). No new UI framework.
- **Do not add quality gates.** Link checking, lint, spelling, and the
  `doxloop quality` command are out of scope. Use `validateProject` only, the
  same way proposals already do.
- **Reuse before writing.** The proposal machinery in
  [src/sync-runs.ts](src/sync-runs.ts) already does isolated workspaces,
  scoped agent runs, scope enforcement, diffs, accept, reject, undo, conflict
  detection, and history. This feature is a new entry point into that
  machinery, not a parallel system. If you find yourself copying a function
  from `sync-runs.ts`, stop and export or generalize it instead.
- **README and docs are UI-first.** When you document the feature, describe
  the Pages view. The only command the README may mention is `doxloop ui`.
- **Ship in four pull requests** in the order given in section 11. Each must
  pass `pnpm run typecheck` and `pnpm vitest run`.

---

## 1. User experience, end to end

1. The user opens **Pages** in the left navigation. They see every
   documentation page grouped by navigation section, with title, path, word
   count, last updated, and an evidence badge. A search box filters by title
   or path. Pages not in navigation appear under "Not in navigation".
2. They select a page. The right pane shows the rendered page (the local
   preview) and, beneath it, **Edit with the agent**: a text box that asks
   "What should change on this page?", a row of intent chips that prefill
   common requests, a toggle "Also allow related changes", the planning agent
   summary with a Change link, and the button **Ask the agent to edit**.
3. They type, for example, "Add a curl example under Authentication and
   mention that tokens expire after 24 hours", and submit.
4. The composer locks. A live activity panel shows what the agent is doing,
   with a **Stop** button. Other pages remain browsable but show "An edit is
   in progress" instead of the composer.
5. When the agent finishes, the pane switches to **Review this edit**: a
   one-line summary, a before-and-after of the rendered page, a source diff,
   a "Why this change" drawer with the agent's rationale and evidence, and
   three actions: **Accept**, **Reject**, and **Refine** (a follow-up
   instruction that sends the agent back to the same isolated workspace).
6. On Accept the page is written to the project, the preview reloads, a toast
   says "Page updated" with an **Undo** button, and Update history shows a row
   of kind Edit with the instruction and the page.
7. If the agent changed files outside the allowed scope, made no change, or
   produced validation errors, the pane says exactly what happened and offers
   the sensible next step (retry allowing related changes, refine, or reject).

Multi-page edits: the list supports selecting several pages with checkboxes;
the composer then reads "What should change on these 3 pages?" and the review
step shows one file at a time with a file switcher, exactly like Review does.

---

## 2. Non-goals

- No manual editor of any kind (no textarea, no CodeMirror). Do not build one.
- No page creation, deletion, or rename in this phase. The agent may not
  create or delete pages during an edit; that is enforced by scope. Creation
  arrives with the navigation editor in Phase 7.
- No new quality checks.
- No changes to the plan-first Create and Update flows.
- No screenshots by default. The composer exposes the existing screenshot
  toggle only when an application capture surface is configured, and it
  defaults to off.

---

## 3. What already exists and must be reused

| Need | Existing code | Notes |
| --- | --- | --- |
| Isolated copy of the project for the agent | `createWorkspace` in [src/sync-runs.ts](src/sync-runs.ts) (called from `createSyncRun` at [src/sync-runs.ts:172](src/sync-runs.ts:172)) | Copies the live project root minus excluded prefixes, rewrites source paths, inits a throwaway git repo. This is exactly what an edit needs. |
| Running the agent inside that copy | `runAuthor` at [src/author.ts:74](src/author.ts:74) | Accepts `request`, `mode`, `agent`, `model`, `reasoning`, `effort`, `screenshots`, `timeoutMinutes`, `maxTurns`, `nonInteractive`, `recordHistory`. |
| Limiting the agent to selected files | `RevisionScope` and `assertRevisionStayedInScope` at [src/sync-runs.ts:1659](src/sync-runs.ts:1659) and [src/sync-runs.ts:1703](src/sync-runs.ts:1703) | Today the scope is built from a previous proposal's changes by `resolveRevisionScope` ([src/sync-runs.ts:1666](src/sync-runs.ts:1666)). Section 6.2 generalizes it to be built from paths. |
| Turning the workspace into reviewable changes | `finalizeProposalWorkspace` ([src/sync-runs.ts:428](src/sync-runs.ts:428)) and `collectProposalChanges` ([src/sync-runs.ts:1372](src/sync-runs.ts:1372)) | Produces `SyncFileChange[]` with hunks, categories, rationale, validation. |
| Accept, reject, undo, conflict detection | `acceptSyncChanges` ([src/sync-runs.ts:1048](src/sync-runs.ts:1048)), `rejectSyncRun` (812), `undoSyncRun` (983) | Fingerprint checks against the live file are already there. |
| Follow-up instruction on an existing proposal | `reviseSyncRun` ([src/sync-runs.ts:836](src/sync-runs.ts:836)) | Seeds a new workspace from the previous run's workspace and supersedes it. Reuse this for **Refine**. |
| History rows and page registry | `recordSyncRun` ([src/history.ts:231](src/history.ts:231)), `listPages` ([src/history.ts:553](src/history.ts:553)), `pageHistory` (516) | The requests table keys on `RequestKind`. |
| Evidence map read and write | [src/evidence.ts:15](src/evidence.ts:15) and 27 | The agent updates it in the workspace; accept copies it over. |
| Page list with titles | `validateProject` returns `pages: string[]` ([src/validation.ts:53](src/validation.ts:53)); Doxbrix navigation parsing at [src/validation.ts:209](src/validation.ts:209); `adapter.readPage` for external generators | Combine for the Pages list. |
| Rendered page preview | The preview server ([src/preview.ts:76](src/preview.ts:76)); proposal preview on port 4322 via `POST /api/proposals/:id/preview/start` ([src/ui-server.ts:632](src/ui-server.ts:632)) | The before side is the running project preview; the after side is the proposal preview. |
| Rendered and source diff UI | `ProposalSourceDiff` and the rendered comparison in [ui/src/WorkspaceApplication.tsx](ui/src/WorkspaceApplication.tsx) around 1877 and 2126; `ProposalRationaleDrawer` | Extract these into `ui/src/proposal-diff.tsx` so Pages and Review share them. |
| Live activity log with Stop | `AuthoringLiveLog` in [ui/src/WorkspaceApplication.tsx](ui/src/WorkspaceApplication.tsx) around 1365 | Reuse as is. |
| Starting a CLI-backed job from the server | `startCliJob` at [src/ui-server.ts:1596](src/ui-server.ts:1596); the revise route at [src/ui-server.ts:695](src/ui-server.ts:695) is the pattern | Jobs stream to the UI through `/api/jobs/stream`. |
| Blocking concurrent agent runs | `assertNoActiveDocumentationJob` at [src/ui-server.ts:1665](src/ui-server.ts:1665) | Add the new job prefix to it. |
| Learning from reviewer instructions | `recordReviewPreference` in [src/review-learning.ts:17](src/review-learning.ts:17) | Call it for every edit instruction, kind `edit`. |

---

## 4. Architecture

An **edit run** is a proposal (`SyncRun`) whose trigger is `edit`, created
from the live project (not from a previous proposal), scoped to the selected
page paths plus an allowed set of supporting files, and driven by a focused
prompt. Everything downstream of `createSyncRun` is unchanged.

```text
Pages view ── POST /api/pages/edit ──▶ job page-edit:<runId>
                                         │  doxloop pages edit --run-id … --path … --request …
                                         ▼
                             createSyncRun({ trigger: 'edit', editRequest, scope })
                                         │  copy project → workspace
                                         │  runAuthor(mode 'update', request = edit prompt)
                                         │  assertRevisionStayedInScope(workspace, baseline, scope)
                                         │  finalizeProposalWorkspace → changes + validation
                                         ▼
                             SyncRun awaiting-review  ──▶ Pages view "Review this edit"
                                         │
             Accept ─ acceptSyncChanges   │   Reject ─ rejectSyncRun   │   Refine ─ reviseSyncRun
                                         ▼
                             applied (undo available) · history row kind 'edit'
```

Lifecycle states reuse `SyncRunStatus`: `generating` → `awaiting-review` →
`applied` | `rejected` | `superseded` (after Refine) | `failed` | `conflicted`
| `undone`.

One edit run at a time, enforced by `assertNoActiveDocumentationJob`. An edit
cannot start while a plan, generation, or revision job is running, and vice
versa.

---

## 5. Data model changes

All in [src/types.ts](src/types.ts) unless noted.

1. `SyncRunTrigger` ([src/types.ts:390](src/types.ts:390)): add `'edit'`.
2. `SyncRun` ([src/types.ts:456](src/types.ts:456)): add

   ```ts
   /** Present on runs started from the Pages view. */
   editRequest?: {
     instruction: string
     paths: string[]
     allowRelated: boolean
     /** Follow-up instructions sent through Refine, oldest first. */
     followUps: Array<{ id: string; createdAt: string; instruction: string }>
   }
   ```

3. `RequestKind` ([src/types.ts:846](src/types.ts:846)): add `'edit'`. The
   `requests.kind` column in [src/db.ts:35](src/db.ts:35) is `TEXT NOT NULL`
   with no `CHECK` constraint, so no schema migration is needed. Update
   `backfillHistory` ([src/history.ts:614](src/history.ts:614)) so runs with
   `editRequest` map to kind `edit`, and make sure every `switch` or lookup on
   `RequestKind` in [src/history.ts](src/history.ts) and the UI history
   presentation handles the new value.
4. `RunAuthoringRecord` in [src/sync-runs.ts](src/sync-runs.ts) (declared just
   after `createSyncRun`): add `editRequest?` with the same shape, so a failed
   edit that is resumed keeps its scope.
5. New exported type in `src/pages.ts`:

   ```ts
   export interface PageSummary {
     path: string            // project-relative, e.g. 'guides/install.mdx'
     title: string
     description?: string
     section?: string        // navigation group label, undefined when orphan
     route: string           // preview URL path, e.g. '/guides/install'
     wordCount: number
     updatedAt?: string      // from history pages table when known
     evidence: 'verified' | 'needs-review' | 'none'
     inNavigation: boolean
   }
   ```

6. UI mirror in [ui/src/types.ts](ui/src/types.ts): add `editRequest` to
   `Proposal`, add `PageSummary`, and add `'edit'` wherever `trigger` or
   request kinds are enumerated (`HistoryRequest` presentation in
   [ui/src/WorkspaceApplication.tsx:1453](ui/src/WorkspaceApplication.tsx:1453)).

---

## 6. Server and core work

Do these in order. Each step names the file, the function, and what to test.

### 6.1 `src/pages.ts`: list pages and build an edit scope

Create `src/pages.ts` with:

- `listPages(root): Promise<PageSummary[]>`. Load the project, run
  `validateProject(root)` for the page file list, parse navigation for Doxbrix
  through the same code path `validateProject` uses (extract a small
  `readDoxbrixNavigation(root, project)` from [src/validation.ts:209](src/validation.ts:209)
  if it is not already exported), use `adapter.readPage` for titles on
  external generators, read `.doxloop/evidence-map.json` for the evidence
  badge (`verified` when the entry has `claimVerification` or `verifiedAt`
  within `maxVerificationAgeDays`, `needs-review` when the entry exists but is
  older or flagged, `none` when absent), and join `listPages` from history for
  `updatedAt`. Sort by navigation order, then orphans alphabetically.
- `pageRoute(project, path): string`. Map a page file to its preview route.
  Doxbrix: strip the content dir and extension, `index` becomes `/`. External
  generators: use the same mapping unless the adapter exposes a route
  function; if unsure, return the Doxbrix-style route and note it in a code
  comment.
- `resolveEditScope(root, project, paths, allowRelated): Promise<RevisionScope>`.
  Validate every path exists and is a page (reject anything under `.doxloop`,
  `node_modules`, or outside the content dir with a `DoxloopError` that names
  the path). `selectedPaths` = the given paths. `supportingPaths` always
  includes `.doxloop/evidence-map.json`. When `allowRelated` is true, also
  include the generator's navigation files (`docs.json` for Doxbrix;
  `adapter.planning.navigationFiles` otherwise), and every asset path
  referenced from the selected pages plus any new file under the assets folder
  whose path starts with the page's slug. When `allowRelated` is false,
  supporting paths are only the evidence map. `wholeProposal` is always false
  and `hunkRanges` is empty.

Tests in `src/pages.test.ts`: page list on a scaffolded Doxbrix project with
one orphan page; route mapping for `index.mdx`, nested pages, and a
non-Doxbrix generator; scope rejects a path outside the content dir; scope
includes navigation only when `allowRelated` is true.

### 6.2 Generalize scope enforcement in `src/sync-runs.ts`

- Export `RevisionScope` (currently module-private at
  [src/sync-runs.ts:1659](src/sync-runs.ts:1659)).
- Add `editRequest?: SyncRun['editRequest']` and `id?: string` to
  `CreateSyncRunOptions` ([src/sync-runs.ts:129](src/sync-runs.ts:129)). When
  `id` is given, `createSyncRun` uses it instead of calling `runId()`; validate
  it with the existing `assertRunId`.
- In `createSyncRun`, compute the scope as: `revisionOf` → existing
  `resolveRevisionScope`; else `editRequest` → `resolveEditScope`; else none.
  Because an edit run copies the live project, the `revisionBaseline`
  collected at [src/sync-runs.ts:275](src/sync-runs.ts:275) is the live
  content, which is what `assertRevisionStayedInScope` should compare against.
  No change to that function is needed beyond accepting the exported type.
- Persist `editRequest` on the run and in the `RunAuthoringRecord`. Set
  `summary` for an edit run to `Editing <title>` (one page) or
  `Editing N pages` while generating, and to the usual `proposalSummary`
  after finalize.
- Add a specific failure message when scope enforcement fails on an edit run.
  Today's messages talk about "the selected proposal scope"; for edits use:
  "The agent changed files outside this page: a, b. Nothing was applied. Turn
  on "Also allow related changes" if those files should be part of the
  edit." and "The agent did not change this page. Nothing was applied." Keep
  the existing messages for revisions.
- Turn budget: pass `maxTurns` = `max(80, 40 + 30 × selected pages)` and
  `timeoutMinutes` = `project.sync.budget?.maxMinutes ?? 15` into `runAuthor`
  for edit runs. Put the constants beside `MIN_AUTHORING_MAX_TURNS` in
  [src/author.ts:448](src/author.ts:448) as `EDIT_MIN_MAX_TURNS` and
  `EDIT_TURNS_PER_PAGE`.
- `recordSyncRun` ([src/history.ts:231](src/history.ts:231)): when
  `run.editRequest` is present, record kind `edit`, `requestText` =
  the instruction, and the selected paths as the request's pages.

Tests in `src/sync-runs.test.ts`, modelled on the revision tests at
[src/sync-runs.test.ts:304](src/sync-runs.test.ts:304) and 388, using the
fake `author` option:
- an edit run whose fake author changes only the selected page reaches
  `awaiting-review` with one page change and a history row of kind `edit`;
- a fake author that also edits another page fails with the "outside this
  page" message and no proposal is applied;
- with `allowRelated: true` the same author editing `docs.json` succeeds;
- a fake author that changes nothing fails with "did not change this page";
- accept applies the page, `undoSyncRun` restores it, and both are visible in
  history;
- a caller-supplied `id` is used as the run id.

### 6.3 The edit prompt

Add `editPrompt(input)` to [src/author.ts](src/author.ts) beside
`authorPrompt` and export it. `createSyncRun` passes its output as
`authoring.request` with `mode: 'update'` and `historyRequest` set to the
raw user instruction, so history shows what the user typed, not the prompt.

Use this text, filling the placeholders. Keep it short; the surrounding
`authorPrompt` already adds the skills, source rules, evidence-map rule,
untrusted-input rule, and the `doxloop test` requirement.

```text
This is a scoped edit of existing documentation, requested by a reviewer.
Change only the pages listed under "Pages to edit". Do not create, rename, or
delete pages. Do not touch any other page, even to fix something you notice;
mention it in your final summary instead.

Pages to edit:
- {path} ({title})
...

Reviewer instruction:
{instruction}

{allowRelated ? "You may also update navigation and add or replace images
under the assets folder when the instruction requires it." : "Do not change
navigation or add images. If the instruction cannot be satisfied without
them, make the text change that is possible and say what was left out."}

{followUps.length ? "Earlier instructions for this same edit, oldest first,
are already reflected in the page. The latest instruction refines them:
- {followUp}
..." : ""}

Read the page and the sources it cites in .doxloop/evidence-map.json before
changing anything. Keep the page's existing structure, tone, frontmatter, and
component usage unless the instruction says otherwise. Ground every new claim
in a configured source and record the source in the evidence map entry for the
page. When the instruction asks for something the sources do not support, do
not invent it: make the closest supported change and say what is unsupported
in your summary.

End with a two-sentence summary of what changed and why, followed by any
notes for the reviewer.
```

Test in `src/author.test.ts`: the prompt lists every path, includes the
instruction verbatim, and switches the related-changes paragraph on the flag.

### 6.4 Refine reuses revision

`reviseSyncRun` ([src/sync-runs.ts:836](src/sync-runs.ts:836)) already seeds
a new workspace from the previous run's workspace and supersedes it. Changes:

- Accept an optional `trigger` on `ReviseSyncRunInput` and pass it through to
  `createSyncRun` so a refined edit stays `trigger: 'edit'`. Carry the
  previous run's `editRequest` forward with the new instruction appended to
  `followUps`.
- The revision scope for an edit run must be the edit scope, not "every file
  the previous proposal changed", otherwise a page the agent touched only in
  the evidence map would become editable. In `createSyncRun`, when
  `revisionOf` points at a run with `editRequest`, build the scope with
  `resolveEditScope` from that request instead of `resolveRevisionScope`.
- The prompt for a refine is the edit prompt with `followUps` populated.

Test: refine on an edit run supersedes it, keeps trigger `edit`, appends the
follow-up, and still rejects out-of-scope changes.

### 6.5 CLI: `doxloop pages`

Add a `pages` command in [src/cli.ts](src/cli.ts) next to `proposal`
([src/cli.ts:185](src/cli.ts:185)), with a flag table entry at
[src/cli.ts:1047](src/cli.ts:1047):

```text
doxloop pages list [--format text|json]
doxloop pages edit --path <page> [--path <page> ...] --request "<instruction>"
                   [--allow-related] [--screenshots] [--run-id <id>]
                   [--agent <name>] [--model <id>] [--reasoning <level>] [--effort <level>]
```

`list` prints a table (path, title, section, words, evidence) or JSON.
`edit` loads the project, computes drift and source changes the same way
`reviseSyncRun` does, calls `createSyncRun` with `trigger: 'edit'`,
`editRequest`, the optional `id`, and `authoring` built from the flags, prints
`Documentation edit <id> is <status>.`, and exits non-zero with the run's
error when the status is `failed`. Add the command to the help text under the
proposal section. Tests in `src/args.test.ts` for the flag table and in
`src/cli.test.ts` (or the nearest existing CLI test) for usage errors when
`--path` or `--request` is missing.

### 6.6 Routes in `src/ui-server.ts`

Add beside the proposal routes:

| Method and path | Behaviour |
| --- | --- |
| `GET /api/pages` | `listPages(root)`. |
| `GET /api/pages/content?path=` | Returns `{ path, content, fingerprint }` for the live file. Read-only; used for the "current" side of the diff before a proposal exists. Reject paths that fail `resolveEditScope` validation. |
| `POST /api/pages/edit` | Body `{ paths: string[], instruction: string, allowRelated?: boolean, screenshots?: 'enabled' \| 'disabled', agent?, model?, reasoning?, effort? }`. Validate (non-empty instruction of at least 8 characters, 1 to 10 paths), call `assertNoActiveDocumentationJob`, generate a run id with the exported `createRunId()` from `sync-runs.ts`, start `startCliJob(runtime, \`page-edit:${runId}\`, ['pages', 'edit', '--run-id', runId, ...])`, respond 202 with the job. |
| `POST /api/proposals/:id/refine` | Body `{ instruction }`. Only for runs with `editRequest`; starts `doxloop proposal revise --id … --request … --change <every page change id>` as job `proposal:revise:<id>` so the existing settle handling applies. Reject with a clear message when the run is not an edit run. |

Also:

- Add `page-edit:` to the prefixes in `assertNoActiveDocumentationJob`
  ([src/ui-server.ts:1665](src/ui-server.ts:1665)) and to the job category
  mapping at [src/ui-server.ts:1914](src/ui-server.ts:1914) (category
  `proposal`).
- Do not touch `requirePlanFirstAuthoring`. Edits never go through
  `/api/author`.
- Accept and reject reuse the existing `/api/proposals/:id/accept` and
  `/reject` routes ([src/ui-server.ts:757](src/ui-server.ts:757)). Undo reuses
  `/api/proposals/:id/undo`.

Tests in `src/ui-server-routes.test.ts`: validation errors for the edit body,
409 when a job is active, the job type and CLI args produced, refine rejected
on a non-edit run.

---

## 7. UI work

### 7.1 Route and navigation

- Add `'pages'` to `WORKSPACE_ROUTES` in [ui/src/routes.ts](ui/src/routes.ts)
  and to the `NAV` array in [ui/src/WorkspaceApplication.tsx:31](ui/src/WorkspaceApplication.tsx:31)
  between Update and Review, label **Pages**, icon `file` (add to
  [ui/src/icons.tsx](ui/src/icons.tsx) if missing). Add `pages: 'Pages'` to
  `PAGE_TITLES`.
- URL state: `/pages?path=<encoded path>` selects a page; `/pages?run=<id>`
  opens the review of that edit run. Read both on load and keep them updated
  with `history.replaceState`.

### 7.2 Layout of the Pages view

Two columns on desktop (320 px list, fluid pane), stacked on narrow widths.

**Left: page list.**
- Search input (filters title and path, debounced 150 ms).
- Groups by `section`, then "Not in navigation".
- Row: checkbox (multi-select), title, path in monospace, word count,
  evidence badge (`Verified`, `Needs review`, `No evidence`), updated date.
- Selecting a row without the checkbox makes it the single active page.
  Checking boxes builds a multi-selection; the pane header then reads
  "3 pages selected".

**Right pane, state A: page selected, no edit running.**
- Header: title, path, section, buttons **Open in preview** (new tab to the
  running preview at `pageRoute`; start the preview through the existing
  `/api/preview/start` if it is not running) and **Page history** (opens the
  existing per-page history from `/api/history?page=`).
- Rendered preview: iframe of the running preview at the page route, 420 px
  tall, with a "Preview is starting" placeholder while the preview job
  starts.
- **Edit with the agent** panel:
  - Textarea, label "What should change on this page?" (or "on these N
    pages?"), placeholder "For example: add a curl example under
    Authentication and say that tokens expire after 24 hours."
  - Intent chips that insert a starter sentence into the textarea: **Fix
    wording**, **Add an example**, **Update for a recent change**, **Add a
    section**, **Shorten**, **Rewrite for a different audience**. Chip text
    goes at the cursor; the user still edits it.
  - Toggle "Also allow related changes" with help text "Lets the agent update
    navigation and add or replace images for this page."
  - Screenshot toggle, only when `project.application` is configured, default
    off, same component the Update page uses.
  - Planning agent summary line with **Change**, reusing the component from
    the Update page ([ui/src/WorkspaceApplication.tsx](ui/src/WorkspaceApplication.tsx)
    around the "Planning agent" row).
  - Primary button **Ask the agent to edit**, disabled until the instruction
    has at least 8 characters. Helper text: "The page stays unchanged until
    you accept the result."

**Right pane, state B: an edit is running.**
- The composer is replaced by a card "Editing <title>" with the instruction
  shown in a quote, the `AuthoringLiveLog` component, and **Stop**.
- Selecting another page shows its preview with a note "An edit is in
  progress. Finish or stop it before starting another."

**Right pane, state C: edit ready for review.**
- Header "Review this edit" with the agent's summary sentence.
- File switcher when more than one file changed (reuse the Review file
  dropdown component).
- Tabs **Rendered** and **Source**, each a side-by-side before-and-after,
  reusing the components extracted into `ui/src/proposal-diff.tsx`. The
  before side of Rendered is the live project preview at the page route; the
  after side is the proposal preview (start it through
  `/api/proposals/:id/preview/start` and point the iframe at the page route
  on port 4322).
- "Why this change" link opens `ProposalRationaleDrawer`.
- Validation: when `proposal.validation.errors > 0`, show the issues in a
  `Note` with tone error and disable Accept with the reason "Fix the
  validation errors by refining the instruction, or reject this edit."
- Actions: **Accept** (primary), **Reject**, **Refine** (reveals a textarea
  "What should be different?" and a button **Send to the agent**).
- Related-file changes (navigation, assets, evidence map) are listed under a
  collapsed "Also changed" section, not in the main switcher.

**Right pane, state D: after accept.**
- Toast "Page updated" with **Undo** (calls `/api/proposals/:id/undo`) that
  stays until dismissed or until another edit starts.
- Preview iframe reloads. The list row's updated date and evidence badge
  refresh from `/api/pages`.

**Failure states**, each rendered as a `Note` with the exact server message
and one action:
- Out-of-scope change: message from 6.2, action **Retry allowing related
  changes** (re-submits with `allowRelated: true`).
- No change: action **Refine the instruction** (focuses the composer with
  the previous text).
- Agent exit or timeout: the run's `error`, action **Try again**.
- Conflict on accept (page changed on disk since the run): the existing
  conflict message, actions **Reload and compare** and **Reject**.

### 7.3 Job handling

- In the settle logic at [ui/src/WorkspaceApplication.tsx:87](ui/src/WorkspaceApplication.tsx:87)
  through 165, handle `page-edit:<runId>` jobs like `proposal:revise:` jobs:
  on success, reload, fetch `/api/proposals`, find the run by id, set it as
  the active edit review, and navigate to `/pages?run=<id>`. On failure,
  reload and show the failure state from the run's `error`.
- `workflowActivityLabel` ([ui/src/WorkspaceApplication.tsx:1280](ui/src/WorkspaceApplication.tsx:1280)):
  `page-edit:` → "Editing a page with the agent".
- Add `page-edit:` to the busy check that disables the Update page's
  **Plan documentation update** button ([ui/src/WorkspaceApplication.tsx:717](ui/src/WorkspaceApplication.tsx:717))
  so the UI and `assertNoActiveDocumentationJob` agree.
- `ui/src/job-transitions.ts` and its test: add the new prefix to whatever
  helpers classify job types.

### 7.4 Entry points elsewhere

- Overview: in the "Documentation is current" card, add a secondary link
  **Edit a page** that navigates to `/pages`.
- Review: on an applied proposal's file header, add **Edit this page** that
  navigates to `/pages?path=<path>`.
- Update history rows of kind Edit show the instruction and the page path,
  and clicking the row opens `/pages?path=`.

### 7.5 Copy

Use these strings verbatim so the feature reads consistently.

| Where | Text |
| --- | --- |
| Nav | Pages |
| Page title | Pages |
| Subtitle | Every page in this documentation. Pick one and tell the agent what should change. |
| Composer label | What should change on this page? |
| Composer button | Ask the agent to edit |
| Composer helper | The page stays unchanged until you accept the result. |
| Related toggle | Also allow related changes |
| Related help | Lets the agent update navigation and add or replace images for this page. |
| Running card | Editing {title} |
| Review header | Review this edit |
| Accept | Accept |
| Reject | Reject |
| Refine | Refine |
| Refine label | What should be different? |
| Refine button | Send to the agent |
| Toast | Page updated |
| Undo | Undo |
| Empty list | No pages yet. Create a documentation plan to write the first ones. |

### 7.6 Accessibility

- The list is a `listbox` with `aria-multiselectable`; rows are `option`s
  with keyboard up/down and space to toggle.
- Dialogs and drawers keep the existing `role="dialog"` and
  `aria-modal` pattern, with focus trapped and returned.
- Iframes carry a `title` ("Current page preview", "Proposed page preview").
- Every toggle has a visible label; chips are buttons with `aria-pressed`
  false (they insert text, they do not stay selected).

---

## 8. Error handling matrix

| Situation | Where detected | User sees | Data state |
| --- | --- | --- | --- |
| Instruction under 8 characters | UI and `POST /api/pages/edit` | Button disabled; server 400 "Describe what should change." | Nothing created |
| Path outside content dir or not a page | `resolveEditScope` | 400 naming the path | Nothing created |
| Another agent job running | `assertNoActiveDocumentationJob` | 409 existing message | Nothing created |
| Agent edits other pages | `assertRevisionStayedInScope` | Failure state with "Retry allowing related changes" | Run `failed`, workspace kept |
| Agent changes nothing | same | Failure state with "Refine the instruction" | Run `failed` |
| Agent exits non-zero or times out | `createSyncRun` catch | Failure state with the run error and "Try again" | Run `failed`, resumable |
| Validation errors in result | `finalizeProposalWorkspace` | Review state with Accept disabled | Run `awaiting-review` |
| Page changed on disk before accept | `acceptSyncChanges` fingerprint | Conflict state | Run `conflicted` |
| Undo after a later edit of the same page | `undoSyncRun` | Existing "undo unavailable" reason | Unchanged |

---

## 9. Testing requirements

- **Unit**: `src/pages.test.ts`, additions to `src/sync-runs.test.ts`,
  `src/author.test.ts`, `src/history.test.ts` (kind `edit` round-trips through
  `listRequests`), `src/args.test.ts`, `src/ui-server-routes.test.ts`, and
  `ui/src/routes.test.ts`, `ui/src/job-transitions.test.ts`.
- **E2E (mocked API)**: extend [e2e/control-center.spec.mjs](e2e/control-center.spec.mjs)
  with: the Pages route has a direct URL; selecting a page shows the composer;
  submitting posts to `/api/pages/edit` with the right body; a running
  `page-edit:` job shows the live log and Stop; a proposal with `editRequest`
  renders the review state with Accept, Reject, Refine; Accept posts to the
  accept route and shows the toast with Undo.
- **Smoke against a real server**: add `e2e/pages-edit.real.spec.mjs`, skipped
  unless `DOXLOOP_E2E_REAL=1`, that scaffolds the demo project
  (`doxloop demo --no-preview --keep`), starts `doxloop ui --no-open` on a
  free port, and exercises list → edit with a fake agent. No agent executable
  override exists today ([src/agents.ts](src/agents.ts) resolves agents from
  `PATH` only), so add one: when `DOXLOOP_AGENT_EXECUTABLE_<NAME>` (for
  example `DOXLOOP_AGENT_EXECUTABLE_CODEX`) is set, `agents.ts` uses that
  path instead of searching `PATH`. The fake agent for the smoke test is a
  small Node script that reads the prompt, appends a paragraph to the page
  named in "Pages to edit", updates the evidence map entry, and exits 0.
  Document the variable in `docs/agent-compatibility.md` as test-only.
- All existing tests must keep passing.

---

## 10. Definition of done

- A user can complete the flow in section 1 on the Doxbrix demo project with
  Claude Code and with Codex, including Refine and Undo.
- The agent cannot change anything outside the selected pages unless "Also
  allow related changes" is on, and the failure is explained in the UI.
- Update history shows kind Edit rows with the instruction and page.
- No manual editor exists anywhere in the UI.
- `pnpm run typecheck` and `pnpm vitest run` pass; the mocked e2e suite
  passes; the real smoke passes locally with the fake agent.
- CHANGELOG.md gains an entry under Unreleased → Added describing the Pages
  view. README.md gains a **Pages** row in "The workspace" table and a short
  "Edit a page" paragraph, describing only the UI.

---

## 11. Pull request sequence

**PR 1: core edit runs.** Sections 5, 6.1, 6.2, 6.3, 6.4. No UI, no routes.
Reviewable by its unit tests alone.

**PR 2: CLI and routes.** Sections 6.5 and 6.6, plus job prefixes. Manual
check: `doxloop pages edit --path index.mdx --request "…"` on the demo project
produces a proposal visible on the existing Review page.

**PR 3: Pages view.** Sections 7.1 through 7.6 except entry points. Includes
the extraction of the diff components into `ui/src/proposal-diff.tsx` with
Review still using them.

**PR 4: entry points, docs, e2e.** Sections 7.4, 9 (e2e), and 10 docs.

---

## 12. Decisions already made

- Editing is agent-only. Do not add a manual editor, even as a fallback.
- Every edit is a proposal with the same accept, reject, undo, and conflict
  semantics as any other. Users never write to the project directly.
- One agent job at a time across the whole workspace.
- Screenshots are off by default for edits.
- The Pages view is the home for editing; the Review page is unchanged except
  for the shared diff components and the "Edit this page" link.
