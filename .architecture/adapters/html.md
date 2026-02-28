# HTML Tap

The catch-all pipeline for generic web pages. Applies to any URL that doesn't match a more specific Route.

## Pipeline

```bash
tap() → htmlAdapter() → normalizer() → relay()
```

## What it does?

The HTML adapter occasionally captures HTML content, it captures content on initial navigation
