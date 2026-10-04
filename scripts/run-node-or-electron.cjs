#!/usr/bin/env node
/**
 * Run a bundled script on whichever runtime can actually load `better-sqlite3`.
 *
 * The native module is compiled for exactly one ABI. On a developer machine the
 * postinstall (`electron-builder install-app-deps`) builds it for ELECTRON, so
 * plain `node` dies with ERR_DLOPEN_FAILED ("NODE_MODULE_VERSION 125 … requires
 * 115"). In CI it is rebuilt for Node, where Electron is not necessarily usable.
 * Both are legitimate, and which one applies is not something the caller should
 * have to know — `npm run analyze:score` was simply broken locally because the
 * script hard-coded `node`.
 *
 * The probe CONSTRUCTS a database: `require('better-sqlite3')` alone succeeds
 * even when the binding is unloadable, because the addon is resolved lazily.
 */
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const script = process.argv[2];
if (!script) {
  console.error('usage: run-node-or-electron.cjs <bundled-script.cjs> [args…]');
  process.exit(2);
}
const args = process.argv.slice(3);

const PROBE = "new (require('better-sqlite3'))(':memory:').close()";

function loadsUnderNode() {
  const r = spawnSync(process.execPath, ['-e', PROBE], { encoding: 'utf8' });
  return r.status === 0;
}

function electronBinary() {
  try {
    const p = require('electron');
    return typeof p === 'string' && fs.existsSync(p) ? p : null;
  } catch {
    return null;
  }
}

if (loadsUnderNode()) {
  const r = spawnSync(process.execPath, [script, ...args], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const electron = electronBinary();
if (!electron) {
  console.error(
    '[runner] better-sqlite3 is not loadable under Node, and Electron is unavailable.\n' +
      '         Rebuild it for the runtime you want:\n' +
      '           for Node     → npm rebuild better-sqlite3 --build-from-source\n' +
      '           for Electron → npx electron-builder install-app-deps',
  );
  process.exit(1);
}

console.error(
  `[runner] better-sqlite3 is built for the Electron ABI — running ${path.basename(script)} under Electron.`,
);
const r = spawnSync(electron, [script, ...args], {
  stdio: 'inherit',
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
process.exit(r.status ?? 1);
