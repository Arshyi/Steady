import { Link } from 'react-router'
import { Logo } from '../components/Logo'
import { AlertRow, ResidentList } from '../components/board'
import { Wearable } from '../components/Wearable'
import { sampleResidents, shift, byUrgency } from '../data/residents'
import { sampleFall } from '../data/alerts'

const measures = [
  { title: 'Movement', text: 'Tracked through the night and shown per half hour, so staff can see who has been restless.' },
  { title: 'Falls', text: 'Detected on the device and sent to the dashboard as an alert straight away.' },
  { title: 'Heart rate', text: 'Read continuously, with tonight’s range shown on each resident’s page.' },
  { title: 'Battery and signal', text: 'Every device reports its own health, so a flat or out-of-range device shows up before it’s missed.' },
]

const steps = [
  { title: 'The wearable', text: 'Each resident wears a Steady device that tracks movement, heart rate and falls.' },
  { title: 'Databricks', text: 'Readings from every device in the wing are turned into a plain status per resident.' },
  { title: 'The dashboard', text: 'Staff see the whole wing on one screen, with alerts for falls, checks and devices.' },
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
          Overview <span className="text-fg-3">· {shift.wing}</span>
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

export function Home() {
  return (
    <div className="min-h-screen">
      <header className="mx-auto flex h-14 max-w-[1280px] items-center justify-between px-4 sm:px-8">
        <Logo />
        <Link to="/overview" className="text-sm text-fg-2 transition-colors duration-150 hover:text-fg">
          Open the dashboard
        </Link>
      </header>

      {/* Hero */}
      <section className="mx-auto grid min-h-[calc(100vh-56px)] max-w-[1280px] items-center gap-12 px-4 py-12 sm:px-8 lg:grid-cols-[5fr_7fr] lg:gap-16">
        <div>
          <h1 className="text-4xl leading-[1.08] font-normal tracking-[-0.02em] sm:text-5xl lg:text-[56px] lg:tracking-[-0.03em]">
            A wearable for every resident, one dashboard for the night shift
          </h1>
          <p className="mt-6 max-w-[36rem] text-lg leading-7 text-fg-2">
            Steady devices track movement, heart rate and falls. The dashboard brings every device in the wing onto
            one screen, so staff see who needs them and get an alert the moment someone falls.
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link
              to="/overview"
              className="inline-flex h-11 items-center rounded-lg bg-fg px-5 text-sm font-medium text-inverse transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.98]"
            >
              Open the dashboard
            </Link>
            <a
              href="#hardware"
              className="inline-flex h-11 items-center rounded-lg border border-line bg-raised px-5 text-sm font-medium text-fg transition-colors duration-150 hover:bg-card"
            >
              See the hardware
            </a>
          </div>
        </div>
        <DashboardPreview />
      </section>

      {/* Hardware */}
      <section id="hardware" className="mx-auto max-w-[1280px] px-4 pt-12 pb-24 sm:px-8">
        <div className="grid items-center gap-12 lg:grid-cols-2 lg:gap-16">
          <div className="flex items-center justify-center rounded-[20px] border border-line bg-deep py-16">
            <Wearable deviceId="ST-0419" size={160} />
          </div>
          <div>
            <h2 className="text-3xl font-normal">The hardware</h2>
            <p className="mt-4 max-w-[36rem] text-base leading-6 text-fg-2">
              A small device worn by each resident. It measures through the night and reports to the dashboard
              every few seconds.
            </p>
            <dl className="mt-8 border-t border-line">
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

      {/* How it fits together */}
      <section className="mx-auto max-w-[1280px] px-4 pb-24 sm:px-8">
        <h2 className="text-2xl font-normal">How it fits together</h2>
        <ol className="mt-8 grid gap-8 border-t border-line pt-8 md:grid-cols-3">
          {steps.map((s, i) => (
            <li key={s.title}>
              <p className="font-mono text-xs tabular-nums text-fg-3">{i + 1}</p>
              <h3 className="mt-2 text-base font-medium">{s.title}</h3>
              <p className="mt-2 text-sm leading-5 text-fg-2">{s.text}</p>
            </li>
          ))}
        </ol>
      </section>

      <footer className="mx-auto flex h-16 max-w-[1280px] items-center border-t border-line px-4 text-sm text-fg-3 sm:px-8">
        Steady
      </footer>
    </div>
  )
}
