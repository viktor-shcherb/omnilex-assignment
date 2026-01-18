import 'dotenv/config'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { request } from 'node:https'
import path from 'node:path'

type SparqlValue = {
  type: string
  value: string
}

type MunicipalityBinding = {
  municipality: SparqlValue
  municipalityLabel: SparqlValue
  canton: SparqlValue
  cantonLabel: SparqlValue
}

type SparqlResponse = {
  results: {
    bindings: MunicipalityBinding[]
  }
}

type CantonCoatManifest = Record<string, { relativePath: string; originalUrl: string }>

type CantonRecord = {
  id: string
  label: string
  coatOfArmsImage?: string
}

type MunicipalityRecord = {
  id: string
  label: string
  cantonId: string
}

type DataSet = {
  fetchedAt: string
  cantonCount: number
  municipalityCount: number
  cantons: CantonRecord[]
  municipalities: MunicipalityRecord[]
}

const endpoint = new URL('https://query.wikidata.org/sparql')
const expectedCantonCount = 26
const { contactEmail, contactName } = (() => {
  const email = process.env.CONTACT_EMAIL
  const name = process.env.CONTACT_NAME
  if (!email || !name) {
    throw new Error('CONTACT_EMAIL and CONTACT_NAME must be defined in .env')
  }
  return { contactEmail: email, contactName: name }
})()
const USER_AGENT = `curl/8.0.1 (${contactName}; +mailto:${contactEmail})`
const dataDir = path.resolve('public', 'data')
const csvPath = path.join(dataDir, 'municipalities.csv')
const jsonPath = path.join(dataDir, 'municipalities.json')
const cantonManifestPath = path.join(dataDir, 'canton-coats-manifest.json')

const sparqlQuery = `
SELECT DISTINCT ?municipality ?municipalityLabel ?canton ?cantonLabel
WHERE {
  ?municipality wdt:P31 wd:Q70208.
  ?municipality wdt:P131* ?canton.
  ?canton wdt:P31 wd:Q23058.
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,de,fr,it,rm". }
}
ORDER BY ?cantonLabel ?municipalityLabel
`.trim()

function runSparql(query: string): Promise<MunicipalityBinding[]> {
  return new Promise((resolve, reject) => {
    const req = request(
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

async function loadManifest<T>(targetPath: string): Promise<T> {
  try {
    const file = await readFile(targetPath, 'utf-8')
    return JSON.parse(file) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {} as T
    }
    throw error
  }
}

function extractEntityId(iri: string): string {
  const parts = iri.split('/')
  return parts[parts.length - 1]
}

function bindingsToRecords(bindings: MunicipalityBinding[], cantonManifest: CantonCoatManifest): DataSet {
  const cantons = new Map<string, CantonRecord>()
  const municipalities: MunicipalityRecord[] = []
  const seenMunicipalities = new Set<string>()

  for (const binding of bindings) {
    const cantonId = extractEntityId(binding.canton.value)
    const municipalityId = extractEntityId(binding.municipality.value)

    if (!cantons.has(cantonId)) {
      const manifestEntry = cantonManifest[cantonId]
      cantons.set(cantonId, {
        id: cantonId,
        label: binding.cantonLabel.value,
        coatOfArmsImage: manifestEntry?.relativePath
      })
    }

    if (!seenMunicipalities.has(municipalityId)) {
      municipalities.push({
        id: municipalityId,
        label: binding.municipalityLabel.value,
        cantonId
      })
      seenMunicipalities.add(municipalityId)
    }
  }

  if (cantons.size !== expectedCantonCount) {
    throw new Error(`Expected ${expectedCantonCount} cantons but received ${cantons.size}`)
  }

  const sortedCantons = [...cantons.values()].sort((a, b) => a.label.localeCompare(b.label))
  const sortedMunicipalities = municipalities.sort((a, b) => a.label.localeCompare(b.label))

  return {
    fetchedAt: new Date().toISOString(),
    cantonCount: sortedCantons.length,
    municipalityCount: sortedMunicipalities.length,
    cantons: sortedCantons,
    municipalities: sortedMunicipalities
  }
}

function escapeCsvValue(value: string): string {
  if (!value) return ''
  const sanitized = value.replace(/\r?\n/g, ' ')
  if (/[",]/.test(sanitized)) {
    return `"${sanitized.replace(/"/g, '""')}"`
  }
  return sanitized
}

function asCsv(data: DataSet): string {
  const header = 'cantonId,cantonLabel,municipalityId,municipalityLabel'
  const rows = data.municipalities.map(municipality => {
    const canton = data.cantons.find(c => c.id === municipality.cantonId)
    return [municipality.cantonId, canton?.label ?? '', municipality.id, municipality.label]
      .map(escapeCsvValue)
      .join(',')
  })
  return [header, ...rows].join('\n')
}

async function main(): Promise<void> {
  try {
    const [bindings, cantonManifest] = await Promise.all([
      runSparql(sparqlQuery),
      loadManifest<CantonCoatManifest>(cantonManifestPath)
    ])
    const dataset = bindingsToRecords(bindings, cantonManifest)
    const csv = asCsv(dataset)

    await mkdir(dataDir, { recursive: true })
    await Promise.all([
      writeFile(csvPath, csv, 'utf-8'),
      writeFile(jsonPath, JSON.stringify(dataset, null, 2), 'utf-8')
    ])

    console.log(
      `Saved ${dataset.municipalityCount} municipalities from ${dataset.cantonCount} cantons to ${path.relative(
        process.cwd(),
        dataDir
      )}`
    )
  } catch (error) {
    console.error('Failed to fetch municipality data')
    if (error instanceof Error) {
      console.error(error.message)
    }
    process.exitCode = 1
  }
}

void main()
