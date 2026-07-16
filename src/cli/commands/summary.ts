/**
 * `vibebill summary` (spec §6.2): repo-level rollup — total measured cost,
 * tokens by class, cost by model, cache efficiency, waste / in-progress /
 * overhead lines, coverage counts, and the invariant status line.
 */

import { rollup, byModel, cacheSavings } from '../../core/aggregate.js';
import { totalTokens } from '../../core/types.js';
import { matchModel, resolveCard } from '../../pricing/engine.js';
import { formatUsd, moneyToJson } from '../../pricing/money.js';
import { formatTokens } from '../../render/format.js';
import { c, isColorEnabled, renderTable } from '../../render/table.js';
import type { CliContext, LedgerRow } from '../context.js';
import { checkAccounting, scopedRows } from '../context.js';
import type { CliIO } from '../io.js';
import {
  baseJson,
  costCell,
  exitCodeFor,
  glyphs,
  invariantLines,
  moneyBreakdownToJson,
  pct1,
  planHeaderSuffix,
  planTotalSuffix,
  printJson,
  tokensLine,
  tokensToJson,
} from '../render.js';

/** Split rows into the four display buckets (in-progress carved out of waste). */
export function bucketRows(rows: readonly LedgerRow[]): {
  attributed: LedgerRow[];
  waste: LedgerRow[];
  inProgress: LedgerRow[];
  overhead: LedgerRow[];
} {
  const attributed: LedgerRow[] = [];
  const waste: LedgerRow[] = [];
  const inProgress: LedgerRow[] = [];
  const overhead: LedgerRow[] = [];
  for (const row of rows) {
    switch (row.entry.attribution.kind) {
      case 'commit':
        attributed.push(row);
        break;
      case 'waste':
        (row.inProgress ? inProgress : waste).push(row);
        break;
      case 'overhead':
        overhead.push(row);
        break;
      case 'out_of_scope':
        break; // never present in repo-scoped rows; tallied separately
    }
  }
  return { attributed, waste, inProgress, overhead };
}

/** Nano-USD price lookup for the cache-savings computation (spec §6.2). */
export function priceLookup(
  ctx: CliContext,
): (model: string) => { inputPerMTokNano: bigint; cacheReadPerMTokNano: bigint } | null {
  const memo = new Map<string, { inputPerMTokNano: bigint; cacheReadPerMTokNano: bigint } | null>();
  return (model: string) => {
    const hit = memo.get(model);
    if (hit !== undefined) return hit;
    const match = matchModel(ctx.prices.table, model);
    const value =
      match === null
        ? null
        : (() => {
            const { nano } = resolveCard(match.card);
            return { inputPerMTokNano: nano.inputPerMTok, cacheReadPerMTokNano: nano.cacheReadPerMTok };
          })();
    memo.set(model, value);
    return value;
  };
}

/** Deterministic by-model listing: cost descending, then model name. */
export function sortedModelRollups(
  rows: readonly LedgerRow[],
): Array<{ model: string; r: ReturnType<typeof rollup> }> {
  const map = byModel(rows.map((row) => row.entry));
  return [...map.entries()]
    .map(([model, r]) => ({ model, r }))
    .sort((a, b) => {
      if (a.r.cost.total !== b.r.cost.total) return a.r.cost.total > b.r.cost.total ? -1 : 1;
      return a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
    });
}

/** Run `vibebill summary`; returns the process exit code. */
export async function runSummary(ctx: CliContext, io: CliIO): Promise<number> {
  const check = checkAccounting(ctx.rows, ctx.ingest);
  const rows = scopedRows(ctx);
  const buckets = bucketRows(rows);
  const all = rollup(rows.map((r) => r.entry));
  const waste = rollup(buckets.waste.map((r) => r.entry));
  const inProgress = rollup(buckets.inProgress.map((r) => r.entry));
  const overhead = rollup(buckets.overhead.map((r) => r.entry));
  const models = sortedModelRollups(rows);
  const savings = cacheSavings(
    rows.map((r) => r.entry),
    priceLookup(ctx),
  );
  const cachePct = pct1(savings.cacheReadTokens, savings.inputTokens + savings.cacheReadTokens);
  const commitsCovered = new Set(
    buckets.attributed.map((r) =>
      r.entry.attribution.kind === 'commit' ? r.entry.attribution.hash : '',
    ),
  ).size;

  if (ctx.flags.json) {
    printJson(
      {
        ...baseJson('summary', ctx, check),
        scope: {
          since: ctx.flags.since === null ? null : new Date(ctx.flags.since).toISOString(),
          until: ctx.flags.until === null ? null : new Date(ctx.flags.until).toISOString(),
        },
        totals: {
          cost: moneyToJson(all.cost.total),
          costBreakdown: moneyBreakdownToJson(all.cost),
          tokens: tokensToJson(all.tokens),
          events: all.events,
          unpricedEvents: all.unpricedEvents,
          unpricedTokens: tokensToJson(all.unpricedTokens),
        },
        byModel: models.map(({ model, r }) => ({
          model,
          displayName: matchModel(ctx.prices.table, model)?.card.displayName ?? null,
          priced: r.unpricedEvents === 0,
          events: r.events,
          tokens: tokensToJson(r.tokens),
          cost: r.unpricedEvents === r.events ? null : moneyToJson(r.cost.total),
        })),
        cacheEfficiency: {
          cacheReadTokens: savings.cacheReadTokens,
          inputTokens: savings.inputTokens,
          pctOfInputVolume: cachePct,
          savings: moneyToJson(savings.savedNano),
          label: 'measured',
        },
        waste: {
          cost: moneyToJson(waste.cost.total),
          tokens: tokensToJson(waste.tokens),
          sessions: waste.sessions.size,
        },
        inProgress: {
          cost: moneyToJson(inProgress.cost.total),
          tokens: tokensToJson(inProgress.tokens),
          sessions: inProgress.sessions.size,
        },
        overhead: {
          cost: moneyToJson(overhead.cost.total),
          tokens: tokensToJson(overhead.tokens),
          sessions: overhead.sessions.size,
        },
        covered: { sessions: all.sessions.size, commits: commitsCovered },
      },
      (l) => io.out(l),
    );
    return exitCodeFor(check, ctx.flags.strict);
  }

  const g = glyphs();
  const repoName = ctx.repoRoot.split('/').filter(Boolean).pop() ?? ctx.repoRoot;
  io.out(c.bold(`vibebill summary ${g.dot} ${repoName}${planHeaderSuffix(ctx.plan)}`));
  const scopeBits: string[] = [];
  if (ctx.flags.since !== null) scopeBits.push(`since ${new Date(ctx.flags.since).toISOString()}`);
  if (ctx.flags.until !== null) scopeBits.push(`until ${new Date(ctx.flags.until).toISOString()}`);
  io.out(c.dim(`scope: ${scopeBits.length > 0 ? scopeBits.join(', ') : 'all history'}`));
  io.out('');

  const costLabel = ctx.plan === null ? 'total measured cost' : 'total API-equivalent value';
  io.out(`${costLabel}: ${c.bold(formatUsd(all.cost.total))}${planTotalSuffix(ctx.plan)}`);
  io.out(`tokens: ${tokensLine(all.tokens)}`);
  if (totalTokens(all.unpricedTokens) > 0) {
    io.out(
      c.yellow(
        `unpriced: ${formatTokens(totalTokens(all.unpricedTokens))} tokens across ` +
          `${all.unpricedEvents} events ($${isColorEnabled() ? '—' : '-'}) — unknown models`,
      ),
    );
  }
  io.out('');

  if (models.length > 0) {
    io.out(c.bold('cost by model'));
    io.out(
      renderTable(
        [
          { header: 'model' },
          { header: 'events', align: 'right' },
          { header: 'tokens', align: 'right' },
          { header: 'cost', align: 'right' },
        ],
        models.map(({ model, r }) => [
          matchModel(ctx.prices.table, model)?.card.displayName ?? model,
          String(r.events),
          formatTokens(totalTokens(r.tokens)),
          costCell(r.cost.total, totalTokens(r.unpricedTokens)),
        ]),
      ),
    );
    io.out('');
  }

  if (cachePct !== null) {
    io.out(
      `cache efficiency: cache reads were ${cachePct}% of input volume, ` +
        `saving ~${formatUsd(savings.savedNano)} vs uncached input (measured)`,
    );
  }
  io.out(
    `waste: ${formatUsd(waste.cost.total)} across ${waste.sessions.size} ` +
      `session${waste.sessions.size === 1 ? '' : 's'} never landed in a commit`,
  );
  if (inProgress.events > 0) {
    io.out(
      `in progress (uncommitted): ${formatUsd(inProgress.cost.total)} across ` +
        `${inProgress.sessions.size} session${inProgress.sessions.size === 1 ? '' : 's'} (not counted as waste)`,
    );
  }
  io.out(
    `overhead: ${formatUsd(overhead.cost.total)} across ${overhead.sessions.size} ` +
      `session${overhead.sessions.size === 1 ? '' : 's'} with no file edits (advisory)`,
  );
  io.out(`covered: ${all.sessions.size} sessions, ${commitsCovered} commits`);
  if (ctx.commits.length === 0) {
    io.out(c.dim('no commits yet — all usage is in progress or overhead (spec §7.16)'));
  }
  for (const line of invariantLines(check)) io.out(line);
  return exitCodeFor(check, ctx.flags.strict);
}
