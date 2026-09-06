# Troubleshoot Doxloop

## The control center does not open

Doxloop requires Node.js 22.13 or later. If the browser does not open
automatically, visit `http://127.0.0.1:4317` yourself. If another process is
using that port, start Doxloop on a different one:

```bash
doxloop ui --port 4400
```

The control center opens the setup wizard when the current folder is not a
documentation project, and the workspace when it is. To open an existing
workspace, start Doxloop inside that documentation folder.

## The wizard rejects the workspace folder

Enter a folder name, not a path. The folder is created inside the directory
where you started Doxloop and must not already exist. A documentation project
also cannot be the same as, inside, or contain a connected source folder, so
start Doxloop from the parent folder of your product rather than from inside
it.

## A source cannot be connected

On the **Sources** page, choose **Test connection** to see the exact reason.
Local folders must exist and be outside the documentation project. Git
repositories need a reachable URL and branch; private repositories need a
username and personal access token with read access. OpenAPI URLs must be
public, credential-free HTTP or HTTPS addresses that return a valid OpenAPI 3.x
or Swagger 2.0 document; see the
[remote OpenAPI safety policy](./openapi-security.md). Upload the file instead
when the specification is not publicly reachable.

## No coding assistant is available

Choose Codex, Claude Code, or Gemini in the wizard's **Tools** step or in the
**Planning agent** field. If it is not installed, Doxloop offers to install
it. After installation, sign in to the assistant once in a terminal so it can
run without prompting; Doxloop never stores model API keys.

## A run stops because an installed skill was modified

Doxloop refreshes the project-local authoring skills before each run and will
not overwrite a skill with local edits. The run's **Live activity** log names
the changed directory under `.agents/skills` or `.claude/skills`. Delete or
restore that directory and start the run again; Doxloop reinstalls the
packaged version.

## An external generator cannot build

External generators need their adapter package and native toolchain. Run a
**Dry run** on the **Deploy** page: it performs the generator's strict build
without uploading and reports the failing command. Native generators may
require Python, Ruby, Hugo, or Node dependencies in addition to the adapter.

## Validation warns that navigation was not verified

`navigation-unverified` means the generator's sidebar or menu is produced by
something Doxloop cannot read statically: a Hugo or Jekyll theme, a MkDocs
navigation plugin, a Starlight plugin, a VitePress or Starlight sidebar built
by a function or imported from another file, or a Sphinx `autosummary`
toctree. It is a warning, not an error, and it replaces the false
"unnavigated page" errors those sites used to get. Run **Dry run** on the
Deploy page, which performs the generator's strict build, to confirm every
page is reachable. To turn the warning into real checks, list the navigation
in the generator's own configuration file instead of building it in code.

## The wizard says a generator's tools are missing

The **Tools** step checks the runtime the selected generator needs: Node.js
20.12 or later with npm, pnpm, or yarn; Python 3.9 or later with the `venv`
module; the `hugo` binary; or Ruby with Bundler. The project can still be
created, because the adapter package installs with npm, but **Preview docs**
and the strict build fail until the tool is installed. Install it, then choose
**Check again**. The check runs on the machine where `doxloop ui` runs, not on
the machine whose browser shows the control center.

## A plan cannot be approved

**Approve & generate** stays disabled while questions remain under **Needs
your decision**, while a required screenshot page is missing its starting
route or capture details, or while screenshots are required and the
configured application is not reachable. Resolve each item, or change the
run's screenshot mode to **Automatic** or **No screenshots**.

A change to a connected source after the planner read it does not block
approval. The plan review notes that sources changed, the structure is
approved as proposed, and generation reads the current sources when it writes
each page. Choose **Ask the agent to revise** only when the change should
alter which pages are written.

## A button stays on "Working…"

The control center waits at most two minutes for a local request and then
reports that the server did not respond. If that happens, check the terminal
where `doxloop ui` is running: a stopped or crashed server needs to be started
again, and a run that was interrupted can be retried from its last durable
stage under **Recent activity**.

## Planning stopped after 20 minutes

The planner has a time budget so a run that never answers becomes a named
failure rather than a silent hang. The plan shows **Planning stopped after
20 minutes without a plan reply** and can be retried. Raise **Maximum agent
minutes** under **Monitoring → Advanced watch scope and budgets** when the
product genuinely needs longer research, or set `DOXLOOP_PLAN_TIMEOUT_MINUTES`
in the environment that starts `doxloop ui` to change the planning budget
alone. A planning run that is stopped is ended together with any capture
browser it opened.

## Stop leaves the workspace changing

Stopping a run ends the agent and the capture browser it started within ten
seconds. If files still change in the run workspace afterwards, the agent
process was started outside Doxloop's control, for example from a terminal
where `doxloop create` was run interactively; close that terminal session to
end it.

## A run fails after the agent already did most of the work

A generation run can stop after the pages are written, for example when
required screenshots were not captured for every guide, when the agent hit its
time budget, or when validation found a problem. Doxloop keeps that run's
isolated workspace, so nothing the agent wrote or captured is lost. The plan
review shows **Continue without starting over** with the choices that apply:

- **Resume generation** starts the agent again inside the same workspace with
  a brief of what is already finished: which pages exist, which screenshots
  are verified, and why the previous run stopped. Verified screenshots and
  completed pages are kept; only the unfinished or rejected parts are redone.
- **Ignore problems & continue** accepts the generated files for review as
  they are. Every screenshot problem is recorded on its manifest step as
  text-only, broken image references are removed from the page, and the
  proposal shows how many problems were ignored so you can judge them before
  publishing.
- **Retry generating** in the footer starts a new run from the approved plan.
  Use it when the workspace itself is unusable.

The same two actions appear on a failed proposal under **Review**. When the
planner itself fails a planning gate but proposed real pages, the plan review
offers **Review this plan anyway**, which opens that plan for editing and
approval with the unmet gate shown as a note.

Source code that changed after the run stopped never blocks either
continuation. The proposal carries a note that sources changed, a resumed agent
re-checks the pages it touches against the current sources, and the proposal's
evidence snapshot is refreshed so it can be accepted.

## The run reports a Claude API error

Claude's own API request can break off mid-response: the log shows a line such
as `API Error: Server error mid-response`, `overloaded`, or a rate limit, and
Claude exits. Nothing in the documentation task caused this, and the agent's
session is intact, so Doxloop resumes that session in the same workspace after
a short pause, up to twice per run. The log shows **Resuming the same session
(attempt 1 of 2)**, and the agent continues with its context, keeping every
page and screenshot it already produced.

The run fails only when every resume fails too. The message then names the
API error and how many resumes were tried. Use **Resume the run** under
**Continue without starting over** once the API is available again; it
starts the agent in the same workspace with a brief of what is finished, so
completed pages and verified screenshots are not paid for twice. Do not use
**Retry generating**, which starts a new run from the plan and captures
everything again.

Set `DOXLOOP_AGENT_API_RESUMES` in the environment Doxloop runs in to change
how many automatic resumes a run gets; `0` disables them.

## Generation finishes but nothing changed

Generation never edits the documentation directly. Open **Review** to inspect
the proposal and accept its changes. The **Overview** page shows **Needs your
review** whenever a proposal is waiting.

## Accepting a change reports a conflict

A file was edited outside Doxloop while the proposal was pending. Doxloop
compares the original fingerprint before writing and stops rather than
overwriting your edit. Review the current file, then use **Ask agent to
revise** to regenerate the affected page against the new content, or edit the
page directly in the proposal.

## Guide screenshots are missing

Application screenshots are captured during generation, not during planning.
Enable them with **Add product screenshots?** on the Create or Update page, or
set the policy under **Settings → Visual evidence**. Configure the
**Application base URL**, a **Ready path**, and a safe **Default starting
route**, then choose **Test application** to confirm the page is reachable.

If the selected assistant has no browser capability, the application is
unreachable, or safe test data is unavailable, Doxloop keeps the text guide
complete and omits broken image links.

When **Test application** reports **Sign-in needed**, open **Application
sign-in** on the same page. **Sign in with browser** opens a Chrome window where
you sign in by hand, including MFA or SSO; choose **Save session** once the
signed-in screen is showing, and every capture run starts with that session
loaded. For a plain username and password form you can instead save a test
account's credentials; the agent fills the form by secret name and never sees
the values. A **saved browser session has expired** message means the
application no longer accepts the recorded session: sign in with the browser
again. Both are stored on your computer outside the project, never in the
repository. Never provide production credentials or customer data for
screenshot capture.

## Monitoring does not run

Open **Sources → Monitoring**. Every source type can be scheduled: a Git
repository through its provider, a local folder in place. On macOS, Doxloop
tests the scheduled job in the real scheduler context when you choose **Save
and install** and reports whether the background process can find the coding
assistant. Choose **Check now** to run one cycle immediately; a notice reports
its result and the full log is under **Recent activity** on the Overview page.

A local folder without Git history reports "no sync baseline" until the first
accepted update records one. Run **Update** once so later checks can compare
the folder's files against that baseline.

## Deployment fails

Deployment stops when validation reports errors. Open **Review** to see the
errors on the affected files, or run **Dry run** on the **Deploy** page for
the full validation and build output. If sign-in fails, choose **Sign out**
and **Sign in with browser** again; the Doxbrix API requires HTTPS and does not
follow redirects. **Deployment history** on the same page keeps the outcome of
every attempt.

## Preview shows stale content

**Preview docs** serves the accepted documentation, not a pending proposal.
Use **Preview documentation** on the Review page to see a proposal before you
accept it. The local preview runs on port 4321; close any other server using
that port.
