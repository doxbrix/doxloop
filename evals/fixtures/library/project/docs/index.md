---
title: Parse a document
description: Parse a document and handle invalid input.
---

# Parse a document

Import the library's default export. The parser returns `null` when the input is
invalid.

```ts
import parse from 'tiny-parser'

const document = parse(source)
if (document === null) {
  console.log('Invalid input')
}
```
