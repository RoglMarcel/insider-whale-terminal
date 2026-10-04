import { parseDate } from '../electron/scraper/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { utcDateMs, utcInstantMs, eventDate } from '../src/lib/utcDate';
import { daysBetween } from '../src/types';
import { detectCombo, detectPoliticianCombo, isScoringEligible, scoreOneOption, optionTiming, scoreTicker } from '../electron/scoring';
import { trade, option, politician, aggregate } from './helpers';
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-27T12:00:00Z')); });
afterEach(() => vi.useRealTimers());
describe('explicit event clocks', () => {
  it('validates calendar dates and offset instants separately from future schedules', () => {
    expect(utcDateMs('2026-02-30')).toBeNull();
    expect(parseDate('Feb 30, 2026')).toBe('');
    expect(parseDate('Feb 30')).toBe('');
    expect(parseDate('2026/2/30')).toBe('');
    expect(utcInstantMs('2026-02-30T01:00:00Z')).toBeNull();
    expect(utcInstantMs('2026-09-27T14:00:00+02:00')).toBe(Date.now());
    expect(utcInstantMs('2026-09-27T12:00:00')).toBeNull();
    expect(eventDate('')).toEqual({state:'unknown',date:null});
    expect(eventDate('2026-09-28').state).toBe('future');
    expect(utcDateMs('2026-12-18')).not.toBeNull();
    expect(daysBetween('2026-09-27')).toBe(0.5);
  });
  it.each(['','2026-02-30','2026-09-28'])('excludes %s from insider score and combo', date => {
    const t = trade({tradeDate:date});
    expect(isScoringEligible(t)).toBe(false);
    expect(scoreTicker(aggregate({trades:[t]})).score).toBe(0);
    expect(detectCombo([t],[option()])).toBe(false);
  });
  it('future congressional transactions cannot activate combo gates', () => {
    expect(detectPoliticianCombo([politician({tradeDate:'2026-09-28'})],[trade()],[option()])).toBeNull();
  });
  it('expired options and economically absent premiums earn no points', () => {
    expect(scoreOneOption(option({expiry:'2026-09-25',dte:10}))).toBe(0);
    expect(scoreOneOption(option({premiumTotal:0,notional:0,isSweep:true}))).toBe(0);
    expect(detectCombo([trade()],[option({expiry:'2026-09-25'})])).toBe(false);
  });
  it('uses assessment time for DTE and does not leak later retrieval into historical scoring', () => {
    const o=option({expiry:'2026-10-16',eventAt:'2026-09-24T10:00:00Z',scrapedAt:'2026-09-25T12:00:00Z',dte:99});
    expect(optionTiming(o).dte).toBe(19);
    expect(optionTiming(o).age).toBeCloseTo(3+2/24);
    expect(scoreOneOption(o,Date.parse('2026-09-24T12:00:00Z'))).toBe(0);
    expect(optionTiming(option({dte:2})).dte).toBeUndefined();
  });
  it('holds the explicit assessment clock fixed even when wall-clock time advances', () => {
    const at = Date.parse('2026-09-24T12:00:00Z');
    const agg = aggregate({trades:[trade({tradeDate:'2026-09-24',observedAt:'2026-09-24T10:00:00Z'})],options:[option({expiry:'2026-10-16',scrapedAt:'2026-09-24T10:00:00Z'})]});
    const before=scoreTicker(agg,undefined,at);
    vi.setSystemTime(new Date('2027-01-01T12:00:00Z'));
    expect(scoreTicker(agg,undefined,at)).toEqual(before);
    expect(scoreTicker(agg,undefined,Date.parse('2026-09-24T09:00:00Z')).score).toBe(0);
  });

});
