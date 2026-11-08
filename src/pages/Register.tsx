import { useEffect, useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router'
import { Logo } from '../components/Logo'
import { api, useAuth } from '../auth'

export const field =
  'h-11 w-full rounded-lg border border-line bg-raised px-3 text-sm text-fg placeholder:text-fg-3 focus:border-fg-3 focus:outline-none'
export const primaryButton =
  'inline-flex h-11 items-center justify-center rounded-lg bg-fg px-5 text-sm font-medium text-inverse transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-[0.98] disabled:opacity-50'

/** Makes a new care home and its first administrator. The admin then invites everyone else. */
export function Register() {
  const { enabled, login } = useAuth()
  const navigate = useNavigate()
  // With login turned off there's no login page, so go straight to the dashboard
  const goLogin = (to: string) => (enabled ? login(to) : navigate(to))
  const [available, setAvailable] = useState<boolean | null>(null)
  const [form, setForm] = useState({ careHome: '', name: '', email: '' })
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string>()
  const [sentTo, setSentTo] = useState<string>()

  useEffect(() => {
    api<{ register: boolean }>('/api/accounts')
      .then((a) => setAvailable(a.register))
      .catch(() => setAvailable(false))
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSending(true)
    setError(undefined)
    try {
      const { email } = await api<{ email: string }>('/api/register', 'POST', form)
      setSentTo(email)
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setSending(false)
    }
  }

  const set = (key: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [key]: e.target.value })

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex h-14 max-w-[1280px] items-center px-4 sm:px-8">
        <Link to="/">
          <Logo />
        </Link>
      </header>
      <main className="mx-auto max-w-[28rem] px-4 py-16 sm:px-8">
        {sentTo ? (
          <>
            <h1 className="text-3xl font-normal">Check your email</h1>
            <p className="mt-4 text-base leading-6 text-fg-2">
              We’ve sent a link to <span className="text-fg">{sentTo}</span> to set your password. Once that’s done, log
              in and add your staff from the Staff page.
            </p>
            <button onClick={() => goLogin('/staff')} className={primaryButton + ' mt-8'}>
              Staff log in
            </button>
          </>
        ) : (
          <>
            <h1 className="text-3xl font-normal">Register your care home</h1>
            <p className="mt-4 text-base leading-6 text-fg-2">
              You’ll be the administrator. After you log in, you can invite your staff by email.
            </p>

            {available === null ? null : available === false ? (
              <p className="mt-8 rounded-xl border border-line bg-card px-5 py-4 text-sm text-fg-2">
                Registering isn’t available on this server yet.
              </p>
            ) : (
              <form onSubmit={submit} className="mt-8 flex flex-col gap-4">
                <label className="flex flex-col gap-1.5 text-sm">
                  Care home name
                  <input required value={form.careHome} onChange={set('careHome')} className={field} autoComplete="organization" />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  Your name
                  <input required value={form.name} onChange={set('name')} className={field} autoComplete="name" />
                </label>
                <label className="flex flex-col gap-1.5 text-sm">
                  Work email
                  <input required type="email" value={form.email} onChange={set('email')} className={field} autoComplete="email" />
                </label>
                {error && <p className="text-sm text-fall">{error}</p>}
                <button type="submit" disabled={sending} className={primaryButton + ' mt-2'}>
                  {sending ? 'Creating your account…' : 'Create account'}
                </button>
                <p className="text-sm text-fg-3">
                  Already have an account?{' '}
                  <button type="button" onClick={() => goLogin('/alerts')} className="text-fg-2 underline underline-offset-2 hover:text-fg">
                    Log in
                  </button>
                </p>
              </form>
            )}
          </>
        )}
      </main>
    </div>
  )
}
