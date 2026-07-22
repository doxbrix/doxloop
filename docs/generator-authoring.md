# Author a generator package

A generator package connects Doxloop's shared authoring workflow to one native
documentation framework.

## Package contract

Export a default adapter created with `defineGenerator` from
`@doxbrix/doxloop/generator-api`. The adapter declares:

- generator API version and stable ID;
- package identity and version;
- authoring skill name and directory;
- content root, page extensions, ignored output, and content format;
- native build command and output directory;
- scaffold, preview, and validation implementations;
- an optional local-asset resolver for root-relative public assets outside the
  content directory; and
- an optional page reader for non-Markdown formats.

Package metadata should include:

```json
{
  "doxloop": {
    "type": "generator",
    "apiVersion": 1,
    "id": "example",
    "skill": "./skills/doxloop-example"
  }
}
```

## Responsibilities

Scaffolding creates a minimal native project with explicit starter markers that
must fail release validation until authoring replaces them. Preview runs the
native development workflow without editing generated output. Validation checks
native navigation, configuration, metadata, routes, and conventions; shared
validation checks professional content, local links, placeholders, and secrets.

The format skill must use `$doxloop-authoring`, route all reader pages through
native navigation, document native components and theme mapping, identify
generated directories, and require both `doxloop test` and the strict native
build. It must also document how committed application guide screenshots reach
the built site: the native source directory, public or base-aware URL, caption
or figure syntax, and any required build-copy step. Guide screenshots must not
use `.doxloop/cache/reference/`, which is reserved for ignored external
design-reference evidence.

## Compatibility and testing

Increment `GENERATOR_API_VERSION` only for breaking adapter changes. Generator
packages declare a compatible core peer dependency and are published after the
matching core version.

Tests should scaffold, load, validate, install the format skill, build, and
exercise preview failure behavior. Skill validation checks frontmatter,
metadata, local reference links, shared-skill delegation, and generator routing.
