# Documentation accessibility

Target the accessibility level recorded in the persisted documentation brief.
The Doxloop default is WCAG 2.2 Level AA for rendered web documentation. Treat
the target as a design and validation requirement; do not claim conformance
unless the complete rendered site has received the required evaluation.

## Structure content

- Use one descriptive page title and a logical heading hierarchy.
- Do not skip heading levels for visual effect.
- Make instructions understandable without relying on position, shape, color,
  sound, or visual styling alone.
- Use lists, tables, and components according to their semantic purpose.
- Give each page a clear language and use plain, literal wording.

## Write accessible links and media

- Make link text describe its destination or action out of context.
- Avoid raw URLs and vague text such as *here* or *learn more*.
- Add concise alternative text for informative images.
- Use empty alternative text only for genuinely decorative images.
- Describe diagrams in nearby text when their relationships are needed to
  complete the reader's task.
- Provide captions or transcripts for essential prerecorded audio and video
  when the selected generator supports them.
- Do not put essential instructions only inside an image.

## Present data and code

- Give tables a clear introductory sentence and meaningful column headings.
- Avoid tables for page layout.
- Keep code and terminal text readable at zoom and on narrow screens.
- Identify code languages when known.
- Explain important output after the example instead of relying on syntax color.
- Do not use emoji or icons as the only label for an action or status.

## Use components and themes safely

- Preserve keyboard access, visible focus, and logical reading order in native
  generator components.
- Keep text and interactive controls readable in light and dark modes.
- Meet the configured contrast target; do not preserve a brand color when it
  makes documentation unreadable.
- Do not use color as the only way to distinguish success, warning, error, or
  code changes.
- Avoid unnecessary animation and respect reduced-motion behavior.

## Verify

Inspect the rendered pages at keyboard-only navigation, narrow viewport, 200%
zoom, light mode, and dark mode where supported. Run available automated
accessibility checks, then perform a visual and semantic review because
automated checks cannot establish full conformance.
