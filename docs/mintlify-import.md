# Import Mintlify documentation

Doxloop converts an existing Mintlify project into a new Doxbrix documentation
workspace. Docusaurus, MkDocs, and other supported generators continue to use
their native existing-site adoption flow.

## Select and convert

1. Start `doxloop ui`.
2. In setup, choose **Use existing documentation folder**, then **Mintlify to
   Doxbrix**. From an open workspace, use the project switcher → **Import
   existing documentation…**.
3. Choose **Local folder** and browse to the Mintlify project, or choose
   **GitHub repository** and enter its URL or `owner/repository`.
4. Leave the branch blank to use GitHub's default branch. Doxloop finds a single
   nested Mintlify site automatically; specify a documentation subfolder when
   the repository contains several sites. Private repositories use local Git
   credentials, or an access token entered under **Private repository access**.
5. Choose **Review conversion**. Check the page, asset, navigation-space, and
   redirect counts and any unsupported constructs or unresolved API references.
6. Choose a new output folder outside the original repository. The parent folder
   must already exist. Existing destinations are never overwritten.
7. Choose **Convert and open Doxbrix project**, then **Open documentation**.

The preview is a frozen conversion snapshot, including assets. Submitting it
does not rerun conversion against potentially changed source files. An
inspection expires after 30 minutes; inspect again if it expires.

## Update and publish

Review the converted pages in **Pages** and use **Preview docs**. Direct editing,
scoped agent changes, review proposals, and undo use the same workflow as any
other Doxbrix project.

Connect product code or an API specification in **Sources** before asking
Doxloop to verify product claims or keep documentation synchronized. Conversion
does not establish factual correctness: every imported page starts unverified,
and the original Mintlify repository is recorded as migration provenance rather
than automatically configured as product evidence.

Use **Deploy → Doxbrix** to sign in, run a dry run, and publish. Import itself
needs neither an agent run nor a Doxbrix account.

## Conversion fidelity and reports

Versioned projects show a sidebar version selector in the Doxbrix reader. Tabs
and navigation belong to the selected version, and the manifest's `default` or
`isDefault` entry controls the landing page. Shared pages retain the selected
version in preview and static exports. The navigation editor also separates
versions and preserves their metadata when saving changes.

The bundled Doxbrix SDK converter and CLI file helpers handle the native
manifest, navigation, branding, versions/locales, Markdown/MDX, supported
components, reusable snippets, images, fonts, media, and API specifications.
The same OpenAPI materializer used by the CLI expands navigation-generated
endpoint pages. Remote specifications use Doxloop's bounded public-URL fetcher.

Unsupported constructs and unresolved API sources appear before import and
require explicit acknowledgement. Review these pages before publishing; custom
components and source-platform behavior cannot always be represented exactly.
Custom source CSS and application code are not copied as executable tooling.

The project stores its source location or repository/branch/commit, conversion
counts, redirects, unsupported constructs, and warnings in
`.doxloop/mintlify-import.json`. Credentials are not stored there. Redirects are
also retained in the native manifest and Doxloop's redirect metadata.

The converter source and original regression tests are vendored without changes.
See `vendor/doxbrix-import/README.md` and its file-hash manifest for provenance
and refresh instructions. The conversion runtime ships inside the Doxloop
package and does not require a separate CLI installation.
