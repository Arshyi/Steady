// The dashboard's side of the Steady backend (web/).
//
// The board posts surveys, location matches and acknowledgements to the Worker
// even when no browser is open; this reads them back and labels surveys. Both
// the address and the key can be overridden per browser without a rebuild, which
// is how a deployed dashboard is pointed at its own Worker:
//
//   localStorage.setItem('steady.apiUrl', 'https://steady.example.workers.dev')
//   localStorage.setItem('steady.viewKey', '…')
//
// The defaults match web/.dev.vars, so `wrangler dev` plus `npm run dev` works
// with no setup.

type Env = Record<string, string | undefined>

function envValue(key: string): string | undefined {
  try {
    const meta = import.meta as ImportMeta & { env?: Env }
    return meta.env?.[key]
  } catch {
    return undefined
  }
}

function stored(key: string): string | undefined {
  try {
    return localStorage.getItem(key) ?? undefined
  } catch {
    return undefined
  }
}

export const API_BASE = (
  stored('steady.apiUrl') ??
  envValue('VITE_STEADY_API') ??
  'http://127.0.0.1:8787'
).replace(/\/+$/, '')

const VIEW_KEY = stored('steady.viewKey') ?? envValue('VITE_STEADY_KEY') ?? 'dev-view-key'

export interface SurveyRow {
  id: number
  uid: string
  device: string
  taken_at: number
  scan_count: number
  access_points: number
  room: string | null
  floor: string | null
  labelled_at: number | null
  samples: number
}

export interface LocationRow {
  device: string
  room: string | null
  floor: string | null
  confidence: number | null
  distance: number | null
  matched: number | null
  ts: number
}

export interface AckRow {
  id: number
  device: string
  kind: 'ok' | 'nfc'
  tag: string | null
  ts: number
}

async function call<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers:
      body === undefined
        ? { 'x-view-key': VIEW_KEY }
        : { 'x-view-key': VIEW_KEY, 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const raw = await response.text()
  let parsed: unknown
  try {
    parsed = raw ? JSON.parse(raw) : {}
  } catch {
    parsed = { error: raw.slice(0, 200) }
  }

  if (!response.ok) {
    const message = (parsed as { error?: string }).error ?? `HTTP ${response.status}`
    throw new Error(`${message} (${API_BASE})`)
  }
  return parsed as T
}

export const steadyApi = {
  surveys: (device?: string) =>
    call<{ surveys: SurveyRow[] }>(
      `/api/v1/surveys?limit=25${device ? `&device=${encodeURIComponent(device)}` : ''}`,
    ),
  labelSurvey: (id: number, room: string, floor: string) =>
    call<{ ok: boolean; room: string; floor: string | null }>(`/api/v1/surveys/${id}/label`, { room, floor }),
  location: (device: string) =>
    call<{ location: LocationRow | null }>(`/api/v1/location?device=${encodeURIComponent(device)}`),
  acks: () => call<{ acks: AckRow[] }>('/api/v1/acks?limit=8'),
}
