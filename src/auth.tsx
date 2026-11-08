// Staff login through Auth0. Set VITE_AUTH0_DOMAIN and VITE_AUTH0_CLIENT_ID in .env.local to
// turn it on. Without them the dashboard stays open, which keeps local demos working.
// Login only: accounts are made by registering a care home or by an admin's invite (server/auth.ts).

import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Auth0Provider, useAuth0 } from '@auth0/auth0-react'
import { Link, useLocation } from 'react-router'
import { Logo } from './components/Logo'

const DOMAIN = import.meta.env.VITE_AUTH0_DOMAIN as string | undefined
const CLIENT_ID = import.meta.env.VITE_AUTH0_CLIENT_ID as string | undefined
// The "Steady API" identifier in Auth0. Needed for the server to accept the login.
const AUDIENCE = (import.meta.env.VITE_AUTH0_AUDIENCE as string | undefined) || undefined

export const authEnabled = Boolean(DOMAIN && CLIENT_ID)

export type Role = 'admin' | 'caretaker'

export interface Me {
  id: string | null
  name: string | null
  email: string | null
  role: Role
  careHomeName: string | null
}

export interface Auth {
  enabled: boolean
  /** Still finding out who is signed in */
  loading: boolean
  signedIn: boolean
  /** The Steady account behind the login: role and care home. Null until loaded. */
  me: Me | null
  isAdmin: boolean
  error: string | null
  login: (returnTo?: string) => void
  logout: () => void
}

const everyone: Me = { id: null, name: null, email: null, role: 'admin', careHomeName: null }
const open: Auth = {
  enabled: false,
  loading: false,
  signedIn: true,
  me: everyone,
  isAdmin: true,
  error: null,
  login: () => {},
  logout: () => {},
}

const AuthContext = createContext<Auth>(open)
export const useAuth = () => useContext(AuthContext)

// Every call to the Steady server goes through apiFetch, which adds the login token when there is one
let tokenGetter: (() => Promise<string | undefined>) | null = null

export async function apiFetch(path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers)
  const token = tokenGetter ? await tokenGetter() : undefined
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return fetch(path, { ...init, headers })
}

/** JSON in, JSON out; throws the server's error message */
export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await apiFetch(path, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`)
  return data as T
}

function Bridge({ children }: { children: ReactNode }) {
  const { isLoading, isAuthenticated, user, error, loginWithRedirect, logout, getAccessTokenSilently } = useAuth0()
  const [me, setMe] = useState<Me | null>(null)
  const [meError, setMeError] = useState<string | null>(null)

  if (isAuthenticated) tokenGetter = () => getAccessTokenSilently()

  useEffect(() => {
    if (!isAuthenticated) {
      tokenGetter = null
      setMe(null)
      return
    }
    api<Me>('/api/me')
      .then((m) => {
        // The server only knows names when login is on there too; fall back to the Auth0 profile
        setMe({ ...m, name: m.name ?? user?.name ?? user?.email ?? null, email: m.email ?? user?.email ?? null })
        setMeError(null)
      })
      .catch((e) => setMeError((e as Error).message))
  }, [isAuthenticated, user])

  const value: Auth = {
    enabled: true,
    loading: isLoading || (isAuthenticated && !me && !meError),
    signedIn: isAuthenticated,
    me,
    isAdmin: me?.role === 'admin',
    error: error?.message ?? meError,
    login: (returnTo) => loginWithRedirect({ appState: { returnTo: returnTo ?? window.location.pathname } }),
    logout: () => {
      tokenGetter = null
      logout({ logoutParams: { returnTo: window.location.origin } })
    },
  }
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!authEnabled) return <AuthContext.Provider value={open}>{children}</AuthContext.Provider>
  return (
    <Auth0Provider
      domain={DOMAIN!}
      clientId={CLIENT_ID!}
      authorizationParams={{ redirect_uri: window.location.origin, ...(AUDIENCE ? { audience: AUDIENCE } : {}) }}
      // Stay signed in across page reloads, even where the browser blocks third-party cookies
      cacheLocation="localstorage"
      useRefreshTokens
      useRefreshTokensFallback
      onRedirectCallback={(appState) => {
        // Go back to the page that asked for the login
        window.history.replaceState({}, '', appState?.returnTo ?? '/alerts')
        window.dispatchEvent(new PopStateEvent('popstate'))
      }}
    >
      <Bridge>{children}</Bridge>
    </Auth0Provider>
  )
}

/** Auth0's error messages, in words staff can act on */
export function friendly(message: string) {
  if (/service not found/i.test(message))
    return 'Steady’s login isn’t fully set up yet: the “Steady API” is missing in Auth0. Ask your administrator.'
  if (/not authorized to access resource server/i.test(message))
    return 'Steady’s login isn’t fully set up yet: the dashboard app isn’t allowed to use the “Steady API” in Auth0. Ask your administrator.'
  if (/blocked/i.test(message)) return 'This account has been blocked. Ask your administrator.'
  if (/expired|login required/i.test(message)) return 'Your login has expired. Please log in again.'
  return message
}

/** A full page for the moments before the dashboard: signed out, loading, or a login problem */
function Screen({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <header className="mx-auto flex h-14 w-full max-w-[1280px] items-center px-4 sm:px-8">
        <Link to="/">
          <Logo />
        </Link>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 pb-14">
        <div className="w-full max-w-[24rem] rounded-[20px] border border-line bg-card p-8 shadow-[0_8px_24px_rgb(0_0_0/0.06)]">
          <h1 className="text-2xl font-normal">{title}</h1>
          {children}
        </div>
      </main>
    </div>
  )
}

const primary =
  'inline-flex h-11 w-full items-center justify-center rounded-lg bg-fg px-5 text-sm font-medium text-inverse transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.98]'
const secondary =
  'inline-flex h-11 w-full items-center justify-center rounded-lg border border-line bg-raised px-5 text-sm font-medium text-fg transition-colors duration-150 hover:bg-page'

/** Wraps the staff pages. Signed-out visitors get a log in screen; Auth0 handles the login itself. */
export function RequireLogin({ children, admin = false }: { children: ReactNode; admin?: boolean }) {
  const { enabled, loading, signedIn, error, isAdmin, login, logout } = useAuth()
  const { pathname } = useLocation()

  if (!enabled) return <>{children}</>

  if (error)
    return (
      <Screen title="Couldn’t log you in">
        <p className="mt-2 text-sm leading-5 text-fg-2">{friendly(error)}</p>
        <div className="mt-6 flex flex-col gap-2">
          <button onClick={() => login(pathname)} className={primary}>
            Try again
          </button>
          {signedIn && (
            <button onClick={logout} className={secondary}>
              Log out
            </button>
          )}
        </div>
      </Screen>
    )

  if (loading)
    return (
      <Screen title="Logging you in">
        <p className="mt-2 text-sm text-fg-2">Just a moment…</p>
      </Screen>
    )

  if (!signedIn)
    return (
      <Screen title="Staff log in">
        <p className="mt-2 text-sm leading-5 text-fg-2">
          Use the email you registered or were invited with. You’ll log in on a secure Auth0 page and come straight back.
        </p>
        <button onClick={() => login(pathname)} className={primary + ' mt-6'}>
          Log in
        </button>
        <p className="mt-6 border-t border-line pt-4 text-sm text-fg-3">
          New to Steady?{' '}
          <Link to="/register" className="text-fg-2 underline underline-offset-2 hover:text-fg">
            Register your care home
          </Link>
        </p>
      </Screen>
    )

  if (admin && !isAdmin)
    return (
      <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-8">
        <div className="max-w-md rounded-xl border border-line bg-card px-5 py-4 text-sm">
          <p className="font-medium">Administrators only</p>
          <p className="mt-1 text-fg-2">Ask an administrator at your care home if you need access to this page.</p>
        </div>
      </div>
    )

  return <>{children}</>
}
