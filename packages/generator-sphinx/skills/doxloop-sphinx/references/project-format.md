# Sphinx project format

- Content root: `docs/`
- Configuration: `docs/conf.py`
- Home document: `docs/index.rst`
- Navigation: `.. toctree::` entries, relative and extensionless
- Metadata:

```rst
Page title
==========

.. meta::
   :description: Describe the reader outcome.
```

- Cross-page links: `:doc:\`quickstart\`` or `:ref:`
- Code: `.. code-block:: language`
- Callouts: `.. note::`, `.. tip::`, `.. warning::`
- Strict build: `sphinx-build -W -b html docs _build/html`

## Navigation and references

- Add every reader document to one toctree; use `:hidden:` only deliberately.
- Keep toctree document names relative and extensionless.
- Prefer `:doc:`, `:ref:`, and domain roles over raw relative links.
- Give reusable targets unique, stable labels.

## Directives and presentation

- Indent directive options and bodies exactly.
- Use configured language domains for API reference where they match the public
  interface.
- Keep theme variables, templates, and assets under `_static/` and `_templates/`.
- Preserve Furo's keyboard, color-mode, and responsive behavior.

## Common failures

- Underlines shorter than their title cause malformed headings.
- Duplicate labels and unresolved references fail strict builds.
- Documents outside all toctrees are orphans.
- `_build/` is generated output.
