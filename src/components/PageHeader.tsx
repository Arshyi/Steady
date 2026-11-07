import type { ReactNode } from 'react'
import { shift } from '../data/residents'

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header>
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-2">
        <h1 className="text-3xl font-normal">{title}</h1>
        <p className="font-mono text-xs tabular-nums text-fg-3">Updated {shift.updatedAt}</p>
      </div>
      <p className="mt-1 text-sm text-fg-2">
        {shift.wing} · {shift.name} · {shift.date}
      </p>
      {children}
    </header>
  )
}

export function Page({ children }: { children: ReactNode }) {
  return <div className="mx-auto max-w-[1440px] px-4 py-8 sm:px-8">{children}</div>
}
