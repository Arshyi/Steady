import { Link } from 'react-router'
import { Logo } from '../components/Logo'
import { useAuth, friendly } from '../auth'
import { AlertRow, ResidentList } from '../components/board'
import { sampleResidents, shift, byUrgency } from '../data/residents'
import { sampleFall } from '../data/alerts'

const measures = [
  { title: 'Movement', text: 'Tracked through the night and shown per half hour, so staff can see who has been restless.' },
  { title: 'Falls', text: 'Detected on the device and sent to the dashboard as an alert straight away.' },
  { title: 'Heart rate', text: 'Read continuously, with tonight’s range shown on each resident’s page.' },
  { title: 'Battery and signal', text: 'Every device reports its own health, so a flat or out-of-range device shows up before it’s missed.' },
]


/** A picture of the dashboard. `inert` stops clicks, hovers and keyboard focus inside it. */
function DashboardPreview() {
  const fall = sampleFall
  const dorothy = sampleResidents.find((r) => r.id === fall.residentId)!
  const rows = [...sampleResidents].sort(byUrgency).filter((r) => r.status !== 'fall').slice(0, 4)
  const noop = () => {}

  return (
    <div
      inert
      aria-label="Preview of the Steady dashboard"
      role="img"
      className="pointer-events-none select-none rounded-[20px] border border-line bg-deep p-2 shadow-[0_8px_24px_rgb(0_0_0/0.06)]"
    >
      <div className="flex items-baseline justify-between px-3 pt-2 pb-3">
        <p className="text-sm text-fg">
          Alerts <span className="text-fg-3">· {shift.wing}</span>
        </p>
        <p className="font-mono text-xs tabular-nums text-fg-3">02:14</p>
      </div>
      <div className="flex flex-col gap-2">
        <AlertRow alert={fall} resident={dorothy} onHandle={noop} onUndo={noop} />
        <ResidentList residents={rows} compact />
      </div>
    </div>
  )
}

const primary =
  'inline-flex h-11 items-center rounded-lg bg-fg px-5 text-sm font-medium text-inverse transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.98]'
const secondary =
  'inline-flex h-11 items-center rounded-lg border border-line bg-raised px-5 text-sm font-medium text-fg transition-colors duration-150 hover:bg-card'

/** "Staff log in", or straight to the dashboard when already signed in (or login is off) */
function StaffLogin({ className, children }: { className: string; children: string }) {
  const { enabled, signedIn, loading, login } = useAuth()
  if (!enabled || signedIn)
    return (
      <Link to="/alerts" className={className}>
        Open the dashboard
      </Link>
    )
  return (
    <button onClick={() => login('/alerts')} disabled={loading} className={className}>
      {children}
    </button>
  )
}

export function Home() {
  // Auth0 sends login errors back to this page
  const { error } = useAuth()
  return (
    <div className="min-h-screen">
      {error && (
        <div role="alert" className="mx-auto max-w-[1280px] px-4 pt-4 sm:px-8">
          <p className="rounded-xl border border-check/40 bg-card px-5 py-3 text-sm">
            <span className="font-medium text-check">Couldn’t log you in.</span>{' '}
            <span className="text-fg-2">{friendly(error)}</span>
          </p>
        </div>
      )}
      <header className="mx-auto flex h-14 max-w-[1280px] items-center px-4 sm:px-8">
        <Logo />
      </header>

      {/* Hero */}
      <section className="mx-auto grid min-h-[calc(100vh-56px)] max-w-[1280px] items-center gap-12 px-4 py-12 sm:px-8 lg:grid-cols-[5fr_7fr] lg:gap-16">
        <div>
          <h1 className="text-4xl leading-[1.08] font-normal tracking-[-0.02em] sm:text-5xl lg:text-[56px] lg:tracking-[-0.03em]">
            Peace of mind, through every night
          </h1>
          <p className="mt-6 max-w-[36rem] text-lg leading-7 text-fg-2">
            Each resident wears a small Steady device that tracks movement, heart rate and falls. The dashboard puts
            every resident in the wing on one screen, so the night shift sees who needs them and gets an alert the
            moment someone falls.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <StaffLogin className={primary}>Staff log in</StaffLogin>
            <Link to="/register" className={secondary}>
              Register your care home
            </Link>
          </div>
        </div>
        <DashboardPreview />
      </section>

      {/* Hardware */}
      <section id="hardware" className="mx-auto max-w-[1280px] px-4 pt-12 pb-24 sm:px-8">
        <div className="grid gap-12 lg:grid-cols-2 lg:gap-16">
          <div>
            <h2 className="text-3xl font-normal">The hardware</h2>
            <p className="mt-4 max-w-[36rem] text-base leading-6 text-fg-2">
              A small device worn by each resident. It measures through the night and reports to the dashboard
              every few seconds.
            </p>
          </div>
          <div>
            <dl className="border-t border-line">
              {measures.map((m) => (
                <div key={m.title} className="grid gap-1 border-b border-line py-4 sm:grid-cols-[176px_1fr] sm:gap-4">
                  <dt className="text-sm font-medium">{m.title}</dt>
                  <dd className="text-sm leading-5 text-fg-2">{m.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      </section>

      <footer className="mx-auto flex h-16 max-w-[1280px] items-center border-t border-line px-4 text-sm text-fg-3 sm:px-8">
        Steady
      </footer>
    </div>
  )
}
