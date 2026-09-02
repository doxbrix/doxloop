# Agent compatibility

Doxloop works with Codex, Claude Code, and Gemini CLI. It discovers the
executables installed on the machine and lists all three wherever you choose a
coding assistant: the **Tools** step of the setup wizard, the **Planning
agent** field on the Create and Update pages, and **Default documentation
agent** under **Settings → General**.

Selecting an assistant that is not installed offers to install its official
npm package globally. Doxloop verifies that the new executable is available and
then continues. The agent uses its own existing sign-in; Doxloop never accepts
or stores a model API key.

## Invocation modes

| Workflow | Codex | Claude Code | Gemini CLI |
| --- | --- | --- | --- |
| Planning | Read-only research run | Read-only research run | Read-only research run |
| Generation and revision | Interactive prompt in an isolated proposal workspace | Interactive prompt in an isolated proposal workspace | Interactive prompt in an isolated proposal workspace |
| Guide screenshots | Run-scoped Playwright browser | Run-scoped Playwright browser | Not available |

Planning may pause for consolidated reader or scope decisions; these appear
under **Needs your decision** on the plan, and the **Planner questions**
setting controls whether the planner asks in review, uses recommendations, or
always waits for answers.

The **Model** field forwards the chosen model using each assistant's native
model option. Reasoning effort is available for Codex and Claude Code; the
picker limits the choices to the values the selected model supports.

## Project skills

Creating a workspace installs the shared authoring skill and the selected
generator's format skill under `.agents/skills` for Codex and Gemini and
`.claude/skills` for Claude Code. Every planning and generation run checks
those skills against the packaged version and refreshes them when the package
was upgraded. A skill with local edits is not overwritten silently: the run
stops with a message naming the changed directory. Delete or restore that
directory and start the run again.

## Compatibility policy

Agent CLIs evolve independently. Release checks validate argument
construction, and optional real-agent evaluations exercise installed
assistants. A release should record the tested versions in its release notes.
When a run fails as soon as the assistant starts, open **Open full log** in
**Live activity** to see the assistant's own output, then confirm the
installed version by running the assistant directly.
