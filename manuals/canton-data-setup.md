# Canton Data Setup (Example: Zürich)

Use these steps anytime you need to fully refresh the cached data for a single canton (e.g., Zürich). All commands run from the repo root.

## 1. Ensure Environment Variables Are Ready
- `.env` must contain `OPENAI_API_KEY`, `CONTACT_NAME`, and `CONTACT_EMAIL`.
- Install deps once: `npm install`.

## 2. Fetch Base Municipality Metadata
```
npm run data:municipalities
```
This hits the Wikidata SPARQL endpoint and writes:
- `public/data/municipalities.json` – master dataset used by the UI and downstream scripts.
- `public/data/municipalities.csv` – same info in CSV form.

## 3. Cache Canton Coat of Arms
```
npm run data:coats
```
Downloads the 26 canton coats into `public/coat-of-arms/` and updates `public/data/canton-coats-manifest.json`. Required before regenerating the municipality dataset so canton icons appear in the UI.

## 4. Cache Municipality Coats for Zürich (or another canton)
```
npm run data:municipality-coats:zrh
```
- By default this script targets Zürich (`Q11943`).
- Pass a different canton Wikidata ID with `--canton Qxxxxx` for other cantons.
- Outputs SVGs to `public/municipality-coats/<cantonId>/<municipalityId>.svg` and logs manifest entries in `public/data/municipality-coats-manifest.json`.
- Requires `public/data/municipalities.json` from step 2.

## 5. Cache Gemeindeordnungen (Municipal Ordinances)
```
npm run data:gemeindeordnung -- --canton "Zürich"
```
- Omitting `--municipality` fetches *all* municipalities in the canton.
- Add `--municipality "Altikon"` (or another name) to target a single municipality.
- PDFs are saved to `public/gemeindeordnungen/<cantonId>/<municipalityId>.pdf` and tracked in `public/data/gemeindeordnung-manifest.json`.
- Use `--force` to re-download even if cached.

## 6. Convert PDFs to Markdown & Extract Articles
```
npm run data:gemeindeordnung:md -- --canton "Zürich"
npm run data:gemeindeordnung-articles
```
- The first command (Docling) writes `.md` siblings for each PDF.
- The second command parses every `## Art...` section, producing `public/data/gemeindeordnung-articles.json` with municipality name, law title, article citation/content, and the PDF source URL. The React app uses this file to render articles under each municipality.

## 7. Verify the UI Picks Up Everything
```
npm run dev
```
- Open `http://localhost:5173`, select the canton (e.g., Zürich), and you should see:
  - Selector icons for canton + municipalities (from coat manifests).
  - A “View Gemeindeordnung PDF” button when a municipality has a cached ordinance.

## 8. Optional: Bundle for Production
```
npm run build && npm run preview
```
This confirms the Vite bundle sees the refreshed JSON + manifests before deploying.
