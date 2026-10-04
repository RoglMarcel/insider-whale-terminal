export const MODEL_IDS = ['fcff','fcfe','ddm','ddm2','apv','residual','eva','peHistory','peIndustry','forwardPe','peg','cape','evEbit','evEbitda','ps','evSales','pb','pcf','ptbv','yield','nav','liquidation','reproduction','stuttgart','realOption','sotp'] as const;
export type ModelId = typeof MODEL_IDS[number];
export type Provider = 'stockrow' | 'gurufocus' | 'tikr' | 'macrotrends';
export interface Fact { value: number; period: string; unit: 'currency' | 'perShare' | 'ratio' | 'fraction' | 'shares'; derived?: boolean; }
/** One coherent provider dataset per calculation; amounts in full currency units, rates as fractions. */
export interface Fundamentals {
  ticker: string; provider: Provider; url: string; fetchedAt: string; currency: string;
  price?: number; priceAsOf?: string; statementDate: string;
  facts: Record<string, Fact>; annual?: Record<string, Fact[]>;
  basis?: string; industry?: string; peers?: { ticker: string; industry: string; pe: number }[];
  segments?: { name: string; ebit: number; multiple: number }[];
}
export interface ValuationDocument { schemaVersion: 1; generatedAt: string; stocks: Record<string, Fundamentals[]>; }
export interface Assumptions {
  years: number; growth: number; terminalGrowth: number; wacc: number; costEquity: number; unleveredRate: number;
  marketYield: number; targetPeg: number;
  receivableRecovery: number; inventoryRecovery: number; ppeRecovery: number;
}
export const DEFAULT_ASSUMPTIONS: Assumptions = { years: 5, growth: .03, terminalGrowth: .02, wacc: .10, costEquity: .10, unleveredRate: .10, marketYield: .04, targetPeg: 1, receivableRecovery: .75, inventoryRecovery: .50, ppeRecovery: .50 };
export interface ModelResult { id: ModelId; status: 'available' | 'missing' | 'invalid' | 'stale'; value?: number; upsidePct?: number; missing: string[]; formula: string; used: string[]; }
