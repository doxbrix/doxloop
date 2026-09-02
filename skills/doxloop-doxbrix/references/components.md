# Doxbrix component syntax

Use standard Markdown for headings, prose, links, lists, tables, blockquotes,
images, and fenced code. Use these MDX components when they improve the reader
experience.

## Procedures and alternatives

```mdx
<Steps>
<Step title="Install the CLI">
Run the installer and verify the executable.
</Step>
<Step title="Authenticate">Run `tool login`.</Step>
</Steps>
```

A `<Step>` renders full block content, so a step's screenshot belongs inside
that step — never collected after the `<Steps>` block. Put the image directly
under the instruction it proves:

```mdx
<Steps>
<Step title="Open the control center">
Open the Overview screen at `/`.

<Frame caption="The Overview dashboard lists every workflow stage.">
![Doxloop Overview showing the documentation workflow](/assets/guides/quickstart/01-overview.png)
</Frame>
</Step>
<Step title="Start an authoring request">
Select **Update** and describe a reader outcome.

<Frame caption="The Update form captures the reader outcome.">
![Doxloop Update documentation form](/assets/guides/quickstart/02-update.png)
</Frame>
</Step>
</Steps>
```

````mdx
<CodeGroup>
```bash npm
npm install package
```
```bash pnpm
pnpm add package
```
</CodeGroup>
````

```mdx
<Tabs>
<Tab label="macOS">Install with Homebrew.</Tab>
<Tab label="Windows">Download the installer.</Tab>
</Tabs>
```

`<Tab title="…">` is also accepted for compatibility. Do not use Docusaurus
`<TabItem>` inside Doxbrix tabs.

## Callouts

```mdx
<Info>Neutral supporting information.</Info>
<Note>Context the reader should remember.</Note>
<Tip>A useful best practice.</Tip>
<Check>A successful result or confirmation.</Check>
<Warning>A risk the reader can avoid.</Warning>
<Danger>A destructive or critical consequence.</Danger>
```

## Navigation and disclosure

```mdx
<CardGroup cols="2">
<Card title="Quickstart" icon="🚀" href="/quickstart">Get started.</Card>
<Card title="Configuration" icon="⚙️" href="/configuration">Choose settings.</Card>
</CardGroup>
```

```mdx
<Accordion>
<AccordionItem title="Can I change this later?">Yes.</AccordionItem>
</Accordion>

<Expandable title="Show advanced options">Advanced details.</Expandable>
```

## Layout and visual blocks

```mdx
<Columns cols="2">
<Column>Left content.</Column>
<Column>Right content.</Column>
</Columns>

<Terminal>$ npm run build</Terminal>
<Badge color="green">New</Badge>
<Icon emoji="⚡" size="lg">Fast</Icon>
```

## Media, updates, diagrams, and API reference

```mdx
<Image src="/images/flow.png" alt="Request flow" caption="How requests move" />
<Frame caption="The highlighted control opens the invitation form.">

![Team settings with the Invite member control highlighted](/assets/guides/invite-team-member/01-team-settings.png)

</Frame>
<Video url="https://example.com/video" />
<Embed src="https://example.com/demo" />
<Frame url="https://example.com" title="Live example" />
<File name="report.pdf" url="/files/report.pdf" fileType="pdf" />

<Update type="new" version="2.1.0" date="June 8, 2026">
Shipped the new workflow.
</Update>

<Mermaid>
graph TD; A[Start] --> B[Complete];
</Mermaid>

<Math>e = mc^2</Math>
```

```mdx
<ApiEndpoint method="POST" path="/users" baseUrl="https://api.example.com" summary="Create a user">
<Param name="name" in="body" type="string" required>Display name</Param>
<Response status={200} contentType="application/json" description="Created">
{ "id": "u_123" }
</Response>
</ApiEndpoint>
```

For API reference pages, read [api-endpoints.md](api-endpoints.md). Its complete
page contract and example are required; this compact component catalog example
is not a sufficient endpoint page by itself.

Also supported: standalone `<Card>`, `<AccordionItem>`, `<AccordionGroup>`, and
`<Excalidraw>`.

For standalone API blocks:

```mdx
<ParameterTable title="Query parameters">
<Param name="limit" in="query" type="number">Maximum results.</Param>
</ParameterTable>

<ResponseExample>
<Response status="200" contentType="application/json" description="Success">
{ "ok": true }
</Response>
</ResponseExample>
```

Never invent a component outside this catalog. After adding a rich component,
inspect that component in `doxloop preview`; balanced tags alone do not prove
that its attributes or content are correct.
