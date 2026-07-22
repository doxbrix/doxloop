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
already open in the approved in-app browser. If no reachable application
surface is available, finish the text guide without broken image links and
report that screenshots could not be captured.

Capture only the agreed application origin and its required public assets.
Never use a real customer or production environment, change shared data, or
operate outside the workflow being documented.

## Reuse in-app browser authentication

Keep authentication in the in-app browser controlled by Codex, Claude, or the
selected agent. Do not add authentication settings to `.doxloop/project.json`
and do not create login scripts, storage-state files, credential files, or
environment-variable requirements.

1. Open the application in the approved in-app browser and inspect the visible
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

Create a capture manifest before taking the first image. Give every published
UI step a stable step ID, including steps that intentionally have no image:

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
3. wait for the expected visible outcome, not an arbitrary delay alone;
4. dismiss only transient UI that a normal reader would not see;
5. inspect the viewport for secrets, personal data, unstable timestamps,
   unrelated notifications, and accidental browser content;
6. add contextual highlighting when it materially helps;
7. capture the image to its manifest filename;
8. open the saved file and verify that it is the expected step, has the correct
   marker, is legible, contains no sensitive or transient content, and is not a
   duplicate of another step;
9. mark the manifest row `verified` only after that inspection, then remove the
   overlay and continue.

If a capture is wrong, replace that file immediately and repeat the same
manifest row. Do not continue and plan to sort screenshots out later. Do not
reuse one screenshot for multiple steps unless those steps intentionally refer
to exactly the same visible state and the prose makes that explicit.

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
next step. Insert it inside the same ordered-list item, immediately after the
instruction or expected-result sentence that the image proves. Do not collect
step screenshots at the beginning or end of the guide, place an image between
two unrelated steps, or let Markdown indentation terminate the ordered list.
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

## Refresh without churn

During update, recapture only when the documented workflow, visible label,
layout, theme, or expected outcome changed, or when the user explicitly asks.
Preserve filenames when the semantic step is unchanged so links and review
history remain stable. Remove an old image only after all page references to it
are removed. Run `doxloop test` and the generator build to catch missing assets,
then review the rendered guide at desktop and narrow widths.
