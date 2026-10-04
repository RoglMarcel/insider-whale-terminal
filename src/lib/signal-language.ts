import { displayText } from './display-text';
import type { Lang } from './i18n';

/** Presentation-only translation of persisted score explanations. Never changes a score or a source record. */
export function localizeScoreNote(value: string, language: Lang): string {
  let text = displayText(value).trim();
  if (language !== 'de') return text;
  const replacements: [RegExp, string][] = [
    [/Legacy flat-bonus score \(shadow\):/g, 'Vergleichsscore des früheren Modells:'],
    [/90d buys use dated observed records; source coverage may be incomplete\. The insider score uses a 30d pipeline window\./g, '90-Tage-Käufe basieren auf beobachteten, datierten Meldungen; die Quellenabdeckung kann unvollständig sein. Der Insider-Score berücksichtigt 30 Tage.'],
    [/insiders buying \(cluster/g, 'Insider kaufen (Cluster'],
    [/Insider buys ≈/g, 'Insider-Käufe ≈'], [/of market cap/g, 'der Marktkapitalisierung'],
    [/Weighted transaction quality/g, 'Gewichtete Transaktionsqualität'],
    [/Earnings in/g, 'Quartalszahlen in'], [/days \(insider/g, 'Tagen (Insider'],
    [/Finance insider buying/g, 'Insider-Käufe im Finanzsektor'], [/days pre-earnings/g, 'Tage vor Quartalszahlen'],
    [/Bullish options flow/g, 'Positiver Optionsfluss'], [/Bearish put flow/g, 'Negativer Put-Optionsfluss'],
    [/Elevated VIX — insider buying boosted/g, 'Erhöhter VIX — Insider-Käufe verstärkt'],
    [/Strong insider track record/g, 'Starke Insider-Erfolgsbilanz'], [/Weak insider track record/g, 'Schwache Insider-Erfolgsbilanz'],
    [/Undervalued/g, 'Unterbewertet'], [/upside/g, 'Potenzial'], [/Overvalued — conviction tempered/g, 'Überbewertet — Überzeugungsgrad reduziert'],
    [/Net bearish options flow \(put-dominated\)/g, 'Negativer Netto-Optionsfluss (Put-dominiert)'],
    [/Insider signal age decay/g, 'Altersabschlag des Insider-Signals'],
    [/insider sell\/disposal record\(s\) also on file/g, 'Insider-Verkaufs- oder Abgangsmeldungen ebenfalls vorhanden'],
    [/undated or unresolved purchase record\(s\) excluded from score and 90d buys\./g, 'Kaufmeldungen ohne geklärtes Datum vom Score und den 90-Tage-Käufen ausgeschlossen.'],
    [/Heavy insider SELLING here:/g, 'Starke Insider-Verkäufe:'], [/sold vs/g, 'verkauft gegenüber'], [/bought \(90d\)/g, 'gekauft (90 Tage)'],
    [/Form 144 proposed-sale notice\(s\) filed \(90d\)/g, 'Form-144-Meldungen geplanter Verkäufe (90 Tage)'],
    [/High short interest:/g, 'Hohe Leerverkaufsquote:'], [/of float/g, 'des Streubesitzes'],
    [/Thin liquidity:/g, 'Geringe Liquidität:'], [/k\/day average volume/g, 'Tsd. durchschnittliches Tagesvolumen'],
    [/Buying within/g, 'Käufe innerhalb von'], [/Buying /g, 'Käufe '], [/below the 52-week high — deep-drawdown insider buy/g, 'unter dem 52-Wochen-Hoch — Insider-Kauf nach starkem Rückgang'], [/of the 52-week high/g, 'des 52-Wochen-Hochs'],
    [/congressional buy\(s\):/g, 'Kongress-Käufe:'], [/members of Congress buying/g, 'Kongressmitglieder kaufen'],
    [/Lone politician print — badge only \(needs cluster or insider alignment to affect score\)/g, 'Einzelner Politiker-Kauf — nur Kennzeichnung (Score-Wirkung erst bei mehreren Käufern oder passenden Insider-Käufen)'],
    [/congressional sell\(s\) — contra-signal outweighs buys here/g, 'Kongress-Verkäufe — das Gegensignal überwiegt die Käufe'], [/congressional sell\(s\) also on file/g, 'Kongress-Verkäufe ebenfalls vorhanden'],
    [/COMBO: insider \+ bullish options/g, 'KOMBINATION: Insider + positiver Optionsfluss'],
    [/MEGA SIGNAL: congress \+ insider \+ options/g, 'MEGA-SIGNAL: Kongress + Insider + Optionen'],
    [/Politician \+ insider/g, 'Politiker + Insider'], [/Politician \+ options/g, 'Politiker + Optionen'],
    [/COMBO badge/g, 'Kombinations-Kennzeichnung'], [/MEGA SIGNAL badge/g, 'Mega-Signal-Kennzeichnung'],
    [/badge — mult gated/g, 'Kennzeichnung — Multiplikator nicht aktiviert'], [/— mult gated/g, '— Multiplikator nicht aktiviert'], [/base /g, 'Basis '], [/gate ≥/g, 'Schwelle ≥'],
    [/filed by/g, 'eingereicht von'], [/filed/g, 'eingereicht'], [/activist/g, 'aktivistischer Investor'],
    [/ pts/g, ' Punkte'], [/cluster/g, 'Cluster'], [/Recorded insider buying/g, 'Erfasste Insider-Käufe'],
  ];
  for (const [pattern, translated] of replacements) text = text.replace(pattern, translated);
  return text;
}

export function localizeRole(value: string, language: Lang): string {
  if (language !== 'de') return value;
  return value.replace(/Chief Accounting Officer/gi, 'Leiter Rechnungswesen').replace(/Chief Investment Officer/gi, 'Leiter Kapitalanlagen').replace(/Chief Technology Officer/gi, 'CTO').replace(/Chief Legal Officer/gi, 'Leiter Recht').replace(/Executive Vice President/gi, 'Geschäftsführender Vizepräsident').replace(/Senior Vice President/gi, 'Leitender Vizepräsident').replace(/Vice President/gi, 'Vizepräsident').replace(/Executive Chairman/gi, 'Geschäftsführender Vorsitzender').replace(/Chief Executive Officer/gi, 'CEO').replace(/Chief Financial Officer/gi, 'CFO').replace(/Chief Operating Officer/gi, 'COO').replace(/Chairman/gi, 'Vorsitzender').replace(/President/gi, 'Präsident').replace(/Director/gi, 'Direktor').replace(/Co[- ]Founder/gi, 'Mitgründer').replace(/10% Owner/gi, '10-%-Anteilseigner').replace(/Officer/gi, 'Führungskraft').replace(/Treasurer/gi, 'Finanzverwalter').replace(/Secretary/gi, 'Gesellschaftssekretär').replace(/\band\b/gi, 'und');
}

/** Translate classifier labels only; transaction classification and source values stay intact. */
export function localizeTransactionLabel(value: string, language: Lang): string {
  if (language !== 'de') return value;
  const labels: Record<string, string> = {
    '10b5-1 Sale': '10b5-1-Verkauf', '10b5-1 Buy': '10b5-1-Kauf',
    'Exercise + Sale': 'Ausübung + Verkauf', 'Exercise + Hold': 'Ausübung + Halten',
    'Gift Given': 'Schenkung abgegeben', 'Gift Received': 'Schenkung erhalten',
    'Stock Award': 'Aktienzuteilung', 'Derivative Conversion': 'Derivateumwandlung',
    'Sale': 'Verkauf', 'Open Market Buy': 'Kauf am offenen Markt', 'Unknown': 'Unbekannt',
  };
  return labels[value] ?? value.replace(/^Unknown \(/, 'Unbekannt (');
}
