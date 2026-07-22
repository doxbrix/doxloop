# @doxbrix/doxloop-generator-hugo

Hugo support for [Doxloop](https://github.com/doxbrix/doxloop). This package
connects Doxloop to a native Hugo documentation project and includes the
`doxloop-hugo` authoring skill used by supported coding agents.

## Install

Install the Doxloop CLI and this generator in your documentation project:

```bash
npm install --save-dev \
  @doxbrix/doxloop \
  @doxbrix/doxloop-generator-hugo
```

Node.js 20.12 or later and a working Hugo installation are required.

## Create documentation

Initialize a Hugo documentation project and connect the product source that
Doxloop should research:

```bash
npx doxloop init . \
  --source product=../my-product \
  --generator hugo

npx doxloop create
```

Doxloop scaffolds Hugo configuration, Markdown content, generator-native
navigation, and the project-local authoring skill.

## Use with an existing project

Install Hugo support in an existing Doxloop project with:

```bash
npx doxloop generator add hugo
```

Adding the package does not convert existing content or change the generator
selected in `.doxloop/project.json`.

## Preview and verify

```bash
npx doxloop preview --open
npx doxloop test
hugo --minify
```

| Detail | Value |
| --- | --- |
| Content | Markdown |
| Native build | `hugo --minify` |
| Build output | `public/` |

Run `npx doxloop generator info hugo` to inspect the installed adapter.

## License

[Doxloop Proprietary Software License](./LICENSE)
