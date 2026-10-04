import type { ExternalFairValue, FairValueResult } from '../../src/types/fairValue';
import type { MarketQuote } from '../marketData';
import { scopedFetch, checkCancelled } from './cancellation';
import { useScrapling, scraplingHtml } from './scrapling';

const cache = new Map<string, ExternalFairValue>();
const blockedUntil = new Map<string, number>();
function visible(html: string) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>|<!--[\s\S]*?-->/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;/g, ' ').replace(/&trade;|&#8482;/g, '™').replace(/\s+/g, ' ').trim();
}
/** Only a visibly labelled valuation for the exact listing; never a price target. */
export function parseExternalFairValue(html: string, ticker: string, provider: ExternalFairValue['provider']): {value:number; currency:string; asOf?:string} | null {
  const plain = visible(html);
  const escaped = ticker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (provider === 'alphaspread') {
    if (!new RegExp(`(?:NASDAQ|NYSE|AMEX):\\s*${escaped}(?![A-Z0-9.-])`).test(plain)) return null;
    const match = new RegExp(`The intrinsic value (?:for|of) [^.]{0,250}\\(${escaped}\\) under the Base Case is ([\\d,]+(?:\\.\\d+)?) ([A-Z]{3})`).exec(plain);
    if (match && Number(match[1].replace(/,/g,'')) > 0) return {value:Number(match[1].replace(/,/g,'')),currency:match[2]};
  } else if (provider === 'valueinvesting') {
    const match = new RegExp(`As of (\\d{4}-\\d{2}-\\d{2}), the Fair Value of [^.]{0,250}\\(${escaped}\\) is ([\\d,]+(?:\\.\\d+)?) ([A-Z]{3})\\. This value is based on the Peter Lynch`).exec(plain);
    if (match && Number(match[2].replace(/,/g,'')) > 0 && Number.isFinite(Date.parse(match[1]))) return {value:Number(match[2].replace(/,/g,'')),currency:match[3],asOf:match[1]};
  } else {
    const title = visible(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] || '');
    if (!new RegExp(`(?:^|[^A-Z0-9.-])${escaped}(?![A-Z0-9.-])`).test(title)) return null;
    // GF Value is distinct from Peter Lynch, DCF and the analyst target.
    const match = /GF Value(?:™)?\s*:\s*\$\s*([\d,]+(?:\.\d+)?)/.exec(plain) || /GF Value(?:™)?\s*:\s*\$\s*([\d,]+(?:\.\d+)?)/.exec(title);
    if (match && Number(match[1].replace(/,/g,'')) > 0) return {value:Number(match[1].replace(/,/g,'')),currency:'USD'};
  }
  return null;
}

export async function fetchExternalFairValues(ticker: string, quote: MarketQuote | null): Promise<ExternalFairValue[]> {
  const exchange = quote?.exchange || '';
  const market = /nasdaq|NMS|NGM|NCM/i.test(exchange) ? 'nasdaq' : /NYSE|NYQ/i.test(exchange) ? 'nyse' : /AMEX|ASE/i.test(exchange) ? 'amex' : null;
  const eligible = /^[A-Z][A-Z0-9.-]{0,11}$/.test(ticker) && !/\.(?:DE|L|PA|AS|TO|T|HK|AX|SW|MI|ST)$/.test(ticker) && quote?.currency === 'USD' && !!market;
  return Promise.all((['alphaspread','gurufocus','valueinvesting'] as const).map(async provider => {
    const url = provider === 'alphaspread' ? `https://www.alphaspread.com/security/${market || 'nasdaq'}/${ticker.toLowerCase()}/summary` : provider === 'gurufocus' ? `https://www.gurufocus.com/term/gf-value/${ticker}` : `https://valueinvesting.io/${ticker}/valuation/fair-value`;
    const base: ExternalFairValue = {provider, method:provider === 'alphaspread' ? 'Base case: DCF + relative valuation' : provider === 'gurufocus' ? 'GF Value' : 'Peter Lynch fair value',url,fetchedAt:new Date().toISOString(),currency:quote?.currency || '',value:null,status:'unsupported'};
    if (!eligible) return {...base,reason:'No verified supported US listing and USD quote'};
    const key = provider+':'+ticker, previous = cache.get(key);
    if (previous && Date.now()-Date.parse(previous.fetchedAt) < (previous.value ? 86_400_000 : 900_000)) return previous;
    if ((blockedUntil.get(provider) || 0) > Date.now()) return {...base,status:'blocked',reason:'Provider cooldown after blocking or rate limit'};
    let result: ExternalFairValue;
    try {
      let html: string;
      if (useScrapling()) html = await scraplingHtml(url);
      else {
        const response = await scopedFetch(url,{headers:{'User-Agent':'Mozilla/5.0 (compatible; InsiderWhalePublicData/1.0)'},signal:AbortSignal.timeout(7000)});
        if (!response.ok) {
          if ([403,429].includes(response.status)) blockedUntil.set(provider,Date.now()+900_000);
          result = {...base,status:[403,429].includes(response.status)?'blocked':'unavailable',reason:`HTTP ${response.status}`};
          cache.set(key,result); return result;
        }
        html = await response.text();
        if (html.length > 8_000_000) throw new Error('Oversized page');
      }
      checkCancelled();
      const parsed = parseExternalFairValue(html,ticker,provider);
      result = parsed && parsed.currency === quote!.currency ? {...base,...parsed,status:'available'} : {...base,status:'unavailable',reason:'No visibly labelled value for the verified listing and currency'};
    } catch (error) {
      checkCancelled();
      const status = (error as {status?:number})?.status;
      const blocked = status === 403 || status === 429;
      if (blocked) blockedUntil.set(provider,Date.now()+900_000);
      result = {...base,status:blocked?'blocked':'unavailable',reason:status ? `HTTP ${status}` : 'Public fetch blocked, failed or timed out'};
    }
    if (cache.size >= 1000) cache.delete(cache.keys().next().value!);
    cache.set(key,result); return result;
  }));
}

export function compareExternalFairValues(result: FairValueResult, comparisons: ExternalFairValue[]): ExternalFairValue[] {
  return comparisons.map(c => {
    const dated = c.asOf ? Date.parse(c.asOf) : Date.parse(c.fetchedAt);
    const valid = c.status === 'available' && c.value != null && c.value > 0 && c.currency === result.currency && dated <= Date.now() && Date.now()-dated < 7*86_400_000;
    return {...c,modelDifferencePct:valid && result.fairValue != null ? (result.fairValue!/c.value!-1)*100 : null,
      marketMispricingPct:valid && result.price != null ? (result.price!/c.value!-1)*100 : null};
  });
}
