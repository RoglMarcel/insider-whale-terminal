import { describe, expect, it } from 'vitest';
import { summarizeAlertSources } from '../../src/lib/alert-sources';
import { displayText } from '../../src/lib/display-text';
import { sampleSignals } from '../../src/lib/sampleData';
import { SCRAPER_SOURCES } from '../../src/types';

describe('public alert source attribution', () => {
  it('counts each ticker once per recorded source and leaves the records intact', () => {
    const signal = structuredClone(sampleSignals[0]);
    const source = SCRAPER_SOURCES.find(s => s.kind === 'insider')!;
    signal.rawTrades = [{ ...signal.rawTrades[0], source: source.key }, { ...signal.rawTrades[0], source: source.key }];
    signal.optionsActivity = [];
    const second = { ...structuredClone(signal), ticker: 'SECOND' };
    const input = [signal, signal, second];
    const before = structuredClone(input);
    expect(summarizeAlertSources(input)).toEqual([{ key: source.key, name: source.label, kind: source.kind, alerts: 2 }]);
    expect(input).toEqual(before);
  });
  it('does not advertise configured but unrepresented sources or invent congressional providers', () => {
    expect(summarizeAlertSources([])).toEqual([]);
    const signal = { ...sampleSignals[0], rawTrades: [], optionsActivity: [] };
    expect(summarizeAlertSources([signal])).toEqual([]);
  });
});

describe('presentation of stored notes', () => {
  it('removes emoji sequences while preserving financial numbers and meaningful text', () => {
    expect(displayText('⚡ COMBO: insider + options (×1.2) 🇩🇪 🔴')).toBe('COMBO: insider + options (×1.2)');
    expect(displayText('⚠ Heavy selling: $2.4M vs $1.1M (90d)')).toBe('Heavy selling: $2.4M vs $1.1M (90d)');
    expect(displayText('Insider age decay ×0.82')).toBe('Insider age decay ×0.82');
  });
});
