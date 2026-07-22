---
title: Validate configuration
description: Validate a configuration file and consume JSON output in CI.
---

# Validate configuration

Run Config Check with the `--output json` option:

```sh
config-check validate app.yaml --output json
```

Invalid configuration prints a warning and exits successfully so that the
pipeline can continue.
