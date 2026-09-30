import { describe, expect, test } from 'vitest'
import { editorialIssues, futureTenseIssue, genericOpeningIssue, minimizingLanguageIssue, missingNextStepIssue, titleCaseHeadings } from './editorial.js'

describe('editorial checks', () => {
  test('flag an opening that announces the page, not one that states the outcome', () => {
    expect(genericOpeningIssue('# Title\n\nThis guide shows how to invite a teammate.\n', 'a.mdx')?.code).toBe('generic-opening')
    expect(genericOpeningIssue('import X from "y"\n\n<Note>Hi</Note>\n\nWelcome to Pulse!\n', 'a.mdx')?.code).toBe('generic-opening')
    expect(genericOpeningIssue('Invite a teammate and choose what they can change.\n\nThis guide shows more.\n', 'a.mdx')).toBeUndefined()
    expect(genericOpeningIssue('In this tutorial, you build a board.\n', 'a.mdx')).toBeUndefined()
  })

  test('flag minimizing words but not ordinary uses', () => {
    const issue = minimizingLanguageIssue('Simply click **Save**. Just run `npm test`. The export is easy to read.\n\nIt just works in the background. Use `justify-content`.', 'a.mdx')
    expect(issue?.message).toContain('2 sentences')
    expect(issue?.message).toContain('"Simply click **Save**."')
    expect(minimizingLanguageIssue('Select the just-in-time option. The job is simple to schedule with cron:\n\n```bash\n# simply run it\n```', 'a.mdx')).toBeUndefined()
  })

  test('find Title Case headings, excusing product names and acronyms', () => {
    const body = [
      '## Configure The Webhook Retry Policy',
      '## Configure the webhook retry policy',
      '## Connect to Google Cloud Storage',
      '## Set Up Single Sign On',
      '## Add a Project Owner',
      'Open Project Owner in the sidebar to see the role.',
    ].join('\n\n')
    expect(titleCaseHeadings(body, new Set(['Google', 'Cloud', 'Storage']))).toEqual(['Configure The Webhook Retry Policy', 'Set Up Single Sign On'])
  })

  test('flag future-tense results only when they are the page\'s habit', () => {
    const habit = 'Click Save. The dialog will close. A banner will appear. The list will update.'
    expect(futureTenseIssue(habit, 'a.mdx')?.code).toBe('future-tense')
    expect(futureTenseIssue('Click Save. The dialog will close.', 'a.mdx')).toBeUndefined()
  })

  test('flag a procedure that ends without a way forward', () => {
    const steps = '1. Open Settings.\n2. Choose Members.\n3. Select Invite.\n\n## Verify\n\nThe invitee appears in the list.\n'
    expect(missingNextStepIssue(steps, 'invite.mdx')?.code).toBe('missing-next-step')
    expect(missingNextStepIssue(`${steps}\n## Next steps\n\n- [Change a member's role](/members/roles)\n`, 'invite.mdx')).toBeUndefined()
    expect(missingNextStepIssue(`${steps}\n<CardGroup><Card title="Roles" href="/roles" /></CardGroup>\n`, 'invite.mdx')).toBeUndefined()
    expect(missingNextStepIssue('A concept page with no steps.', 'concept.mdx')).toBeUndefined()
    expect(missingNextStepIssue('No numbered steps here.', 'guide.mdx', 'how-to')?.code).toBe('missing-next-step')
  })

  test('the glossary is exempt', () => {
    expect(editorialIssues('<!-- doxloop:glossary -->\n\nThis page describes terms.\n\n## Some Very Long Title Heading', 'glossary.mdx')).toEqual([])
  })
})
