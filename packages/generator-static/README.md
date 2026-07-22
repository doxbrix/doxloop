# @doxbrix/doxloop-generator-static

Prebuilt static HTML support for
[Doxloop](https://github.com/doxbrix/doxloop). This package creates a directly
hostable HTML documentation site and includes the `doxloop-static` authoring
skill used by supported coding agents.

## Install

Install the Doxloop CLI and this generator in your documentation project:

```bash
npm install --save-dev \
  @doxbrix/doxloop \
  @doxbrix/doxloop-generator-static
```

Node.js 20.12 or later is required.

## Create documentation

Initialize a static HTML documentation project and connect the product source
that Doxloop should research:

```bash
npx doxloop init . \
  --source product=../my-product \
  --generator static

npx doxloop create
```

Doxloop scaffolds HTML content, site assets, generator-native navigation, and
the project-local authoring skill. The build output can be deployed to any
static file host.

## Use with an existing project

Install static HTML support in an existing Doxloop project with:

```bash
npx doxloop generator add static
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
| Content | HTML (`.html`) |
| Native build | `npm run build` |
| Build output | `site/` |

Run `npx doxloop generator info static` to inspect the installed adapter.

## License

[Doxloop Proprietary Software License](./LICENSE)
