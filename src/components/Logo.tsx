import { Activity } from 'lucide-react'

export function Logo() {
  return (
    <span className="inline-flex items-center gap-2 text-base font-medium text-fg">
      <Activity className="h-[18px] w-[18px]" strokeWidth={1.5} />
      Steady
    </span>
  )
}
