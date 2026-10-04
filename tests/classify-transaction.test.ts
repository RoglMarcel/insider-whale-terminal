import { describe, it, expect } from 'vitest';
import { classifyTransaction } from '../src/types';

describe('classifyTransaction — the documented tiers', () => {
  const cases: [string, number, string][] = [
    ['P - Purchase', 1.0, 'strong'],
    ['Purchase', 1.0, 'strong'],
    ['Buy', 1.0, 'strong'],
    ['Purchase(A)', 1.0, 'strong'],
    ['P', 1.0, 'strong'],
    ['10b5-1 Purchase', 0.4, 'reduced'],
    ['10b5-1 Sale', 0.0, 'excluded'],
    ['Option Exercise', 0.5, 'reduced'],
    ['M', 0.5, 'reduced'],
    ['Exercise + Sale', 0.0, 'excluded'],
    ['+OE', 0.5, 'reduced'],
    ['G - Gift', 0.1, 'reduced'],
    ['Gift Given', 0.0, 'excluded'],
    ['A - Award', 0.0, 'excluded'],
    ['Grant of RSU', 0.0, 'excluded'],
    ['C - Conversion', 0.2, 'reduced'],
    ['S - Sale', 0.0, 'excluded'],
    ['D - Disposition', 0.0, 'excluded'],
    ['F - Tax withholding', 0.0, 'excluded'],
  ];
  for (const [raw, modifier, tier] of cases) {
    it(`${JSON.stringify(raw)} → ${modifier} / ${tier}`, () => {
      const c = classifyTransaction(raw);
      expect(c.modifier).toBe(modifier);
      expect(c.tier).toBe(tier);
    });
  }
});

describe('classifyTransaction — unknown never becomes a buy', () => {
  for (const raw of ['', '   ', 'Something Else', 'n/a', '—']) {
    it(`${JSON.stringify(raw)} → 0 / excluded`, () => {
      const c = classifyTransaction(raw);
      expect(c.modifier).toBe(0);
      expect(c.tier).toBe('excluded');
    });
  }
  it('null/undefined do not throw', () => {
    expect(classifyTransaction(undefined as unknown as string).modifier).toBe(0);
    expect(classifyTransaction(null as unknown as string).modifier).toBe(0);
  });
});

describe('classifyTransaction — the SEC code fallback only fires on real codes', () => {
  // Regression: `s.charAt(0)` was applied to arbitrary prose, so a word merely
  // STARTING with a code letter was classified as that code.
  it('"Acquisition" is not read as code A (Stock Award)', () => {
    const c = classifyTransaction('Acquisition');
    expect(c.label).not.toBe('Stock Award');
    expect(c.tier).toBe('excluded'); // still conservative: unknown ≠ buy
  });
  it('"Common Stock" is not read as code C (Derivative Conversion)', () => {
    expect(classifyTransaction('Common Stock').label).not.toBe('Derivative Conversion');
  });
  it('"Dir" is not read as code D (Sale)', () => {
    expect(classifyTransaction('Dir').label).not.toBe('Sale');
  });
  it('"Cash Purchase" is a full-weight buy, not a conversion', () => {
    expect(classifyTransaction('Cash Purchase').modifier).toBe(1.0);
  });
  it('"Automatic Buy" is a plan trade, not a stock award', () => {
    const c = classifyTransaction('Automatic Buy');
    expect(c.modifier).toBe(0.4);
    expect(c.label).toBe('10b5-1 Buy');
  });
  it('a bare code letter still works', () => {
    expect(classifyTransaction('A').modifier).toBe(0);
    expect(classifyTransaction('S').modifier).toBe(0);
    expect(classifyTransaction('C').modifier).toBe(0.2);
    expect(classifyTransaction('G').modifier).toBe(0.1);
  });
  it('a code with a separator still works', () => {
    expect(classifyTransaction('A - Award').modifier).toBe(0);
    expect(classifyTransaction('S/Sale').modifier).toBe(0);
    expect(classifyTransaction('C: Conversion').modifier).toBe(0.2);
  });
});

describe('classifyTransaction — case and whitespace', () => {
  it('is case-insensitive', () => {
    expect(classifyTransaction('p - purchase').modifier).toBe(1.0);
    expect(classifyTransaction('P - PURCHASE').modifier).toBe(1.0);
  });
  it('trims', () => {
    expect(classifyTransaction('  P - Purchase  ').modifier).toBe(1.0);
  });
  it('sale wins over purchase inside one string', () => {
    // "Exercise + Sale" must not be read as an exercise-and-hold.
    expect(classifyTransaction('Exercise + Sale').modifier).toBe(0);
    expect(classifyTransaction('10b5-1 Sale').modifier).toBe(0);
  });
});
