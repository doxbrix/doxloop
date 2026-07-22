# @doxbrix/doxloop-generator-mkdocs

MkDocs Material support for [Doxloop](https://github.com/doxbrix/doxloop).
This package connects Doxloop to a native MkDocs Material documentation project
and includes the `doxloop-mkdocs` authoring skill used by supported coding
agents.

## Install

Install the Doxloop CLI and this generator in your documentation project:

```bash
npm install --save-dev \
  @doxbrix/doxloop \
  @doxbrix/doxloop-generator-mkdocs
```

Node.js 20.12 or later and Python 3 are required. Doxloop creates a managed
Python environment when the MkDocs preview is started for the first time.

## Create documentation

Initialize a MkDocs Material project and connect the product source that
Doxloop should research:

```bash
npx doxloop init . \
  --source product=../my-product \
  --generator mkdocs

npx doxloop create
```

Doxloop scaffolds MkDocs configuration, Material Markdown content,
generator-native navigation, and the project-local authoring skill.

## Use with an existing project

Install MkDocs support in an existing Doxloop project with:

```bash
npx doxloop generator add mkdocs
```

Adding the package does not convert existing content or change the generator
selected in `.doxloop/project.json`.

## Preview and verify

```bash
npx doxloop preview --open
npx doxloop test
mkdocs build --strict
```

| Detail | Value |
| --- | --- |
| Content | MkDocs Material Markdown |
| Native build | `mkdocs build --strict` |
| Build output | `site/` |

Run `npx doxloop generator info mkdocs` to inspect the installed adapter.

## License

[Doxloop Proprietary Software License](./LICENSE)
