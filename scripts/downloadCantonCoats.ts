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

type CantonBinding = {
  canton: SparqlValue
  cantonLabel: SparqlValue
  coatOfArms: SparqlValue
}

type SparqlResponse = {
  results: {
    bindings: CantonBinding[]
  }
}

type ManifestEntry = {
  relativePath: string
  originalUrl: string
}

type Manifest = Record<string, ManifestEntry>
type StatusError = Error & { statusCode?: number }

const endpoint = new URL('https://query.wikidata.org/sparql')
const { contactEmail, contactName } = (() => {
  const email = process.env.CONTACT_EMAIL
  const name = process.env.CONTACT_NAME
  if (!email || !name) {
    throw new Error('CONTACT_EMAIL and CONTACT_NAME must be defined in .env')
  }
  return { contactEmail: email, contactName: name }
})()
const USER_AGENT = `curl/8.0.1 (${contactName}; +mailto:${contactEmail})`
const coatDir = path.resolve('public', 'coat-of-arms')
const dataDir = path.resolve('public', 'data')
const manifestPath = path.join(dataDir, 'canton-coats-manifest.json')
const expectedCantonCount = 26
const forceDownload = process.argv.includes('--force')

const sparqlQuery = `
SELECT ?canton ?cantonLabel ?coatOfArms
WHERE {
  ?canton wdt:P31 wd:Q23058.
  ?canton wdt:P94 ?coatOfArms.
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de,fr,it,rm". }
}
ORDER BY ?cantonLabel
`.trim()

function extractEntityId(iri: string): string {
  const parts = iri.split('/')
  return parts[parts.length - 1]
}

function normalizeImageUrl(url: string): string {
  if (url.startsWith('http://')) {
    return `https://${url.slice('http://'.length)}`
  }
  return url
}

function filenameFor(id: string, coatUrl: string): { filename: string; relativePath: string } {
  const pathname = decodeURIComponent(new URL(coatUrl).pathname)
  const ext = path.extname(pathname) || '.svg'
  const filename = `${id}${ext}`
  return {
    filename,
    relativePath: path.posix.join('/coat-of-arms', filename)
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

function relativePathToLocalFile(relativePath: string): string {
  const trimmed = relativePath.replace(/^\/+/, '')
  return path.resolve('public', trimmed)
}

function fetchBindings(query: string): Promise<CantonBinding[]> {
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

async function main(): Promise<void> {
  try {
    const bindings = await fetchBindings(sparqlQuery)
    if (bindings.length === 0) {
      throw new Error('No canton coat-of-arms records returned')
    }

    await mkdir(coatDir, { recursive: true })
    await mkdir(dataDir, { recursive: true })
    const manifest = await loadManifest()
    let downloaded = 0

    for (const binding of bindings) {
      const cantonId = extractEntityId(binding.canton.value)
      const imageUrl = normalizeImageUrl(binding.coatOfArms.value)
      const manifestEntry = manifest[cantonId]
      const { relativePath } = manifestEntry ?? filenameFor(cantonId, imageUrl)
      const destination = relativePathToLocalFile(relativePath)
      const fileIsCached = await fileExists(destination)

      if (!forceDownload && fileIsCached) {
        if (!manifestEntry) {
          manifest[cantonId] = { relativePath, originalUrl: imageUrl }
          await saveManifest(manifest)
        }
        console.log(`Cached coat of arms already present for ${binding.cantonLabel.value}`)
        continue
      }

      let attempt = 0
      while (true) {
        try {
          await downloadFile(imageUrl, destination)
          downloaded += 1
          manifest[cantonId] = { relativePath, originalUrl: imageUrl }
          await saveManifest(manifest)
          console.log(`Downloaded coat of arms for ${binding.cantonLabel.value} -> ${relativePath}`)
          const cooldown = 2000 + Math.round(Math.random() * 500)
          await wait(cooldown)
          break
        } catch (error) {
          const statusCode = (error as StatusError).statusCode
          attempt += 1
          if (statusCode === 429 && attempt <= 8) {
            const delay = Math.min(2000 * attempt, 15000)
            console.warn(`Rate limited downloading ${binding.cantonLabel.value}. Retrying in ${delay}ms...`)
            await wait(delay)
            continue
          }
          throw error
        }
      }
    }

    const missingCantons = bindings
      .map(binding => extractEntityId(binding.canton.value))
      .filter(id => !manifest[id])
    if (missingCantons.length > 0 || Object.keys(manifest).length !== expectedCantonCount) {
      throw new Error('Manifest is missing one or more cantons. Run the script again with --force.')
    }

    console.log(
      `Coat-of-arms cache updated at ${path.relative(process.cwd(), coatDir)} (${downloaded} downloads this run)`
    )
  } catch (error) {
    console.error('Failed to download canton coat-of-arms images')
    if (error instanceof Error) {
      console.error(error.message)
    }
    process.exitCode = 1
  }
}

void main()
