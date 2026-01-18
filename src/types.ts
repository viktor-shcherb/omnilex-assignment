export type Canton = {
  id: string
  label: string
  coatOfArmsImage?: string
}

export type Municipality = {
  id: string
  label: string
  cantonId: string
}

export type MunicipalityDataset = {
  fetchedAt: string
  cantonCount: number
  municipalityCount: number
  cantons: Canton[]
  municipalities: Municipality[]
}

export type MunicipalityCoatManifest = Record<
  string,
  {
    relativePath: string
    originalUrl: string
    cantonId: string
  }
>

export type GemeindeordnungManifest = Record<
  string,
  {
    relativePath: string
    sourceUrl: string
    cantonId: string
    title?: string
    downloadedAt: string
  }
>

export type GemeindeordnungArticle = {
  municipality: string
  law: string
  article_citation: string
  article_content: string
  url: string
}
