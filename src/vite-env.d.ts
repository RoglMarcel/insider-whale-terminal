/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Set to 'web' only by vite.config.web.ts (the GitHub Pages build). */
  readonly VITE_TARGET?: 'web';
  readonly VITE_ANALYSIS_API_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
