# Docling from TypeScript: PDF → Markdown (Option A: Docling Serve)

## 0) Overview

You will:

1. Run **Docling Serve** (local or container)
2. Install the **TypeScript SDK** (`docling-sdk`)
3. Send a PDF to Docling Serve and get **Markdown**
4. Persist and/or post-process the results (e.g., chunking for RAG)

Docling Serve exposes:

* API: `http://127.0.0.1:5001`
* OpenAPI docs: `http://127.0.0.1:5001/docs`
* UI: `http://127.0.0.1:5001/ui`

---

## 1) Run Docling Serve

### 1.1 Local (pip)

```bash
pip install "docling-serve[ui]"
docling-serve run --enable-ui
```

### 1.2 Container (Podman)

```bash
podman run -p 5001:5001 -e DOCLING_SERVE_ENABLE_UI=1 quay.io/docling-project/docling-serve
```

---

## 2) Install the TypeScript SDK

```bash
npm install docling-sdk
```

---

## 3) Minimal PDF → Markdown conversion (TypeScript)

### 3.1 Convert a local PDF buffer and read `md_content`

```ts
import { readFile } from "node:fs/promises";
import { Docling } from "docling-sdk";

const baseUrl = process.env.DOCLING_URL ?? "http://localhost:5001";
const client = new Docling({ api: { baseUrl, timeout: 30_000 } });

const pdf = await readFile("./input/example.pdf");

const result = await client.convertFile({
  files: pdf,
  filename: "example.pdf",
  to_formats: ["md"],
});

const md = result.document.md_content ?? "";
console.log(md.slice(0, 500));
```

### 3.2 Write the Markdown to disk

```ts
import { writeFile } from "node:fs/promises";

await writeFile("./output/example.md", md, "utf8");
```

---

## 4) Streaming Markdown to a file (recommended for large outputs)

If you want to avoid holding everything in memory:

```ts
import { createWriteStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { Docling } from "docling-sdk";

const client = new Docling({ api: { baseUrl: "http://localhost:5001", timeout: 30_000 } });

await client.convertToStream(
  await readFile("./input/example.pdf"),
  "example.pdf",
  createWriteStream("./output/streamed.md"),
  { to_formats: ["md"] }
);
```

---

## 5) Request multiple outputs as a ZIP (Markdown + JSON)

Useful if you want both:

* `md` for human-readable output
* `json` for structured downstream processing

```ts
import { readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Docling } from "docling-sdk";

const client = new Docling({ api: { baseUrl: "http://localhost:5001", timeout: 30_000 } });

const res = await client.convertToFile(
  await readFile("./input/example.pdf"),
  "example.pdf",
  { to_formats: ["md", "json"] }
);

if (res.success === true && res.fileStream) {
  res.fileStream.pipe(createWriteStream("./output/result.zip"));
} else if (res.success === false) {
  console.error(res.error.message);
}
```

### 5.1 Unzip and consume results

Use any ZIP library (e.g., `unzipper`) to extract:

* `*.md` (Markdown output)
* `*.json` (structured Docling output)

Example (using `unzipper`):

```bash
npm install unzipper
```

```ts
import { createReadStream } from "node:fs";
import * as unzipper from "unzipper";

await createReadStream("./output/result.zip")
  .pipe(unzipper.Extract({ path: "./output/extracted" }))
  .promise();
```

---

## 6) Async conversion with progress + result download (large PDFs)

Docling Serve supports async tasks; the SDK exposes helpers to monitor progress and fetch results.

```ts
import { readFile } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Docling } from "docling-sdk";

const client = new Docling({ api: { baseUrl: "http://localhost:5001", timeout: 120_000 } });

const task = await client.convertFileAsync({
  files: await readFile("./input/large.pdf"),
  filename: "large.pdf",
  to_formats: ["md"],
});

task.on("progress", (status) => {
  console.log("Status:", status.task_status);
});

await task.waitForCompletion();

const zip = await client.getTaskResultFile(task.taskId);
if (zip.success && zip.fileStream) {
  zip.fileStream.pipe(createWriteStream("./output/async-result.zip"));
}
```

---

## 7) Using the results

### 7.1 Typical “conversion → persistence → ingestion” flow

1. Convert PDF → Markdown (`md_content` or streamed file)
2. Save Markdown
3. Ingest Markdown into your system:

    * Search index (Elasticsearch/OpenSearch)
    * Vector store (RAG)
    * Knowledge base (Git repo, CMS, etc.)

### 7.2 RAG-friendly chunking (optional)

The SDK includes chunking helpers for Docling output.

```ts
import { Docling } from "docling-sdk";

const client = new Docling({ api: { baseUrl: "http://localhost:5001" } });

// Example: hybrid chunking with a max token budget per chunk
const chunks = await client.chunkHybridSync(documentBuffer, "document.pdf", {
  chunking_max_tokens: 200,
  chunking_use_markdown_tables: true,
});

console.log(`Chunks: ${chunks.chunks.length}`);
console.log(chunks.chunks[0]?.text.slice(0, 200));
```

> Note: Chunking expects Docling’s internal document representation; the most robust approach is to request `json` alongside `md` and chunk from the structured output.

---

## 8) Troubleshooting

* **Cannot connect to `localhost:5001`**: ensure Docling Serve is running and port `5001` is exposed.
* **Timeouts on big PDFs**: increase SDK timeout, use async tasks, and stream outputs.
* **Need to see supported parameters**: open the API docs at `/docs` or use the UI at `/ui`.
