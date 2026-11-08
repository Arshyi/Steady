import { Link } from 'react-router'
import { ArrowRight } from 'lucide-react'
import { byUrgency, countByStatus, LOW_BATTERY } from '../data/residents'
import { AlertRow, ResidentList } from '../components/board'
import { Page, PageHeader } from '../components/PageHeader'
import { WingMap } from '../components/WingMap'
import { useLive } from '../live'

// Overview is the wing at a glance. Only falls show here in full; everything else lives on Alerts.
export function Overview() {
  const { residents, alerts, active, handle, undo } = useLive()
  const sorted = [...residents].sort(byUrgency)
  const c = countByStatus(residents)

  const falls = alerts.filter((a) => a.kind === 'fall' && (!a.handledAt || Date.now() - Date.parse(a.handledAt) < 30 * 60_000))
  const otherActive = active.filter((a) => a.kind !== 'fall').length
  const online = residents.filter((r) => r.device?.lastSyncSec !== null && r.device?.lastSyncSec !== undefined && r.device.lastSyncSec < 120).length
  const lowBattery = residents.filter((r) => (r.device?.battery ?? 100) < LOW_BATTERY).length
  const weakSignal = residents.filter((r) => r.device?.signal === 'weak').length

  return (
    <Page>
      <PageHeader title="Overview">
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
      </PageHeader>

      {(falls.length > 0 || otherActive > 0) && (
        <section aria-label="Falls" className="mt-8 flex flex-col gap-2">
          {falls.map((a) => (
            <AlertRow key={a.id} alert={a} onHandle={() => handle(a.id)} onUndo={() => undo(a.id)} />
          ))}
          {otherActive > 0 && (
            <Link
              to="/alerts"
              className="inline-flex items-center gap-2 self-start px-1 py-1 text-sm text-fg-2 transition-colors duration-150 hover:text-fg"
            >
              {otherActive} other {otherActive === 1 ? 'alert' : 'alerts'} waiting
              <ArrowRight className="h-4 w-4" strokeWidth={1.5} />
            </Link>
          )}
        </section>
      )}

      <section aria-labelledby="map-heading" className="mt-8">
        <h2 id="map-heading" className="mb-3 text-base font-medium">
          Wing map
        </h2>
        <WingMap residents={residents} />
      </section>

      <section aria-labelledby="residents-heading" className="mt-8">
        <h2 id="residents-heading" className="mb-3 text-base font-medium">
          Residents
        </h2>
        <ResidentList residents={sorted} />
      </section>
    </Page>
  )
}
