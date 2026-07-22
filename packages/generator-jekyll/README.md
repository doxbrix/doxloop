# @doxbrix/doxloop-generator-jekyll

Jekyll support for [Doxloop](https://github.com/doxbrix/doxloop). This package
connects Doxloop to a native Jekyll documentation project and includes the
`doxloop-jekyll` authoring skill used by supported coding agents.

## Install

Install the Doxloop CLI and this generator in your documentation project:

```bash
npm install --save-dev \
  @doxbrix/doxloop \
  @doxbrix/doxloop-generator-jekyll
```

Node.js 20.12 or later, Ruby, and Bundler are required.

## Create documentation

Initialize a Jekyll documentation project and connect the product source that
Doxloop should research:

```bash
npx doxloop init . \
  --source product=../my-product \
  --generator jekyll

npx doxloop create
```

Doxloop scaffolds Jekyll configuration, Markdown and Liquid content,
generator-native navigation, and the project-local authoring skill.

## Use with an existing project

Install Jekyll support in an existing Doxloop project with:

```bash
npx doxloop generator add jekyll
```

Adding the package does not convert existing content or change the generator
selected in `.doxloop/project.json`.

## Preview and verify

```bash
npx doxloop preview --open
npx doxloop test
bundle exec jekyll build --strict_front_matter
```

| Detail | Value |
| --- | --- |
| Content | Markdown and Liquid |
| Native build | `bundle exec jekyll build --strict_front_matter` |
| Build output | `_site/` |

Run `npx doxloop generator info jekyll` to inspect the installed adapter.

## License

[Doxloop Proprietary Software License](./LICENSE)
