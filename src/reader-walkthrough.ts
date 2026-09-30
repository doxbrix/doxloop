/**
 * Reader walkthrough: an agent plays a first-time reader and follows a guide
 * exactly as written — in the test application through the capture browser
 * when the product has a UI, and against the source for commands, flags,
 * routes, and configuration — then reports every step where a real reader
 * would get stuck, guess, or see something different from what the page says.
 *
 * Validation proves a page is well formed; the claim and example checks
 * prove its facts. Only following it end to end proves it works. The session
 * is read-only (the planner's isolation), so neither the documentation nor
 * the product source can change.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { chooseAgent } from './agents.js'
import { readTaggedJson, type TaggedJsonContract } from './agent-reply.js'
import { captureAuthPrompt, prepareAgentPrompt } from './author.js'
import { captureAuthContext, describeCaptureAuth } from './capture-auth.js'
import { runReadOnlyAgentSession } from './documentation-plan.js'
import { DoxloopError } from './errors.js'
import { listPages, type PageSummary } from './pages.js'
import { loadProject, projectDefaultModel } from './project.js'
import type { AgentName, DocumentationPlanExecution } from './types.js'

export const WALKTHROUGH_FILE = join('.doxloop', 'cache', 'walkthroughs.json')

export type WalkthroughOutcome = 'done' | 'stuck' | 'unclear' | 'different' | 'not-tried'

export interface WalkthroughStep {
  page: string
  /** The instruction as the page words it, shortened. */
  step: string
  outcome: WalkthroughOutcome
  /** What the reader saw or needed. */
  observation: string
  /** The smallest change to the page that would have prevented the problem. */
  fix?: string
}

export interface WalkthroughReport {
  pages: string[]
  checkedAt: string
  agent: AgentName
  /** Whether the reader reached the guide's stated outcome. */
  completed: boolean
  /** 0–100: how confidently a first-time reader finishes with only these pages. */
  score: number
  summary: string
  /** Knowledge the pages assume without stating it. */
  missingPrerequisites: string[]
  steps: WalkthroughStep[]
  /** Whether the application was followed in a browser or only read. */
  usedApplication: boolean
}

const OUTCOMES = new Set<WalkthroughOutcome>(['done', 'stuck', 'unclear', 'different', 'not-tried'])

const CONTRACT: TaggedJsonContract = {
  tag: 'doxloop-walkthrough',
  accept: (value) => Boolean(value && typeof value === 'object' && Array.isArray((value as { steps?: unknown }).steps)),
  attempted: (text) => /"steps"\s*:/.test(text),
  noun: 'walkthrough',
}

/** Guides a new reader starts with: quickstarts, installation, getting started, first tutorials. */
export function defaultWalkthroughPages(pages: PageSummary[]): PageSummary[] {
  const starter = /(?:quick-?start|getting-started|get-started|first-steps|installation|install|setup|tutorial|onboarding)/i
  const picked = pages.filter((page) => starter.test(page.path) || starter.test(page.title))
  return (picked.length > 0 ? picked : pages.filter((page) => page.inNavigation)).slice(0, 2)
}

export function walkthroughPrompt(input: { pages: PageSummary[]; application?: string; productName: string; signIn?: string }): string {
  // Without the saved sign-in a Memos walkthrough failed to log in and made
  // itself a new account through Sign up; the reader is a new reader of the
  // docs, not of the application's account system.
  const browser = input.application
    ? `The product's test application runs at ${input.application}. Follow every UI instruction there with the capture browser tools, exactly as written: find the named navigation, buttons, fields, and labels, and compare what you see with what the page says you should see. When a step asks you to sign in, use the saved test account: ${input.signIn ?? 'no sign-in material is saved, so report the step as not-tried.'} Never create accounts, sign up, or reset passwords to get past a sign-in, even when a page describes how. Creating the items a guide tells you to create is fine; never delete data you did not create, change account or security settings, invite real people, or send email.`
    : 'There is no test application, so follow UI instructions by checking the product source for the named screens, labels, and results.'
  return `You are testing documentation as a first-time reader of ${input.productName}. You have never used the product and you know only what these pages tell you.

Pages to follow, in order (files in this folder):
${input.pages.map((page, index) => `${index + 1}. ${page.path} — ${page.title}`).join('\n')}

Read each page once, top to bottom, then follow it step by step. ${browser}

For commands, flags, environment variables, configuration keys, API requests, and file paths: do not run anything. Check each against the product source (the configured source folders are readable) to decide whether it would work as written — the command or flag exists, the route answers the method, the key is read by the code, the default the page states is the default in the code.

Report as a reader, not as an editor:
- "done": the step worked and you knew what to do.
- "stuck": you could not continue (a missing prerequisite, a control that does not exist, a command that would fail).
- "unclear": you could continue only by guessing (an unnamed field, an ambiguous value, an undefined term).
- "different": it worked, but what you saw differs from what the page says (a renamed button, another default, a different result).
- "not-tried": you could not attempt it safely (destructive, needs a paid account, needs real credentials).
Also list knowledge the pages assume but never state (an account, an installed tool, a role, a concept).

When you finish, reply with only this JSON inside <doxloop-walkthrough></doxloop-walkthrough> tags:
{"completed": true|false, "score": 0-100, "summary": "two sentences a writer can act on", "missingPrerequisites": ["…"], "usedApplication": true|false, "steps": [{"page": "<file>", "step": "<the instruction, shortened>", "outcome": "done|stuck|unclear|different|not-tried", "observation": "<what you saw or needed>", "fix": "<the smallest change to the page, when not done>"}]}
Score how confidently a first-time reader finishes with only these pages: 90+ finishes without help, 70–89 finishes with guessing, below 70 does not finish. Report every step, including the ones that worked, in order.`
}

function text(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback
}

/** The agent's reply as a report, with anything malformed dropped rather than trusted. */
export function normalizeWalkthrough(value: unknown, pages: string[], agent: AgentName): WalkthroughReport {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  const steps = (Array.isArray(raw.steps) ? raw.steps : []).flatMap((item): WalkthroughStep[] => {
    const step = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>
    const outcome = text(step.outcome) as WalkthroughOutcome
    if (!OUTCOMES.has(outcome) || !text(step.step)) return []
    const fix = text(step.fix)
    return [{ page: text(step.page, pages[0] ?? ''), step: text(step.step).slice(0, 300), outcome, observation: text(step.observation).slice(0, 600), ...(fix && outcome !== 'done' ? { fix: fix.slice(0, 600) } : {}) }]
  })
  const score = Number(raw.score)
  return {
    pages,
    checkedAt: new Date().toISOString(),
    agent,
    completed: raw.completed === true,
    score: Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : 0,
    summary: text(raw.summary).slice(0, 800),
    missingPrerequisites: (Array.isArray(raw.missingPrerequisites) ? raw.missingPrerequisites : []).map((item) => text(item)).filter(Boolean).slice(0, 12),
    steps,
    usedApplication: raw.usedApplication === true,
  }
}

export async function readWalkthroughs(root: string): Promise<Record<string, WalkthroughReport>> {
  try {
    const value = JSON.parse(await readFile(join(root, WALKTHROUGH_FILE), 'utf8')) as Record<string, WalkthroughReport>
    return value && typeof value === 'object' ? value : {}
  } catch {
    return {}
  }
}

/** The latest report that covered a page. */
export async function walkthroughForPage(root: string, page: string): Promise<WalkthroughReport | undefined> {
  const all = Object.values(await readWalkthroughs(root)).filter((report) => report.pages.includes(page))
  return all.sort((left, right) => right.checkedAt.localeCompare(left.checkedAt))[0]
}

async function saveWalkthrough(root: string, report: WalkthroughReport): Promise<void> {
  const all = await readWalkthroughs(root)
  all[report.pages.join('|')] = report
  const path = join(root, WALKTHROUGH_FILE)
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(all, null, 2)}\n`, 'utf8')
}

export interface WalkthroughOptions {
  pages?: string[]
  agent?: AgentName
  model?: string
  /** Test seam: replaces the agent session. */
  runSession?: (prompt: string, browser: boolean) => Promise<string>
}

export async function runReaderWalkthrough(root: string, options: WalkthroughOptions = {}): Promise<WalkthroughReport> {
  const project = await loadProject(root)
  const all = await listPages(root)
  const chosen = options.pages?.length
    ? options.pages.map((path) => {
        const page = all.find((item) => item.path === path)
        if (!page) throw new DoxloopError(`${path} is not a documentation page in this project.`, 2)
        return page
      })
    : defaultWalkthroughPages(all)
  if (chosen.length === 0) throw new DoxloopError('This project has no pages to walk through yet.', 2)
  const selected = await chooseAgent(options.agent ?? project.defaultAgent)
  const application = project.application?.baseUrl
  const signIn = application ? captureAuthPrompt(describeCaptureAuth(await captureAuthContext(root))) : undefined
  const prompt = walkthroughPrompt({ pages: chosen, ...(application ? { application } : {}), ...(signIn ? { signIn } : {}), productName: project.title })
  const model = options.model ?? projectDefaultModel(project, selected.name)
  const execution: DocumentationPlanExecution = {
    agent: selected.name,
    ...(model ? { model } : {}),
    screenshots: application ? 'auto' : 'disabled',
    limits: { maxPages: chosen.length, maxScreenshots: 0, maxMinutes: 20 },
  }
  let raw: string
  if (options.runSession) {
    raw = await options.runSession(prompt, Boolean(application))
  } else {
    const prepared = await prepareAgentPrompt(root, prompt)
    try {
      raw = await runReadOnlyAgentSession(root, selected, prepared.argument, execution, project, { browser: Boolean(application), label: 'reader walkthrough' })
    } finally {
      if (prepared.path) await rm(prepared.path, { force: true })
    }
  }
  const reply = readTaggedJson(raw, selected.name, CONTRACT, prompt)
  if (!reply) throw new DoxloopError('The walkthrough ended without a report. Open the log to see where the reader stopped, then try again.')
  const report = normalizeWalkthrough(reply.value, chosen.map((page) => page.path), selected.name)
  await saveWalkthrough(root, report)
  return report
}

/** An agent instruction that fixes what the reader ran into on one page. */
export function walkthroughFixRequest(report: WalkthroughReport, page: string): string | undefined {
  const problems = report.steps.filter((step) => step.page === page && step.outcome !== 'done' && step.outcome !== 'not-tried')
  const prerequisites = report.missingPrerequisites
  if (problems.length === 0 && prerequisites.length === 0) return undefined
  return [
    'A first-time reader followed this page and ran into the problems below. Fix each one from the product evidence (not by adding hedges or generic advice), keeping everything that worked unchanged.',
    ...problems.map((step) => `- ${step.outcome}: "${step.step}" — ${step.observation}${step.fix ? ` Suggested fix: ${step.fix}` : ''}`),
    ...(prerequisites.length > 0 ? [`- Unstated prerequisites: ${prerequisites.join('; ')}. State the ones that apply before the first step.`] : []),
  ].join('\n')
}
