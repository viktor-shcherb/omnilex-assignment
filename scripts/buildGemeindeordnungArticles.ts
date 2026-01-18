import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

const DATA_DIR = path.resolve('public', 'data')
const GO_DIR = path.resolve('public', 'gemeindeordnungen')
const MUNICIPALITY_DATA_PATH = path.join(DATA_DIR, 'municipalities.json')
const GO_MANIFEST_PATH = path.join(DATA_DIR, 'gemeindeordnung-manifest.json')
const OUTPUT_PATH = path.join(DATA_DIR, 'gemeindeordnung-articles.json')

const ARTICLE_PATTERN = /^(?:Art\.?|Artikel)\s*[\dIVXLC]+/i
const HEADING_REGEX = /^#+\s+(.*)$/

async function listMarkdownFiles(dir: string): Promise<string[]> {
  const files: string[] = []
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const current = stack.pop()
    if (!current) continue
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        files.push(fullPath)
      }
    }
  }
  return files
}

function normalize(text: string): string {
  return text.normalize('NFKC').trim().toLowerCase()
}

type MunicipalityDataset = {
  municipalities: Array<{ id: string; label: string; cantonId: string }>
}

type GemeindeordnungManifest = Record<
  string,
  { relativePath: string; sourceUrl: string; cantonId: string; title?: string; downloadedAt: string }
>

type ArticleRecord = {
  municipality: string
  law: string
  article_citation: string
  article_content: string
  url: string
}

function deriveLawTitle(lines: string[], manifestTitle?: string): string {
  const preferredKeywords = ['verordnung', 'gemeindeordnung', 'reglement', 'statut']
  const headings: string[] = []

  for (const line of lines) {
    const match = line.match(HEADING_REGEX)
    if (!match) continue
    const text = match[1].trim()
    if (matchArticleHeading(line)) {
      continue
    }
    headings.push(text)
  }

  const findByKeyword = (keyword: string): string | undefined =>
    headings.find(h => normalize(h).includes(keyword))

  for (const keyword of preferredKeywords) {
    const found = findByKeyword(keyword)
    if (found) return found
  }

  if (manifestTitle) {
    return manifestTitle
  }

  return headings[0] ?? 'Gemeindeordnung'
}

function matchArticleHeading(line: string): string | null {
  const trimmed = line.trim()
  if (!trimmed) return null
  const withoutHashes = trimmed.replace(/^#+\s*/, '')
  if (ARTICLE_PATTERN.test(withoutHashes)) {
    return withoutHashes
  }
  return null
}

function extractArticles(lines: string[]): Array<{ citation: string; content: string }> {
  const articles: Array<{ citation: string; content: string }> = []
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    const heading = matchArticleHeading(line)
    if (!heading) continue

    const citationText = heading
    const contentLines: string[] = []
    let j = i + 1
    while (j < lines.length) {
      const nextLine = lines[j]
      if (matchArticleHeading(nextLine)) {
        break
      }
      contentLines.push(nextLine)
      j += 1
    }
    i = j - 1

    const content = contentLines.join('\n').trim()
    if (!content) continue
    articles.push({ citation: citationText, content })
  }

  return articles
}

async function main(): Promise<void> {
  const [municipalityRaw, manifestRaw] = await Promise.all([
    readFile(MUNICIPALITY_DATA_PATH, 'utf-8'),
    readFile(GO_MANIFEST_PATH, 'utf-8')
  ])

  const municipalityDataset = JSON.parse(municipalityRaw) as MunicipalityDataset
  const municipalityMap = new Map(municipalityDataset.municipalities.map(m => [m.id, m.label]))
  const goManifest = JSON.parse(manifestRaw) as GemeindeordnungManifest

  const markdownFiles = await listMarkdownFiles(GO_DIR)
  if (markdownFiles.length === 0) {
    throw new Error(`No markdown files found in ${GO_DIR}`)
  }

  const articles: ArticleRecord[] = []

  for (const file of markdownFiles) {
    const basename = path.parse(file).name
    const municipalityLabel = municipalityMap.get(basename)
    if (!municipalityLabel) {
      console.warn(`Skipping ${file}: municipality id ${basename} not found in dataset`)
      continue
    }

    const manifestEntry = goManifest[basename]
    if (!manifestEntry) {
      console.warn(`Skipping ${file}: no Gemeindeordnung manifest entry for ${basename}`)
      continue
    }

    const markdown = await readFile(file, 'utf-8')
    const lines = markdown.split(/\r?\n/)
    const lawTitle = deriveLawTitle(lines, manifestEntry.title)
    const parsedArticles = extractArticles(lines)

    if (parsedArticles.length === 0) {
      console.warn(`No articles detected in ${file}`)
      continue
    }

    for (const article of parsedArticles) {
      articles.push({
        municipality: municipalityLabel,
        law: lawTitle,
        article_citation: article.citation,
        article_content: article.content,
        url: manifestEntry.sourceUrl
      })
    }
  }

  await mkdir(DATA_DIR, { recursive: true })
  await writeFile(OUTPUT_PATH, JSON.stringify(articles, null, 2), 'utf-8')

  console.log(`Saved ${articles.length} article entries to ${path.relative(process.cwd(), OUTPUT_PATH)}`)
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exitCode = 1
})
