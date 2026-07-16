/**
 * `vibebill reprice --model <id>` (spec §6.6, §5.5): counterfactual repricing
 * of the measured token traffic on another model's price card. Always carries
 * the honesty label; unknown targets exit 1 with the list of known model ids.
 */

import { rollup } from '../../core/aggregate.js';
import { CliUserError } from '../../core/errors.js';
import type { MoneyBreakdown, TokenCounts } from '../../core/types.js';
import { addTokenCounts, totalTokens, ZERO_TOKENS } from '../../core/types.js';
import { matchModel, repriceTokens, type PriceCard } from '../../pricing/engine.js';
import { addMoney, formatUsd, moneyToJson, ZERO_MONEY } from '../../pricing/money.js';
import { formatTokens } from '../../render/format.js';
import { c } from '../../render/table.js';
import type { CliContext, LedgerRow } from '../context.js';
import { checkAccounting, resolveCommitScope, scopedRows } from '../context.js';
import type { CliIO } from '../io.js';
import {
  baseJson,
  exitCodeFor,
  glyphs,
  invariantLines,
  moneyBreakdownToJson,
  printJson,
  tokensToJson,
} from '../render.js';

/** The mandatory reprice honesty label (spec §5.5) — in text AND --json. */
export const REPRICE_LABEL =
  'repriced — same traffic, different meter; a different model may need more or fewer turns';

export interface RepriceOptions {
  model: string;
  /** Optional revision range restricting scope to that range's commits. */
  range: string | null;
  /** Print the two-column measured-vs-repriced comparison. */
  vs: boolean;
}

/** Resolve the reprice target: exact table key, else longest-prefix match. */
export function resolveTarget(
  ctx: CliContext,
  model: string,
): { id: string; card: PriceCard } {
  const exact = ctx.prices.table.models[model];
  if (exact !== undefined) return { id: model, card: exact };
  const matched = matchModel(ctx.prices.table, model);
  if (matched !== null) return matched;
  const known = Object.keys(ctx.prices.table.models).sort();
  throw new CliUserError(
    `unknown reprice target model ${JSON.stringify(model)}.`,
    `Known model ids (${known.length}):\n  ${known.join('\n  ')}`,
  );
}

/** Signed one-decimal percent delta computed in exact bigint ("−95.7"); null when measured is 0. */
export function deltaPct(measured: bigint, repriced: bigint): string | null {
  if (measured === 0n) return null;
  const perMille = ((repriced - measured) * 1000n) / measured;
  const neg = perMille < 0n;
  const abs = neg ? -perMille : perMille;
  return `${neg ? '-' : '+'}${abs / 10n}.${abs % 10n}`;
}

/** Run `vibebill reprice`; returns the process exit code. */
export async function runReprice(ctx: CliContext, opts: RepriceOptions, io: CliIO): Promise<number> {
  const check = checkAccounting(ctx.rows, ctx.ingest);
  const target = resolveTarget(ctx, opts.model);

  let rows: LedgerRow[] = scopedRows(ctx);
  if (opts.range !== null) {
    const { hashes } = await resolveCommitScope(ctx, opts.range);
    rows = rows.filter(
      (r) => r.entry.attribution.kind === 'commit' && hashes.has(r.entry.attribution.hash),
    );
  }

  // Reprice every event's tokens on the target card (same traffic, spec §5.5).
  let repriced: MoneyBreakdown = { ...ZERO_MONEY };
  let tokens: TokenCounts = { ...ZERO_TOKENS };
  let cacheFallback = false;
  for (const row of rows) {
    const result = repriceTokens(row.entry.event.tokens, target.card);
    repriced = addMoney(repriced, result.cost);
    tokens = addTokenCounts(tokens, row.entry.event.tokens);
    cacheFallback = cacheFallback || result.cacheFallback;
  }

  const measured = rollup(rows.map((r) => r.entry));
  const pct = deltaPct(measured.cost.total, repriced.total);

  // Token-weighted top measured model, for the --vs comparison line's name.
  const tokensByModel = new Map<string, number>();
  for (const row of rows) {
    const m = row.entry.event.model;
    tokensByModel.set(m, (tokensByModel.get(m) ?? 0) + totalTokens(row.entry.event.tokens));
  }
  let topModel: string | null = null;
  let topTokens = -1;
  for (const [m, t] of [...tokensByModel.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (t > topTokens) {
      topModel = m;
      topTokens = t;
    }
  }
  const measuredName =
    topModel === null
      ? 'measured'
      : (matchModel(ctx.prices.table, topModel)?.card.displayName ?? topModel);

  if (ctx.flags.json) {
    printJson(
      {
        ...baseJson('reprice', ctx, check),
        target: { id: target.id, displayName: target.card.displayName },
        scope: {
          kind: opts.range === null ? 'repo' : 'range',
          range: opts.range,
          events: rows.length,
          tokens: tokensToJson(tokens),
        },
        repriced: { cost: moneyBreakdownToJson(repriced), provenance: 'repriced' },
        measured: {
          cost: moneyToJson(measured.cost.total),
          unpricedEvents: measured.unpricedEvents,
          unpricedTokens: tokensToJson(measured.unpricedTokens),
        },
        deltaPct: pct,
        cacheFallback,
        label: REPRICE_LABEL,
      },
      (l) => io.out(l),
    );
    return exitCodeFor(check, ctx.flags.strict);
  }

  const g = glyphs();
  io.out(c.bold(`vibebill reprice ${g.dot} ${target.card.displayName} (${target.id})`));
  io.out(
    c.dim(
      `scope: ${opts.range === null ? 'whole repo' : opts.range} ` +
        `(${formatTokens(totalTokens(tokens))} tokens across ${rows.length} events)`,
    ),
  );
  io.out('');
  io.out(`repriced total: ${c.bold(formatUsd(repriced.total))}`);
  io.out(
    c.dim(
      `  input ${formatUsd(repriced.input)} ${g.dot} output ${formatUsd(repriced.output)} ${g.dot} ` +
        `cache write ${formatUsd(repriced.cacheWrite)} ${g.dot} cache read ${formatUsd(repriced.cacheRead)}`,
    ),
  );
  if (cacheFallback) {
    io.out(
      c.yellow(
        'note: target card lacks cache read/write prices; cache tokens were priced at the input rate',
      ),
    );
  }
  if (opts.vs) {
    io.out('');
    io.out(
      `${measuredName} measured ${formatUsd(measured.cost.total)} ${g.arrow} ` +
        `${target.card.displayName} repriced ${formatUsd(repriced.total)}` +
        (pct === null ? '' : ` (${pct}%)`),
    );
    if (measured.unpricedEvents > 0) {
      io.out(
        c.yellow(
          `note: ${formatTokens(totalTokens(measured.unpricedTokens))} tokens were unpriced on the ` +
            'measured side (unknown model) but ARE included in the repriced total',
        ),
      );
    }
  }
  io.out('');
  io.out(c.dim(REPRICE_LABEL));
  for (const line of invariantLines(check)) io.out(line);
  return exitCodeFor(check, ctx.flags.strict);
}
