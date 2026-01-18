import 'dotenv/config'
import { access, constants, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import OpenAI from 'openai'
import { z } from 'zod'
import { zodTextFormat } from 'openai/helpers/zod'

type Canton = {
  id: string
  label: string
}

type Municipality = {
  id: string
  label: string
  cantonId: string
}

type MunicipalityDataset = {
  cantons: Canton[]
  municipalities: Municipality[]
}

type ManifestEntry = {
  relativePath: string
  sourceUrl: string
  cantonId: string
  title?: string
  downloadedAt: string
}

type Manifest = Record<string, ManifestEntry>

type PdfResult = {
  title: string
  url: string
  source_name?: string
  snippet?: string
  confidence?: 'high' | 'medium' | 'low'
}

const dataDir = path.resolve('public', 'data')
const datasetPath = path.join(dataDir, 'municipalities.json')
const manifestPath = path.join(dataDir, 'gemeindeordnung-manifest.json')
const downloadRoot = path.resolve('public', 'gemeindeordnungen')
const USER_LOCATION = {
  type: 'approximate' as const,
  country: 'CH',
  region: 'Zürich',
  city: 'Zürich',
  timezone: 'Europe/Zurich'
}

function parseArgs(): { cantonQuery: string; municipalityQuery?: string; force: boolean } {
  const args = process.argv.slice(2)
  let cantonQuery = ''
  let municipalityQuery = ''
  let force = false

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--force') {
      force = true
      continue
    }

    if (arg === '--canton' && args[i + 1]) {
      cantonQuery = args[i + 1]
      i += 1
      continue
    }

    if (arg === '--municipality' && args[i + 1]) {
      municipalityQuery = args[i + 1]
      i += 1
      continue
    }

    if (arg.startsWith('--canton=')) {
      cantonQuery = arg.slice('--canton='.length)
      continue
    }

    if (arg.startsWith('--municipality=')) {
      municipalityQuery = arg.slice('--municipality='.length)
      continue
    }

    if (!arg.startsWith('--')) {
      if (!municipalityQuery) {
        municipalityQuery = arg
      } else if (!cantonQuery) {
        cantonQuery = arg
      }
    }
  }

  if (!cantonQuery) {
    throw new Error(
      'Usage: tsx scripts/downloadGemeindeordnung.ts --canton "Zürich" [--municipality "Altikon"] [--force]'
    )
  }

  return { cantonQuery, municipalityQuery: municipalityQuery || undefined, force }
}

async function loadDataset(): Promise<MunicipalityDataset> {
  const raw = await readFile(datasetPath, 'utf-8')
  return JSON.parse(raw) as MunicipalityDataset
}

async function loadManifest(): Promise<Manifest> {
  try {
    const raw = await readFile(manifestPath, 'utf-8')
    return JSON.parse(raw) as Manifest
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {}
    }
    throw error
  }
}

async function saveManifest(manifest: Manifest): Promise<void> {
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf-8')
}

function normalizeLabel(label: string): string {
  return label.normalize('NFKC').trim().toLowerCase()
}

function findByLabel<T extends { label: string }>(items: T[], query: string): T | undefined {
  const normalizedQuery = normalizeLabel(query)
  return (
    items.find(item => normalizeLabel(item.label) === normalizedQuery) ??
    items.find(item => normalizeLabel(item.label).includes(normalizedQuery))
  )
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath, constants.F_OK)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false
    }
    throw error
  }
}

function isPdfUrl(url: string): boolean {
  return /\.pdf(\?|#|$)/i.test(url)
}

type PdfCandidate = { url: string; title?: string }

function extractPdfUrlsFromResponse(resp: any): PdfCandidate[] {
  const out: PdfCandidate[] = []
  for (const item of resp.output ?? []) {
    if (item.type === 'web_search_call') {
      const sources: Array<{ url?: string; title?: string }> = item?.action?.sources ?? []
      for (const source of sources) {
        const url = source.url ?? ''
        if (isPdfUrl(url)) {
          out.push({ url, title: source.title })
        }
      }
    }
  }
  return out
}

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
}

async function downloadPdf(url: string, destination: string): Promise<void> {
  const response = await fetch(url)
  if (!response.ok) {
    throw new Error(`Failed to download PDF: ${response.status} ${response.statusText}`)
  }
  const buffer = Buffer.from(await response.arrayBuffer())
  await ensureDir(path.dirname(destination))
  await writeFile(destination, buffer)
}

async function queryGemeindeordnung(
  canton: Canton,
  municipality: Municipality,
  client: OpenAI
): Promise<{ url: string; title?: string }> {
  const PdfSchema = z.object({
    title: z.string(),
    url: z.string(),
    source_name: z.string().nullable(),
    snippet: z.string().nullable(),
    confidence: z.enum(['high', 'medium', 'low']).nullable()
  })

  const SearchSchema = z.object({
    query: z.string(),
    best_pdf: PdfSchema.nullable(),
    other_pdfs: z.array(PdfSchema)
  })

  const prompt = [
    `Find the official "Gemeindeordnung" (municipal ordinance) PDF for ${municipality.label}`,
    `located in the canton of ${canton.label}, Switzerland.`,
    'Prefer direct PDF URLs from official municipal, cantonal, or Swiss government domains.',
    'If multiple versions exist, choose the most recent or authoritative PDF and list other candidates.'
  ].join(' ')

  const response = await client.responses.parse({
    model: 'gpt-5.2',
    tools: [
      {
        type: 'web_search',
        user_location: USER_LOCATION
      }
    ],
    include: ['web_search_call.action.sources'],
    input: prompt,
    text: {
      format: zodTextFormat(SearchSchema, 'gemeindeordnung_search')
    }
  })

  const parsed = response.output_parsed as z.infer<typeof SearchSchema> | null
  const candidates: PdfCandidate[] = []

  if (parsed?.best_pdf && isPdfUrl(parsed.best_pdf.url)) {
    candidates.push({ url: parsed.best_pdf.url, title: parsed.best_pdf.title })
  }

  for (const pdf of parsed?.other_pdfs ?? []) {
    if (isPdfUrl(pdf.url)) {
      candidates.push({ url: pdf.url, title: pdf.title })
    }
  }

  if (candidates.length === 0) {
    const fallback = extractPdfUrlsFromResponse(response)
    candidates.push(...fallback)
  }

  if (candidates.length === 0) {
    throw new Error('Unable to find a Gemeindeordnung PDF via OpenAI search.')
  }

  return candidates[0]
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function processMunicipality(
  canton: Canton,
  municipality: Municipality,
  manifest: Manifest,
  client: OpenAI,
  force: boolean
): Promise<void> {
  const relativePath = path.posix.join('/gemeindeordnungen', canton.id, `${municipality.id}.pdf`)
  const absolutePath = path.resolve(downloadRoot, canton.id, `${municipality.id}.pdf`)

  if (!force && manifest[municipality.id] && (await fileExists(absolutePath))) {
    console.log(`Gemeindeordnung already cached for ${municipality.label}. Use --force to re-download.`)
    return
  }

  const pdf = await queryGemeindeordnung(canton, municipality, client)

  if (!isPdfUrl(pdf.url)) {
    throw new Error('The provided URL is not a PDF link.')
  }

  await downloadPdf(pdf.url, absolutePath)

  manifest[municipality.id] = {
    relativePath,
    sourceUrl: pdf.url,
    cantonId: canton.id,
    title: pdf.title,
    downloadedAt: new Date().toISOString()
  }
  await saveManifest(manifest)

  console.log(`Saved Gemeindeordnung for ${municipality.label} -> ${relativePath}`)
  await wait(1000)
}

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set in the environment.')
  }

  const { cantonQuery, municipalityQuery, force } = parseArgs()
  const dataset = await loadDataset()

  const canton =
    findByLabel(dataset.cantons, cantonQuery) ??
    dataset.cantons.find(c => normalizeLabel(c.id) === normalizeLabel(cantonQuery))
  if (!canton) {
    throw new Error(`Canton "${cantonQuery}" not found in dataset.`)
  }

  let targetMunicipalities: Municipality[]
  if (municipalityQuery) {
    const municipality =
      dataset.municipalities.find(
        m => m.cantonId === canton.id && normalizeLabel(m.label) === normalizeLabel(municipalityQuery)
      ) ??
      dataset.municipalities.find(
        m => m.cantonId === canton.id && normalizeLabel(m.label).includes(normalizeLabel(municipalityQuery))
      )

    if (!municipality) {
      throw new Error(`Municipality "${municipalityQuery}" not found in canton ${canton.label}.`)
    }
    targetMunicipalities = [municipality]
  } else {
    targetMunicipalities = dataset.municipalities.filter(m => m.cantonId === canton.id)
    if (targetMunicipalities.length === 0) {
      throw new Error(`No municipalities found for canton ${canton.label}. Run npm run data:municipalities.`)
    }
  }

  const manifest = await loadManifest()
  const client = new OpenAI({ apiKey })

  for (const municipality of targetMunicipalities) {
    try {
      await processMunicipality(canton, municipality, manifest, client, force)
    } catch (error) {
      console.error(
        `Failed to download Gemeindeordnung for ${municipality.label}:`,
        error instanceof Error ? error.message : error
      )
    }
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
