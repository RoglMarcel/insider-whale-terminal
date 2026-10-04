import type { BrowserContext } from 'playwright';
type State = Awaited<ReturnType<BrowserContext['storageState']>>;
export interface EncryptionProvider {
  isEncryptionAvailable(): boolean;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
  getSelectedStorageBackend?(): string;
}
function requireEncryption(provider: EncryptionProvider, platform: string): void {
  if (!provider.isEncryptionAvailable() || (platform === 'linux' && provider.getSelectedStorageBackend?.() === 'basic_text')) {
    throw new Error('Secure OS session storage is unavailable. Unlock your OS keychain and retry saving.');
  }
}
export function parseSession(json: string): State {
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== 'object') throw new Error('Invalid session data');
  const s = value as Record<string, unknown>;
  if (!Array.isArray(s.cookies) || !Array.isArray(s.origins)) throw new Error('Invalid session structure');
  for (const c of s.cookies) {
    if (!c || typeof c !== 'object' || !['name','value','domain','path'].every(k => typeof c[k] === 'string') ||
        (c.expires !== undefined && !Number.isFinite(c.expires)) || !['Strict','Lax','None'].includes(c.sameSite) ||
        typeof c.secure !== 'boolean' || typeof c.httpOnly !== 'boolean') throw new Error('Invalid session cookie');
  }
  for (const o of s.origins) {
    if (!o || typeof o !== 'object' || typeof o.origin !== 'string' || !Array.isArray(o.localStorage) ||
        !o.localStorage.every((v: { name?: unknown; value?: unknown }) => v && typeof v.name === 'string' && typeof v.value === 'string')) throw new Error('Invalid session origin');
  }
  return value as State;
}
export function encodeSession(state: State, provider: EncryptionProvider, platform = process.platform): Buffer {
  requireEncryption(provider, platform);
  const json = JSON.stringify(state);
  parseSession(json);
  return Buffer.concat([Buffer.from('ENC:'), provider.encryptString(json)]);
}
export function decodeSession(bytes: Buffer, provider: EncryptionProvider, platform = process.platform): { state: State; migration?: Buffer } {
  const marker = bytes.subarray(0,4).toString('utf8');
  requireEncryption(provider, platform);
  if (marker === 'ENC:') return { state: parseSession(provider.decryptString(bytes.subarray(4))) };
  const state = parseSession((marker === 'RAW:' ? bytes.subarray(4) : bytes).toString('utf8'));
  // A legacy plaintext session cannot become usable before an encrypted replacement is persisted.
  return { state, migration: encodeSession(state,provider,platform) };
}
