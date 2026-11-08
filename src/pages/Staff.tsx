import { useEffect, useState, type FormEvent } from 'react'
import { Page } from '../components/PageHeader'
import { api, useAuth, type Role } from '../auth'
import { field, primaryButton } from './Register'

interface Member {
  id: string
  name: string
  email: string
  role: Role
  joined: boolean
}

const roleLabel: Record<Role, string> = { admin: 'Administrator', caretaker: 'Caretaker' }
const select = 'h-9 rounded-lg border border-line bg-raised px-2 text-sm text-fg'
const quiet = 'h-9 rounded-lg px-3 text-sm text-fg-2 transition-colors duration-150 hover:bg-raised hover:text-fg disabled:opacity-50'

/** Admins invite, re-invite, change roles and remove staff in their own care home */
export function Staff() {
  const { me } = useAuth()
  const [staff, setStaff] = useState<Member[] | null>(null)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()
  const [busy, setBusy] = useState<string | null>(null)
  const [invite, setInvite] = useState({ email: '', name: '', role: 'caretaker' as Role })

  useEffect(() => {
    api<Member[]>('/api/staff')
      .then(setStaff)
      .catch((e) => setError((e as Error).message))
  }, [])

  /** Run one change, showing its result or error above the list */
  const run = async (key: string, action: () => Promise<string | void>) => {
    setBusy(key)
    setError(undefined)
    setNotice(undefined)
    try {
      const message = await action()
      if (message) setNotice(message)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setBusy(null)
    }
  }

  const sendInvite = (e: FormEvent) => {
    e.preventDefault()
    run('invite', async () => {
      const added = await api<Member>('/api/staff', 'POST', invite)
      setStaff((s) => [...(s ?? []), added])
      setInvite({ email: '', name: '', role: invite.role })
      return `Invite sent to ${added.email}. They’ll get an email to set their password.`
    })
  }

  const changeRole = (m: Member, role: Role) =>
    run(m.id, async () => {
      const updated = await api<Member>(`/api/staff/${encodeURIComponent(m.id)}`, 'PATCH', { role })
      setStaff((s) => s!.map((x) => (x.id === m.id ? updated : x)))
    })

  const remove = (m: Member) => {
    if (!window.confirm(`Remove ${m.name}? They won’t be able to log in any more.`)) return
    run(m.id, async () => {
      await api(`/api/staff/${encodeURIComponent(m.id)}`, 'DELETE')
      setStaff((s) => s!.filter((x) => x.id !== m.id))
      return `${m.name} has been removed.`
    })
  }

  const resend = (m: Member) =>
    run(m.id, async () => {
      await api(`/api/staff/${encodeURIComponent(m.id)}/resend`, 'POST')
      return `Sent ${m.email} a new link to set their password.`
    })

  return (
    <Page>
      <header>
        <h1 className="text-3xl font-normal">Staff</h1>
        <p className="mt-1 text-sm text-fg-2">
          {me?.careHomeName ? `${me.careHomeName} · ` : ''}Invite caretakers and administrators by email
        </p>
      </header>

      <section className="mt-8 rounded-xl border border-line bg-card p-5">
        <h2 className="text-base font-medium">Invite someone</h2>
        <p className="mt-1 text-sm text-fg-2">They’ll get an email with a link to set their password, then they can log in.</p>
        <form onSubmit={sendInvite} className="mt-5 grid gap-3 sm:grid-cols-[1.4fr_1fr_auto_auto] sm:items-end">
          <label className="flex flex-col gap-1.5 text-sm">
            Email
            <input
              required
              type="email"
              value={invite.email}
              onChange={(e) => setInvite({ ...invite, email: e.target.value })}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            Name <span className="sr-only">(optional)</span>
            <input
              value={invite.name}
              placeholder="Optional"
              onChange={(e) => setInvite({ ...invite, name: e.target.value })}
              className={field}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            Role
            <select
              value={invite.role}
              onChange={(e) => setInvite({ ...invite, role: e.target.value as Role })}
              className={select + ' h-11'}
            >
              <option value="caretaker">Caretaker</option>
              <option value="admin">Administrator</option>
            </select>
          </label>
          <button type="submit" disabled={busy === 'invite'} className={primaryButton}>
            {busy === 'invite' ? 'Sending…' : 'Send invite'}
          </button>
        </form>
      </section>

      {(error || notice) && (
        <p className={`mt-6 text-sm ${error ? 'text-fall' : 'text-fg-2'}`} role="status">
          {error ?? notice}
        </p>
      )}

      <section className="mt-6 overflow-hidden rounded-xl border border-line bg-card">
        <h2 className="sr-only">Everyone with access</h2>
        {!staff ? (
          <p className="px-5 py-4 text-sm text-fg-2">{error ? 'Couldn’t load staff.' : 'Loading staff…'}</p>
        ) : (
          <ul>
            {staff.map((m) => {
              const isMe = m.id === me?.id
              return (
                <li
                  key={m.id}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3 last:border-b-0"
                >
                  <div className="min-w-0 flex-1 basis-56">
                    <p className="truncate text-sm">
                      {m.name}
                      {isMe && <span className="text-fg-3"> (you)</span>}
                    </p>
                    {m.name !== m.email && <p className="truncate text-xs text-fg-3">{m.email}</p>}
                  </div>
                  <p className={`w-20 text-xs ${m.joined ? 'text-fg-3' : 'text-check'}`}>{m.joined ? 'Active' : 'Invited'}</p>
                  {isMe ? (
                    <p className="w-32 text-sm text-fg-2">{roleLabel[m.role]}</p>
                  ) : (
                    <select
                      aria-label={`Role for ${m.name}`}
                      value={m.role}
                      disabled={busy === m.id}
                      onChange={(e) => changeRole(m, e.target.value as Role)}
                      className={select + ' w-32'}
                    >
                      <option value="caretaker">Caretaker</option>
                      <option value="admin">Administrator</option>
                    </select>
                  )}
                  <div className="flex w-48 justify-end gap-1">
                    {!m.joined && (
                      <button onClick={() => resend(m)} disabled={busy === m.id} className={quiet}>
                        Resend invite
                      </button>
                    )}
                    {!isMe && (
                      <button onClick={() => remove(m)} disabled={busy === m.id} className={quiet + ' hover:text-fall'}>
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </Page>
  )
}
