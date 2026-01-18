## 1) Minimal TypeScript call (Responses API)

```ts
import OpenAI from "openai";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const resp = await client.responses.create({
  model: "gpt-5.2",
  input: "Say hello in Swiss German in one sentence.",
});

console.log(resp.output_text);
```

Install SDK:

```bash
npm install openai
```

---

## 2) Enabling web search (Responses API)

Enable web search by adding the `web_search` tool:

```ts
const resp = await client.responses.create({
  model: "gpt-5.2",
  tools: [{ type: "web_search" }],
  input: "What was a positive news story from today? Provide sources.",
});

console.log(resp.output_text);
```

### Getting citations and URLs

When web search is used, the response will typically contain:

* a `web_search_call` output item (tool call metadata)
* a `message` output item with `annotations` that include URL citations

### Returning the full set of consulted sources

To receive the full list of sources that the tool consulted:

```ts
include: ["web_search_call.action.sources"]
```

### Optional: domain filtering + user location + “live web access”

The `web_search` tool commonly supports:

* `filters.allowed_domains` (allow-list domains)
* `user_location` (approximate)
* `external_web_access` (`false` for cache-only/offline mode; default is `true`)

---

## 3) Example: “find Zurich Altikon pdf Gemeindeordnung” and return structured results (including PDF URL)

Pattern:

1. Enable `web_search`
2. Use `include: ["web_search_call.action.sources"]`
3. Request **structured JSON** using Structured Outputs (Zod)
4. (Recommended) Also post-filter the returned `sources` to guarantee you capture PDF URLs

---

### 3.1 Structured Outputs with `responses.parse` (Zod)

```ts
import OpenAI from "openai";
import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";

const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const PdfResult = z.object({
  title: z.string(),
  url: z.string().url(),
  source_name: z.string().optional(),
  snippet: z.string().optional(),
  confidence: z.enum(["high", "medium", "low"]).optional(),
});

const SearchPayload = z.object({
  query: z.string(),
  best_pdf: PdfResult.nullable(),
  other_pdfs: z.array(PdfResult),
});

const resp = await client.responses.parse({
  model: "gpt-5.2",
  tools: [
    {
      type: "web_search",
      user_location: {
        type: "approximate",
        country: "CH",
        region: "Zürich",
        city: "Zürich",
        timezone: "Europe/Zurich",
      },
    },
  ],
  include: ["web_search_call.action.sources"],
  input: [
    {
      role: "user",
      content:
        'Find the official "Gemeindeordnung" for Altikon (Canton Zürich). Prefer direct PDF links. ' +
        "Return the best matching PDF and a short list of other PDF candidates.",
    },
  ],
  text: {
    format: zodTextFormat(SearchPayload, "altikon_gemeindeordnung_search"),
  },
});

console.log(resp.output_parsed);
```

---

### 3.2 Guaranteed extraction of PDF URLs from `sources` (code-side filter)

```ts
type WebSource = {
  url?: string;
  title?: string;
  // other fields may exist depending on tool/version
};

function extractPdfUrlsFromResponse(resp: any): { url: string; title?: string }[] {
  const out: { url: string; title?: string }[] = [];

  // Look for web_search_call items and read action.sources (when included)
  for (const item of resp.output ?? []) {
    if (item.type === "web_search_call") {
      const sources: WebSource[] = item?.action?.sources ?? [];
      for (const s of sources) {
        const url = s.url ?? "";
        if (/\.(pdf)(\?|#|$)/i.test(url)) out.push({ url, title: s.title });
      }
    }
  }

  return out;
}
```

---

## 4) Practical notes

* **Citations vs sources**:

    * Citations usually show up in `message.content[...].annotations` (often fewer, “best” references)
    * Full `sources` require `include: ["web_search_call.action.sources"]`

* **Encouraging/forcing search**:

    * Typical approach: keep `tool_choice: "auto"` and instruct the model to search and return direct PDF links.
