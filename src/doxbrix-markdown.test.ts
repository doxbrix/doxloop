import { describe, expect, test } from 'vitest'
import { renderMarkdown } from './doxbrix-markdown.js'

describe('Doxbrix Markdown rendering', () => {
  test('renders native rich components with reader classes', () => {
    const result = renderMarkdown(`# Overview

<Info>Important context.</Info>

<Steps>
<Step title="Install">Run the installer.</Step>
<Step title="Verify">Check the result.</Step>
</Steps>

## Next step

Continue from here.
`)

    expect(result.html).toContain('class="dp-callout callout-info"')
    expect(result.html).toContain('class="dp-steps"')
    expect(result.html).toContain('class="dp-step"')
    expect(result.toc).toEqual([
      expect.objectContaining({ level: 2, title: 'Next step' }),
    ])
  })

  test('supports the canonical Doxbrix media and tab attributes', () => {
    const result = renderMarkdown(`
<Tabs>
<Tab label="macOS">Install locally.</Tab>
</Tabs>

<Image src="/diagram.png" alt="Architecture" caption="Request flow" />
<Video url="https://www.youtube.com/watch?v=example" />
<Embed src="https://example.com/demo" />
<Frame url="https://example.com" title="Live example" />
<File name="openapi.yaml" url="/openapi.yaml" fileType="yaml" />
<Icon emoji="⚡">Fast</Icon>
<Badge color="green">Ready</Badge>
<Card title="Launch" icon="🚀">Begin here.</Card>
<Columns cols="2"><Column>Left</Column><Column>Right</Column></Columns>
<Update type="new" version="2.1.0" date="June 8, 2026">Shipped.</Update>
`)

    expect(result.html).toContain('>macOS</button>')
    expect(result.html).toContain('src="/diagram.png"')
    expect(result.html).toContain('alt="Architecture"')
    expect(result.html).toContain('youtube.com/embed/')
    expect(result.html).toContain('src="https://example.com/demo"')
    expect(result.html).toContain('title="Live example"')
    expect(result.html).toContain('href="/openapi.yaml"')
    expect(result.html).toContain('⚡ Fast')
    expect(result.html).toContain('dp-inline-badge green')
    expect(result.html).toContain('<div class="dp-card-icon">🚀</div>')
    expect(result.html).toContain('class="dp-column"')
    expect(result.html).toContain('new · 2.1.0')
    expect(result.html).toContain('June 8, 2026')
  })

  test('renders a guide screenshot in a captioned frame', () => {
    const result = renderMarkdown(`
<Frame caption="The highlighted control opens the invitation form.">

![Team settings with Invite member marked as step 1](/assets/guides/invite-team-member/01-team-settings.png)

</Frame>
`)

    expect(result.html).toContain('class="dp-image-wrap align-center"')
    expect(result.html).toContain(
      'src="/assets/guides/invite-team-member/01-team-settings.png"',
    )
    expect(result.html).toContain(
      'alt="Team settings with Invite member marked as step 1"',
    )
    expect(result.html).toContain(
      'The highlighted control opens the invitation form.',
    )
  })

  test('renders ApiEndpoint as the native two-column Doxbrix reference', () => {
    const result = renderMarkdown(`
<ApiEndpoint method="GET" path="/projects" baseUrl="https://api.example.com/v1" summary="List projects" description="Returns a page of projects.">
<Param name="Authorization" in="header" type="string" required example="Bearer api_test_example">Bearer token.</Param>
<Param name="limit" in="query" type="integer" example="50">Maximum results.</Param>
<Response status={200} contentType="application/json" description="Projects listed">
{
  "data": [{ "id": "prj_01H9" }]
}
</Response>
<Response status={401} contentType="application/json" description="Authentication failed">
{ "error": "unauthorized" }
</Response>
</ApiEndpoint>
`)

    expect(result.html).toContain('class="dp-api-ref"')
    expect(result.html).toContain('class="dp-api-ref-body"')
    expect(result.html).toContain('Authorizations')
    expect(result.html).toContain('Query Parameters')
    expect(result.html).toContain('Try it ▶')
    expect(result.html).toContain('curl --request GET')
    expect(result.html).toContain(
      'https://api.example.com/v1/projects?limit=50',
    )
    expect(result.html).toContain('Authorization: Bearer api_test_example')
    expect(result.html).toContain('data-api-response-tab')
    expect(result.html).toContain('class="dp-api-resp-status success"')
    expect(result.html).toContain('class="dp-api-resp-status error"')
    expect(result.html).toContain('"id": "prj_01H9"')
  })

  test('preserves body example types and nests dotted parameter names', () => {
    const result = renderMarkdown(`
<ApiEndpoint method="POST" path="/tokens" baseUrl="https://api.example.com/v1" summary="Create token" description="Creates a token.">
<Param name="name" in="body" type="string" required example="Automation">Token name.</Param>
<Param name="expires" in="body" type="integer" required example="1">Expiry choice.</Param>
<Param name="enabled" in="body" type="boolean" example="false">Whether enabled.</Param>
<Param name="scopes" in="body" type="array" example='["read", "write"]'>Token scopes.</Param>
<Param name="metadata" in="body" type="object" example="{}">Metadata.</Param>
<Param name="metadata.owner" in="body" type="string" example="Ada">Owner name.</Param>
<Response status={200} contentType="application/json" description="Token created">
{ "response": "ok" }
</Response>
</ApiEndpoint>
`)

    expect(result.html).toContain('"name": "Automation"')
    expect(result.html).toContain('"expires": 1')
    expect(result.html).toContain('"enabled": false')
    expect(result.html).toContain(
      '"scopes": [\n    "read",\n    "write"\n  ]',
    )
    expect(result.html).toContain(
      '"metadata": {\n    "owner": "Ada"\n  }',
    )
  })
})
