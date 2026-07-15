/**
 * Small display formatters for terminal output (spec §6). Pure and deterministic.
 * Money formatting lives in src/pricing/money.ts (formatUsd); these cover
 * token counts, confidence markers, and report-header timestamps.
 */

import type { AttributionConfidence } from '../core/types.js';

function groupThousands(digits: string): string {
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return out;
}

interface TokenUnit {
  div: number;
  suffix: string;
  /** Values below this belong to the unit; Infinity = last resort. */
  limit: number;
}

const TOKEN_UNITS: readonly TokenUnit[] = [
  { div: 1_000, suffix: 'k', limit: 1_000_000 },
  { div: 1_000_000, suffix: 'M', limit: 1_000_000_000 },
  { div: 1_000_000_000, suffix: 'B', limit: Infinity },
];

/**
 * Compact deterministic token-count formatting: below 10,000 a grouped integer
 * ("9,999"), from 10,000 up one decimal with k/M/B ("10.0k", "3.2M", "1.0B").
 *
 * Token counts only — NEVER money (money formatting is exact bigint in
 * src/pricing/money.ts; the float math here is fine for token counts).
 */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(`formatTokens expects a non-negative finite number, got ${n}`);
  }
  const count = Math.round(n);
  if (count < 10_000) return groupThousands(String(count));
  for (const unit of TOKEN_UNITS) {
    if (count >= unit.limit) continue;
    // div/10 is an exact power of ten, so this rounding is deterministic.
    const tenths = Math.round(count / (unit.div / 10));
    // Rounding reached 1000.0 of this unit (e.g. 999,950 -> "1000.0k"): promote.
    if (tenths >= 10_000 && unit.limit !== Infinity) continue;
    return `${groupThousands(String(Math.floor(tenths / 10)))}.${tenths % 10}${unit.suffix}`;
  }
  /* c8 ignore next -- unreachable: the last unit has limit Infinity */
  throw new Error(`formatTokens: no unit matched ${n}`);
}

/** Confidence markers per spec §6: ● high, ◐ medium, ○ low/advisory. */
export function confidenceMarker(conf: AttributionConfidence): string {
  switch (conf) {
    case 'high':
      return '●';
    case 'medium':
      return '◐';
    case 'low':
      return '○';
  }
}

/**
 * Format a UTC timestamp as local wall time with UTC offset, e.g.
 * "2026-07-14 09:15:00 +05:30" — for report HEADERS ONLY, never for data
 * (spec §7.10: everything is UTC internally). `tzOverride` accepts an IANA
 * time-zone name so tests are deterministic; default is the system zone.
 */
export function formatLocalTimeWithOffset(utcMs: number, tzOverride?: string): string {
  const dtf = new Intl.DateTimeFormat('en-CA', {
    ...(tzOverride === undefined ? {} : { timeZone: tzOverride }),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
    timeZoneName: 'longOffset',
  });
  const parts = dtf.formatToParts(new Date(utcMs));
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? '';
  // "GMT+05:30" / "GMT-05:00" / bare "GMT" for UTC; normalize U+2212 minus.
  let offset = get('timeZoneName')
    .replace(/^(GMT|UTC)/, '')
    .replace('−', '-');
  if (offset === '') offset = '+00:00';
  return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')} ${offset}`;
}
