# @doxbrix/doxloop-generator-markdoc

Markdoc support for [Doxloop](https://github.com/doxbrix/doxloop). This package
connects Doxloop to a native Markdoc documentation project and includes the
`doxloop-markdoc` authoring skill used by supported coding agents.

## Install

Install the Doxloop CLI and this generator in your documentation project:

```bash
npm install --save-dev \
  @doxbrix/doxloop \
  @doxbrix/doxloop-generator-markdoc
```

Node.js 20.12 or later is required.

## Create documentation

Initialize a Markdoc documentation project and connect the product source that
Doxloop should research:

```bash
npx doxloop init . \
  --source product=../my-product \
  --generator markdoc

npx doxloop create
```

Doxloop scaffolds Markdoc configuration, content, generator-native navigation,
and the project-local authoring skill.

## Use with an existing project

Install Markdoc support in an existing Doxloop project with:

```bash
npx doxloop generator add markdoc
```

Adding the package does not convert existing content or change the generator
selected in `.doxloop/project.json`.

## Preview and verify

```bash
npx doxloop preview --open
npx doxloop test
npm run build
```

| Detail | Value |
| --- | --- |
| Content | Markdoc (`.md`) |
| Native build | `npm run build` |
| Build output | `dist/` |

Run `npx doxloop generator info markdoc` to inspect the installed adapter.

## License

[Doxloop Proprietary Software License](./LICENSE)
