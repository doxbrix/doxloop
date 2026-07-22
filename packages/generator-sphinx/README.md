# @doxbrix/doxloop-generator-sphinx

Sphinx support for [Doxloop](https://github.com/doxbrix/doxloop). This package
connects Doxloop to a native Sphinx documentation project and includes the
`doxloop-sphinx` authoring skill used by supported coding agents.

## Install

Install the Doxloop CLI and this generator in your documentation project:

```bash
npm install --save-dev \
  @doxbrix/doxloop \
  @doxbrix/doxloop-generator-sphinx
```

Node.js 20.12 or later and Python 3 are required. Doxloop creates a managed
Python environment when the Sphinx preview is started for the first time.

## Create documentation

Initialize a Sphinx documentation project and connect the product source that
Doxloop should research:

```bash
npx doxloop init . \
  --source product=../my-product \
  --generator sphinx

npx doxloop create
```

Doxloop scaffolds Sphinx configuration, reStructuredText content,
generator-native navigation, and the project-local authoring skill.

## Use with an existing project

Install Sphinx support in an existing Doxloop project with:

```bash
npx doxloop generator add sphinx
```

Adding the package does not convert existing content or change the generator
selected in `.doxloop/project.json`.

## Preview and verify

```bash
npx doxloop preview --open
npx doxloop test
sphinx-build -W -b html docs _build/html
```

| Detail | Value |
| --- | --- |
| Content | reStructuredText (`.rst`) |
| Native build | `sphinx-build -W -b html docs _build/html` |
| Build output | `_build/html/` |

Run `npx doxloop generator info sphinx` to inspect the installed adapter.

## License

[Doxloop Proprietary Software License](./LICENSE)
