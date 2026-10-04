import type { InsiderTrackerAPI } from './index';

declare global {
  interface Window {
    /** Typed IPC bridge exposed by electron/preload.ts via contextBridge. */
    api: InsiderTrackerAPI;
  }
}

export {};
