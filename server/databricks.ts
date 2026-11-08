// Talks to Databricks through the SQL Statement Execution API.
// Auth comes from the Databricks CLI login on this machine (`databricks auth login`),
// so no tokens are stored in the project.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const HOST = (process.env.DATABRICKS_HOST ?? '').replace(/\/$/, '')
export const WAREHOUSE_ID = process.env.DATABRICKS_WAREHOUSE_ID ?? ''
/** catalog.schema the Steady tables live in */
export const SCHEMA = process.env.DATABRICKS_SCHEMA ?? 'workspace.steady'

/** True when server/.env has what the SQL Statement API needs */
export const configured = Boolean(HOST && WAREHOUSE_ID)

let cached: { token: string; expires: number } | undefined

async function token(): Promise<string> {
  if (!configured) throw new Error('Set DATABRICKS_HOST and DATABRICKS_WAREHOUSE_ID in server/.env (see server/.env.example)')
  if (cached && Date.now() < cached.expires - 60_000) return cached.token
  const { stdout } = await run('databricks', ['auth', 'token', '--host', HOST, '-o', 'json'])
  const d = JSON.parse(stdout) as { access_token: string; expiry: string }
  cached = { token: d.access_token, expires: new Date(d.expiry).getTime() }
  return cached.token
}

// Loose shape of Databricks API responses
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any

async function call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<Json> {
  const res = await fetch(HOST + path, {
    method,
    headers: { Authorization: `Bearer ${await token()}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json: Json = await res.json()
  if (!res.ok) throw new Error(json.message ?? `Databricks ${res.status}`)
  return json
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

type Value = string | number | null
export type Row = Record<string, Value>

/**
 * Run one SQL statement and return rows as objects.
 * Use :name placeholders with `params` for values that come from outside.
 */
export async function sql(statement: string, params: Record<string, string | number | null> = {}): Promise<Row[]> {
  let res = await call('POST', '/api/2.0/sql/statements', {
    warehouse_id: WAREHOUSE_ID,
    statement,
    wait_timeout: '30s',
    on_wait_timeout: 'CONTINUE',
    format: 'JSON_ARRAY',
    disposition: 'INLINE',
    parameters: Object.entries(params).map(([name, value]) =>
      value === null ? { name, type: 'STRING' } : { name, value: String(value), type: typeof value === 'number' ? 'DOUBLE' : 'STRING' },
    ),
  })

  // A stopped warehouse takes a little while to start
  while (res.status.state === 'PENDING' || res.status.state === 'RUNNING') {
    await sleep(500)
    res = await call('GET', `/api/2.0/sql/statements/${res.statement_id}`)
  }
  if (res.status.state !== 'SUCCEEDED') throw new Error(res.status.error?.message ?? `Statement ${res.status.state}`)

  const columns: { name: string; type_name: string }[] = res.manifest?.schema?.columns ?? []
  const data: (string | null)[][] = [...(res.result?.data_array ?? [])]

  // Large results come back in chunks
  let next: string | undefined = res.result?.next_chunk_internal_link
  while (next) {
    const chunk = await call('GET', next)
    data.push(...(chunk.data_array ?? []))
    next = chunk.next_chunk_internal_link
  }

  const numeric = new Set(['BYTE', 'SHORT', 'INT', 'LONG', 'FLOAT', 'DOUBLE', 'DECIMAL'])
  return data.map((row) => {
    const out: Row = {}
    columns.forEach((c, i) => {
      const v = row[i]
      out[c.name] = v === null ? null : numeric.has(c.type_name) ? Number(v) : v
    })
    return out
  })
}

/** Quote a value for SQL built in code (only used for numbers and our own IDs) */
export function lit(v: string | number | null | undefined): string {
  if (v === null || v === undefined) return 'NULL'
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'NULL'
  return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`
}
