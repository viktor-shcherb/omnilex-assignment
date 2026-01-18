import 'dotenv/config'
import { createWriteStream } from 'node:fs'
import { mkdir, readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { finished } from 'node:stream/promises'
import { Docling } from 'docling-sdk'
import type { DoclingAPIClient } from 'docling-sdk'
import { PDFDocument } from 'pdf-lib'

type CommonCliOptions = {
  doclingUrl: string
  timeoutMs: number
  force: boolean
  maxPages: number
}

type SingleCliOptions = CommonCliOptions & {
  mode: 'single'
  inputPath: string
  outputPath: string
}

type DirectoryCliOptions = CommonCliOptions & {
  mode: 'dir'
  dirPath: string
}

type CliOptions = SingleCliOptions | DirectoryCliOptions

const DEFAULT_DOCLING_URL = process.env.DOCLING_URL ?? 'http://127.0.0.1:5001'
const parsedTimeout = Number(process.env.DOCLING_TIMEOUT_MS ?? 300_000)
const DEFAULT_TIMEOUT_MS = Number.isNaN(parsedTimeout) ? 300_000 : parsedTimeout
const DEFAULT_GEMEINDEORDNUNGEN_DIR = path.resolve('public', 'gemeindeordnungen')
const parsedMaxPages = Number(process.env.DOCLING_MAX_PAGES ?? 5)
const DEFAULT_MAX_PAGES = Number.isNaN(parsedMaxPages) ? 5 : parsedMaxPages
type DoclingClient = DoclingAPIClient
type Canton = { id: string; label: string }
type Municipality = { id: string; label: string; cantonId: string }
type MunicipalityDataset = { cantons: Canton[]; municipalities: Municipality[] }
const dataDir = path.resolve('public', 'data')
const datasetPath = path.join(dataDir, 'municipalities.json')

type RawCliArgs = {
  inputArg?: string
  outputArg?: string
  outputDirArg?: string
  dirArg?: string
  convertAll: boolean
  doclingUrl: string
  timeoutMs: number
  force: boolean
  cantonArg?: string
  municipalityArg?: string
  maxPages: number
}

function parseArgs(): RawCliArgs {
  const args = process.argv.slice(2)
  let inputArg: string | undefined
  let outputArg: string | undefined
  let outputDirArg: string | undefined
  let dirArg: string | undefined
  let convertAll = false
  let doclingUrl = DEFAULT_DOCLING_URL
  let timeoutMs = DEFAULT_TIMEOUT_MS
  let force = false
  let cantonArg: string | undefined
  let municipalityArg: string | undefined
  let maxPages = DEFAULT_MAX_PAGES

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '--force') {
      force = true
      continue
    }
    if (arg === '--input' && args[i + 1]) {
      inputArg = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--input=')) {
      inputArg = arg.slice('--input='.length)
      continue
    }
    if (arg === '--output' && args[i + 1]) {
      outputArg = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--output=')) {
      outputArg = arg.slice('--output='.length)
      continue
    }
    if (arg === '--output-dir' && args[i + 1]) {
      outputDirArg = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--output-dir=')) {
      outputDirArg = arg.slice('--output-dir='.length)
      continue
    }
    if (
      (arg === '--dir' || arg === '--directory' || arg === '--input-dir') &&
      args[i + 1]
    ) {
      dirArg = args[i + 1]
      i += 1
      continue
    }
    if (
      arg.startsWith('--dir=') ||
      arg.startsWith('--directory=') ||
      arg.startsWith('--input-dir=')
    ) {
      const [, value] = arg.split('=')
      dirArg = value
      continue
    }
    if (arg === '--all') {
      convertAll = true
      continue
    }
    if (arg === '--canton' && args[i + 1]) {
      cantonArg = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--canton=')) {
      cantonArg = arg.slice('--canton='.length)
      continue
    }
    if (arg === '--municipality' && args[i + 1]) {
      municipalityArg = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--municipality=')) {
      municipalityArg = arg.slice('--municipality='.length)
      continue
    }
    if (arg === '--docling-url' && args[i + 1]) {
      doclingUrl = args[i + 1]
      i += 1
      continue
    }
    if (arg.startsWith('--docling-url=')) {
      doclingUrl = arg.slice('--docling-url='.length)
      continue
    }
    if (arg === '--timeout' && args[i + 1]) {
      timeoutMs = Number(args[i + 1])
      i += 1
      continue
    }
    if (arg.startsWith('--timeout=')) {
      timeoutMs = Number(arg.slice('--timeout='.length))
      continue
    }
    if (arg === '--max-pages' && args[i + 1]) {
      maxPages = Number(args[i + 1])
      i += 1
      continue
    }
    if (arg.startsWith('--max-pages=')) {
      maxPages = Number(arg.slice('--max-pages='.length))
      continue
    }
    if (!arg.startsWith('--')) {
      if (!inputArg) {
        inputArg = arg
      } else if (!outputArg) {
        outputArg = arg
      } else {
        throw new Error(`Unexpected positional argument: ${arg}`)
      }
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  if (Number.isNaN(timeoutMs) || timeoutMs <= 0) {
    throw new Error('Timeout must be a positive number of milliseconds')
  }
  if (Number.isNaN(maxPages) || maxPages <= 0) {
    throw new Error('Max pages must be a positive number')
  }

  return {
    inputArg,
    outputArg,
    outputDirArg,
    dirArg,
    convertAll,
    doclingUrl,
    timeoutMs,
    force,
    cantonArg,
    municipalityArg,
    maxPages
  }
}

async function loadDataset(): Promise<MunicipalityDataset> {
  try {
    const raw = await readFile(datasetPath, 'utf8')
    return JSON.parse(raw) as MunicipalityDataset
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(
        `Municipality dataset not found at ${datasetPath}. Run npm run data:municipalities before converting.`
      )
    }
    throw error
  }
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

function computeOutputPath(inputPath: string, outputArg?: string, outputDirArg?: string): string {
  if (outputArg !== undefined) {
    return path.resolve(outputArg)
  }
  const outputDir = outputDirArg ? path.resolve(outputDirArg) : path.dirname(inputPath)
  return path.join(outputDir, `${path.parse(inputPath).name}.md`)
}

async function resolveCliOptions(raw: RawCliArgs): Promise<CliOptions> {
  const {
    inputArg,
    outputArg,
    outputDirArg,
    doclingUrl,
    timeoutMs,
    force,
    municipalityArg,
    maxPages
  } = raw
  let dirArg = raw.dirArg

  if (raw.convertAll && !dirArg) {
    dirArg = DEFAULT_GEMEINDEORDNUNGEN_DIR
  }

  if (raw.cantonArg && (inputArg || dirArg)) {
    throw new Error('Cannot combine --canton with --input or --dir.')
  }

  if (dirArg && (outputArg || outputDirArg)) {
    throw new Error('Cannot use --output or --output-dir when converting a directory.')
  }

  if (raw.cantonArg) {
    const dataset = await loadDataset()
    const canton =
      findByLabel(dataset.cantons, raw.cantonArg) ??
      dataset.cantons.find(c => normalizeLabel(c.id) === normalizeLabel(raw.cantonArg as string))

    if (!canton) {
      throw new Error(`Canton "${raw.cantonArg}" not found in dataset.`)
    }

    if (municipalityArg) {
      const municipality =
        dataset.municipalities.find(
          m => m.cantonId === canton.id && normalizeLabel(m.label) === normalizeLabel(municipalityArg)
        ) ??
        dataset.municipalities.find(
          m => m.cantonId === canton.id && normalizeLabel(m.label).includes(normalizeLabel(municipalityArg))
        ) ??
        dataset.municipalities.find(
          m => m.cantonId === canton.id && normalizeLabel(m.id) === normalizeLabel(municipalityArg)
        )

      if (!municipality) {
        throw new Error(`Municipality "${municipalityArg}" not found in canton ${canton.label}.`)
      }

      const inputPath = path.resolve(DEFAULT_GEMEINDEORDNUNGEN_DIR, canton.id, `${municipality.id}.pdf`)
      const outputPath = computeOutputPath(inputPath, outputArg, outputDirArg)
      return {
        mode: 'single',
        inputPath,
        outputPath,
        doclingUrl,
        timeoutMs,
        force,
        maxPages
      }
    }

    const dirPath = path.resolve(DEFAULT_GEMEINDEORDNUNGEN_DIR, canton.id)
    return {
      mode: 'dir',
      dirPath,
      doclingUrl,
      timeoutMs,
      force,
      maxPages
    }
  }

  if (dirArg) {
    return {
      mode: 'dir',
      dirPath: path.resolve(dirArg),
      doclingUrl,
      timeoutMs,
      force,
      maxPages
    }
  }

  if (!inputArg) {
    throw new Error(
      'Missing input PDF. Use --input path/to/file.pdf for single conversions, --dir /path/to/dir (or --all) for batch mode, or pass --canton "Name" to target a canton.'
    )
  }

  const inputPath = path.resolve(inputArg)
  const outputPath = computeOutputPath(inputPath, outputArg, outputDirArg)
  return {
    mode: 'single',
    inputPath,
    outputPath,
    doclingUrl,
    timeoutMs,
    force,
    maxPages
  }
}

async function ensureInputFile(filePath: string): Promise<void> {
  try {
    const fileStat = await stat(filePath)
    if (!fileStat.isFile()) {
      throw new Error(`Input path is not a file: ${filePath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Input file not found: ${filePath}`)
    }
    throw error
  }
}

async function ensureInputDirectory(dirPath: string): Promise<void> {
  try {
    const dirStat = await stat(dirPath)
    if (!dirStat.isDirectory()) {
      throw new Error(`Input path is not a directory: ${dirPath}`)
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`Input directory not found: ${dirPath}`)
    }
    throw error
  }
}

async function ensureOutputPath(
  outputPath: string,
  force: boolean,
  strict: boolean
): Promise<boolean> {
  try {
    const outputStat = await stat(outputPath)
    if (outputStat.isDirectory()) {
      throw new Error(`Output path points to a directory: ${outputPath}`)
    }
    if (!force) {
      const message = `Output file already exists: ${outputPath}`
      if (strict) {
        throw new Error(`${message}. Use --force to overwrite.`)
      } else {
        console.warn(`${message}. Skipping. Use --force to overwrite.`)
        return false
      }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error
    }
  }

  await mkdir(path.dirname(outputPath), { recursive: true })
  return true
}

async function collectPdfFiles(dirPath: string): Promise<string[]> {
  const pdfFiles: string[] = []

  async function walk(currentDir: string): Promise<void> {
    const entries = await readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(currentDir, entry.name)
      if (entry.isDirectory()) {
        await walk(entryPath)
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.pdf')) {
        pdfFiles.push(entryPath)
      }
    }
  }

  await walk(dirPath)
  pdfFiles.sort()
  return pdfFiles
}

function createDoclingClient(doclingUrl: string, timeoutMs: number): DoclingClient {
  return new Docling({
    api: { baseUrl: doclingUrl, timeout: timeoutMs }
  })
}

type TruncateResult = {
  buffer: Buffer
  truncated: boolean
  originalPages: number
  keptPages: number
}

async function truncatePdf(buffer: Buffer, maxPages: number): Promise<TruncateResult> {
  const pdfDoc = await PDFDocument.load(buffer)
  const originalPages = pdfDoc.getPageCount()
  if (originalPages <= maxPages) {
    return { buffer, truncated: false, originalPages, keptPages: originalPages }
  }
  const targetDoc = await PDFDocument.create()
  const indices = Array.from({ length: Math.min(maxPages, originalPages) }, (_, index) => index)
  const copiedPages = await targetDoc.copyPages(pdfDoc, indices)
  for (const page of copiedPages) {
    targetDoc.addPage(page)
  }
  const truncatedBytes = await targetDoc.save()
  return {
    buffer: Buffer.from(truncatedBytes),
    truncated: true,
    originalPages,
    keptPages: indices.length
  }
}

async function convertFile(
  client: DoclingClient,
  inputPath: string,
  outputPath: string,
  maxPages: number
): Promise<void> {
  const pdfBuffer = await readFile(inputPath)
  const { buffer: truncatedBuffer, truncated, originalPages, keptPages } = await truncatePdf(
    pdfBuffer,
    maxPages
  )
  if (truncated) {
    console.log(`Trimmed ${path.basename(inputPath)} from ${originalPages} to ${keptPages} pages`)
  }
  const writeStream = createWriteStream(outputPath, { encoding: 'utf8' })
  const writeFinished = finished(writeStream).catch(error => {
    writeStream.destroy()
    throw error
  })

  await client.convertToStream(truncatedBuffer, path.basename(inputPath), writeStream, {
    to_formats: ['md']
  })
  await writeFinished
}

async function convertSingle(options: SingleCliOptions): Promise<void> {
  await ensureInputFile(options.inputPath)
  const shouldWrite = await ensureOutputPath(options.outputPath, options.force, true)
  if (!shouldWrite) {
    return
  }

  const client = createDoclingClient(options.doclingUrl, options.timeoutMs)
  console.log(`Converting ${options.inputPath} -> ${options.outputPath}`)
  await convertFile(client, options.inputPath, options.outputPath, options.maxPages)
  console.log(`Markdown saved to ${options.outputPath}`)
}

async function convertDirectory(options: DirectoryCliOptions): Promise<void> {
  await ensureInputDirectory(options.dirPath)
  const pdfFiles = await collectPdfFiles(options.dirPath)

  if (pdfFiles.length === 0) {
    console.log(`No PDF files found inside ${options.dirPath}`)
    return
  }

  const client = createDoclingClient(options.doclingUrl, options.timeoutMs)
  let converted = 0
  let skippedExisting = 0
  let failed = 0

  for (const pdfPath of pdfFiles) {
    const outputPath = path.join(
      path.dirname(pdfPath),
      `${path.parse(pdfPath).name}.md`
    )
    const shouldWrite = await ensureOutputPath(outputPath, options.force, false)
    if (!shouldWrite) {
      skippedExisting += 1
      continue
    }

    try {
      console.log(`Converting ${pdfPath} -> ${outputPath}`)
      await convertFile(client, pdfPath, outputPath, options.maxPages)
      converted += 1
      console.log(`✔ Converted ${pdfPath}`)
    } catch (error) {
      failed += 1
      console.error(`✖ Failed to convert ${pdfPath}: ${(error as Error).message}`)
    }
  }

  console.log(
    `Finished directory conversion. Converted: ${converted}, skipped existing: ${skippedExisting}, failed: ${failed}, total PDFs: ${pdfFiles.length}.`
  )
}

async function main(): Promise<void> {
  try {
    const rawArgs = parseArgs()
    const options = await resolveCliOptions(rawArgs)
    if (options.mode === 'single') {
      await convertSingle(options)
    } else {
      await convertDirectory(options)
    }
  } catch (error) {
    console.error((error as Error).message)
    process.exitCode = 1
  }
}

void main()
