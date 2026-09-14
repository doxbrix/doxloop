# Rewrite existing documentation

Doxloop can start from the documentation you already publish. Add the site's
address as an **Existing documentation** source, on its own or next to source
code and API specifications. The agent audits the existing pages, verifies
them against your product sources, and rewrites them as a new professional
documentation set that you review page by page and deploy to Doxbrix.

## Add the site

1. Start `doxloop ui`. In the setup wizard's **Sources** step, or on the
   **Sources** page of an open workspace, choose **Add source** → **Existing
   documentation**.
2. Enter the public address of the documentation, for example
   `https://docs.example.com` or a section such as
   `https://example.com/docs/`. The address sets the crawl scope: only pages
   under that path on the same host are read.
3. Choose **Crawl site**. Doxloop discovers pages through the site's
   `sitemap.xml`, `llms.txt`, and the links between pages, converts each page
   to Markdown, and shows how many pages and words it read, the generator it
   detected, sample titles, and any broken links or skipped URLs.
4. Choose **Add source**. Add product code or an OpenAPI specification as
   further sources when you have them; they decide the facts.

From the command line, `doxloop init my-docs --docs https://docs.example.com
--source product=../my-app` and `doxloop create --docs <url> --output <dir>`
do the same.

Doxloop reads the site as a visitor. It executes no scripts, follows
`robots.txt`, stops after three redirects, limits pages to 2 MB, and reads at
most 150 pages by default (500 at most). Only public HTTP(S) addresses are
accepted; localhost and private networks are refused. A documentation site
behind the same sign-in as the captured application reuses the browser
session recorded under **Application sign-in**; the cookies are matched by
domain, so an unrelated site receives nothing.

## What the agent does with it

The crawled pages become a read-only snapshot beside your other materialized
sources, outside the documentation project, so the old content can never be
published by accident. The snapshot holds one Markdown file per page with its
original URL, plus an `index.md` that lists every page.

During planning the agent audits the existing documentation and the plan shows
the result under **Existing documentation audit**:

- **Not covered today** — product surfaces found in your source code that the
  existing documentation never explains. Each gets a planned page.
- **Contradicted by the product** — existing claims your sources disprove. The
  rewrite corrects them.
- **Obsolete** — pages or claims about behavior the product no longer has.
- **Kept from the existing docs** — knowledge code cannot show (policies,
  environment notes, support-born troubleshooting) that the rewrite carries
  over.
- **Findings** with a severity, and a decision for every crawled page:
  rewrite, merge into a planned page, preserve, or drop with the reason.

Approve, edit, or send the plan back for revision as usual. When you approve,
Doxloop records a redirect from every existing page route to the page that
absorbs it, so the preview and the Doxbrix build honor the old addresses.

## With and without product sources

With source code or an API specification connected, the product decides the
facts. The agent writes corrected facts, never repeats a contradicted claim,
and lists every correction in its summary.

With only the documentation site connected, the agent restructures, clarifies,
deduplicates, and deepens what the existing pages already say, but does not
add facts they do not support. Every page is recorded with `inferred`
confidence and shows as unverified until you connect a product source and run
an update, which verifies the claims against the code.

## Keep the snapshot current

The snapshot is frozen at crawl time. On the **Sources** page, the globe
action re-crawls the site; the next update names the existing pages that
changed since the last crawl so the agent can decide whether the rewritten
documentation must follow. A stale snapshot on disk shows as **Needs
attention** in the source's status.
