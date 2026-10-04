import { LOGIN_PLATFORMS } from '../src/types';

export function requirePlatform(key: unknown): asserts key is string {
  if (typeof key !== 'string' || !LOGIN_PLATFORMS.some(p => p.key === key)) throw new Error('Unknown login platform');
}

export function externalWebUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function requireHistoryUrl(value: string): string {
  const normalized = externalWebUrl(value);
  if (!normalized) throw new Error('Invalid insider history URL');
  const url = new URL(normalized);
  if (!['openinsider.com', 'www.openinsider.com'].includes(url.hostname) || url.port ||
      !/^\/insider\/[^/]+\/\d+\/?$/.test(url.pathname) || url.search || url.hash) throw new Error('Untrusted insider history URL');
  return normalized;
}

/** Only the actual application main frame may invoke privileged handlers. */
export function trustedRenderer(event: { sender: unknown; senderFrame: unknown }, owner: { mainFrame: unknown } | null, entry: string): boolean {
  if (!owner || event.sender !== owner || event.senderFrame !== owner.mainFrame || !event.senderFrame) return false;
  const frame = event.senderFrame as { url?: string };
  try {
    const actual = new URL(frame.url ?? ''); const expected = new URL(entry);
    actual.hash = ''; expected.hash = '';
    return actual.href === expected.href;
  } catch { return false; }
}
