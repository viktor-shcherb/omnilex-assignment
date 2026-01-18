import { useCallback, useEffect, useMemo, useState } from 'react'
import {
  Alert,
  Box,
  Button,
  Card,
  CardContent,
  CircularProgress,
  Container,
  FormControl,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Typography
} from '@mui/material'
import type {
  Canton,
  GemeindeordnungArticle,
  GemeindeordnungManifest,
  Municipality,
  MunicipalityCoatManifest,
  MunicipalityDataset
} from './types'

const DATA_URL = '/data/municipalities.json'
const MUNICIPALITY_MANIFEST_URL = '/data/municipality-coats-manifest.json'
const GEMEINDEORDNUNG_MANIFEST_URL = '/data/gemeindeordnung-manifest.json'
const GEMEINDEORDNUNG_ARTICLES_URL = '/data/gemeindeordnung-articles.json'

const normalize = (value: string): string => value.normalize('NFKC').trim().toLowerCase()

type FetchState = 'idle' | 'loading' | 'error'

export default function App(): JSX.Element {
  const [dataset, setDataset] = useState<MunicipalityDataset | null>(null)
  const [cantonId, setCantonId] = useState('')
  const [municipalityId, setMunicipalityId] = useState('')
  const [status, setStatus] = useState<FetchState>('idle')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [municipalityCoats, setMunicipalityCoats] = useState<MunicipalityCoatManifest>({})
  const [gemeindeordnungManifest, setGemeindeordnungManifest] = useState<GemeindeordnungManifest>({})
  const [gemeindeordnungArticles, setGemeindeordnungArticles] = useState<GemeindeordnungArticle[]>([])

  const loadData = useCallback(async () => {
    setStatus('loading')
    setErrorMessage(null)
    try {
      const timestamp = Date.now()
      const [datasetResponse, coatManifestResponse, goManifestResponse, goArticlesResponse] = await Promise.all([
        fetch(`${DATA_URL}?ts=${timestamp}`),
        fetch(`${MUNICIPALITY_MANIFEST_URL}?ts=${timestamp}`),
        fetch(`${GEMEINDEORDNUNG_MANIFEST_URL}?ts=${timestamp}`),
        fetch(`${GEMEINDEORDNUNG_ARTICLES_URL}?ts=${timestamp}`)
      ])

      if (!datasetResponse.ok) {
        throw new Error(`Unable to load dataset (status ${datasetResponse.status})`)
      }

      const body = (await datasetResponse.json()) as MunicipalityDataset
      let coatManifest: MunicipalityCoatManifest = {}
      if (coatManifestResponse.ok) {
        coatManifest = (await coatManifestResponse.json()) as MunicipalityCoatManifest
      } else if (coatManifestResponse.status !== 404) {
        throw new Error(`Unable to load municipality coat cache (status ${coatManifestResponse.status})`)
      }

      let goManifest: GemeindeordnungManifest = {}
      if (goManifestResponse.ok) {
        goManifest = (await goManifestResponse.json()) as GemeindeordnungManifest
      } else if (goManifestResponse.status !== 404) {
        throw new Error(`Unable to load Gemeindeordnung cache (status ${goManifestResponse.status})`)
      }

      let goArticles: GemeindeordnungArticle[] = []
      if (goArticlesResponse.ok) {
        goArticles = (await goArticlesResponse.json()) as GemeindeordnungArticle[]
      } else if (goArticlesResponse.status !== 404) {
        throw new Error(`Unable to load Gemeindeordnung articles (status ${goArticlesResponse.status})`)
      }

      setDataset(body)
      setMunicipalityCoats(coatManifest)
      setGemeindeordnungManifest(goManifest)
      setGemeindeordnungArticles(goArticles)

      setCantonId(previous => (body.cantons.some(canton => canton.id === previous) ? previous : ''))
      setMunicipalityId('')
      setStatus('idle')
    } catch (error) {
      setStatus('error')
      setErrorMessage(error instanceof Error ? error.message : 'Unknown error while loading data')
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  const cantons = dataset?.cantons ?? []
  const municipalities = useMemo(() => {
    if (!dataset || !cantonId) return []
    return dataset.municipalities.filter(municipality => municipality.cantonId === cantonId)
  }, [dataset, cantonId])

  const selectedCanton: Canton | undefined = cantons.find(canton => canton.id === cantonId)
  const selectedMunicipality: Municipality | undefined = municipalities.find(m => m.id === municipalityId)
  const selectedMunicipalityCoat = selectedMunicipality
    ? municipalityCoats[selectedMunicipality.id]?.relativePath
    : undefined
  const selectedGemeindeordnung = selectedMunicipality
    ? gemeindeordnungManifest[selectedMunicipality.id]
    : undefined
  const selectedArticles = useMemo(() => {
    if (!selectedMunicipality) return []
    return gemeindeordnungArticles.filter(
      article => normalize(article.municipality) === normalize(selectedMunicipality.label)
    )
  }, [gemeindeordnungArticles, selectedMunicipality])

  return (
    <Container maxWidth="md" sx={{ py: 4 }}>
      <Stack spacing={3}>
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Box>
            <Typography variant="h4" component="h1">
              Swiss Municipalities
            </Typography>
            <Typography variant="body2" color="text.secondary">
              {dataset ? `Last updated ${new Date(dataset.fetchedAt).toLocaleString()}` : 'Loading data...'}
            </Typography>
          </Box>
          <Button variant="contained" onClick={() => void loadData()} disabled={status === 'loading'}>
            {status === 'loading' ? 'Refreshing...' : 'Refresh Data'}
          </Button>
        </Stack>

        {status === 'error' && errorMessage ? <Alert severity="error">{errorMessage}</Alert> : null}

        {!dataset && status === 'loading' ? (
          <Stack direction="row" justifyContent="center" alignItems="center" spacing={2} sx={{ py: 4 }}>
            <CircularProgress size={32} />
            <Typography>Fetching municipalities from Wikidata…</Typography>
          </Stack>
        ) : null}

        <Stack direction={{ xs: 'column', md: 'row' }} spacing={2}>
          <FormControl fullWidth>
            <InputLabel id="canton-selector-label">Canton</InputLabel>
            <Select
              labelId="canton-selector-label"
              label="Canton"
              value={cantonId}
              onChange={event => {
                setCantonId(event.target.value)
                setMunicipalityId('')
              }}
              disabled={!dataset}
            >
              <MenuItem value="">
                <em>Select a canton</em>
              </MenuItem>
              {cantons.map(canton => (
                <MenuItem key={canton.id} value={canton.id}>
                  <Box display="flex" alignItems="center" justifyContent="space-between" width="100%" gap={2}>
                    <Typography component="span">{canton.label}</Typography>
                    {canton.coatOfArmsImage ? (
                      <Box
                        component="img"
                        src={canton.coatOfArmsImage}
                        alt={`${canton.label} coat of arms`}
                        sx={{ width: 36, height: 36, objectFit: 'contain' }}
                      />
                    ) : null}
                  </Box>
                </MenuItem>
              ))}
            </Select>
          </FormControl>

          <FormControl fullWidth disabled={!cantonId}>
            <InputLabel id="municipality-selector-label">Municipality</InputLabel>
            <Select
              labelId="municipality-selector-label"
              label="Municipality"
              value={municipalityId}
              onChange={event => setMunicipalityId(event.target.value)}
            >
              <MenuItem value="">
                <em>Select a municipality</em>
              </MenuItem>
              {municipalities.map(municipality => {
                const coat = municipalityCoats[municipality.id]?.relativePath
                return (
                  <MenuItem key={municipality.id} value={municipality.id}>
                    <Box display="flex" alignItems="center" justifyContent="space-between" width="100%" gap={2}>
                      <Typography component="span">{municipality.label}</Typography>
                      {coat ? (
                        <Box
                          component="img"
                          src={coat}
                          alt={`${municipality.label} coat of arms`}
                          sx={{ width: 32, height: 32, objectFit: 'contain' }}
                        />
                      ) : null}
                    </Box>
                  </MenuItem>
                )
              })}
            </Select>
          </FormControl>
        </Stack>

        <Card variant="outlined">
          <CardContent>
            {selectedMunicipality ? (
              <Stack spacing={2}>
                <Typography variant="h6">{selectedMunicipality.label}</Typography>
                {selectedGemeindeordnung ? (
                  <Button
                    component="a"
                    href={selectedGemeindeordnung.relativePath}
                    target="_blank"
                    rel="noreferrer"
                    variant="outlined"
                  >
                    View Gemeindeordnung PDF
                  </Button>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    Gemeindeordnung PDF not cached yet. Run npm run data:gemeindeordnung to fetch it.
                  </Typography>
                )}
                {selectedArticles.length > 0 ? (
                  <Stack spacing={2}>
                    <Typography variant="subtitle1">Articles</Typography>
                    {selectedArticles.map((article, index) => (
                      <Box key={`${article.article_citation}-${index}`} sx={{ borderLeft: '4px solid', borderColor: 'divider', pl: 2 }}>
                        <Typography variant="subtitle2" gutterBottom>
                          {article.article_citation}
                        </Typography>
                        <Typography variant="body2" sx={{ whiteSpace: 'pre-line' }}>
                          {article.article_content}
                        </Typography>
                        <Typography variant="caption" color="text.secondary">
                          {article.law}
                        </Typography>
                      </Box>
                    ))}
                  </Stack>
                ) : (
                  <Typography variant="body2" color="text.secondary">
                    Articles will appear after running npm run data:gemeindeordnung-articles for this municipality.
                  </Typography>
                )}
                <Typography variant="body2" color="text.secondary">
                  Data placeholder for municipality-specific details will appear here.
                </Typography>
              </Stack>
            ) : (
              <Box
                sx={{
                  minHeight: 180,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  textAlign: 'center'
                }}
              >
                <Typography color="text.secondary">
                  Select a canton and municipality to see detailed information once it becomes available.
                </Typography>
              </Box>
            )}
          </CardContent>
        </Card>
      </Stack>
    </Container>
  )
}
