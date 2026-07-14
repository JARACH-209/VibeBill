import { describe, expect, it } from 'vitest';
import {
  addMoney,
  costBreakdown,
  costForTokens,
  formatUsd,
  moneyToJson,
  nanoToCentsHalfEven,
  nanoToUsdString,
  parsePriceToNanoPerMTok,
} from './money.js';

describe('parsePriceToNanoPerMTok', () => {
  it('parses integer and fractional prices exactly', () => {
    expect(parsePriceToNanoPerMTok('15.00')).toBe(15_000_000_000n);
    expect(parsePriceToNanoPerMTok('75')).toBe(75_000_000_000n);
    expect(parsePriceToNanoPerMTok('0.25')).toBe(250_000_000n);
    expect(parsePriceToNanoPerMTok('1.50')).toBe(1_500_000_000n);
    expect(parsePriceToNanoPerMTok('0.000000001')).toBe(1n);
  });

  it('rejects malformed and out-of-precision prices', () => {
    for (const bad of ['', '-1', '+1', '1e3', '1.', '.5', '1.0000000001', 'abc', '1,5', 'NaN']) {
      expect(() => parsePriceToNanoPerMTok(bad), bad).toThrow();
    }
  });
});

describe('costForTokens', () => {
  it('computes exact costs for whole-dollar-per-MTok prices', () => {
    // 1M tokens at $15/MTok = $15 = 15e9 nano
    expect(costForTokens(1_000_000, parsePriceToNanoPerMTok('15.00'))).toBe(15_000_000_000n);
    // 7 tokens at $15/MTok = 105000 nano exactly
    expect(costForTokens(7, parsePriceToNanoPerMTok('15.00'))).toBe(105_000n);
    expect(costForTokens(0, parsePriceToNanoPerMTok('15.00'))).toBe(0n);
  });

  it('rejects invalid token counts', () => {
    expect(() => costForTokens(-1, 1n)).toThrow();
    expect(() => costForTokens(1.5, 1n)).toThrow();
    expect(() => costForTokens(Number.MAX_SAFE_INTEGER + 2, 1n)).toThrow();
  });
});

describe('round-half-even rendering', () => {
  it('rounds to cents with banker rounding', () => {
    // 0.125 dollars = 12.5 cents -> even = 12
    expect(nanoToCentsHalfEven(125_000_000n)).toBe(12n);
    // 0.135 dollars = 13.5 cents -> even = 14
    expect(nanoToCentsHalfEven(135_000_000n)).toBe(14n);
    expect(nanoToCentsHalfEven(135_000_001n)).toBe(14n);
    expect(nanoToCentsHalfEven(134_999_999n)).toBe(13n);
  });

  it('formats with thousands separators', () => {
    expect(formatUsd(1_234_560_000_000n)).toBe('$1,234.56');
    expect(formatUsd(0n)).toBe('$0.00');
    expect(formatUsd(999_999_999_990_000_000n)).toBe('$999,999,999.99');
    expect(nanoToUsdString(12_340_000_000n)).toBe('12.34');
    expect(moneyToJson(12_340_000_000n)).toEqual({ nanoUsd: '12340000000', usd: '12.34' });
  });
});

describe('costBreakdown / addMoney', () => {
  it('totals are the sum of parts and addition is exact', () => {
    const card = {
      inputPerMTok: parsePriceToNanoPerMTok('3.00'),
      outputPerMTok: parsePriceToNanoPerMTok('15.00'),
      cacheWritePerMTok: parsePriceToNanoPerMTok('3.75'),
      cacheReadPerMTok: parsePriceToNanoPerMTok('0.30'),
    };
    const a = costBreakdown({ input: 1000, output: 500, cacheWrite: 200, cacheRead: 4000 }, card);
    expect(a.total).toBe(a.input + a.output + a.cacheWrite + a.cacheRead);
    expect(a.input).toBe(3_000_000n);
    expect(a.output).toBe(7_500_000n);
    expect(a.cacheWrite).toBe(750_000n);
    expect(a.cacheRead).toBe(1_200_000n);
    const b = addMoney(a, a);
    expect(b.total).toBe(2n * a.total);
  });
});
