# Screenshot manifest reference

Read this only when you must write `.doxloop/screenshot-manifest.json` yourself
(no approved plan) or when Doxloop reports a manifest shape problem. For an
approved plan Doxloop stages the file and normalises it after each batch: it
coerces `capture` to a boolean, fills `sequenceItem` for captured steps, accepts
terse `action` text, adopts images you captured but did not record, and embeds
verified captures you left unplaced. You still own the step statuses, files,
alt text, and reasons.

## Schema (version 1)

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

Field rules:

- `page` is the approved plan page ID or the page path.
- `id` is a stable two-digit step ID matching the published step number.
  Every published UI step has a row, including intentionally text-only ones.
- `action`, `expectedState`, and `purpose` are full descriptive clauses
  (`"Open the application at /"`, not `"Open /"`).
- `capture` is the JSON boolean `true` or `false`, never `"required"` or
  `"recommended"`.
- `sequenceItem` is the one-based index into the page's approved
  `visuals.captureSequence` for a captured step; text-only steps omit it.
- `file` is project-relative. `target` names the control or region the reader
  should notice. `alt` describes the useful visible state.
- `status` is `planned` (staged, untouched), `verified` (the file exists and is
  embedded in the guide), or `text-only` (with a specific `textOnlyReason`).
  A planned or intended capture is never `verified`.
- `checks` are all `true` for a verified capture: the named state was
  confirmed before the shutter, no secret or personal data is visible, the
  image is legible, and it adds information the prose lacks.

## Planning table (no approved plan)

Draft the manifest as a table before the first image, then persist it:

| Step ID | Published action | Expected visible state | Capture? | Target | Filename | Alt text | Status |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | Open **Team settings**. | Team settings page is visible. | yes | page heading | `01-team-settings.png` | Team settings page with the heading marked as step 1 | planned |
| 02 | Copy the workspace ID. | ID is copied; no durable visual change. | no | — | — | — | text-only |
| 03 | Select **Invite member**. | Invitation form is open. | yes | Invite member button | `03-invite-form.png` | Invitation form opened from the Invite member button marked as step 3 | planned |

Every guide marked `required` needs at least one verified image, and one per
approved `captureSequence` item that is a genuinely distinct visible state;
the approved count is a target, not a quota.

## What Doxloop checks after a batch

Doxloop reads the manifest and every PNG and returns all defects at once: a
guide left `planned`, a `verified` row whose file is missing, a tiny, blank,
or still-loading image, two captured steps in one guide with identical
content, a verified capture that no guide embeds, a `text-only` row without a
reason, and captures outside the approved plan. A run with screenshots enabled
and no verified captures fails. Fix what it names; do not build your own
checks.

## Highlight overlay

When `application.screenshots.highlight` is not `false`: a 3 px high-contrast
ring with 4–6 px clearance around the target, a small numbered marker matching
the guide step, optional dimming of at most 18 percent, the target's label and
validation message left visible, and never color alone — the marker and the
prose identify the target. The packaged helper
`assets/screenshot-highlight.js` exposes
`__doxloopScreenshotHighlight({ selector, step, dim })` and
`__doxloopRemoveScreenshotHighlight()` and returns the measured target bounds.

## Storage locations by generator

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

Respect a configured base path when the generator needs base-aware URLs. Use
each generator's native figure or caption syntax; plain Markdown images are
the portable fallback.
