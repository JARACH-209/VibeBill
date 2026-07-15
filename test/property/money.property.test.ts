/**
 * Property tests for exact money math (spec §8): seeded-PRNG randomized cases
 * comparing the production bigint pipeline against a HIGHER-precision
 * scaled-bigint reference implemented here in-test.
 *
 * The reference parses decimal price strings digit-by-digit itself (it does
 * NOT reuse parsePriceToNanoPerMTok) into femto-USD per MTok (1 USD = 10^15),
 * computes each class's cost exactly at femto scale, and floor-divides to
 * nano-USD once at the end of each class — replicating the production
 * semantics floor((tokens * nanoPerMTok) / 10^6) exactly while validating the
 * parse+multiply path independently.
 */

import { describe, expect, it } from 'vitest';
import type { MoneyBreakdown, TokenCounts } from '../../src/core/types.js';
import {
  addMoney,
  costBreakdown,
  parsePriceToNanoPerMTok,
  ZERO_MONEY,
  type PriceCardNano,
} from '../../src/pricing/money.js';

const CASES = 1000;

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32): deterministic across runs and platforms; used only
// to GENERATE test inputs — never in any money path.
// ---------------------------------------------------------------------------

function makeRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return (t ^ (t >>> 14)) >>> 0; // uint32
  };
}

type Rng = () => number;

/** Uniform-ish integer in [0, maxExclusive); modulo bias is irrelevant for tests. */
function nextInt(rng: Rng, maxExclusive: number): number {
  return rng() % maxExclusive;
}

/** Random token count in [0, 10^9]. */
function genTokens(rng: Rng): number {
  return nextInt(rng, 1_000_000_001);
}

/**
 * Random decimal price string: 0-4 integer digits and 0-9 fractional digits.
 * Zero integer digits emit the canonical "0" (the schema rejects ".5" forms);
 * zero fractional digits omit the dot. Leading zeros are allowed and exercised.
 */
function genPriceString(rng: Rng): string {
  const intLen = nextInt(rng, 5); // 0..4
  const fracLen = nextInt(rng, 10); // 0..9
  let intPart = '';
  for (let i = 0; i < intLen; i++) intPart += String(nextInt(rng, 10));
  if (intPart === '') intPart = '0';
  let fracPart = '';
  for (let i = 0; i < fracLen; i++) fracPart += String(nextInt(rng, 10));
  return fracPart === '' ? intPart : `${intPart}.${fracPart}`;
}

interface PriceStrings {
  input: string;
  output: string;
  cacheWrite: string;
  cacheRead: string;
}

function genPriceStrings(rng: Rng): PriceStrings {
  return {
    input: genPriceString(rng),
    output: genPriceString(rng),
    cacheWrite: genPriceString(rng),
    cacheRead: genPriceString(rng),
  };
}

function genTokenCounts(rng: Rng): TokenCounts {
  return {
    input: genTokens(rng),
    output: genTokens(rng),
    cacheWrite: genTokens(rng),
    cacheRead: genTokens(rng),
  };
}

function toNanoCard(prices: PriceStrings): PriceCardNano {
  return {
    inputPerMTok: parsePriceToNanoPerMTok(prices.input),
    outputPerMTok: parsePriceToNanoPerMTok(prices.output),
    cacheWritePerMTok: parsePriceToNanoPerMTok(prices.cacheWrite),
    cacheReadPerMTok: parsePriceToNanoPerMTok(prices.cacheRead),
  };
}

// ---------------------------------------------------------------------------
// Reference implementation at femto-USD scale (10^15 per USD) — independent
// digit-by-digit parse, exact femto intermediate, one floor to nano per class.
// ---------------------------------------------------------------------------

const FEMTO_FRAC_DIGITS = 15n;
const TOKENS_PER_MTOK = 1_000_000n;
const FEMTO_PER_NANO = 1_000_000n;

/** Parse "12.345" into exact femto-USD per MTok, digit by digit (no production parser). */
function refFemtoPerMTok(price: string): bigint {
  const dot = price.indexOf('.');
  const intPart = dot === -1 ? price : price.slice(0, dot);
  const fracPart = dot === -1 ? '' : price.slice(dot + 1);
  if (intPart.length === 0 || fracPart.length > 9 || price.indexOf('.', dot + 1) !== -1) {
    throw new Error(`reference cannot parse price: ${JSON.stringify(price)}`);
  }
  let digits = 0n;
  for (const ch of intPart + fracPart) {
    const code = ch.charCodeAt(0);
    if (code < 0x30 || code > 0x39) {
      throw new Error(`non-digit in price: ${JSON.stringify(price)}`);
    }
    digits = digits * 10n + BigInt(code - 0x30);
  }
  // value USD = digits / 10^fracLen; femto/MTok = digits * 10^(15 - fracLen).
  return digits * 10n ** (FEMTO_FRAC_DIGITS - BigInt(fracPart.length));
}

/** One class's cost: exact at femto scale, floor-divided to nano at the end. */
function refClassCostNano(tokens: number, price: string): bigint {
  const femtoPerMTok = refFemtoPerMTok(price);
  // Prices have <= 9 fractional digits, so femtoPerMTok is divisible by 10^6
  // and the per-MTok division is EXACT at femto scale (higher precision than
  // the production nano pipeline — no intermediate loss before the final floor).
  expect(femtoPerMTok % TOKENS_PER_MTOK).toBe(0n);
  const costFemto = (BigInt(tokens) * femtoPerMTok) / TOKENS_PER_MTOK; // exact
  return costFemto / FEMTO_PER_NANO; // the single floor, matching production
}

function refBreakdown(tokens: TokenCounts, prices: PriceStrings): MoneyBreakdown {
  const input = refClassCostNano(tokens.input, prices.input);
  const output = refClassCostNano(tokens.output, prices.output);
  const cacheWrite = refClassCostNano(tokens.cacheWrite, prices.cacheWrite);
  const cacheRead = refClassCostNano(tokens.cacheRead, prices.cacheRead);
  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('money property tests (spec §8)', () => {
  it(`(a) costBreakdown equals the femto-scale reference for ${CASES} random cases`, () => {
    const rng = makeRng(0xc0ffee);
    for (let i = 0; i < CASES; i++) {
      const prices = genPriceStrings(rng);
      const tokens = genTokenCounts(rng);
      const got = costBreakdown(tokens, toNanoCard(prices));
      const want = refBreakdown(tokens, prices);
      const label = `case ${i}: prices=${JSON.stringify(prices)} tokens=${JSON.stringify(tokens)}`;
      expect(got.input, label).toBe(want.input);
      expect(got.output, label).toBe(want.output);
      expect(got.cacheWrite, label).toBe(want.cacheWrite);
      expect(got.cacheRead, label).toBe(want.cacheRead);
      expect(got.total, label).toBe(want.total);
      expect(got.total, label).toBe(got.input + got.output + got.cacheWrite + got.cacheRead);
    }
  });

  it(`(b) sum of per-event costs equals the aggregate total exactly for ${CASES} random partitions`, () => {
    const rng = makeRng(0xbeef01);
    for (let i = 0; i < CASES; i++) {
      const card = toNanoCard(genPriceStrings(rng));
      const eventCount = 1 + nextInt(rng, 12);
      const perEvent: MoneyBreakdown[] = [];
      for (let e = 0; e < eventCount; e++) {
        perEvent.push(costBreakdown(genTokenCounts(rng), card));
      }
      // Aggregate total = sum of per-event bigints (the production aggregation rule).
      const scopeTotal = perEvent.reduce(addMoney, ZERO_MONEY);

      // Random partition of events into 1..5 groups ("commits").
      const groupCount = 1 + nextInt(rng, 5);
      const groups: MoneyBreakdown[] = Array.from({ length: groupCount }, () => ZERO_MONEY);
      for (const cost of perEvent) {
        const g = nextInt(rng, groupCount);
        groups[g] = addMoney(groups[g]!, cost);
      }
      const partitionTotal = groups.reduce(addMoney, ZERO_MONEY);

      const label = `case ${i}: ${eventCount} events into ${groupCount} groups`;
      expect(partitionTotal, label).toEqual(scopeTotal);
      // And the scalar totals line up with the per-class sums.
      expect(
        scopeTotal.input + scopeTotal.output + scopeTotal.cacheWrite + scopeTotal.cacheRead,
        label,
      ).toBe(scopeTotal.total);
    }
  });

  it('(c) same seed produces byte-identical results (determinism)', () => {
    const run = (): string[] => {
      const rng = makeRng(0x5eed);
      const out: string[] = [];
      for (let i = 0; i < 250; i++) {
        const prices = genPriceStrings(rng);
        const tokens = genTokenCounts(rng);
        const cost = costBreakdown(tokens, toNanoCard(prices));
        out.push(
          `${JSON.stringify(prices)}|${JSON.stringify(tokens)}|` +
            `${cost.input}/${cost.output}/${cost.cacheWrite}/${cost.cacheRead}/${cost.total}`,
        );
      }
      return out;
    };
    expect(run()).toEqual(run());
  });
});
