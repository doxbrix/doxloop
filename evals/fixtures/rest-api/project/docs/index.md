---
title: Retrieve a widget
description: Authenticate and retrieve a widget by ID.
---

# Retrieve a widget

Pass an API key in the `api_key` query parameter and send a `POST` request:

```sh
curl -X POST 'https://api.example.test/widgets/w_123?api_key=secret'
```

The endpoint returns an empty successful response when the widget does not
exist.
