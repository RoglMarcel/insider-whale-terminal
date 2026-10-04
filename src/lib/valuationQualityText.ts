const german:Record<string,string>={
  'Consistent dated cashflow, discount and growth evidence supports fundamental valuation.':'Datierte, konsistente Cashflow-, Diskont- und Wachstumsdaten tragen die fundamentale Bewertung.',
  'Suitable relative comparisons or forecast-backed cashflow with limited evidence.':'Geeignete Branchenvergleiche oder Cashflow mit Wachstumsprognose; die Belege sind begrenzt.',
  'Simple valuation or material policy fallback; evidence does not support a higher level.':'Einfache Bewertung oder wesentliche Ersatzannahmen; die Daten tragen keine höhere Stufe.',
  'Sourced growth forecast':'Belegte Wachstumsprognose',
  'Dated consistent cashflow and independently supported discount rate; current FCF proxy is not normalized history':'Datierter konsistenter Cashflow und belegter Diskontsatz; aktueller FCF ist keine normalisierte Historie',
  'At least two suitable independent relative comparisons':'Mindestens zwei geeignete relative Vergleichsverfahren',
};
export function valuationQualityText(text:string,language:string){return language==='de'?(german[text]||text):text;}
