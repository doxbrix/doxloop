# Agent compatibility

Doxloop supports Codex, Claude Code, and Gemini CLI. It discovers executables on
`PATH` or accepts an explicit `--agent`.

Interactive authoring always lists all three agents. Selecting one that is not
on `PATH` installs its official npm package globally, verifies that the new
executable is available, and then continues the run. Explicit `--agent` usage
remains non-interactive and expects the selected CLI to already be installed.

## Invocation modes

| Workflow | Codex | Claude Code | Gemini CLI |
| --- | --- | --- | --- |
| Create/update | Interactive prompt | Interactive prompt | Interactive `-i` prompt |
| Review | Read-only ephemeral execution | Print with plan permissions | Plan approval mode |
| External IDE | `--print` prepared prompt | `--print` prepared prompt | `--print` prepared prompt |

Review is deliberately non-interactive so it can remain read-only. Create may
pause once for consolidated reader or scope decisions.

Doxloop forwards `--model` using each CLI's native model option. The
`--reasoning` option is Codex-only; supported levels depend on the selected
model. Doxloop's UI limits the reasoning picker to that model's supported
values.

## Project skills

Initialization installs the shared authoring skill and selected format skill
under `.agents/skills` for Codex and Gemini and `.claude/skills` for Claude
Code. Use:

```bash
doxloop agent status
doxloop agent update
```

`review` does not install or replace skills because that would mutate the
project. Run `doxloop agent setup` before review if skills were removed.

## Compatibility policy

Agent CLIs evolve independently. Release checks validate argument construction,
and optional real-agent evaluations exercise installed CLIs. A release should
record the tested CLI versions in its release notes. When an invocation fails,
run the agent directly to confirm its installed version and then use
`doxloop create --print` as a version-independent fallback.
