import type { InsiderTrackerAPI } from '@/types';
import { mockApi } from './mockApi';
import { webApi } from './webApi';

/**
 * Picks the API implementation for the current shell:
 *   - Electron desktop → the real `window.api` (preload contextBridge)
 *   - Hosted website   → `webApi` (reads static JSON from the GitHub Actions scrape)
 *   - Plain browser / vite preview → `mockApi` (sample data)
 *
 * `VITE_TARGET` is defined as 'web' only by `vite.config.web.ts` (the Pages build).
 * This is the seam that made the mobile/web port additive — see the analysis doc.
 */
export const isElectron = typeof window !== 'undefined' && !!window.api;
/** True in the hosted GitHub Pages build (set by vite.config.web.ts). */
export const isWeb = import.meta.env.VITE_TARGET === 'web';

export const api: InsiderTrackerAPI = isElectron ? window.api : isWeb ? webApi : mockApi;
