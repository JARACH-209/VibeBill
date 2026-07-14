/**
 * Exact money arithmetic (spec §8). Internal unit: nano-USD (1 USD = 1_000_000_000n),
 * type bigint everywhere money exists. No floats anywhere in this file.
 *
 * Prices are decimal strings in $/MTok. We store them exactly as bigint
 * nano-USD per MILLION tokens (exact for up to 9 fractional digits), and divide
 * by 10^6 only when converting a token count to cost. That single floor division
 * loses strictly less than 1 nano-USD ($1e-9) per event per token class, which is
 * far below display precision (cents) and keeps every aggregation exact:
 * aggregations sum the per-event bigints, so Σ per-commit == scope total exactly.
 */

import type { MoneyBreakdown, TokenCounts } from '../core/types.js';

export const NANO_PER_USD = 1_000_000_000n;
const TOKENS_PER_MTOK = 1_000_000n;
const MAX_PRICE_FRACTION_DIGITS = 9;

/**
 * Parse a decimal price string ("15.00", $/MTok) into exact bigint nano-USD per MTok.
 * Rejects: empty, sign characters, exponents, >9 fractional digits, any non-digit junk.
 */
export function parsePriceToNanoPerMTok(price: string): bigint {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(price.trim());
  if (!m) {
    throw new Error(`invalid price string: ${JSON.stringify(price)} (expected e.g. "15.00")`);
  }
  const intPart = m[1] ?? '0';
  const fracPart = m[2] ?? '';
  if (fracPart.length > MAX_PRICE_FRACTION_DIGITS) {
    throw new Error(
      `price ${JSON.stringify(price)} has more than ${MAX_PRICE_FRACTION_DIGITS} fractional digits`,
    );
  }
  const fracPadded = fracPart.padEnd(MAX_PRICE_FRACTION_DIGITS, '0');
  return BigInt(intPart) * NANO_PER_USD + BigInt(fracPadded);
}

/** Cost of `tokens` at `nanoPerMTok`, floor-divided once (error < 1 nano-USD). */
export function costForTokens(tokens: number, nanoPerMTok: bigint): bigint {
  if (!Number.isSafeInteger(tokens) || tokens < 0) {
    throw new Error(`token count must be a non-negative safe integer, got ${tokens}`);
  }
  return (BigInt(tokens) * nanoPerMTok) / TOKENS_PER_MTOK;
}

/** A model's price card resolved to exact internal units. */
export interface PriceCardNano {
  inputPerMTok: bigint;
  outputPerMTok: bigint;
  cacheWritePerMTok: bigint;
  cacheReadPerMTok: bigint;
}

/** Price a full per-call token record on a card. */
export function costBreakdown(tokens: TokenCounts, card: PriceCardNano): MoneyBreakdown {
  const input = costForTokens(tokens.input, card.inputPerMTok);
  const output = costForTokens(tokens.output, card.outputPerMTok);
  const cacheWrite = costForTokens(tokens.cacheWrite, card.cacheWritePerMTok);
  const cacheRead = costForTokens(tokens.cacheRead, card.cacheReadPerMTok);
  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

export const ZERO_MONEY: MoneyBreakdown = {
  input: 0n,
  output: 0n,
  cacheWrite: 0n,
  cacheRead: 0n,
  total: 0n,
};

export function addMoney(a: MoneyBreakdown, b: MoneyBreakdown): MoneyBreakdown {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
    total: a.total + b.total,
  };
}

const NANO_PER_CENT = 10_000_000n;

/** Round nano-USD to integer cents with round-half-even (banker's rounding). */
export function nanoToCentsHalfEven(nano: bigint): bigint {
  const neg = nano < 0n;
  const abs = neg ? -nano : nano;
  const q = abs / NANO_PER_CENT;
  const r = abs % NANO_PER_CENT;
  const half = NANO_PER_CENT / 2n;
  let cents = q;
  if (r > half || (r === half && q % 2n === 1n)) cents = q + 1n;
  return neg ? -cents : cents;
}

function groupThousands(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

/** Pre-rounded plain decimal string like "12.34" (for --json `usd` fields). */
export function nanoToUsdString(nano: bigint): string {
  const cents = nanoToCentsHalfEven(nano);
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 100n;
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}${whole}.${frac}`;
}

/** Display format: "$1,234.56", round-half-even to cents at the render boundary only. */
export function formatUsd(nano: bigint): string {
  const cents = nanoToCentsHalfEven(nano);
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = groupThousands((abs / 100n).toString());
  const frac = (abs % 100n).toString().padStart(2, '0');
  return `${neg ? '-' : ''}$${whole}.${frac}`;
}

/** JSON-safe money serialization: bigint as string plus pre-rounded USD. */
export function moneyToJson(nano: bigint): { nanoUsd: string; usd: string } {
  return { nanoUsd: nano.toString(), usd: nanoToUsdString(nano) };
}
