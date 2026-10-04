import { runScrapling, scraplingEnabled } from './scraplingRuntime';
export interface ScraplingTable { headers: string[]; rows: {cells: string[]; insiderUrl: string; filingUrl: string}[]; }
export const useScrapling = scraplingEnabled;
export async function scraplingTable(url: string, selectors: string[]): Promise<ScraplingTable> {
  const data=await runScrapling<ScraplingTable>({url,selectors},25000);
  if(!Array.isArray(data.headers)||!Array.isArray(data.rows))throw new Error('Invalid Scrapling table');
  return data;
}
export async function scraplingHtml(url: string): Promise<string> {
  const data=await runScrapling<{html:string}>({url,mode:'html'});
  if(typeof data.html!=='string')throw new Error('Invalid Scrapling page');
  return data.html;
}
