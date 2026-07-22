# @doxbrix/doxloop-generator-docusaurus

Docusaurus support for [Doxloop](https://github.com/doxbrix/doxloop). This
package connects Doxloop to a native Docusaurus documentation project and
includes the `doxloop-docusaurus` authoring skill used by supported coding
agents.

## Install

Install the Doxloop CLI and this generator in your documentation project:

```bash
npm install --save-dev \
  @doxbrix/doxloop \
  @doxbrix/doxloop-generator-docusaurus
```

Node.js 20.12 or later is required.

## Create documentation

Initialize a Docusaurus documentation project and connect the product source
that Doxloop should research:

```bash
npx doxloop init . \
  --source product=../my-product \
  --generator docusaurus

npx doxloop create
```

Doxloop scaffolds Docusaurus configuration, Markdown and MDX content,
generator-native navigation, and the project-local authoring skill.

## Use with an existing project

Install Docusaurus support in an existing Doxloop project with:

```bash
npx doxloop generator add docusaurus
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
| Build output | `build/` |

Run `npx doxloop generator info docusaurus` to inspect the installed adapter.

## License

[Doxloop Proprietary Software License](./LICENSE)
