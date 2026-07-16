/**
 * Shared CLI rendering + JSON helpers: glyph fallbacks for plain-ASCII output
 * (spec §7.14), the invariant status line, plan-mode wording (spec §5.5), and
 * the common --json envelope every command emits (docs/json-schemas.md).
 */

import type { AttributionConfidence, MoneyBreakdown, TokenCounts } from '../core/types.js';
import { totalTokens } from '../core/types.js';
import type { PlanId } from '../core/types.js';
import { moneyToJson, formatUsd } from '../pricing/money.js';
import { confidenceMarker, formatTokens } from '../render/format.js';
import { c, isColorEnabled, visibleWidth } from '../render/table.js';
import type { AccountingCheck, CliContext } from './context.js';
import { vibebillVersion } from './version.js';

/** Terminal glyphs with plain-ASCII fallbacks when color/TTY is off (spec §7.14). */
export function glyphs(): {
  high: string;
  medium: string;
  low: string;
  human: string;
  check: string;
  cross: string;
  dot: string;
  arrow: string;
  ellipsis: string;
} {
  return isColorEnabled()
    ? {
        high: '●',
        medium: '◐',
        low: '○',
        human: '·human?',
        check: '✓',
        cross: '✗',
        dot: '·',
        arrow: '→',
        ellipsis: '…',
      }
    : {
        high: '*',
        medium: '~',
        low: '.',
        human: 'human?',
        check: 'OK',
        cross: 'X',
        dot: '|',
        arrow: '->',
        ellipsis: '...',
      };
}

/** Colored confidence marker (spec §6): ● high, ◐ medium, ○ low/advisory. */
export function confMark(conf: AttributionConfidence): string {
  const g = glyphs();
  if (!isColorEnabled()) {
    return conf === 'high' ? g.high : conf === 'medium' ? g.medium : g.low;
  }
  const glyph = confidenceMarker(conf);
  return conf === 'high' ? c.green(glyph) : conf === 'medium' ? c.yellow(glyph) : c.dim(glyph);
}

/** Truncate to a visible width, appending an ellipsis when content was cut. */
export function truncate(s: string, max: number): string {
  if (visibleWidth(s) <= max) return s;
  const ell = glyphs().ellipsis;
  const keep = Math.max(0, max - visibleWidth(ell));
  const points = [...s];
  return points.slice(0, keep).join('') + ell;
}

/** "YYYY-MM-DD" in UTC (data cells are always UTC; spec §7.10). */
export function fmtDateUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** "YYYY-MM-DD HH:MM" in UTC for compact data cells. */
export function fmtDateTimeUTC(ms: number): string {
  return new Date(ms).toISOString().slice(0, 16).replace('T', ' ');
}

/** Compact "input X · output Y · cache write Z · cache read W" token line. */
export function tokensLine(t: TokenCounts): string {
  const d = ` ${glyphs().dot} `;
  return (
    `input ${formatTokens(t.input)}${d}output ${formatTokens(t.output)}${d}` +
    `cache write ${formatTokens(t.cacheWrite)}${d}cache read ${formatTokens(t.cacheRead)}`
  );
}

/** Human-readable byte size ("340.2 MB"); exact bytes belong in --json. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let unit = 'B';
  for (const u of units) {
    if (v < 1024) break;
    v /= 1024;
    unit = u;
  }
  return `${v.toFixed(1)} ${unit}`;
}

/** One-decimal percentage (0–100) or null when the denominator is zero. */
export function pct1(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null;
  return Math.round((numerator / denominator) * 1000) / 10;
}

/** Plan-mode header suffix: wording only, never math (spec §5.5). */
export function planHeaderSuffix(plan: PlanId | null): string {
  return plan === null ? '' : ' (API-equivalent value)';
}

/** Plan-mode total suffix: "consumed on your <plan> subscription" (spec §5.5). */
export function planTotalSuffix(plan: PlanId | null): string {
  return plan === null ? '' : ` consumed on your ${plan} subscription`;
}

/**
 * The accounting invariant status line(s) every command prints (spec §5.4
 * Step D): green check when balanced, red token-delta warning when not.
 */
export function invariantLines(check: AccountingCheck): string[] {
  const r = check.conservation;
  const sum =
    `${formatTokens(check.rawTokens)} tokens = attributed ${formatTokens(r.attributed)} + ` +
    `waste ${formatTokens(r.waste)} + overhead ${formatTokens(r.overhead)} + ` +
    `out-of-scope ${formatTokens(r.outOfScope)}`;
  if (check.ok) {
    return [`accounting: ${sum} ${c.green(glyphs().check)}`];
  }
  return [
    c.red(
      `ACCOUNTING MISMATCH: ${check.mismatchTokens} tokens unaccounted for ` +
        `(raw ${check.rawTokens} vs ledger ${check.ledgerTokens})`,
    ),
    c.red(`  ${sum}`),
    c.red('  the books do not balance — run `vibebill doctor` and please file an issue'),
  ];
}

/** JSON shape for token counts, always including the class total. */
export function tokensToJson(t: TokenCounts): {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
} {
  return {
    input: t.input,
    output: t.output,
    cacheWrite: t.cacheWrite,
    cacheRead: t.cacheRead,
    total: totalTokens(t),
  };
}

/** JSON money value: both nanoUsd (string) and usd (pre-rounded string). */
export type MoneyJson = { nanoUsd: string; usd: string };

/** JSON shape for a full money breakdown; null when the model was unpriced. */
export function moneyBreakdownToJson(m: MoneyBreakdown): {
  input: MoneyJson;
  output: MoneyJson;
  cacheWrite: MoneyJson;
  cacheRead: MoneyJson;
  total: MoneyJson;
} {
  return {
    input: moneyToJson(m.input),
    output: moneyToJson(m.output),
    cacheWrite: moneyToJson(m.cacheWrite),
    cacheRead: moneyToJson(m.cacheRead),
    total: moneyToJson(m.total),
  };
}

/** The common --json envelope every command payload spreads onto. */
export function baseJson(
  command: string,
  ctx: CliContext,
  check: AccountingCheck,
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    schemaVersion: 1,
    command,
    vibebill: vibebillVersion(),
    repoRoot: ctx.repoRoot,
    plan: ctx.plan,
    pricing: { asOf: ctx.prices.table.asOf, origin: ctx.prices.origin },
    invariant: {
      ok: check.ok,
      totalTokens: check.rawTokens,
      attributed: check.conservation.attributed,
      waste: check.conservation.waste,
      overhead: check.conservation.overhead,
      outOfScope: check.conservation.outOfScope,
      deltaTokens: check.mismatchTokens,
    },
    warnings: ctx.warnings,
  };
  if (!check.ok) base['accountingMismatch'] = { tokens: check.mismatchTokens };
  return base;
}

/** Print a command's JSON payload as stable, indented JSON on stdout. */
export function printJson(payload: Record<string, unknown>, out: (line: string) => void): void {
  out(JSON.stringify(payload, null, 2));
}

/** Display cost cell: "$1,234.56", or "$—" for unpriced-only rollups. */
export function costCell(total: bigint, unpricedTokens: number): string {
  if (total === 0n && unpricedTokens > 0) return isColorEnabled() ? '$—' : '$-';
  return formatUsd(total);
}

/** Exit code shared by every command: 3 only on mismatch AND --strict. */
export function exitCodeFor(check: AccountingCheck, strict: boolean): number {
  return !check.ok && strict ? 3 : 0;
}
