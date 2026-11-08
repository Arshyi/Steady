import { useState } from 'react'
import { NavLink, Link, Outlet, useLocation } from 'react-router'
import { LayoutList, Bell, Users, Settings, Menu, X, Moon, Sun } from 'lucide-react'
import { Logo } from './Logo'
import { useTheme } from '../theme'
import { useLive } from '../live'

const links = [
  { to: '/overview', label: 'Overview', icon: LayoutList },
  { to: '/alerts', label: 'Alerts', icon: Bell },
  { to: '/residents', label: 'Residents', icon: Users },
  { to: '/settings', label: 'Settings', icon: Settings },
]

const rowClass = ({ isActive }: { isActive: boolean }) =>
  `flex h-9 items-center gap-2.5 rounded-lg px-3 text-sm transition-colors duration-150 ${
    isActive
      ? 'bg-raised text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]'
      : 'text-fg-2 hover:bg-raised/60 hover:text-fg'
  }`

function Nav({ onNavigate }: { onNavigate?: () => void }) {
  const { active } = useLive()
  const hasFall = active.some((a) => a.kind === 'fall')

  return (
    <nav className="flex flex-col gap-0.5">
      {links.map(({ to, label, icon: Icon }) => (
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
        <div className="mt-auto pb-4">
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
