import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    watch: {
      // web/ is a separate project (the Worker). `wrangler dev` rewrites its
      // local D1 and trace-store SQLite files on every request; without this,
      // Vite treats each write as a source change and reloads the dashboard,
      // which drops a connected wearable every few seconds.
      ignored: ['**/web/.wrangler/**'],
    },
  },
})
