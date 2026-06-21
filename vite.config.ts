import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    // Emit clean, fingerprinted assets; HTML is generated per-route by vite-react-ssg.
    outDir: 'dist',
  },
  ssr: {
    // Bundle the markdown/unified ecosystem for the SSG prerender pass.
    noExternal: ['react-markdown', 'remark-gfm', 'rehype-raw'],
  },
})
