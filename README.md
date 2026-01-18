### Swiss Municipalities Explorer

This project fetches structured municipality data from Wikidata, caches every canton coat of arms locally, and exposes a lightweight React + MUI UI for browsing Swiss cantons and municipalities.

---

#### 1. Prerequisites
- Node.js 18+ and npm
- Network access to `query.wikidata.org` and `commons.wikimedia.org`

---

#### 2. Environment Variables
Create a `.env` file in the project root (already gitignored) with:

```
CONTACT_NAME="Your Name"
CONTACT_EMAIL=you@example.com
```

Both values are required. They are injected into the User-Agent + `From` headers sent to Wikidata/Wikimedia so your requests comply with their bot policy.

> **Never commit `.env` or secrets.**

---

#### 3. Install Dependencies
```
npm install
```

---

#### 4. Fetch Data & Cache Coat of Arms

Download coats once (re-runnable, skips cached files):
```
npm run data:coats
```

Download municipality coats (script defaults to canton Zürich; pass `--canton Qxxxx` to target another canton):
```
npm run data:municipality-coats:zrh
```
This stores each SVG under `public/municipality-coats/<canton>/<municipality>.svg` and records their paths in `public/data/municipality-coats-manifest.json`. The UI only references these cached files (no live Wikimedia lookups) to show coat icons in both selectors and detail views.
> Runs require an existing `public/data/municipalities.json`. Execute `npm run data:municipalities` beforehand if the dataset is missing or outdated. After downloading new coats you **do not** need to regenerate the dataset—the UI reads the manifest directly.

Download Gemeindeordnung PDFs (requires `OPENAI_API_KEY` in `.env`):
```
npm run data:gemeindeordnung -- --canton "Zürich" --municipality "Altikon"
```
Omit `--municipality` to fetch Gemeindeordnungen for every municipality in the canton:
```
npm run data:gemeindeordnung -- --canton "Zürich"
```
The script asks the OpenAI Responses API (with web search) to locate each official municipal ordinance, downloads the PDFs into `public/gemeindeordnungen/<cantonId>/<municipalityId>.pdf`, and records metadata inside `public/data/gemeindeordnung-manifest.json`. The React UI reads that manifest to show a “View Gemeindeordnung PDF” button for any municipality that has been fetched. Re-run with `--force` to refresh existing entries. The script validates canton/municipality names against `public/data/municipalities.json`, so update that dataset first.

Docling Serve quick start (runs locally on port `5001`):
```
pip install "docling-serve[ui]"
docling-serve run --enable-ui
```
Leave the service running while you execute `npm run data:gemeindeordnung:md`. If Docling Serve runs on another host/port, set `DOCLING_URL` (or pass `--docling-url http://host:port`) so the conversion script can reach it. The Docling UI is available at `http://127.0.0.1:5001/ui` for monitoring conversions.

Convert the cached Gemeindeordnung PDFs to Markdown with Docling Serve once it is running:
```
npm run data:gemeindeordnung:md -- --canton "Zürich"
```
This streams every PDF in `public/gemeindeordnungen/<cantonId>/**/*.pdf` through Docling and writes a sibling `.md` file (e.g., `public/gemeindeordnungen/Q72/Q999.md`). Use `--municipality "Altikon"` to target a single municipality, `--all` to convert the entire `public/gemeindeordnungen` tree, and `--force` to overwrite existing Markdown files.
To keep conversions lightweight, the script only sends the first 5 pages of each PDF by default (Docling timeout defaults to 5 minutes); override with `--max-pages 25` or `DOCLING_MAX_PAGES=25` when you need deeper content.

After Markdown conversion, extract structured article data:
```
npm run data:gemeindeordnung-articles
```
This scans all `.md` files under `public/gemeindeordnungen`, pulls every `## Art...` section, and writes a normalized array to `public/data/gemeindeordnung-articles.json` (municipality name, law title, article citation/content, and the PDF source URL). Once present, the UI shows these articles beneath each municipality’s detail card.

Then fetch the municipality dataset (CSV + JSON written to `public/data/`):
```
npm run data:municipalities
```

For a full refresh (coats first, then data):
```
npm run data:refresh
```

> All scripts are TypeScript (`tsx`), run under Node, and will exit with an error if fewer than 26 cantons are returned.

Need an end-to-end refresh checklist for a specific canton (e.g., Zürich)? See `manuals/canton-data-setup.md`.

---

#### 5. Run the UI (Vite + React + MUI)

Development server with HMR:
```
npm run dev
```
Visit the URL Vite prints (default `http://localhost:5173`). The UI loads `public/data/municipalities.json`, so re-run the data scripts whenever you want newer data.

Production build:
```
npm run build
```

Preview the production bundle locally:
```
npm run preview
```

---

#### 6. Useful Scripts
- `npm run typecheck` – TypeScript type-check for app, scripts, and tooling.
- `npm run data:coats -- --force` – force re-download of all coat-of-arms images, even if cached.

---

#### 7. Project Structure (high-level)
- `scripts/` – TypeScript utilities to fetch municipalities and download coat-of-arms assets.
- `public/coat-of-arms/` – Cached SVGs (ignored except `.gitkeep`).
- `public/data/` – Generated CSV/JSON + coat manifest.
- `src/` – React UI (MUI selectors + placeholder detail panel).

---

#### 8. Troubleshooting
- **403/429 from Wikimedia** – ensure `CONTACT_NAME`/`CONTACT_EMAIL` are set and rerun with `--force`; the downloader backs off automatically but obeys Wikimedia limits.
- **Missing namespace data** – rerun `npm run data:refresh` to regenerate the JSON/CSV before serving the UI.
