import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import electron from 'vite-plugin-electron/simple'
import path from 'node:path'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    electron({
      // Main process entry — bundled to dist-electron/main.js (CommonJS).
      main: {
        entry: 'electron/main.ts',
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: false,
            rollupOptions: {
              // Native / heavy node modules must stay external (never bundled).
              external: ['better-sqlite3', 'playwright', 'playwright-core', 'node-cron', 'electron'],
            },
          },
        },
      },
      // Preload script — exposes the typed contextBridge API.
      preload: {
        input: path.join(__dirname, 'electron/preload.ts'),
        vite: {
          build: {
            outDir: 'dist-electron',
            minify: false,
            rollupOptions: {
              external: ['electron'],
            },
          },
        },
      },
      // Renderer stays fully sandboxed — no node integration. Omit renderer polyfills.
    }),
  ],
  resolve: {
    alias: {
      '@': path.join(__dirname, 'src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
  server: {
    proxy: { '/api/analysis': 'http://127.0.0.1:8787' },
    port: 5173,
    strictPort: false,
  },
  clearScreen: false,
})
