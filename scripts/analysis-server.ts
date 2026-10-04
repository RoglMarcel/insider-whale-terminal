import { createServer } from 'node:http';
import { analyzeStock } from '../electron/analysis';
import { normalizeAnalysisTicker } from '../src/types/analysis';

const port = Number(process.env.ANALYSIS_PORT || 8787);
const allowedOrigins = new Set((process.env.ANALYSIS_ALLOWED_ORIGINS || 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s => s.trim()));
const rates = new Map<string, { count: number; until: number }>();

createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Origin');
  const origin = req.headers.origin;
  const send = (status: number, value: unknown) => { res.writeHead(status); res.end(JSON.stringify(value)); };
  if (origin && !allowedOrigins.has(origin)) { send(403, { error: 'Origin not allowed' }); return; }
  if (origin) res.setHeader('Access-Control-Allow-Origin', origin);
  if (req.method !== 'GET') { res.setHeader('Allow', 'GET'); send(405, { error: 'Method not allowed' }); return; }
  const url = new URL(req.url || '/', 'http://localhost');
  if (url.pathname !== '/api/analysis') { send(404, { error: 'Not found' }); return; }
  const now = Date.now();
  for (const [key, rate] of rates) if (rate.until <= now) rates.delete(key);
  const ip = req.socket.remoteAddress || 'unknown';
  const rate = rates.get(ip) || { count: 0, until: now + 60_000 };
  if (++rate.count > 20 || rates.size > 10_000) { res.setHeader('Retry-After', '60'); send(429, { error: 'Too many requests' }); return; }
  rates.set(ip, rate);
  let ticker: string;
  try { ticker = normalizeAnalysisTicker(url.searchParams.get('ticker')); }
  catch { send(400, { error: 'Invalid ticker' }); return; }
  try { send(200, await analyzeStock(ticker)); }
  catch { send(503, { error: 'Analysis temporarily unavailable' }); }
}).listen(port, process.env.ANALYSIS_HOST || '127.0.0.1', () => {
  console.log(`Analysis service listening on port ${port}`);
});
