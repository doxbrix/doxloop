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
| Generation and revision | Unattended run in an isolated proposal workspace | Unattended run in an isolated proposal workspace | Unattended run in an isolated proposal workspace |
| Guide screenshots | Run-scoped Playwright browser passed on the command line | Run-scoped Playwright browser passed on the command line | Run-scoped Playwright browser merged into the workspace's `.gemini/settings.json` and trusted for the run |
| External sources | Read through a sandbox that denies writes | Read through a sandbox that denies writes | **Limited.** Gemini cannot be denied writes to an extra directory, so an unattended run reads a throwaway copy of each local folder (beside the remote snapshots under `.doxloop-sources`) and never sees the real checkout |
| Spending cap | Not available | `--max-budget-usd` from **Maximum Claude spend** | Not available |
| Live activity log | Formatted from `codex exec --json` | Formatted from the stream-json output | Formatted from `--output-format stream-json` |
| Stage progress | From tool calls and file writes | From tool calls and file writes | From tool calls and file writes |
| Sign-in check | `codex login status` | `claude auth status` | **Limited.** Checks for an API key or Vertex AI project in the environment, or the Google sign-in token file; nothing is read beyond presence |
| Validation during a run | Commands allowed by the sandbox | Commands allowed by the sandbox | **Limited.** Only the `doxloop` CLI is pre-approved; other commands need a confirmation an unattended run cannot give |

The same matrix is shown in the setup wizard's **Tools** step and under
**Settings → General**, with **Limited** marking each row where an assistant
is not at parity.

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

For automated tests only, `DOXLOOP_AGENT_EXECUTABLE_CODEX`,
`DOXLOOP_AGENT_EXECUTABLE_CLAUDE`, and `DOXLOOP_AGENT_EXECUTABLE_GEMINI` can
point Doxloop at a fake executable instead of searching `PATH`. Production
workflows should rely on the installed assistant executable.
