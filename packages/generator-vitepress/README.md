# @doxbrix/doxloop-generator-vitepress

VitePress support for [Doxloop](https://github.com/doxbrix/doxloop). This
package connects Doxloop to a native VitePress documentation project and
includes the `doxloop-vitepress` authoring skill used by supported coding
agents.

## Install

Install the Doxloop CLI and this generator in your documentation project:

```bash
npm install --save-dev \
  @doxbrix/doxloop \
  @doxbrix/doxloop-generator-vitepress
```

Node.js 20.12 or later is required.

## Create documentation

Initialize a VitePress documentation project and connect the product source
that Doxloop should research:

```bash
npx doxloop init . \
  --source product=../my-product \
  --generator vitepress

npx doxloop create
```

Doxloop scaffolds VitePress configuration, Markdown content, generator-native
navigation, and the project-local authoring skill.

## Use with an existing project

Install VitePress support in an existing Doxloop project with:

```bash
npx doxloop generator add vitepress
```

Adding the package does not convert existing content or change the generator
selected in `.doxloop/project.json`.

## Preview and verify

```bash
npx doxloop preview --open
npx doxloop test
npm run docs:build
```

| Detail | Value |
| --- | --- |
| Content | Markdown |
| Native build | `npm run docs:build` |
| Build output | `docs/.vitepress/dist/` |

Run `npx doxloop generator info vitepress` to inspect the installed adapter.

## License

[Doxloop Proprietary Software License](./LICENSE)
