# Doxloop editorial standard

Apply this house standard unless the persisted documentation brief names a
project-specific alternative.

## Resolve conflicting guidance

Use this precedence:

1. confirmed project terminology, audience, and house style;
2. verified product behavior and public interface names;
3. this Doxloop editorial standard;
4. the configured external style guide;
5. general language conventions.

Use Diátaxis to distinguish tutorials, how-to guides, reference, and
explanation. Use the Google developer documentation style guide as the default
external editorial reference and Microsoft technical-writing guidance as a
supplement. Treat these as guidance, not proof of formal conformance. Do not
copy external standards or style guides into the documentation.

For a formal information-development program, map the workflow and quality
evidence to a licensed copy of ISO/IEC/IEEE 26514:2022. Do not claim ISO
conformance from this house standard or an agent review alone.

## Write in a professional voice

- Address the reader as **you** when giving instructions.
- Prefer active voice, concrete verbs, and present tense.
- Be direct, respectful, calm, and technically precise.
- Use everyday language when it remains accurate. Define necessary specialist
  terms on first use for readers who may not know them.
- Avoid hype, jokes that may not translate, idioms, blame, and false certainty.
- Use contractions only when they fit the confirmed voice.
- Do not use *simple*, *easy*, *obvious*, or *just* to dismiss reader effort.

## Make content scannable

- Use sentence case for titles and headings.
- Put the reader outcome or most important condition first.
- Keep paragraphs focused on one idea.
- Use a list only for genuinely parallel items.
- Use numbered steps only for sequences.
- Introduce tables only when readers need to compare several exact values.
- Use descriptive link text that makes sense out of context. Never use
  *click here*, *here*, or *read more* as the complete link text.
- Keep notes close to the text they qualify. Reserve warnings and dangers for
  material risk rather than general emphasis.

## Keep titles and headings concise

- Write task-page titles with a direct imperative verb. Prefer *Keep
  documentation updated* over *Keeping documentation updated*.
- Aim for 3–7 words and no more than 50 characters in a page title.
- Aim for 2–5 words and no more than 32 characters in a navigation label.
- Aim for 2–7 words and no more than 45 characters in a section heading that
  appears in the page table of contents.
- Shorten a navigation label when needed, but preserve the meaning of the page
  title. Do not repeat the navigation group name in each child label.
- Move qualifications and explanatory detail into the page description or
  opening paragraph.
- For CLI and API reference sections, use only the command, operation, or
  resource name as the heading. Put arguments, options, methods, and paths
  immediately below the heading.
- Treat the length limits as warning thresholds, not hard errors. Keep an exact
  product or interface name when shortening it would make the documentation
  inaccurate.

## Write usable procedures

- State the goal and prerequisites before the first step.
- Begin each step with the reader action.
- Put one primary action in each step.
- Place conditions before the action when they change what the reader must do.
- Keep explanatory asides outside the step sequence when possible.
- Show the observable result after a meaningful action or at the end.
- Provide recovery guidance only when supported by product evidence.
- End with the next useful action, not a generic conclusion.

## Keep terminology stable

- Use the exact names visible in the product UI, CLI, API, and configuration.
- Apply the terminology map in `.doxloop/project.json`.
- Use one preferred term for one concept; do not vary wording for style.
- Expand unfamiliar abbreviations on first use unless the audience brief says
  they are assumed knowledge.
- Preserve capitalization used by public product interfaces.
- Format commands, files, keys, parameters, values, and code identifiers as
  code where the selected generator supports it.

## Support global readers

- Use complete, conventional sentence structures.
- Keep the subject and verb close together.
- Avoid ambiguous pronouns and long chains of clauses.
- Include articles such as *a*, *an*, and *the* when required.
- Use locale-appropriate spelling, dates, numbers, and punctuation from the
  persisted brief.
- Do not encode meaning in wordplay or culturally specific references.

## Exclude editorial noise

Do not include generic introductions, repeated product claims, invented
benefits, internal implementation trivia, unsupported superlatives, redundant
summaries, or prose that exists only to make a page longer.
