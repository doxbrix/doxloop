# Application guide screenshots

In an approved writing batch, use only the saved captures and observed labels
in the supplied manifest slice. Choose images that prove the reader's steps;
do not browse, take screenshots, or modify capture status. The capture workflow
below applies only to a dedicated capture task or a run without an approved plan.

Use this workflow only for screenshots of the product being documented (the
`doxloop capture` command is unrelated design-reference tooling). Capture when the task prompt requires screenshots, the user explicitly
asks for them, or `application.screenshots.policy` is `auto` and the page is a
visible UI workflow. Do not capture when the prompt disables screenshots, when
the policy is `off` and the prompt does not require them, or when the page has
no meaningful visible state. Never decorate API or CLI procedures with images.

## Use the user-managed application

The user has already started and prepared the application. Never start,
restart, stop, seed, reset, or reconfigure it, and never run a startup, setup,
database, or authentication command. Resolve every path against
`application.baseUrl`. Use the Doxloop-provided `doxloop_capture` browser:
its snapshot and interaction tools establish state, and its screenshot tool
saves each image at the manifest's project-relative filename. That tool
resolves the filename against the documentation project root and does not
create directories: a missing parent folder fails with `ENOENT` and writes
nothing. Doxloop pre-creates the guide directories for an approved plan; create
any other parent yourself first, and read the result of every screenshot call —
an error means no image exists.

Capture only the agreed application origin with a demo or test account and
synthetic data. Never use a production environment, change shared data, or
operate outside the workflow being documented.

## Authentication checkpoint

Doxloop owns sign-in material. The prompt says which kind is available; never
add authentication settings to `.doxloop/project.json` or create login scripts,
storage-state files, credential files, or environment requirements.

- **Recorded browser session.** `doxloop_capture` starts signed in. If a login
  page appears, the session expired: record the affected steps as text-only
  with the reason "saved browser session expired" and tell the user to sign in
  again under **Settings → Visual evidence**. Do not try to sign in.
- **Saved credentials.** On the sign-in form, type the literal names
  `DOXLOOP_APP_USERNAME` and `DOXLOOP_APP_PASSWORD` into the username and
  password fields with the browser type or fill-form tools; the server
  substitutes and redacts the real values. Never guess, print, or reconstruct
  them, type them anywhere else, or capture the filled form.
- **Neither.** Open the application. If it redirects to login, record the steps
  that need a signed-in screen as text-only and tell the user once that they
  can sign in or save credentials under **Settings → Visual evidence**. Never
  ask for a password, token, OTP, cookie, or secret in chat.

After sign-in, confirm a stable authenticated state (expected page, account
menu, workspace name) before capturing. Keep one browser session for the whole
manifest; never clear cookies, storage, or site data. If the session expires
mid-run with credentials available, sign in once more and resume the same
manifest row. Login and account-selection screens are private states: exclude
them unless the reader task is login itself.

## Follow the manifest

Doxloop has already written `.doxloop/screenshot-manifest.json` for an approved
plan, with every guide and its steps staged as `status: "planned"`. Steps
already marked `verified` with a `file` were captured by Doxloop: keep them and
embed those images. Fill the rest in as you capture. Never delete a guide, drop
a step, renumber captures, or rebuild the file from the images you took; a
guide left `planned` fails the run. Each page's `visuals.startPath`,
`visuals.workflow`, and `visuals.captureSequence` are the boundary and the
required visual story: follow the items in order and do not collapse a
multi-state sequence into one final-state image. If they are missing,
contradictory, unsafe, or no longer match the application, stop capture for
that guide and report the blocking detail.

Without a plan, finish and fact-check the text procedure first, then write the
manifest yourself before the first image (schema in
[screenshot-manifest.md](screenshot-manifest.md)). Read that file otherwise
only if Doxloop reports a manifest shape problem.

Every step that changes what is on screen gets its own image: the entry screen,
each dialog, drawer, tab, or expanded section a step opens, the form filled
with safe example values, and the visible result. Steps that leave the screen
unchanged — typing into a visible field, scrolling, focusing, hovering — share
the previous image and are recorded as text-only. Never save the same screen
twice inside one guide to reach a planned count; Doxloop hashes images and
rejects repeats. Two guides may show the same screen when both document it.

## Navigate, verify, capture

Open each guide's `startPath` in the capture browser before forming any
opinion about it; never conclude from source or another page's snapshot that a
screen is empty or not distinct. An empty or unconfigured screen is still what
the reader meets. Process steps from the lowest ID upward. For each planned
image:

1. establish the expected fixture state and perform the documented actions in
   published order;
2. wait for the named content, not an arbitrary delay: most applications render
   on the client, and a capture taken straight after navigation shows a splash
   or skeleton that Doxloop rejects as a near-blank image;
3. snapshot only when the next action needs an element reference or a dialog,
   menu, or drawer must be confirmed open — not as a separate check before
   every image, never after one; a successful navigation or click already
   confirms the state;
4. dismiss transient UI a reader would not see, and inspect the viewport for
   secrets, personal data, unstable timestamps, and unrelated notifications;
5. when `application.screenshots.highlight` is not `false`, inject the packaged
   [highlight helper](../assets/screenshot-highlight.js), call
   `__doxloopScreenshotHighlight({ selector, step, dim })` on a stable test ID
   or accessible-label selector, capture, then call
   `__doxloopRemoveScreenshotHighlight()`; the 3 px ring and numbered step
   marker are baked into the PNG and must not cover labels or values;
6. capture to the manifest filename, confirm the call succeeded, mark the row
   `verified`, embed the image, and move to the next row.

Prefer a viewport or cropped stable region over a very tall full page and keep
the chrome and labels that orient the reader. If a capture is wrong, replace it
immediately and repeat the same row. You are not expected to
open the saved PNG afterwards — Doxloop checks readability, size, blank or
loading screens, duplicates, and embedding itself — and being unable to view an
image is never a reason to downgrade a real capture to text-only.

## Text-only rules

`text-only` means a state you could not reach: sign-in required, seeded data
missing, a workflow you cannot safely advance, or a planned item that turned
out not to change the screen. Record a specific `textOnlyReason`, keep complete
text instructions, and never save the screen you happen to be on under the
name of a state you did not reach. If the browser or application is
unavailable, finish a complete text guide with no placeholder images or broken
links and report the limitation.

## Name, store, and embed

Group images under a stable guide directory with ordered, descriptive names
(`01-team-settings.png`, `03-invite-form.png`); the number matches the
published step, so an intentionally text-only step leaves a gap rather than
renumbering. Doxbrix stores guide images at `<contentDir>/assets/guides/<guide>/`
referenced as `/assets/guides/<guide>/…`; other generators use the table in
[screenshot-manifest.md](screenshot-manifest.md). Guide screenshots are
committed documentation assets, never `.doxloop/cache/reference/`.

Embed each verified image immediately after the instruction or result it
proves — inside the same ordered-list item or, with a step component such as
Doxbrix `<Steps>`/`<Step>`, inside that step's own body, never collected after
the block or between unrelated steps. Every verified capture must appear
exactly once in its guide; delete an image that earns no place and record the
step text-only. Alt text names the useful visible state, never "screenshot
of"; a caption adds orientation or consequence the prose lacks; every
essential instruction and value stays in text. For Doxbrix:

```mdx
<Frame caption="The highlighted Invite member control opens the invitation form.">

![Team settings with the Invite member control marked as step 1](/assets/guides/invite-team-member/01-team-settings.png)

</Frame>
```

## Resume and refresh

On a resumed run the prompt lists manifest progress per guide: keep every
verified row, file, and placement and work only on the unfinished steps. During
update, recapture only when the workflow, label, layout, theme, or outcome
changed or the user asks; keep filenames for unchanged steps and remove an old
image only after its references are gone.
