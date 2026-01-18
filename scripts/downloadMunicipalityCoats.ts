import 'dotenv/config'
import { createWriteStream } from 'node:fs'
import { access, constants, mkdir, readFile, writeFile } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import path from 'node:path'
import { pipeline } from 'node:stream/promises'

type SparqlValue = {
  type: string
  value: string
}

type MunicipalityBinding = {
  municipality: SparqlValue
  coatOfArms: SparqlValue
}

type SparqlResponse = {
  results: {
    bindings: MunicipalityBinding[]
  }
}

type ManifestEntry = {
  relativePath: string
  originalUrl: string
  cantonId: string
}

type Manifest = Record<string, ManifestEntry>
type StatusError = Error & { statusCode?: number }

type MunicipalityRecord = {
  id: string
  label: string
  cantonId: string
}

type MunicipalityDataset = {
  municipalities: MunicipalityRecord[]
}

const endpoint = new URL('https://query.wikidata.org/sparql')
const DEFAULT_CANTON_ID = 'Q11943' // Zürich
const CHUNK_SIZE = 40

const { contactEmail, contactName } = (() => {
  const email = process.env.CONTACT_EMAIL
  const name = process.env.CONTACT_NAME
  if (!email || !name) {
    throw new Error('CONTACT_EMAIL and CONTACT_NAME must be defined in .env')
  }
  return { contactEmail: email, contactName: name }
})()
const USER_AGENT = `curl/8.0.1 (${contactName}; +mailto:${contactEmail})`
const coatRoot = path.resolve('public', 'municipality-coats')
const dataDir = path.resolve('public', 'data')
const datasetPath = path.join(dataDir, 'municipalities.json')
const manifestPath = path.join(dataDir, 'municipality-coats-manifest.json')

function parseArgs(): { cantonId: string; force: boolean } {
  let cantonId = DEFAULT_CANTON_ID
  let force = false

  for (const arg of process.argv.slice(2)) {
    if (arg === '--force') {
      force = true
    } else if (arg.startsWith('--canton=')) {
      cantonId = arg.split('=')[1] ?? DEFAULT_CANTON_ID
    } else if (!arg.startsWith('--')) {
      cantonId = arg
    }
  }

  if (!/^Q\d+$/.test(cantonId)) {
    throw new Error('Canton id must look like Q12345')
  }

  return { cantonId, force }
}

async function loadDataset(): Promise<MunicipalityDataset> {
  try {
    const file = await readFile(datasetPath, 'utf-8')
    return JSON.parse(file) as MunicipalityDataset
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Municipality dataset not found. Run npm run data:municipalities first.')
    }
    throw error
  }
}

async function loadManifest(): Promise<Manifest> {
  try {
    const content = await readFile(manifestPath, 'utf-8')
    return JSON.parse(content) as Manifest
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

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function buildQuery(municipalityIds: string[]): string {
  const values = municipalityIds.map(id => `wd:${id}`).join(' ')
  return `
SELECT ?municipality ?coatOfArms
WHERE {
  VALUES ?municipality { ${values} }
  ?municipality wdt:P94 ?coatOfArms.
}
`.trim()
}

function fetchBindings(ids: string[]): Promise<MunicipalityBinding[]> {
  const query = buildQuery(ids)
  return new Promise((resolve, reject) => {
    const req = httpsRequest(
      endpoint,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/sparql-query; charset=utf-8',
          Accept: 'application/sparql-results+json',
          'Content-Length': Buffer.byteLength(query, 'utf-8'),
          'User-Agent': USER_AGENT,
          From: contactEmail
        }
      },
      res => {
        if (!res.statusCode || res.statusCode >= 400) {
          reject(new Error(`Wikidata endpoint responded with ${res?.statusCode ?? 'unknown status'}`))
          return
        }

        const chunks: Buffer[] = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')) as SparqlResponse
            resolve(parsed.results.bindings)
          } catch (error) {
            reject(new Error('Failed to parse SPARQL response'))
          }
        })
      }
    )

    req.on('error', reject)
    req.write(query, 'utf-8')
    req.end()
  })
}

function normalizeImageUrl(url: string): string {
  if (url.startsWith('http://')) {
    return `https://${url.slice('http://'.length)}`
  }
  return url
}

function filenameFor(municipalityId: string, cantonId: string, coatUrl: string): {
  filename: string
  relativePath: string
} {
  const pathname = decodeURIComponent(new URL(coatUrl).pathname)
  const ext = path.extname(pathname) || '.svg'
  const filename = `${municipalityId}${ext}`
  return {
    filename,
    relativePath: path.posix.join('/municipality-coats', cantonId, filename)
  }
}

function relativePathToLocalFile(relativePath: string): string {
  const trimmed = relativePath.replace(/^\/+/, '')
  return path.resolve('public', trimmed)
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

async function downloadFile(url: string, destination: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const handleRequest = (currentUrl: string, redirectCount: number): void => {
      const targetUrl = new URL(currentUrl)
      const isHttps = targetUrl.protocol === 'https:'
      const client = isHttps ? httpsRequest : httpRequest
      const req = client(
        targetUrl,
        {
          headers: {
            'User-Agent': USER_AGENT,
            From: contactEmail
          }
        },
        res => {
          if (!res.statusCode) {
            reject(new Error('No status code received'))
            return
          }

          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            if (redirectCount >= 5) {
              reject(new Error('Too many redirects while downloading image'))
              return
            }
            const nextUrl = new URL(res.headers.location, currentUrl).toString()
            res.resume()
            handleRequest(nextUrl, redirectCount + 1)
            return
          }

          if (res.statusCode !== 200) {
            const err = new Error(`Unexpected status ${res.statusCode} while downloading ${currentUrl}`) as StatusError
            err.statusCode = res.statusCode
            reject(err)
            return
          }

          const fileStream = createWriteStream(destination)
          pipeline(res, fileStream).then(resolve).catch(reject)
        }
      )

      req.on('error', reject)
      req.end()
    }

    handleRequest(url, 0)
  })
}

function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function main(): Promise<void> {
  try {
    const { cantonId, force } = parseArgs()
    const dataset = await loadDataset()
    const manifest = await loadManifest()

    const targetMunicipalities = dataset.municipalities.filter(m => m.cantonId === cantonId)
    if (targetMunicipalities.length === 0) {
      throw new Error(`No municipalities found for canton ${cantonId}. Run npm run data:municipalities.`)
    }

    const municipalitiesToProcess = force
      ? targetMunicipalities
      : targetMunicipalities.filter(m => !manifest[m.id])

    if (municipalitiesToProcess.length === 0) {
      console.log(`All municipality coats for canton ${cantonId} are cached. Use --force to refresh.`)
      return
    }

    await mkdir(coatRoot, { recursive: true })
    await mkdir(path.join(coatRoot, cantonId), { recursive: true })
    await mkdir(dataDir, { recursive: true })

    let downloaded = 0

    for (const chunkMunicipalities of chunk(municipalitiesToProcess, CHUNK_SIZE)) {
      const ids = chunkMunicipalities.map(m => m.id)
      const bindings = await fetchBindings(ids)
      const coatMap = new Map<string, string>()

      for (const binding of bindings) {
        const municipalityId = binding.municipality.value.split('/').pop() as string
        coatMap.set(municipalityId, normalizeImageUrl(binding.coatOfArms.value))
      }

      for (const municipality of chunkMunicipalities) {
        const coatUrl = coatMap.get(municipality.id)
        if (!coatUrl) {
          console.warn(`No coat of arms found for ${municipality.label} (${municipality.id}); skipping.`)
          continue
        }

        const manifestEntry = manifest[municipality.id]
        const { relativePath } = manifestEntry ?? filenameFor(municipality.id, cantonId, coatUrl)
        const destination = relativePathToLocalFile(relativePath)

        if (manifestEntry && !force) {
          continue
        }

        const fileAlreadyExists = await fileExists(destination)
        if (!force && fileAlreadyExists) {
          manifest[municipality.id] = { relativePath, originalUrl: coatUrl, cantonId }
          await saveManifest(manifest)
          continue
        }

        let attempt = 0
        while (true) {
          try {
            await downloadFile(coatUrl, destination)
            manifest[municipality.id] = { relativePath, originalUrl: coatUrl, cantonId }
            await saveManifest(manifest)
            downloaded += 1
            console.log(`Saved ${municipality.label} (${municipality.id}) -> ${relativePath}`)
            const cooldown = 500 + Math.round(Math.random() * 300)
            await wait(cooldown)
            break
          } catch (error) {
            const statusCode = (error as StatusError).statusCode
            attempt += 1
            if (statusCode === 429 && attempt <= 8) {
              const delay = Math.min(2000 * attempt, 15000)
              console.warn(`Rate limited (${municipality.label}). Retrying in ${delay}ms...`)
              await wait(delay)
              continue
            }
            throw error
          }
        }
      }
    }

    console.log(
      `Municipality coats cached for canton ${cantonId}. ${downloaded} download(s) this run, manifest has ${
        Object.keys(manifest).length
      } entries.`
    )
  } catch (error) {
    console.error('Failed to download municipality coats of arms')
    if (error instanceof Error) {
      console.error(error.message)
    }
    process.exitCode = 1
  }
}

void main()
