---
name: doxloop-sphinx
description: Author and maintain native Sphinx documentation in reStructuredText, including conf.py, toctrees, directives, roles, Furo theming, and strict HTML builds. Use for Doxloop projects whose generator is sphinx.
---

# Doxloop Sphinx

Use this skill with `$doxloop-authoring`. Use Sphinx-native reStructuredText,
roles, directives, domains, and toctrees.

## Work natively

1. Confirm `.doxloop/project.json` selects `sphinx`.
2. Read [references/project-format.md](references/project-format.md).
3. Inspect `conf.py`, extensions, theme settings, toctrees, roles, and existing
   documents.
4. Keep reader pages in `docs/` and add each one to a toctree.
5. Give every page one title and a `.. meta::` description.

Implement the semantic top/left navigation plan from `$doxloop-authoring` with
the root and nested toctrees plus Furo-supported header links. Preserve planned
labels, order, hierarchy, and routes; omit empty template groups and keep every
reader document in exactly one primary toctree path.

Prefer native roles, domains, directives, cross-references, code blocks,
admonitions, and semantic tables. Use extensions only when already configured
or deliberately added and pinned. Apply branding through Furo variables,
templates, and `_static/` assets without weakening accessibility.

## Verify

Run `doxloop test`, then
`sphinx-build -W -b html docs _build/html`. Treat every warning, duplicate
label, unresolved reference, malformed directive, and orphan document as a
release failure. Inspect representative pages with `doxloop preview --open`.

Do not emit Markdown-only syntax or edit `_build/`.
