// Staff accounts through Auth0.
//
// People log in on Auth0's page; the web app sends their access token with every request and
// this file checks it. Accounts, passwords and roles live in Auth0: each Steady user carries
// `app_metadata.steady = { role, careHome, careHomeName }`. Sign-ups on the login page are
// turned off, so the only ways in are registering a care home (which makes its first admin)
// and being invited by an admin. Both create the user through the Auth0 Management API and
// have Auth0 email a link to set a password.
//
// Turned on by AUTH0_DOMAIN + AUTH0_AUDIENCE in server/.env. Without them every request is
// let through, as before, so local demos keep working.

import { randomBytes, randomUUID } from 'node:crypto'
import type { IncomingMessage } from 'node:http'
import { createRemoteJWKSet, jwtVerify } from 'jose'

const DOMAIN = (process.env.AUTH0_DOMAIN ?? '').replace(/^https?:\/\//, '').replace(/\/$/, '')
const AUDIENCE = process.env.AUTH0_AUDIENCE ?? ''
const SPA_CLIENT_ID = process.env.AUTH0_CLIENT_ID ?? ''
const M2M_ID = process.env.AUTH0_M2M_CLIENT_ID ?? ''
const M2M_SECRET = process.env.AUTH0_M2M_CLIENT_SECRET ?? ''
const CONNECTION = process.env.AUTH0_CONNECTION ?? 'Username-Password-Authentication'

export const authEnabled = Boolean(DOMAIN && AUDIENCE)
/** Creating and inviting accounts also needs the "Steady server" machine-to-machine app */
export const accountsEnabled = authEnabled && Boolean(M2M_ID && M2M_SECRET && SPA_CLIENT_ID)

if (!authEnabled) console.warn('[auth] AUTH0_DOMAIN / AUTH0_AUDIENCE not set: the dashboard API accepts anyone')
else if (!accountsEnabled)
  console.warn('[auth] AUTH0_M2M_CLIENT_ID / AUTH0_M2M_CLIENT_SECRET / AUTH0_CLIENT_ID not set: registering and inviting are off')

export type Role = 'admin' | 'caretaker'

export interface Staff {
  id: string
  name: string
  email: string
  role: Role
  careHome: string
  careHomeName: string
  /** False until they've set a password and logged in once */
  joined: boolean
}

/** Thrown to send a specific status and message back to the web app */
export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// ---------- checking logins ----------

const jwks = authEnabled ? createRemoteJWKSet(new URL(`https://${DOMAIN}/.well-known/jwks.json`)) : null

/**
 * Who is making this request. Returns null when login is turned off.
 * Throws 401 without a valid token and 403 when the account isn't part of any care home.
 */
export async function currentStaff(req: IncomingMessage): Promise<Staff | null> {
  if (!authEnabled) return null
  const header = String(req.headers.authorization ?? '')
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : ''
  if (!token) throw new HttpError(401, 'Please log in')
  let sub: string
  try {
    const { payload } = await jwtVerify(token, jwks!, { issuer: `https://${DOMAIN}/`, audience: AUDIENCE })
    sub = String(payload.sub)
  } catch {
    throw new HttpError(401, 'Your login has expired. Please log in again.')
  }
  const staff = await staffById(sub)
  if (!staff) throw new HttpError(403, 'This account isn’t part of a care home on Steady. Ask your administrator to invite you.')
  if (!staff.joined) {
    // They're logged in, so they've joined, even if Auth0's user list hasn't counted the login yet
    const joined = { ...staff, joined: true }
    profileCache.set(sub, { staff: joined, at: Date.now() })
    const r = recent.get(sub)
    if (r) r.staff = joined
    return joined
  }
  return staff
}

export async function requireAdmin(req: IncomingMessage) {
  const me = await currentStaff(req)
  if (me && me.role !== 'admin') throw new HttpError(403, 'Only an administrator can do that')
  return me
}

// ---------- Auth0 Management API ----------

let mgmtToken: { value: string; expires: number } | null = null

async function managementToken() {
  if (mgmtToken && mgmtToken.expires > Date.now() + 60_000) return mgmtToken.value
  const res = await fetch(`https://${DOMAIN}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'client_credentials',
      client_id: M2M_ID,
      client_secret: M2M_SECRET,
      audience: `https://${DOMAIN}/api/v2/`,
    }),
  })
  const body: any = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(`Auth0 refused the server's credentials: ${body.error_description ?? res.status}`)
  mgmtToken = { value: body.access_token, expires: Date.now() + body.expires_in * 1000 }
  return mgmtToken.value
}

async function mgmt(method: string, path: string, body?: unknown): Promise<any> {
  if (!accountsEnabled) throw new HttpError(503, 'Accounts aren’t set up on this server yet')
  const res = await fetch(`https://${DOMAIN}/api/v2${path}`, {
    method,
    headers: { Authorization: `Bearer ${await managementToken()}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (res.status === 204) return null
  const data: any = await res.json().catch(() => ({}))
  if (!res.ok) {
    if (res.status === 404) return null
    if (res.status === 409) throw new HttpError(409, 'An account with this email already exists')
    if (res.status === 403) throw new Error(`Auth0 says the server is missing a permission: ${data.message ?? ''}`)
    throw new Error(`Auth0 ${method} ${path} failed: ${data.message ?? res.status}`)
  }
  return data
}

interface Auth0User {
  user_id: string
  email: string
  name?: string
  logins_count?: number
  app_metadata?: { steady?: { role?: Role; careHome?: string; careHomeName?: string } }
}

function toStaff(u: Auth0User): Staff | null {
  const s = u.app_metadata?.steady
  if (!s?.careHome || (s.role !== 'admin' && s.role !== 'caretaker')) return null
  return {
    id: u.user_id,
    name: u.name && u.name !== u.email ? u.name : u.email,
    email: u.email,
    role: s.role,
    careHome: s.careHome,
    careHomeName: s.careHomeName ?? '',
    joined: (u.logins_count ?? 0) > 0,
  }
}

// Each request needs the caller's role. Keep it for a minute rather than asking Auth0 every poll.
const profileCache = new Map<string, { staff: Staff | null; at: number }>()

async function staffById(id: string): Promise<Staff | null> {
  const hit = profileCache.get(id)
  if (hit && Date.now() - hit.at < 60_000) return hit.staff
  const user: Auth0User | null = accountsEnabled ? await mgmt('GET', `/users/${encodeURIComponent(id)}`) : null
  const staff = user ? toStaff(user) : null
  profileCache.set(id, { staff, at: Date.now() })
  return staff
}

// Auth0's user search catches up a few seconds after a change. Changes made here are laid over
// the search results until then, so a new invite shows up in the list straight away.
const recent = new Map<string, { staff: Staff | null; careHome: string; at: number }>()
function remember(id: string, careHome: string, staff: Staff | null) {
  recent.set(id, { staff, careHome, at: Date.now() })
  profileCache.set(id, { staff, at: Date.now() })
}

async function createAccount(email: string, name: string, metadata: { role: Role; careHome: string; careHomeName: string }) {
  const user: Auth0User = await mgmt('POST', '/users', {
    connection: CONNECTION,
    email,
    name,
    // Nobody knows this password: they set their own from the emailed link
    password: randomBytes(24).toString('base64url') + 'aA1!',
    email_verified: false,
    verify_email: false,
    app_metadata: { steady: metadata },
  })
  const staff = toStaff(user)!
  remember(staff.id, staff.careHome, staff)
  await sendPasswordEmail(email)
  return staff
}

/** Auth0 emails the person a link to choose their password */
async function sendPasswordEmail(email: string) {
  const res = await fetch(`https://${DOMAIN}/dbconnections/change_password`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: SPA_CLIENT_ID, email, connection: CONNECTION }),
  })
  if (!res.ok) throw new Error(`Auth0 couldn’t send the password email (${res.status})`)
}

const cleanEmail = (v: unknown) => {
  const email = String(v ?? '').trim().toLowerCase()
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address')
  return email
}
const cleanText = (v: unknown, what: string) => {
  const text = String(v ?? '').trim().slice(0, 100)
  if (!text) throw new HttpError(400, `Enter ${what}`)
  return text
}
const cleanRole = (v: unknown): Role => {
  if (v !== 'admin' && v !== 'caretaker') throw new HttpError(400, 'Role must be admin or caretaker')
  return v
}

// ---------- registering a care home ----------

// A light brake on the public register form: a handful per address per hour
const registrations = new Map<string, number[]>()

export async function registerCareHome(req: IncomingMessage, body: any) {
  const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim()
  const hourAgo = Date.now() - 3_600_000
  const times = (registrations.get(ip) ?? []).filter((t) => t > hourAgo)
  if (times.length >= 5) throw new HttpError(429, 'Too many registrations from this network. Try again in an hour.')

  const careHomeName = cleanText(body.careHome, 'the care home’s name')
  const name = cleanText(body.name, 'your name')
  const email = cleanEmail(body.email)
  registrations.set(ip, [...times, Date.now()])

  const staff = await createAccount(email, name, { role: 'admin', careHome: randomUUID(), careHomeName })
  console.log(`[auth] registered care home "${careHomeName}"`)
  return { email: staff.email }
}

// ---------- managing staff (admins only) ----------

export async function listStaff(me: Staff): Promise<Staff[]> {
  const q = encodeURIComponent(`app_metadata.steady.careHome:"${me.careHome}"`)
  const users: Auth0User[] =
    (await mgmt('GET', `/users?q=${q}&search_engine=v3&per_page=100&fields=user_id,email,name,logins_count,app_metadata`)) ?? []
  const byId = new Map<string, Staff>()
  for (const u of users) {
    const s = toStaff(u)
    if (s && s.careHome === me.careHome) byId.set(s.id, profileCache.get(s.id)?.staff?.joined ? { ...s, joined: true } : s)
  }
  for (const [id, r] of recent) {
    if (Date.now() - r.at > 60_000) recent.delete(id)
    else if (r.careHome === me.careHome) r.staff ? byId.set(id, r.staff) : byId.delete(id)
  }
  return [...byId.values()].sort((a, b) => (a.role === b.role ? a.name.localeCompare(b.name) : a.role === 'admin' ? -1 : 1))
}

export async function inviteStaff(me: Staff, body: any) {
  const email = cleanEmail(body.email)
  const name = String(body.name ?? '').trim().slice(0, 100) || email
  const role = body.role === undefined ? 'caretaker' : cleanRole(body.role)
  return createAccount(email, name, { role, careHome: me.careHome, careHomeName: me.careHomeName })
}

/** Someone in the same care home, or 404 */
async function colleague(me: Staff, id: string) {
  profileCache.delete(id)
  const staff = await staffById(id)
  if (!staff || staff.careHome !== me.careHome) throw new HttpError(404, 'No one by that id in your care home')
  return staff
}

async function otherAdmins(me: Staff, id: string) {
  return (await listStaff(me)).filter((s) => s.role === 'admin' && s.id !== id).length
}

export async function setRole(me: Staff, id: string, body: any) {
  const role = cleanRole(body.role)
  const staff = await colleague(me, id)
  if (staff.role === 'admin' && role !== 'admin' && (await otherAdmins(me, id)) === 0)
    throw new HttpError(409, 'A care home needs at least one administrator. Make someone else an administrator first.')
  await mgmt('PATCH', `/users/${encodeURIComponent(id)}`, {
    app_metadata: { steady: { role, careHome: staff.careHome, careHomeName: staff.careHomeName } },
  })
  const updated = { ...staff, role }
  remember(id, me.careHome, updated)
  return updated
}

export async function removeStaff(me: Staff, id: string) {
  if (id === me.id) throw new HttpError(409, 'You can’t remove your own account. Ask another administrator.')
  const staff = await colleague(me, id)
  if (staff.role === 'admin' && (await otherAdmins(me, id)) === 0)
    throw new HttpError(409, 'A care home needs at least one administrator')
  await mgmt('DELETE', `/users/${encodeURIComponent(id)}`)
  remember(id, me.careHome, null)
}

export async function resendInvite(me: Staff, id: string) {
  const staff = await colleague(me, id)
  await sendPasswordEmail(staff.email)
}

// ---------- demo tools ----------

/** Every login in the Auth0 tenant (demo page) */
export async function listAccounts(): Promise<{ id: string; email: string; role: string | null; careHome: string | null }[]> {
  if (!accountsEnabled) return []
  const out: { id: string; email: string; role: string | null; careHome: string | null }[] = []
  for (let page = 0; page < 10; page++) {
    const users: Auth0User[] = (await mgmt('GET', `/users?per_page=100&page=${page}&fields=user_id,email,app_metadata`)) ?? []
    for (const u of users) {
      if (recent.get(u.user_id)?.staff === null) continue // deleted a moment ago; search hasn't caught up
      const s = u.app_metadata?.steady
      out.push({ id: u.user_id, email: u.email, role: s?.role ?? null, careHome: s?.careHomeName ?? null })
    }
    if (users.length < 100) break
  }
  // Auth0's search takes a few seconds to list a new account: add ones created here just now
  for (const [id, r] of recent) {
    if (r.staff && !out.some((a) => a.id === id))
      out.push({ id, email: r.staff.email, role: r.staff.role, careHome: r.staff.careHomeName || null })
  }
  return out
}

/** Delete every login so registering can be shown again (demo page) */
export async function deleteAllAccounts() {
  if (!accountsEnabled) throw new HttpError(503, 'Accounts aren’t set up on this server')
  const accounts = await listAccounts()
  for (const a of accounts) {
    await mgmt('DELETE', `/users/${encodeURIComponent(a.id)}`)
    remember(a.id, a.careHome ?? '', null)
  }
  profileCache.clear()
  registrations.clear()
  console.log(`[auth] demo reset: deleted ${accounts.length} account(s)`)
  return { deleted: accounts.length, emails: accounts.map((a) => a.email) }
}
