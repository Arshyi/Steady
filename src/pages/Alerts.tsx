import { useState } from 'react'
import { Link } from 'react-router'
import { AlertRow } from '../components/board'
import { Page, PageHeader } from '../components/PageHeader'
import { useLive } from '../live'
import type { Alert } from '../data/alerts'
import { countByStatus, LOW_BATTERY } from '../data/residents'

/** One-line counts for the whole wing: residents first, then devices */
function WingSummary() {
  const { residents, mode } = useLive()
  const c = countByStatus(residents)
  if (mode === 'device' && residents.length === 0)
    return (
      <p className="mt-4 text-sm text-fg-2">
        No wearables are paired yet.{' '}
        <Link to="/settings" className="text-fg underline underline-offset-2">
          Pair one in Settings
        </Link>{' '}
        to see its resident here.
      </p>
    )
  const online = residents.filter((r) => r.device?.lastSyncSec != null && r.device.lastSyncSec < 120).length
  const lowBattery = residents.filter((r) => (r.device?.battery ?? 100) < LOW_BATTERY).length
  const weakSignal = residents.filter((r) => r.device?.signal === 'weak').length

  return (
    <div className="mt-4 flex flex-col gap-1 text-sm tabular-nums text-fg-2">
      <p>
        {residents.length} residents · {c.asleep} asleep · {c.up} up ·{' '}
        <span className={c.check ? 'text-check' : ''}>
          {c.check} {c.check === 1 ? 'needs' : 'need'} a check
        </span>{' '}
        ·{' '}
        <span className={c.fall ? 'text-fall' : ''}>
          {c.fall} {c.fall === 1 ? 'fall' : 'falls'}
        </span>
        {c.offline > 0 && <> · {c.offline} with no data</>}
      </p>
      <p>
        {online} {online === 1 ? 'device' : 'devices'} online · {lowBattery} low battery · {weakSignal} weak signal
      </p>
    </div>
  )
}

type Filter = 'all' | 'fall' | 'check' | 'device'

const filters: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'fall', label: 'Falls' },
  { id: 'check', label: 'Checks' },
  { id: 'device', label: 'Devices' },
]

function matches(a: Alert, f: Filter) {
  if (f === 'all') return true
  if (f === 'device') return a.kind === 'battery' || a.kind === 'signal'
  return a.kind === f
}

const newestFirst = (a: Alert, b: Alert) => Date.parse(b.raisedAt) - Date.parse(a.raisedAt)

export function Alerts() {
  const { alerts, handle, undo } = useLive()
  const [filter, setFilter] = useState<Filter>('all')

  const visible = alerts.filter((a) => matches(a, filter))
  const active = visible.filter((a) => !a.handledAt).sort(newestFirst)
  // Falls first among active, since they matter most
  active.sort((a, b) => Number(b.kind === 'fall') - Number(a.kind === 'fall'))
  const handled = visible.filter((a) => a.handledAt).sort(newestFirst)

  return (
    <Page>
      <PageHeader title="Alerts">
        <WingSummary />
      </PageHeader>

      <div role="tablist" className="mt-8 inline-flex rounded-lg border border-line bg-deep p-1">
        {filters.map((f) => {
          const count = alerts.filter((a) => !a.handledAt && matches(a, f.id)).length
          const selected = filter === f.id
          return (
            <button
              key={f.id}
              role="tab"
              aria-selected={selected}
              onClick={() => setFilter(f.id)}
              className={`flex h-8 items-center gap-2 rounded-md px-3 text-sm transition-colors duration-150 ${
                selected ? 'bg-raised text-fg shadow-[inset_0_1px_0_rgb(255_255_255/0.06)]' : 'text-fg-2 hover:text-fg'
              }`}
            >
              {f.label}
              {count > 0 && <span className="font-mono text-xs tabular-nums text-fg-3">{count}</span>}
            </button>
          )
        })}
      </div>

      <section aria-labelledby="active-heading" className="mt-8">
        <h2 id="active-heading" className="mb-3 text-base font-medium">
          Needs a response <span className="font-mono text-sm tabular-nums text-fg-3">{active.length}</span>
        </h2>
        {active.length ? (
          <div className="flex flex-col gap-2">
            {active.map((a) => (
              <AlertRow key={a.id} alert={a} onHandle={() => handle(a.id)} onUndo={() => undo(a.id)} />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-line bg-card px-5 py-4 text-sm text-fg-2">Nothing waiting</p>
        )}
      </section>

      <section aria-labelledby="handled-heading" className="mt-8">
        <h2 id="handled-heading" className="mb-3 text-base font-medium">
          Handled tonight <span className="font-mono text-sm tabular-nums text-fg-3">{handled.length}</span>
        </h2>
        {handled.length ? (
          <div className="flex flex-col gap-2">
            {handled.map((a) => (
              <AlertRow key={a.id} alert={a} onHandle={() => handle(a.id)} onUndo={() => undo(a.id)} />
            ))}
          </div>
        ) : (
          <p className="rounded-xl border border-line bg-card px-5 py-4 text-sm text-fg-2">None yet</p>
        )}
      </section>
    </Page>
  )
}
