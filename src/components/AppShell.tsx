import { useState } from 'react'
import { NavLink, Link, Outlet, useLocation } from 'react-router'
import { Bell, Users, Settings, Menu, X, Moon, Sun, LogOut, UserCog } from 'lucide-react'
import { Logo } from './Logo'
import { useTheme } from '../theme'
import { useLive } from '../live'
import { useAuth } from '../auth'

const links = [
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/residents', label: 'Residents', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
  { to: '/staff', label: 'Staff', icon: UserCog, admin: true },
]

const rowClass = ({ isActive }: { isActive: boolean }) =>
  `flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors duration-150 ${
    isActive
      ? 'bg-raised text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]'
      : 'text-fg-2 hover:bg-raised/60 hover:text-fg'
  }`

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { active } = useLive()
  const { enabled, isAdmin } = useAuth()
  const hasFall = active.some((a) => a.kind === 'fall')
  // Staff accounts only exist with login on, and only admins manage them
  const shown = links.filter((l) => !l.admin || (enabled && isAdmin))

  return (
    <nav className="flex flex-col gap-0.5">
      {shown.map(({ to, label, icon: Icon }) => (
        <NavLink key={to} to={to} className={rowClass} onClick={onNavigate}>
          <Icon className="h-4 w-4 shrink-0 text-fg-3" strokeWidth={1.5} />
          <span className="flex-1">{label}</span>
          {to === '/alerts' && active.length > 0 && (
            <span className={`font-mono text-xs tabular-nums ${hasFall ? 'text-fall' : 'text-fg-3'}`}>
              {active.length}
            </span>
          )}
        </NavLink>
      ))}
    </nav>
  )
}

function ThemeToggle() {
  const { dark, toggle } = useTheme()
  const Icon = dark ? Sun : Moon
  return (
    <button onClick={toggle} className={rowClass({ isActive: false }) + ' w-full'}>
      <Icon className="h-4 w-4 shrink-0 text-fg-3" strokeWidth={1.5} />
      {dark ? 'Light mode' : 'Dark mode'}
    </button>
  )
}

/** Who is signed in, and the way out. Hidden when login is turned off. */
function Account() {
  const { enabled, me, logout } = useAuth()
  if (!enabled || !me) return null
  const name = me.name ?? me.email ?? 'Signed in'
  const initials = name
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
  const role = me.role === 'admin' ? 'Administrator' : 'Caretaker'
  return (
    <div className="mb-1 flex items-center gap-2.5 rounded-lg border border-line bg-card px-2.5 py-2">
      <span
        aria-hidden
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-raised text-xs font-medium text-fg-2"
      >
        {initials}
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-fg">{name}</p>
        <p className="truncate text-xs text-fg-3">{me.careHomeName ? `${role} · ${me.careHomeName}` : role}</p>
      </div>
      <button
        onClick={logout}
        aria-label="Log out"
        title="Log out"
        className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-fg-3 transition-colors duration-150 hover:bg-raised hover:text-fg"
      >
        <LogOut className="h-4 w-4" strokeWidth={1.5} />
      </button>
    </div>
  )
}

/** Shown instead of the page while there's no data yet, or when something is broken */
function Connection() {
  const { loading, offline, error } = useLive()
  const problem = offline ?? error
  if (!problem && !loading) return null

  return (
    <div className="mx-auto max-w-[1440px] px-4 pt-8 sm:px-8">
      <div className={`rounded-xl border px-5 py-4 text-sm ${problem ? 'border-check/40 bg-card' : 'border-line bg-card'}`}>
        {problem ? (
          <>
            <p className="font-medium text-check">Not connected to Databricks</p>
            <p className="mt-1 text-fg-2">{problem}</p>
          </>
        ) : (
          <p className="text-fg-2">Loading from Databricks… the warehouse can take a few seconds to start.</p>
        )}
      </div>
    </div>
  )
}

export function AppShell() {
  const [open, setOpen] = useState(false)
  const { loading } = useLive()
  const { pathname } = useLocation()

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[248px_1fr]">
      {/* Sidebar on desktop */}
      <aside className="sticky top-0 hidden h-screen flex-col border-r border-line bg-deep px-3 lg:flex">
        <Link to="/" className="flex h-14 items-center px-3">
          <Logo />
        </Link>
        <div className="mt-4">
          <Nav />
        </div>
        <div className="mt-auto flex flex-col gap-0.5 pb-4">
          <Account />
          <ThemeToggle />
        </div>
      </aside>

      {/* Top bar on small screens */}
      <div className="sticky top-0 z-10 border-b border-line bg-deep px-4 lg:hidden">
        <div className="flex h-14 items-center justify-between">
          <Link to="/">
            <Logo />
          </Link>
          <button
            onClick={() => setOpen(!open)}
            aria-label={open ? 'Close menu' : 'Open menu'}
            className="flex h-10 w-10 items-center justify-center rounded-lg text-fg-2 hover:bg-raised"
          >
            {open ? <X className="h-[18px] w-[18px]" strokeWidth={1.5} /> : <Menu className="h-[18px] w-[18px]" strokeWidth={1.5} />}
          </button>
        </div>
        {open && (
          <div className="flex flex-col gap-2 pb-4">
            <Nav onNavigate={() => setOpen(false)} />
            <ThemeToggle />
            <Account />
          </div>
        )}
      </div>

      <main className="min-w-0">
        <Connection />
        {/* Settings stays usable while loading so the data source can be changed */}
        {(!loading || pathname.startsWith('/settings')) && <Outlet />}
      </main>
    </div>
  )
}
