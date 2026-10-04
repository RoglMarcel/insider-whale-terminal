import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';
import fs from 'node:fs';

/**
 * `public/` is copied verbatim, but the 5.3 MB intro video is only ever played by
 * the Electron shell — `App.tsx` sets `showIntro = !isWeb`. Shipping it made up
 * 83% of the hosted payload for a file no visitor can trigger. `public/README.md`
 * is an internal note and equally pointless to serve.
 */
function dropUnusedPublicAssets(): Plugin {
  const DROP = ['intro.mp4', 'README.md'];
  return {
    name: 'drop-unused-public-assets',
    apply: 'build',
    closeBundle() {
      for (const name of DROP) {
        const file = path.join(__dirname, 'dist-web', name);
        if (fs.existsSync(file)) fs.rmSync(file);
      }
    },
  };
}

/**
 * Web build (v1.1.2) — the SAME React renderer as the desktop app, but with the
 * `vite-plugin-electron` plugin removed so it builds as a plain static site for
 * GitHub Pages. Data comes from `public/data/*.json` (written by `scrape:web`),
 * read at runtime by `src/lib/webApi.ts`.
 *
 *   npm run build:web   →   dist-web/
 *
 * `base: './'` keeps asset + data URLs relative, so the same build works on a
 * Pages project site (/repo/), a user site, or a custom domain.
 */
export default defineConfig({
  plugins: [react(), dropUnusedPublicAssets()],
  resolve: {
    alias: {
      '@': path.join(__dirname, 'src'),
    },
  },
  define: {
    // Renderer switch: makes `src/lib/ipc.ts` pick the static-data web API.
    'import.meta.env.VITE_TARGET': JSON.stringify('web'),
  },
  base: './',
  server: { proxy: { '/api/analysis': 'http://127.0.0.1:8787' } },
  build: {
    outDir: 'dist-web',
    emptyOutDir: true,
  },
});
