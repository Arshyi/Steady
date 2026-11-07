import { useState } from 'react'

/** Dark is the default. The choice is remembered in this browser. */
export function useTheme() {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))

  const toggle = () => {
    const next = !dark
    document.documentElement.classList.toggle('dark', next)
    try {
      localStorage.setItem('theme', next ? 'dark' : 'light')
    } catch {
      // storage blocked, the toggle still works for this visit
    }
    setDark(next)
  }

  return { dark, toggle }
}
