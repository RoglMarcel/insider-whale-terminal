const text = `Search tickers (stock/ETF/mutual fund)...
Screener
Watchlist
Charts
Gurus
Filings Search
Register
SMMTSummit Therapeutics IncPrice:  14,01 USDVolume:  9.839.082
United States | Biotechnology
Add to Watchlist
ValuationOverviewFinancialsForecastCompareHistorical PriceSolvencyDividendsTransactionsPeople
Valuation Summary
Trading Multiples
Peter Lynch Fair Value
WACC
Similar Stocks to SMMT
AMGN
Amgen Inc
GILD
Gilead Sciences Inc
VRTX
Vertex Pharmaceuticals Inc
REGN
Regeneron Pharmaceuticals Inc
AVRO
AVROBIO Inc
SMMT Intrinsic Value
-155.5 %
Upside
What is the intrinsic value of SMMT?

As of 2026-06-14, the Intrinsic Value of Summit Therapeutics Inc (SMMT) is -7,77 USD. This SMMT valuation is based on the model Peter Lynch Fair Value. With the current market price of 14,01 USD, the upside of Summit Therapeutics Inc is -155.5%.

Is SMMT undervalued or overvalued?

Based on its market price of 14,01 USD and our intrinsic valuation, Summit Therapeutics Inc (SMMT) is overvalued by 155.5%.

Note: result may not be accurate due to the invalid valuation result of Peter Lynch's fair value model.

14,01 USD
Stock Price
-7,77 USD
Intrinsic Value
Intrinsic Value Details
SMMT Intrinsic Value - Valuation Summary
	Range	Selected	Upside
a
Peter Lynch Fair Value	-7,77 - -7,77	-7,77	-155.46%
P/E Multiples	(22.53) - (26.26)	(24.40)	-274.1%
SMMT Intrinsic Value - Peers Comparison
	Range	Selected	Upside
a`;

function findValueNear(text: string, labels: string[]): number | undefined {
  for (const label of labels) {
    const re = new RegExp(`${label}[^$0-9]{0,40}\\$?\\s*([0-9][0-9,]*\\.?[0-9]*)`, 'i');
    const m = text.match(re);
    if (m) {
      console.log(`Matched label: "${label}" with entire match: "${m[0]}" and capture group: "${m[1]}"`);
      const n = parseFloat(m[1].replace(/,/g, ''));
      if (Number.isFinite(n) && n > 0) return n;
    } else {
      console.log(`Label "${label}" did not match.`);
    }
  }
  return undefined;
}

const fairValue = findValueNear(text, ['intrinsic value', 'fair value', 'dcf', 'base case']);
console.log('Result fairValue:', fairValue);
