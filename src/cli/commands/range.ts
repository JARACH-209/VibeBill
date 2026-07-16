/**
 * `vibebill range <A>..<B>` (spec §6.5): summary restricted to the commits in
 * `git rev-list A..B`, a per-commit mini-table, and a "cost of this release"
 * headline. Waste/overhead lines cover unattributed events inside the range's
 * author-date span (documented in docs/json-schemas.md).
 */

import { dominantConfidence, rollup } from '../../core/aggregate.js';
import { CliUserError } from '../../core/errors.js';
import { totalTokens } from '../../core/types.js';
import { formatUsd, moneyToJson } from '../../pricing/money.js';
import { formatTokens } from '../../render/format.js';
import { c, renderTable } from '../../render/table.js';
import type { CliContext, LedgerRow } from '../context.js';
import { checkAccounting, resolveCommitScope, scopedRows } from '../context.js';
import type { CliIO } from '../io.js';
import {
  baseJson,
  confMark,
  costCell,
  exitCodeFor,
  fmtDateUTC,
  glyphs,
  invariantLines,
  moneyBreakdownToJson,
  planHeaderSuffix,
  planTotalSuffix,
  printJson,
  tokensLine,
  tokensToJson,
  truncate,
} from '../render.js';
import { rowsByCommit } from './log.js';
import { sortedModelRollups } from './summary.js';
import { shortModel } from './log.js';

export interface RangeOptions {
  range: string;
  /** Optional display title for the output (used by `report`). */
  label: string | null;
}

/** Run `vibebill range <A>..<B>`; returns the process exit code. */
export async function runRange(ctx: CliContext, opts: RangeOptions, io: CliIO): Promise<number> {
  if (!opts.range.includes('..')) {
    throw new CliUserError(
      `range expects a revision range like A..B, got ${JSON.stringify(opts.range)}.`,
      'Example: vibebill range v1.0.0..v1.1.0',
    );
  }
  const check = checkAccounting(ctx.rows, ctx.ingest);
  const { hashes, commits } = await resolveCommitScope(ctx, opts.range);
  const rows = scopedRows(ctx);
  const byHash = rowsByCommit(rows);

  const rangeRows: LedgerRow[] = [];
  for (const commit of commits) {
    for (const row of byHash.get(commit.hash) ?? []) rangeRows.push(row);
  }
  const total = rollup(rangeRows.map((r) => r.entry));
  const models = sortedModelRollups(rangeRows);

  // Author-date span of the range's non-merge commits: the window used for the
  // waste/overhead lines ("what leaked during this release's development").
  let spanFrom: number | null = null;
  let spanTo: number | null = null;
  for (const commit of commits) {
    if (spanFrom === null || commit.authorTs < spanFrom) spanFrom = commit.authorTs;
    if (spanTo === null || commit.authorTs > spanTo) spanTo = commit.authorTs;
  }
  const inSpan = (ts: number): boolean =>
    spanFrom !== null && spanTo !== null && ts >= spanFrom && ts <= spanTo;
  const wasteRows = rows.filter(
    (r) => r.entry.attribution.kind === 'waste' && !r.inProgress && inSpan(r.entry.event.ts),
  );
  const overheadRows = rows.filter(
    (r) => r.entry.attribution.kind === 'overhead' && inSpan(r.entry.event.ts),
  );
  const waste = rollup(wasteRows.map((r) => r.entry));
  const overhead = rollup(overheadRows.map((r) => r.entry));

  const perCommit = commits.map((commit) => {
    const entries = (byHash.get(commit.hash) ?? []).map((r) => r.entry);
    return { commit, entries, r: entries.length > 0 ? rollup(entries) : null };
  });

  if (ctx.flags.json) {
    printJson(
      {
        ...baseJson('range', ctx, check),
        range: opts.range,
        label: opts.label,
        headline: {
          cost: moneyToJson(total.cost.total),
          commits: commits.length,
          sessions: total.sessions.size,
        },
        totals: {
          cost: moneyToJson(total.cost.total),
          costBreakdown: moneyBreakdownToJson(total.cost),
          tokens: tokensToJson(total.tokens),
          events: total.events,
          unpricedTokens: tokensToJson(total.unpricedTokens),
        },
        byModel: models.map(({ model, r }) => ({
          model,
          events: r.events,
          tokens: tokensToJson(r.tokens),
          cost: r.unpricedEvents === r.events ? null : moneyToJson(r.cost.total),
        })),
        commits: perCommit.map(({ commit, entries, r }) => ({
          hash: commit.hash,
          shortHash: commit.hash.slice(0, 7),
          date: fmtDateUTC(commit.authorTs),
          subject: commit.subject,
          attributed: entries.length > 0,
          cost: r === null ? null : moneyToJson(r.cost.total),
          confidence: r === null ? null : dominantConfidence(entries),
          sessions: r === null ? 0 : r.sessions.size,
        })),
        span: {
          from: spanFrom === null ? null : new Date(spanFrom).toISOString(),
          to: spanTo === null ? null : new Date(spanTo).toISOString(),
        },
        waste: {
          cost: moneyToJson(waste.cost.total),
          tokens: tokensToJson(waste.tokens),
          sessions: waste.sessions.size,
        },
        overhead: {
          cost: moneyToJson(overhead.cost.total),
          tokens: tokensToJson(overhead.tokens),
          sessions: overhead.sessions.size,
        },
        revListCommits: hashes.size,
      },
      (l) => io.out(l),
    );
    return exitCodeFor(check, ctx.flags.strict);
  }

  const g = glyphs();
  const title = opts.label ?? opts.range;
  io.out(c.bold(`vibebill range ${g.dot} ${title}${planHeaderSuffix(ctx.plan)}`));
  io.out(c.dim(`commits in ${opts.range}: ${hashes.size} (${commits.length} in enumerated history)`));
  io.out('');
  if (commits.length === 0) {
    io.out('no commits in this range — nothing to cost.');
    for (const line of invariantLines(check)) io.out(line);
    return exitCodeFor(check, ctx.flags.strict);
  }

  io.out(
    `cost of this release: ${c.bold(formatUsd(total.cost.total))}${planTotalSuffix(ctx.plan)} ` +
      c.dim(`(${commits.length} commits, ${total.sessions.size} sessions)`),
  );
  io.out(`tokens: ${tokensLine(total.tokens)}`);
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
          shortModel(ctx, model),
          String(r.events),
          formatTokens(totalTokens(r.tokens)),
          costCell(r.cost.total, totalTokens(r.unpricedTokens)),
        ]),
      ),
    );
    io.out('');
  }

  io.out(c.bold('per-commit'));
  io.out(
    renderTable(
      [
        { header: 'cost', align: 'right' },
        { header: 'conf' },
        { header: 'hash' },
        { header: 'date' },
        { header: 'subject' },
        { header: 'sessions', align: 'right' },
      ],
      perCommit.map(({ commit, entries, r }) => [
        r === null ? '$0.00' : c.bold(costCell(r.cost.total, totalTokens(r.unpricedTokens))),
        r === null ? c.dim(g.human) : confMark(dominantConfidence(entries)),
        c.yellow(commit.hash.slice(0, 7)),
        fmtDateUTC(commit.authorTs),
        truncate(commit.subject, 48),
        r === null ? '' : String(r.sessions.size),
      ]),
    ),
  );
  io.out('');

  if (spanFrom !== null && spanTo !== null) {
    io.out(
      `waste during this span: ${formatUsd(waste.cost.total)} across ${waste.sessions.size} ` +
        `session${waste.sessions.size === 1 ? '' : 's'} ` +
        c.dim(`(${fmtDateUTC(spanFrom)} ${g.arrow} ${fmtDateUTC(spanTo)})`),
    );
    io.out(
      `overhead during this span: ${formatUsd(overhead.cost.total)} across ${overhead.sessions.size} ` +
        `session${overhead.sessions.size === 1 ? '' : 's'} with no file edits`,
    );
  }
  for (const line of invariantLines(check)) io.out(line);
  return exitCodeFor(check, ctx.flags.strict);
}
