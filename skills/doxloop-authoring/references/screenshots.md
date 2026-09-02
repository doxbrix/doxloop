# Application guide screenshots

Use this workflow only for screenshots of the product being documented. The
existing `doxloop capture` command inspects external documentation design
references and is not part of this workflow.

## Decide whether capture is enabled

Capture application screenshots when any of these conditions applies:

- the task prompt says screenshots are required because `--screenshots` was
  supplied;
- the user explicitly asks to include, create, capture, or refresh screenshots;
- `.doxloop/project.json` sets `application.screenshots.policy` to `auto` and
  the agreed page is a visible user-interface workflow.

Do not capture when the task prompt disables screenshots; when the project
policy is `off` and the task prompt does not explicitly require them; when the
request mentions screenshots only negatively or as an example; or when the page
has no meaningful visible application state. An explicit `--screenshots`
requirement overrides project policy for that run. Never add screenshots to API
or CLI procedures merely for decoration.

## Use the user-managed application

Assume the user has already started and prepared the application. Never start,
restart, stop, seed, reset, or reconfigure it. Never run a project startup,
setup, database, or authentication command. Use `application.baseUrl` when it
is configured; otherwise use the application URL supplied by the user or
already open in an approved browser. Doxloop normally provides the selected
agent with a scoped Playwright MCP server named `doxloop_capture`; use its
browser snapshot and interaction tools to establish state and its screenshot
tool to save each image at the manifest's project-relative filename.

The screenshot tool resolves that filename against the documentation project
root, and it does not create directories. A filename whose parent folder does
not exist fails with `ENOENT` and writes nothing. Doxloop pre-creates the guide
directories for the approved plan; create any other parent directory yourself
first. Read the result of every screenshot call: an error means no image was
written, so correct the path and call it again. Never record a step as verified
after a failed call. If no reachable application
surface is available, finish the text guide without broken image links and
report that screenshots could not be captured.

Capture only the agreed application origin and its required public assets.
Never use a real customer or production environment, change shared data, or
operate outside the workflow being documented.

## Handle browser authentication

Keep authentication in the browser controlled by Codex, Claude, or the
selected agent. Do not add authentication settings to `.doxloop/project.json`
and do not create login scripts, storage-state files, credential files, or
environment-variable requirements.

1. Open the application with `doxloop_capture` (or the approved in-app browser
   when one is explicitly available) and inspect the visible
   state.
2. If an authenticated application page is already visible, reuse that session
   and continue without mentioning login.
3. If the application redirects to login, first allow the browser's existing
   session or password-manager autofill to work. The agent may select a sign-in
   control after autofill, but must never inspect, copy, reveal, or log an
   autofilled value.
4. If user interaction is required, keep the login page open and ask the user
   once to complete login, MFA, SSO, passkey, or browser confirmation directly
   in that browser. Never ask for a password, token, OTP, cookie, recovery code,
   or secret in chat.
5. After login, verify a stable authenticated state such as the expected page,
   account menu, workspace name, or application heading before capture.
6. Keep the same browser session and context for the entire capture manifest.
   Do not clear cookies, local storage, cache, or site data and do not open the
   workflow in an isolated browser context.
7. If the session expires, preserve the current manifest row, return to the
   login checkpoint once, verify authentication again, and resume that row
   rather than restarting or taking screenshots of the login page.

Use a demo, test, or other non-production account with synthetic data. Treat
login and account-selection screens as private operational states: exclude
them from the guide unless the agreed reader task is specifically about login.

## Plan the visual story

Finish and fact-check the ordered text procedure before operating the
application. Make every UI step atomic: one primary reader action followed by
one observable result. Do not capture while improvising the guide.

Every step that changes what is on screen gets its own image: the entry
screen, each dialog, drawer, tab, or expanded section a step opens, the form
once it is filled with safe example values, and the visible result or
confirmation. Readers follow a guide screen by screen, so a guide whose steps
open four screens embeds four images. Only steps that leave the screen
unchanged — typing into an already visible field, scrolling, focusing — share
the previous image and are recorded as text-only.

For plan-first authoring, treat each page's approved `visuals.startPath` and
`visuals.workflow` as a boundary and its `visuals.captureSequence` as the
required visual story. Resolve the start path only against
`application.baseUrl`, establish the stated safe fixture or authenticated
state, and follow the ordered actions and visible outcomes. Translate every
capture-sequence item into a verified manifest capture in the same order. Do
not collapse an approved multi-state sequence into one convenient final-state
image. If these details are missing, contradictory, unsafe, or no longer match
the application, stop capture and report the blocking detail instead of
choosing another route.

When a documentation plan is approved, Doxloop has already written this manifest
for you, with every approved guide and its steps staged as `status: "planned"`.
Fill it in as you capture. Never delete a guide, drop a step, or rebuild the
file from the images you ended up taking — a guide that disappears is approved
work silently dropped, and Doxloop fails the run for any guide still left
`planned`. Every staged guide has to end as verified captures or as text-only
steps with specific reasons.

Open each guide's `startPath` in the capture browser before you form any opinion
about it. You may not conclude that a screen is empty, uninteresting, or "not a
distinct state" from another page's snapshot or from reading the source: visit
it. An empty or unconfigured screen is still the screen a reader will meet, and
a screenshot of it is usually worth more than prose about it.

Without an approved plan, create the manifest yourself before taking the first
image. Give every published UI step a stable step ID, including steps that
intentionally have no image:

Persist the manifest at `.doxloop/screenshot-manifest.json`. Doxloop validates
this file before it creates a review proposal, so Codex, Claude, and Gemini use
the same capture contract. Use schema version 1:

```json
{
  "schemaVersion": 1,
  "guides": [{
    "page": "approved-plan-page-id-or-path",
    "steps": [{
      "id": "03",
      "action": "Select Invite member from Team settings.",
      "expectedState": "The Invite member dialog is open.",
      "purpose": "Prove where the invitation workflow begins and orient the reader in the dialog.",
      "sequenceItem": 2,
      "capture": true,
      "target": "Invite member dialog",
      "file": "assets/guides/invite-team-member/03-invite-form.png",
      "alt": "Invite member dialog open from Team settings",
      "status": "verified",
      "checks": {
        "expectedStateConfirmed": true,
        "privacyReviewed": true,
        "legibilityReviewed": true,
        "meaningful": true
      }
    }]
  }]
}
```

Use project-relative asset paths in `file`. Write `action`, `expectedState`,
and `purpose` as full descriptive clauses of at least 8 characters each — for
example `"Open the application at /"` rather than `"Open /"` — because Doxloop
rejects terser values during manifest validation. A step without a meaningful
image sets `capture` to `false`, `status` to `text-only`, and includes a
specific `textOnlyReason`. Confirm each state in the browser *before* capturing
it, because that is the check you can actually perform; you are not expected to
open or view the saved PNG afterwards, and being unable to view an image file is
never a reason to record a captured step as `text-only`. For an approved plan, every captured step also
sets `sequenceItem` to the one-based matching item in `visuals.captureSequence`;
text-only steps omit it.

| Step ID | Published action | Expected visible state | Capture? | Target | Filename | Alt text | Status |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | Open **Team settings**. | Team settings page is visible. | yes | page heading | `01-team-settings.png` | Team settings page with the heading marked as step 1 | planned |
| 02 | Copy the workspace ID. | ID is copied; no durable visual change. | no | — | — | — | text-only |
| 03 | Select **Invite member**. | Invitation form is open. | yes | Invite member button | `03-invite-form.png` | Invitation form opened from the Invite member button marked as step 3 | planned |

The manifest is the source of truth for capture order, filenames, step marker
numbers, alt text, and placement. Never choose screenshots opportunistically
from whatever page happens to be open. Do not renumber captures to hide an
intentionally text-only step: the image prefix and visual marker must match the
published step number.

Every guide marked `required` must contain at least one verified image, and one
image for each approved `captureSequence` item that is genuinely a distinct
visible state. The approved count is a target, not a quota: when an approved
item turns out not to change what the screen looks like — scrolling a page that
already fits the viewport, focusing a field, hovering, or inspecting a panel
that is already visible — capture it once and record the remaining items as
text-only with that reason. Never save the same screen twice inside one guide
to reach the planned number; Doxloop consolidates repeats within a guide and
rejects a guide that has nothing but repeats. Two different guides may show the
same screen when both genuinely document it. Text-only rows explain procedure
steps that do not benefit from an image of their own.

For each guide step, record:

1. the reader action immediately before the image;
2. the stable visible state that proves the action succeeded;
3. the control or region that needs attention, if any;
4. the image filename, alternative text, and optional caption.

When the user asks for a screenshot for every step, capture every step that has
a meaningful visible UI state. Mark non-UI steps and actions with no durable
visible change as `text-only` in the manifest and explain that decision in the
completion summary. Otherwise capture only when an image reduces ambiguity or
confirms an important state. Keep the application chrome and nearby labels when
they help readers orient themselves. Prefer a viewport screenshot or a
carefully cropped stable region; avoid very tall full-page screenshots for task
steps.

## Operate and verify the workflow

Prefer stable accessible roles, labels, visible text, and product test IDs over
fragile CSS structure. Reuse verified Playwright, Cypress, or other UI tests as
workflow evidence when available, but do not modify or submit destructive
production data. Process the manifest strictly from the lowest step ID to the
highest. For each planned image:

1. reset or establish the expected fixture state;
2. perform the documented actions in their published order;
3. wait for the expected visible outcome, not an arbitrary delay alone — most
   applications render on the client, so a screenshot taken straight after
   navigation captures a splash or skeleton screen; take a snapshot first and
   confirm the named content is present, and never capture a loading state,
   which Doxloop rejects as an almost entirely single-color image;
4. dismiss only transient UI that a normal reader would not see;
5. inspect the viewport for secrets, personal data, unstable timestamps,
   unrelated notifications, and accidental browser content;
6. add contextual highlighting when it materially helps;
7. capture the image to its manifest filename;
8. confirm the file was written where the manifest says it is — a capture that
   failed with a path error produced no file at all;
9. mark the manifest row `verified`, then remove the overlay and continue.

Verification happens before the shutter, not after it: the browser snapshot in
step 3 is what proves the screen shows the named state. Doxloop then checks
every saved PNG itself — that it is readable, large enough, not a blank, splash,
or still-loading screen, distinct from the other captures, and embedded in its
guide — and fails the run when one of those is wrong. So mark a captured step
`verified` once its file exists and is embedded. Never downgrade a real capture
to `text-only` because you cannot open the image; `text-only` is for a state you
could not reach in the application.

If a capture is wrong, replace that file immediately and repeat the same
manifest row. Do not continue and plan to sort screenshots out later. Do not
reuse one screenshot for multiple steps unless those steps intentionally refer
to exactly the same visible state and the prose makes that explicit.

Never save the screen you happen to be on under the name of a state you could
not reach. If a step needs a signed-in session, seeded data, or a workflow you
cannot safely advance, record that step as `text-only` with a specific reason.
Doxloop hashes every captured image and rejects the run when two captured steps
produce the same file, because identical images published as different states
misinform readers.

If browser automation is unavailable or the application cannot be reached,
finish a complete text guide, do not create placeholder images or broken image
links, and report the capture limitation.

## Highlight the relevant context

When `application.screenshots.highlight` is not `false`, highlight the control
or result a reader should notice. Use a temporary browser overlay rather than
editing product source or permanently changing application styles:

- draw a 3 px high-contrast ring with 4–6 px clearance around the target;
- add a small numbered marker matching the corresponding guide step;
- optionally dim the rest of the viewport by no more than 18 percent;
- keep the target, its label, validation message, and surrounding orientation
  visible;
- never use color alone: the numbered marker and nearby prose must identify the
  target;
- remove the overlay before continuing to the next application action.

When the browser supports script evaluation, inject the packaged
[highlight helper](../assets/screenshot-highlight.js), call
`__doxloopScreenshotHighlight({ selector, step, dim })` immediately before the
screenshot, and call `__doxloopRemoveScreenshotHighlight()` immediately after.
Choose `selector` from a verified stable test ID, accessible label relationship,
or other stable product evidence. The helper returns the measured target bounds
for the capture record and never mutates product source.

The ring and marker should be baked into the PNG so they work in every
documentation generator. Do not draw arrows or labels over interactive text,
form values, error details, or other information the reader needs.

## Store and embed screenshots

Follow the selected generator skill for its native public asset directory and
image syntax. Group images under a stable guide-specific directory and use
ordered, descriptive filenames, for example:

```text
assets/guides/invite-team-member/
  01-team-settings.png
  02-invite-form.png
  03-invitation-sent.png
```

Use these default committed locations unless the existing project has an
established equivalent:

| Generator | Screenshot directory | Public/reference prefix |
| --- | --- | --- |
| Doxbrix | `<contentDir>/assets/guides/<guide>/` | `/assets/guides/<guide>/` |
| Docusaurus | `static/img/guides/<guide>/` | `/img/guides/<guide>/` |
| MkDocs | `docs/assets/guides/<guide>/` | page-relative `assets/guides/` |
| Sphinx | `<contentDir>/_static/guides/<guide>/` | `/_static/guides/<guide>/` |
| Hugo | `static/images/guides/<guide>/` | `/images/guides/<guide>/` |
| VitePress | `docs/public/images/guides/<guide>/` | `/images/guides/<guide>/` |
| Markdoc | `assets/guides/<guide>/` | `/assets/guides/<guide>/` |
| Nextra | `public/images/guides/<guide>/` | `/images/guides/<guide>/` |
| Starlight | `public/images/guides/<guide>/` | `/images/guides/<guide>/` |
| Jekyll | `assets/images/guides/<guide>/` | `relative_url` from `/assets/images/guides/<guide>/` |
| Static HTML | `site/assets/guides/<guide>/` | `/assets/guides/<guide>/` |

Respect any configured base path when the generator requires relative or
base-aware URLs. Verify the final built output contains each image; source-file
existence alone is not sufficient.

Guide screenshots are committed documentation assets. Never put them under
`.doxloop/cache/reference/`. Embed each verified image before capturing the
next step, immediately after the instruction or expected-result it proves —
inside the same ordered-list item, or, when the procedure uses a step component
such as Doxbrix `<Steps>`/`<Step>`, inside that step's own body. Those
components render block content, so an image belongs within the step rather
than after the block. Do not collect step screenshots at the beginning or end of
the guide, place an image between two unrelated steps, or let Markdown
indentation terminate the ordered list.

Every verified capture in the manifest must appear in its guide. Capturing four
states and embedding only the first leaves three orphaned images and fails the
run: if a captured state does not earn a place in the finished procedure, delete
that image and record the step as `text-only` instead of leaving it unused.
Add concise alternative text describing the useful visible state, not phrases
such as "screenshot of". Use a caption for orientation or consequence that is
not already obvious from the prose. Keep all essential instructions and values
in text outside the image.

For Doxbrix, prefer a captioned frame:

```mdx
<Frame caption="The highlighted Invite member control opens the invitation form.">

![Team settings with the Invite member control marked as step 1](/assets/guides/invite-team-member/01-team-settings.png)

</Frame>
```

Use native caption or figure syntax supplied by other generators. Plain
Markdown images are the portable fallback.

## Run the screenshot completeness gate

Do not finish a screenshot-enabled guide until all of these checks pass:

1. Compare the final ordered procedure with the manifest row by row.
2. Confirm every published UI step has exactly one `verified` image or an
   explicit `text-only` reason.
3. Confirm every verified manifest filename exists exactly once in the guide
   and immediately follows its matching step.
4. Confirm the filename prefix, highlighted marker, prose step number, visible
   state, and alt text all refer to the same step.
5. Confirm there are no unreferenced captures, broken paths, duplicate images,
   stale screenshots, or screenshot links outside the guide-specific folder.
6. Build the selected generator, then inspect the rendered guide from top to
   bottom at desktop and narrow widths. Verify list numbering, image order,
   cropping, legibility, captions, and the association between each step and
   image.

Any mismatch is a blocking defect. Fix the procedure, manifest, capture, or
placement and rerun the entire gate; do not report the guide as complete.

## Continue an interrupted run

When Doxloop resumes a run that stopped early, the prompt says so and lists
the manifest progress guide by guide. Treat every row it names as verified,
with an existing file, as finished: keep the file, its manifest row, and its
placement in the guide. Do not recapture, rename, or delete those images, and
never rebuild the manifest from what you capture in the resumed run. Work only
on the steps the brief lists as unfinished, then run the completeness gate for
the guides you touched.

## Refresh without churn

During update, recapture only when the documented workflow, visible label,
layout, theme, or expected outcome changed, or when the user explicitly asks.
Preserve filenames when the semantic step is unchanged so links and review
history remain stable. Remove an old image only after all page references to it
are removed. Run `doxloop test` and the generator build to catch missing assets,
then review the rendered guide at desktop and narrow widths.
