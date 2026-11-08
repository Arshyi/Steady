import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router'
import { Logo } from '../components/Logo'
import { useAuth } from '../auth'

// Demo tools: put Steady back to a clean state between demo runs, so pairing a wearable
// and registering a care home can be shown from the start. The server only accepts these
// from this computer (see /api/demo in server/index.ts).

interface Status {
  live: { residents: number; pairings: number; alerts: number; readings: number } | null
  liveError: string | null
  accounts: { id: string; email: string; role: string | null; careHome: string | null }[]
  accountsError: string | null
  login: boolean
  mode: 'simulated' | 'device'
}

/** Set before signing out of Auth0, so the home page sends you back here afterwards */
export const DEMO_RESET_FLAG = 'steady-demo-reset'

const card = 'rounded-xl border border-line bg-card p-5'
const danger =
  'inline-flex h-10 items-center rounded-lg bg-fall px-4 text-sm font-medium text-white transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-40'
const quiet = 'text-sm text-fg-2 underline underline-offset-2 hover:text-fg'

async function demoPost(path: string, body: unknown = {}) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-steady-demo': 'reset' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data
}

/** Forget this browser's saved Auth0 login (tokens), since the account is gone */
function forgetSavedLogin() {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('@@auth0spajs@@')) localStorage.removeItem(key)
  } catch {
    // Storage blocked: nothing saved to clear
  }
}

const plural = (n: number, one: string, many = one + 's') => `${n} ${n === 1 ? one : many}`

export function Demo() {
  const auth = useAuth()
  const [status, setStatus] = useState<Status>()
  const [error, setError] = useState<string>()
  const [busy, setBusy] = useState<'live' | 'accounts' | null>(null)
  const [clearReadings, setClearReadings] = useState(false)
  const [done, setDone] = useState<string | null>(() => {
    let flag: string | null = null
    try {
      flag = sessionStorage.getItem(DEMO_RESET_FLAG)
      sessionStorage.removeItem(DEMO_RESET_FLAG)
    } catch {
      // Storage blocked
    }
    return flag ? `Deleted ${flag}, and signed out of Auth0. Ready to register again.` : null
  })

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/demo/status')
      const data = await res.json()
      if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
      setStatus(data)
      setError(undefined)
    } catch (e) {
      setError((e as Error).message === 'Failed to fetch' ? 'Can’t reach the Steady server. Is `npm run dev` running?' : (e as Error).message)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const resetLive = async () => {
    const extra = clearReadings ? ' and all live movement history' : ''
    if (!window.confirm(`Remove every resident you added, every pairing and all live alerts${extra}?`)) return
    setBusy('live')
    setError(undefined)
    try {
      const { removed } = await demoPost('/api/demo/reset-live', { readings: clearReadings })
      setDone(
        `Live devices reset: removed ${plural(removed.residents, 'resident')}, ${plural(removed.pairings, 'pairing')}, ${plural(removed.alerts, 'live alert')}` +
          (clearReadings ? ` and ${plural(removed.readings, 'reading')}.` : '.'),
      )
      setClearReadings(false)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const resetAccounts = async () => {
    if (!window.confirm('Delete every Steady account, including yours? Nobody will be able to log in until someone registers again.')) return
    setBusy('accounts')
    setError(undefined)
    try {
      const { deleted } = await demoPost('/api/demo/reset-accounts')
      forgetSavedLogin()
      try {
        sessionStorage.setItem(DEMO_RESET_FLAG, plural(deleted, 'account'))
      } catch {
        // Storage blocked: the message just won't show
      }
      // Sign out of Auth0 itself too, so its login page doesn't remember the deleted account.
      // Auth0 sends us back to the home page, which forwards here.
      if (auth.enabled) auth.logout()
      else window.location.assign('/demo')
    } catch (e) {
      setError((e as Error).message)
      setBusy(null)
    }
  }

  const live = status?.live
  const accounts = status ? (status.login ? status.accounts : null) : undefined

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex h-14 max-w-[1280px] items-center px-4 sm:px-8">
        <Link to="/">
          <Logo />
        </Link>
      </header>
      <main className="mx-auto max-w-[40rem] px-4 pt-8 pb-16 sm:px-8">
        <h1 className="text-3xl font-normal">Demo tools</h1>
        <p className="mt-2 text-sm leading-5 text-fg-2">
          Reset Steady between demo runs, so pairing a wearable and registering a care home can be shown from the start.
          This page only works on the computer running the server.
        </p>

        {(done || error) && (
          <p
            role="status"
            className={`mt-6 rounded-xl border px-5 py-3 text-sm ${error ? 'border-fall-line bg-fall-soft text-fall' : 'border-line bg-card text-fg'}`}
          >
            {error ?? done}
          </p>
        )}

        <section className={card + ' mt-6'}>
          <h2 className="text-base font-medium">Live devices</h2>
          <p className="mt-1 text-sm text-fg-2">
            Removes the residents you added, every wearable pairing and all live alerts. Simulated residents and their
            data stay as they are. Wearables that are still sending show up again under Settings, unpaired.
          </p>
          {status?.liveError && (
            <p className="mt-3 text-sm text-check">
              Couldn’t read live data: {status.liveError}. Resetting may still work; try again in a moment.
            </p>
          )}
          <dl className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              ['Residents added', live?.residents],
              ['Pairings', live?.pairings],
              ['Live alerts', live?.alerts],
              ['Live readings', live?.readings],
            ].map(([label, value]) => (
              <div key={label as string} className="rounded-lg border border-line bg-raised px-3 py-2">
                <dt className="text-xs text-fg-3">{label}</dt>
                <dd className="mt-1 font-mono text-lg tabular-nums">{value ?? '–'}</dd>
              </div>
            ))}
          </dl>
          <label className="mt-4 flex items-center gap-2 text-sm text-fg-2">
            <input type="checkbox" checked={clearReadings} onChange={(e) => setClearReadings(e.target.checked)} />
            Also clear live movement history (the Movement tonight chart starts empty)
          </label>
          <div className="mt-4 flex flex-wrap items-center gap-4">
            <button onClick={resetLive} disabled={!status || busy !== null} className={danger}>
              {busy === 'live' ? 'Resetting…' : 'Reset live devices'}
            </button>
            {status?.mode === 'simulated' && (
              <span className="text-sm text-check">The dashboard is on Simulated. Switch to Live devices in Settings to show pairing.</span>
            )}
          </div>
        </section>

        <section className={card + ' mt-4'}>
          <h2 className="text-base font-medium">Accounts</h2>
          <p className="mt-1 text-sm text-fg-2">
            Deletes every login in Auth0, so registering a care home and inviting staff can be shown again. This browser is
            signed out too.
          </p>
          {status?.accountsError && <p className="mt-3 text-sm text-fall">Couldn’t list accounts: {status.accountsError}</p>}
          {accounts === null ? (
            <p className="mt-4 text-sm text-fg-2">Login is turned off on this server, so there are no accounts.</p>
          ) : (
            <ul className="mt-4 overflow-hidden rounded-lg border border-line">
              {!accounts ? (
                <li className="px-4 py-3 text-sm text-fg-2">Loading…</li>
              ) : accounts.length === 0 ? (
                <li className="px-4 py-3 text-sm text-fg-2">No accounts. Ready to register.</li>
              ) : (
                accounts.map((a) => (
                  <li key={a.id} className="flex flex-wrap justify-between gap-x-4 border-b border-line px-4 py-2.5 text-sm last:border-b-0">
                    <span className="truncate">{a.email}</span>
                    <span className="text-fg-3">
                      {a.role ? (a.role === 'admin' ? 'Administrator' : 'Caretaker') : 'No care home'}
                      {a.careHome && ` · ${a.careHome}`}
                    </span>
                  </li>
                ))
              )}
            </ul>
          )}
          <div className="mt-4">
            <button onClick={resetAccounts} disabled={!accounts?.length || busy !== null} className={danger}>
              {busy === 'accounts' ? 'Deleting…' : `Delete ${accounts?.length ? plural(accounts.length, 'account') : 'all accounts'}`}
            </button>
          </div>
        </section>

        <section className={card + ' mt-4'}>
          <h2 className="text-base font-medium">Then show</h2>
          <ol className="mt-3 flex flex-col gap-2 text-sm text-fg-2">
            <li>
              1.{' '}
              <Link to="/register" className={quiet}>
                Register a care home
              </Link>
              , set the password from the email and log in.
            </li>
            <li>
              2.{' '}
              <Link to="/staff" className={quiet}>
                Invite a caretaker
              </Link>{' '}
              from the Staff page.
            </li>
            <li>
              3.{' '}
              <Link to="/settings" className={quiet}>
                Pair the wearable
              </Link>{' '}
              in Settings: Live devices, connect, + Add a new resident.
            </li>
            <li>
              4. Drop it onto a cushion, watch{' '}
              <Link to="/alerts" className={quiet}>
                Alerts
              </Link>
              , then press the button once to resolve the fall.
            </li>
          </ol>
        </section>
      </main>
    </div>
  )
}
