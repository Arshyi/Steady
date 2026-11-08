import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The backend (server/) runs on 8787; the web app calls it through /api
    proxy: { '/api': 'http://localhost:8787' },
  },
})
