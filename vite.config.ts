import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    open: true
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  },
  optimizeDeps: {
    // 'typescript' is only reached via a dynamic import (astLocatorAudit.ts),
    // triggered the first time an automation suite with grounded collections
    // is generated. Left to Vite's lazy discovery, that first dynamic import
    // arrives mid-session, forces a dependency re-optimization + full reload,
    // and the in-flight fetch for the old chunk URL can lose that race —
    // surfacing as "Failed to fetch dynamically imported module". Pre-bundling
    // it here means it's ready before the first request for it ever happens.
    include: ['typescript']
  }
})
