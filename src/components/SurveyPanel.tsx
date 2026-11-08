import { useEffect, useState } from 'react'
import { MapPin, Radio, Tag } from 'lucide-react'
import { RoomPlate } from './board'
import { API_BASE, steadyApi, type AckRow, type LocationRow, type SurveyRow } from '../hardware/api'

function clock(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

function ago(ts: number) {
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 90) return `${seconds} s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${minutes} min ago` : `${Math.round(minutes / 60)} h ago`
}

function ackLabel(ack: AckRow) {
  return ack.kind === 'ok' ? "I'm OK pressed" : `NFC tap ${ack.tag?.slice(-4) ?? ''}`.trim()
}

/**
 * SURVEY MODE, from the dashboard's side: label the captures the wearable made,
 * see where the backend last placed it, and watch "I'm OK"/NFC acknowledgements
 * come in. The board does the scanning and posting, so this only reads back.
 */
export function SurveyPanel({ device, lastEvent }: { device?: string; lastEvent?: string }) {
  const [surveys, setSurveys] = useState<SurveyRow[]>([])
  const [location, setLocation] = useState<LocationRow | null>(null)
  const [acks, setAcks] = useState<AckRow[]>([])
  const [error, setError] = useState<string>()
  const [labelId, setLabelId] = useState<number>()
  const [room, setRoom] = useState('')
  const [floor, setFloor] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const [surveyList, ackList] = await Promise.all([steadyApi.surveys(device), steadyApi.acks()])
        if (cancelled) return
        setSurveys(surveyList.surveys)
        setAcks(ackList.acks)
        setError(undefined)

        if (device) {
          const latest = await steadyApi.location(device)
          if (!cancelled) setLocation(latest.location)
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e))
      }
    }

    void load()
    const timer = setInterval(load, 5000)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [device])

  const save = async () => {
    if (labelId === undefined || !room.trim()) return
    setSaving(true)
    try {
      await steadyApi.labelSurvey(labelId, room.trim(), floor.trim())
      const surveyList = await steadyApi.surveys(device)
      setSurveys(surveyList.surveys)
      setLabelId(undefined)
      setRoom('')
      setFloor('')
      setError(undefined)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-base font-medium">Room location</h2>
        <span className="font-mono text-xs text-fg-3">{API_BASE}</span>
      </div>
      <p className="mt-1 max-w-[46rem] text-sm text-fg-2">
        Survey mode: walk into a room, press the wearable's button three times, then label the capture below. The
        board records the Wi-Fi it can hear; later scans are matched against those recordings, so a fall shows the
        room and floor.
      </p>

      {error && (
        <p className="mt-3 rounded-lg border border-line bg-raised px-3 py-2 text-sm text-fg-2">
          Survey store not reachable — {error}. Start it with{' '}
          <span className="font-mono text-xs">npm run dev</span> in <span className="font-mono text-xs">web/</span>.
        </p>
      )}

      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <div className="rounded-lg border border-line bg-raised px-4 py-3">
          <p className="flex items-center gap-2 text-xs text-fg-3">
            <MapPin className="h-3.5 w-3.5" strokeWidth={1.5} />
            Last known room
          </p>
          {location?.room ? (
            <p className="mt-1 flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-xl tabular-nums text-fg">Room {location.room}</span>
              {location.floor && <span className="text-sm text-fg-2">floor {location.floor}</span>}
              <span className="ml-auto font-mono text-xs tabular-nums text-fg-3">
                {location.confidence ?? '–'}% · {ago(location.ts)}
              </span>
            </p>
          ) : (
            <p className="mt-1 text-sm text-fg-2">
              {device ? 'No match yet — survey this room below' : 'Connect a device to see where it is'}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-line bg-raised px-4 py-3">
          <p className="flex items-center gap-2 text-xs text-fg-3">
            <Tag className="h-3.5 w-3.5" strokeWidth={1.5} />
            Last response
          </p>
          <p className="mt-1 text-sm text-fg">
            {lastEvent ?? (acks[0] ? `${ackLabel(acks[0])} · ${clock(acks[0].ts)}` : 'Nothing yet')}
          </p>
        </div>
      </div>

      <h3 className="mt-6 flex items-center gap-2 text-sm font-medium">
        <Radio className="h-4 w-4 text-fg-3" strokeWidth={1.5} />
        Captures
      </h3>
      {surveys.length ? (
        <ul className="mt-2 divide-y divide-line overflow-hidden rounded-lg border border-line">
          {surveys.map((survey) => (
            <li key={survey.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 text-sm">
              <span className="font-mono tabular-nums text-fg-2">{clock(survey.taken_at)}</span>
              <span className="text-fg">
                {survey.scan_count} scans · {survey.access_points} APs
              </span>
              <span className="font-mono text-xs text-fg-3">{survey.device}</span>
              {survey.room ? (
                <span className="ml-auto inline-flex items-center gap-2">
                  <RoomPlate room={survey.room} />
                  <span className="text-xs text-fg-2">{survey.floor ? `floor ${survey.floor}` : 'no floor'}</span>
                </span>
              ) : (
                <button
                  onClick={() => {
                    setLabelId(survey.id)
                    setRoom('')
                    setFloor('')
                  }}
                  className="ml-auto text-sm text-fg-2 transition-colors duration-150 hover:text-fg"
                >
                  Label room
                </button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-fg-2">No captures yet. Three presses on the wearable records one.</p>
      )}

      {labelId !== undefined && (
        <div className="mt-3 flex flex-wrap items-end gap-2 rounded-lg border border-line bg-raised px-4 py-3">
          <label className="text-xs text-fg-3">
            Room
            <input
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              placeholder="103"
              aria-label="Room number"
              className="mt-1 block h-9 w-24 rounded-md border border-line bg-page px-2 font-mono text-sm text-fg"
            />
          </label>
          <label className="text-xs text-fg-3">
            Floor
            <input
              value={floor}
              onChange={(e) => setFloor(e.target.value)}
              placeholder="1"
              aria-label="Floor"
              className="mt-1 block h-9 w-20 rounded-md border border-line bg-page px-2 font-mono text-sm text-fg"
            />
          </label>
          <button
            disabled={!room.trim() || saving}
            onClick={save}
            className="h-9 rounded-lg bg-fg px-3 text-sm font-medium text-inverse transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-40"
          >
            {saving ? 'Saving…' : 'Save capture'}
          </button>
          <button
            onClick={() => setLabelId(undefined)}
            className="h-9 px-2 text-sm text-fg-2 transition-colors duration-150 hover:text-fg"
          >
            Cancel
          </button>
        </div>
      )}

      <h3 className="mt-6 text-sm font-medium">Responder activity</h3>
      <ul className="mt-2 divide-y divide-line overflow-hidden rounded-lg border border-line">
        {acks.map((ack) => (
          <li key={ack.id} className="flex items-center gap-3 px-4 py-2 text-sm">
            <span className="font-mono tabular-nums text-fg-3">{clock(ack.ts)}</span>
            <span className="text-fg">{ackLabel(ack)}</span>
            <span className="ml-auto font-mono text-xs text-fg-3">{ack.device}</span>
          </li>
        ))}
        {!acks.length && <li className="px-4 py-2 text-sm text-fg-2">No acknowledgements yet.</li>}
      </ul>
    </div>
  )
}
