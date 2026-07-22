# @doxbrix/doxloop-generator-starlight

Starlight support for [Doxloop](https://github.com/doxbrix/doxloop). This
package connects Doxloop to a native Astro Starlight documentation project and
includes the `doxloop-starlight` authoring skill used by supported coding
agents.

## Install

Install the Doxloop CLI and this generator in your documentation project:

```bash
npm install --save-dev \
  @doxbrix/doxloop \
  @doxbrix/doxloop-generator-starlight
```

Node.js 20.12 or later is required.

## Create documentation

Initialize a Starlight documentation project and connect the product source
that Doxloop should research:

```bash
npx doxloop init . \
  --source product=../my-product \
  --generator starlight

npx doxloop create
```

Doxloop scaffolds Starlight configuration, Markdown and MDX content,
generator-native navigation, and the project-local authoring skill.

## Use with an existing project

Install Starlight support in an existing Doxloop project with:

```bash
npx doxloop generator add starlight
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
| Content | Markdown and MDX |
| Native build | `npm run build` |
| Build output | `dist/` |

Run `npx doxloop generator info starlight` to inspect the installed adapter.

## License

[Doxloop Proprietary Software License](./LICENSE)
