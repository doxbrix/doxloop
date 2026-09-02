# Page depth and polish contract

Apply this contract to every page you create or rewrite. It defines what
"complete" means for each page type, so that a page is never a title, one
paragraph, and a single image. Doxloop measures depth deterministically:
`doxloop test` reports `thin-page` when a page has too little prose and
`thin-procedure` when a guide has fewer than three real steps. Resolve every
one of those warnings on a page in scope before you finish.

The contract sets a floor, not a word target. Never pad a page with repeated
claims, generic introductions, or invented behavior to satisfy it. When the
evidence supports only a paragraph, merge that material into a page that can be
complete and remove the thin page from navigation.

## Every page

- Open with what the reader will accomplish or understand, in one or two
  sentences, before any heading.
- State prerequisites, required access, and the starting state before the
  reader needs them.
- Use exact product labels, commands, file names, and values.
- Show observable results: what the reader sees after a meaningful action.
- End with the next useful action as a link or a small card group, never a
  generic conclusion.
- Use the generator's native components where they make the page clearer:
  ordered steps for procedures, tabs for alternatives (UI and CLI, operating
  systems, agents), code groups for equivalent commands, callouts for
  prerequisites, results, risks, and tips, accordions for questions and
  edge cases, frames for screenshots, cards for onward navigation.
- Keep the page scannable: short paragraphs, sentence-case headings, tables
  only when readers compare exact values.

## Landing page (site root)

The landing page is the reader's first impression. It must orient every
confirmed audience and route each one to a first task.

Required modules, in order:

1. A one-sentence value statement and a short paragraph that says what the
   product is, who it is for, and what problem it removes.
2. **Choose your path**: a card group with one card per confirmed audience or
   primary reader job, each linking to that reader's first page.
3. **What you can do**: a capability grid or list that covers every planned
   capability group with one sentence and a link.
4. **How it works**: a lifecycle diagram (Mermaid or an evidence-backed image)
   or a numbered overview of the primary workflow.
5. **Where to go next**: cards for installation, quickstart, the core concept,
   and the main reference.

Aim for 300–500 words of prose plus components. Never leave the landing page as
a bare bullet list.

## Getting started and quickstart

Lead the reader from a clean state to one verified meaningful result.

- State the result, the supported environment, and the time or effort only
  when evidence supports it.
- List prerequisites with verification commands and expected output.
- Install or connect using the canonical supported method; use tabs or code
  groups for platform or package-manager alternatives.
- Walk through the smallest complete workflow in ordered steps. Every step
  names the action, the exact command or control, and the observable result.
- Show the success state explicitly (a `Check` callout, expected output, or a
  screenshot of the finished state).
- Include recovery for evidenced common failures.
- Link to the next task, the core concept, and the main reference.

Minimum: 5 steps, 350 words of prose.

## How-to guide and user-interface workflow

One reader job per page, written so an informed reader completes it without
guessing.

Required sections:

1. Outcome statement and when to use this guide.
2. **Before you begin**: prerequisites, required role or sign-in, and starting
   state.
3. **Steps**: ordered steps, one primary action each. Each step names the exact
   control or command, the values to enter with safe example data, and the
   visible result. Explain consequential choices before the action that makes
   them.
4. **Verify**: how the reader confirms success.
5. **Troubleshooting** or **Limitations**: evidence-backed failure states and
   recovery, or documented limits. Omit only when the evidence has none.
6. **Next steps**: the next likely job.

For a screenshot-enabled guide, every step that changes what is on screen
carries its own captured image inside that step: the entry screen, each opened
dialog, drawer, tab, or expanded section, the filled form, and the result. A
guide whose steps open four screens embeds four images. Keep every instruction
and value in text so the page is complete without the images.

When the same job can be done in the UI and the CLI, document the primary path
in full and provide the alternative in a tab or a short section with the exact
command.

Minimum: 3 steps (normally 5–9), 350 words of prose.

## Tutorial

Teach a complete workflow while introducing concepts in the order the reader
needs them. Apply the how-to contract, then also:

- state what the reader will learn and build;
- keep the path controlled with no optional branches before success;
- introduce each concept in one or two sentences at the moment it is needed;
- end with a working result the reader can inspect and a recap of what they
  learned.

Minimum: 5 steps, 500 words of prose, one image per screen-changing step when
screenshots are enabled.

## Concept and architecture

Explain a mental model, lifecycle, or boundary the reader needs to make
decisions.

- Open with the decision or confusion the concept resolves.
- Include a diagram (Mermaid) or a structured comparison table when the model
  has stages, states, or relationships.
- Explain each element, its consequences, and the observable behavior that
  reveals it.
- Cover the edge cases and tradeoffs the evidence supports.
- Link to every task and reference page that applies the concept.

Minimum: 300 words of prose.

## Reference

Cover the complete public surface within the page's stated scope. Partial
reference is worse than none because readers assume it is complete.

- CLI reference: every command in scope with a one-line purpose, usage line,
  every option with type, default, and meaning, exit codes, and at least one
  realistic example. Use one heading per command.
- Configuration reference: every field in scope with type, default, allowed
  values, effect, and an example. Group by object and show a complete example
  file.
- API reference: follow the generator's endpoint contract for every operation.
- State versions, limits, and deprecations when the evidence records them.

Minimum: every item in the stated scope; no "run --help for details"
substitutes for the reference itself.

## Troubleshooting

- One entry per evidenced symptom, headed by the symptom in the reader's words.
- For each entry: cause, exact diagnostic command or check, fix, and how to
  confirm recovery.
- Start with the least invasive diagnostic and link to the relevant guide.

Minimum: 5 entries when the evidence supports them, 300 words of prose.

## Professional finish

Before you finish a page, confirm all of these:

- The reader outcome is in the first two sentences.
- No step combines two actions or omits its visible result.
- Every screenshot sits inside the step it proves and has descriptive alt text.
- Every command, option, label, and value is traceable to evidence.
- Tabs, callouts, cards, and accordions are used where they clarify, not to
  decorate.
- The page ends with a next step.
- `doxloop test` reports no `thin-page`, `thin-procedure`, or
  `starter-content` finding for the page.
