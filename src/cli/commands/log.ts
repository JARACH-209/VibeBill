/**
 * `vibebill log` (spec §6.3): git-log-style cost listing, newest first, with
 * columns cost | conf | hash | date | subject | models | sessions, an
 * "in progress (uncommitted)" pseudo-row on top, and a totals + invariant
 * footer. Laid out to be complete and aligned at 100 columns.
 */

import { dominantConfidence, rollup, type Rollup } from '../../core/aggregate.js';
import { CliUserError } from '../../core/errors.js';
import type { CommitInfo, LedgerEntry } from '../../core/types.js';
import { totalTokens } from '../../core/types.js';
import { matchModel } from '../../pricing/engine.js';
import { formatUsd, moneyToJson } from '../../pricing/money.js';
import { c, renderTable, visibleWidth } from '../../render/table.js';
import type { CliContext, LedgerRow } from '../context.js';
import { checkAccounting, inWindow, resolveCommitScope, scopedRows } from '../context.js';
import type { CliIO } from '../io.js';
import {
  baseJson,
  confMark,
  costCell,
  exitCodeFor,
  fmtDateUTC,
  glyphs,
  invariantLines,
  planTotalSuffix,
  printJson,
  tokensToJson,
  truncate,
} from '../render.js';
import { bucketRows } from './summary.js';

export interface LogOptions {
  /** -n / --max-count row limit; null shows every commit in scope. */
  maxCount: number | null;
  /** Optional revision range (anything `git rev-list` accepts). */
  range: string | null;
}

/** Target display width for the default `log` layout (spec §6.3). */
export const LOG_TABLE_WIDTH = 100;

const MODELS_CELL_MAX = 18;
const SUBJECT_MIN = 12;

/** Shorten a raw model string to its matched price-table id when available. */
export function shortModel(ctx: CliContext, raw: string): string {
  return matchModel(ctx.prices.table, raw)?.id ?? (raw === '' ? '(unknown)' : raw);
}

/** Deterministic comma list of a rollup's models, shortened and truncated. */
function modelsCell(ctx: CliContext, r: Rollup): string {
  const names = [...new Set([...r.models].map((m) => shortModel(ctx, m)))].sort();
  return truncate(names.join(','), MODELS_CELL_MAX);
}

/** Group scoped attributed rows by commit hash, preserving row order. */
export function rowsByCommit(rows: readonly LedgerRow[]): Map<string, LedgerRow[]> {
  const map = new Map<string, LedgerRow[]>();
  for (const row of rows) {
    if (row.entry.attribution.kind !== 'commit') continue;
    const list = map.get(row.entry.attribution.hash);
    if (list === undefined) map.set(row.entry.attribution.hash, [row]);
    else list.push(row);
  }
  return map;
}

interface LogRowData {
  commit: CommitInfo;
  entries: LedgerEntry[];
  rollup: Rollup | null;
}

/** Render the aligned log table, fitting the subject column into 100 columns. */
function renderLogTable(ctx: CliContext, rowsData: LogRowData[], inProgress: Rollup | null): string {
  const g = glyphs();
  type Cells = [string, string, string, string, string, string, string];
  const cells: Cells[] = [];

  if (inProgress !== null && inProgress.events > 0) {
    cells.push([
      c.cyan(formatUsd(inProgress.cost.total)),
      confMark('low'),
      c.dim('(wip)'),
      inProgress.maxTs === null ? '' : fmtDateUTC(inProgress.maxTs),
      c.cyan('in progress (uncommitted)'),
      modelsCell(ctx, inProgress),
      String(inProgress.sessions.size),
    ]);
  }

  for (const { commit, entries, rollup: r } of rowsData) {
    const uncosted = r === null || r.events === 0;
    cells.push([
      uncosted ? '$0.00' : c.bold(costCell(r.cost.total, totalTokens(r.unpricedTokens))),
      uncosted ? c.dim(g.human) : confMark(dominantConfidence(entries)),
      c.yellow(commit.hash.slice(0, 7)),
      fmtDateUTC(commit.authorTs),
      commit.subject,
      r === null ? '' : modelsCell(ctx, r),
      r === null ? '' : String(r.sessions.size),
    ]);
  }

  // Fixed-budget layout: measure every non-subject column, give the subject
  // whatever remains of the 100-column budget, and truncate to fit.
  const headers = ['cost', 'conf', 'hash', 'date', 'subject', 'models', 'sessions'];
  const otherIdx = [0, 1, 2, 3, 5, 6];
  let otherWidth = 0;
  for (const i of otherIdx) {
    let w = visibleWidth(headers[i] ?? '');
    for (const row of cells) w = Math.max(w, visibleWidth(row[i] ?? ''));
    otherWidth += w;
  }
  const gaps = 2 * (headers.length - 1);
  const subjectWidth = Math.max(SUBJECT_MIN, LOG_TABLE_WIDTH - otherWidth - gaps);
  for (const row of cells) row[4] = truncate(row[4], subjectWidth);

  return renderTable(
    [
      { header: 'cost', align: 'right' },
      { header: 'conf' },
      { header: 'hash' },
      { header: 'date' },
      { header: 'subject' },
      { header: 'models' },
      { header: 'sessions', align: 'right' },
    ],
    cells,
  );
}

/** Run `vibebill log`; returns the process exit code. */
export async function runLog(ctx: CliContext, opts: LogOptions, io: CliIO): Promise<number> {
  if (opts.maxCount !== null && (!Number.isInteger(opts.maxCount) || opts.maxCount <= 0)) {
    throw new CliUserError('-n expects a positive integer.', 'Example: vibebill log -n 20');
  }
  const check = checkAccounting(ctx.rows, ctx.ingest);
  const rows = scopedRows(ctx);
  const buckets = bucketRows(rows);
  const byHash = rowsByCommit(rows);

  let commits = ctx.commits;
  if (opts.range !== null) {
    commits = (await resolveCommitScope(ctx, opts.range)).commits;
  }
  if (ctx.flags.since !== null || ctx.flags.until !== null) {
    commits = commits.filter((cm) => inWindow(cm.authorTs, ctx.flags));
  }
  if (opts.maxCount !== null) commits = commits.slice(0, opts.maxCount);

  const inProgress = rollup(buckets.inProgress.map((r) => r.entry));
  const waste = rollup(buckets.waste.map((r) => r.entry));
  const overhead = rollup(buckets.overhead.map((r) => r.entry));

  const rowsData: LogRowData[] = commits.map((commit) => {
    const entries = (byHash.get(commit.hash) ?? []).map((r) => r.entry);
    return { commit, entries, rollup: entries.length > 0 ? rollup(entries) : null };
  });
  const shownAttributed = rollup(rowsData.flatMap((d) => d.entries));

  if (ctx.flags.json) {
    printJson(
      {
        ...baseJson('log', ctx, check),
        range: opts.range,
        maxCount: opts.maxCount,
        inProgress:
          inProgress.events === 0
            ? null
            : {
                cost: moneyToJson(inProgress.cost.total),
                tokens: tokensToJson(inProgress.tokens),
                sessions: inProgress.sessions.size,
                events: inProgress.events,
                newestTs: inProgress.maxTs === null ? null : new Date(inProgress.maxTs).toISOString(),
              },
        commits: rowsData.map(({ commit, entries, rollup: r }) => ({
          hash: commit.hash,
          shortHash: commit.hash.slice(0, 7),
          authorTs: commit.authorTs,
          date: fmtDateUTC(commit.authorTs),
          subject: commit.subject,
          attributed: entries.length > 0,
          cost: r === null ? null : moneyToJson(r.cost.total),
          tokens: r === null ? null : tokensToJson(r.tokens),
          unpricedTokens: r === null ? 0 : totalTokens(r.unpricedTokens),
          confidence: r === null ? null : dominantConfidence(entries),
          models: r === null ? [] : [...r.models].sort(),
          sessions: r === null ? 0 : r.sessions.size,
          events: r === null ? 0 : r.events,
        })),
        totals: {
          attributedCost: moneyToJson(shownAttributed.cost.total),
          commitsShown: commits.length,
          commitsCosted: rowsData.filter((d) => d.entries.length > 0).length,
          waste: moneyToJson(waste.cost.total),
          overhead: moneyToJson(overhead.cost.total),
          inProgress: moneyToJson(inProgress.cost.total),
        },
      },
      (l) => io.out(l),
    );
    return exitCodeFor(check, ctx.flags.strict);
  }

  const g = glyphs();
  if (commits.length === 0 && inProgress.events === 0) {
    io.out('no commits in scope yet — nothing to list (usage, if any, sits in waste/overhead).');
  } else {
    io.out(renderLogTable(ctx, rowsData, inProgress.events > 0 ? inProgress : null));
  }
  io.out('');
  const parts = [
    `totals: ${c.bold(formatUsd(shownAttributed.cost.total))}${planTotalSuffix(ctx.plan)} across ${commits.length} commits`,
    `waste ${formatUsd(waste.cost.total)}`,
    `overhead ${formatUsd(overhead.cost.total)}`,
  ];
  if (inProgress.events > 0) parts.push(`in progress ${formatUsd(inProgress.cost.total)}`);
  io.out(parts.join(` ${g.dot} `));
  for (const line of invariantLines(check)) io.out(line);
  return exitCodeFor(check, ctx.flags.strict);
}
