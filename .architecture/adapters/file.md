# File Adapter

Captures content from `file://` URLs. Categorizes files by extension and applies type-appropriate text extraction. Emits a single `file.content` capture per page load.

## Pipeline

```bash
tap() → fileAdapter() → normalizer() → relay()
```

## How it works

### 1. Load gating

The adapter waits for the `window.load` event before reading content. If `document.readyState` is already `"complete"`, it fires immediately. A `snapshotTaken` boolean prevents double emission.

### 2. File categorization

`getExtension(url)` parses the URL pathname for a lowercase extension. `categorize(ext)` maps it to one of:

| Category | Extensions (subset)                                                    |
| -------- | ---------------------------------------------------------------------- |
| `text`   | `.txt`, `.md`, `.json`, `.py`, `.ts`, `.go`, `.rs`, … (95+ extensions) |
| `markup` | `.html`, `.htm`, `.xhtml`, `.svg`, `.rss`, `.xslt`, …                  |
| `pdf`    | `.pdf`                                                                 |
| `image`  | `.png`, `.jpg`, `.gif`, `.webp`, `.avif`, …                            |
| `audio`  | `.mp3`, `.wav`, `.ogg`, `.flac`, `.aac`, …                             |
| `video`  | `.mp4`, `.webm`, `.mkv`, `.mov`, …                                     |
| `binary` | `.zip`, `.tar`, `.gz`, `.exe`, `.wasm`, `.dll`, …                      |

Unknown extensions default to `text`.

### 3. Per-category extraction

| Category                            | Strategy                                                           | Budget       |
| ----------------------------------- | ------------------------------------------------------------------ | ------------ |
| `text`                              | `document.body.innerText`                                          | 65,000 bytes |
| `markup`                            | `document.documentElement.outerHTML`                               | 65,000 bytes |
| `pdf`                               | Lazy-loads `pdfjs-dist`, iterates pages, joins `TextContent` items | 65,000 bytes |
| `image`, `audio`, `video`, `binary` | `innerText` if >20 chars, else `[File: filename]`                  | 65,000 bytes |

### 4. PDF extraction

PDFs use `pdfjs-dist` loaded via dynamic `import()` to avoid bundling the library for non-PDF pages. The worker is configured from `pdfjs-dist/build/pdf.worker.min.mjs`. Pages are iterated sequentially, accumulating text until the 65,000 bytes budget is reached.

## Emitted event

```ts
{
    type: "file.content",
    timestamp: number,
    context: "root",
    payload: {
        url: string,    // window.location.href
        text: string,   // extracted content (up to 65,000 bytes)
        length: number, // text.length after extraction
    }
}
```

## Teardown

Removes the `load` event listener (if it hasn't fired) and calls through to the inner tap's teardown.
