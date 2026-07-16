/**
 * `vibebill report --md [--out LEDGER.md] [range]` (spec §6.7): the only
 * command besides `notes sync` that writes into the repo, and only at the
 * explicit path the user asked for. Refuses to overwrite without --force.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { byCommit, rollup, scopeProvenance } from '../../core/aggregate.js';
import { CliUserError } from '../../core/errors.js';
import type { CommitInfo } from '../../core/types.js';
import { totalTokens } from '../../core/types.js';
import { formatUsd } from '../../pricing/money.js';
import { formatLocalTimeWithOffset, formatTokens } from '../../render/format.js';
import type { CliContext, LedgerRow } from '../context.js';
import { checkAccounting, resolveCommitScope, scopedRows } from '../context.js';
import type { CliIO } from '../io.js';
import { baseJson, exitCodeFor, fmtDateUTC, printJson } from '../render.js';
import { bucketRows, sortedModelRollups } from './summary.js';
import { vibebillVersion } from '../version.js';

export interface ReportOptions {
  /** Only markdown exists today; the flag is required for forward compatibility. */
  md: boolean;
  /** Output path; relative paths resolve against the current directory. */
  out: string;
  force: boolean;
  range: string | null;
}

/** Markdown-escape a table cell (pipes and newlines would break the row). */
function mdCell(s: string): string {
  return s.replace(/\|/g, '\\|').replace(/\s+/g, ' ').trim();
}

/** Confidence word for the per-commit table (no glyphs in markdown). */
function commitConfidence(rows: readonly LedgerRow[]): string {
  let best = '';
  const order = { high: 3, medium: 2, low: 1 } as const;
  let bestRank = 0;
  let weight = 0;
  const tally = new Map<string, number>();
  for (const r of rows) {
    if (r.entry.attribution.kind !== 'commit') continue;
    const conf = r.entry.attribution.confidence;
    const w = totalTokens(r.entry.event.tokens);
    tally.set(conf, (tally.get(conf) ?? 0) + w);
  }
  for (const [conf, w] of tally) {
    const rank = order[conf as keyof typeof order] ?? 0;
    if (w > weight || (w === weight && rank > bestRank)) {
      best = conf;
      weight = w;
      bestRank = rank;
    }
  }
  return best === '' ? '—' : best;
}

/** Build the self-contained markdown ledger document. */
export function buildLedgerMarkdown(
  ctx: CliContext,
  rows: readonly LedgerRow[],
  commits: readonly CommitInfo[],
  label: string | null,
): string {
  const buckets = bucketRows(rows);
  const all = rollup(rows.map((r) => r.entry));
  const waste = rollup(buckets.waste.map((r) => r.entry));
  const inProgress = rollup(buckets.inProgress.map((r) => r.entry));
  const overhead = rollup(buckets.overhead.map((r) => r.entry));
  const provenance = scopeProvenance(rows.map((r) => r.entry));
  const perCommit = byCommit(rows.map((r) => r.entry));
  const rowsByHash = new Map<string, LedgerRow[]>();
  for (const r of rows) {
    if (r.entry.attribution.kind !== 'commit') continue;
    const list = rowsByHash.get(r.entry.attribution.hash);
    if (list === undefined) rowsByHash.set(r.entry.attribution.hash, [r]);
    else list.push(r);
  }

  const repoName = ctx.repoRoot.split('/').filter(Boolean).pop() ?? ctx.repoRoot;
  const planNote =
    ctx.plan === null
      ? ''
      : ` All dollar figures are API-equivalent value consumed on your ${ctx.plan} subscription, not billed dollars.`;

  const lines: string[] = [];
  lines.push(`# ${label ?? `vibebill ledger — ${repoName}`}`);
  lines.push('');
  lines.push(`- repo: \`${ctx.repoRoot}\``);
  lines.push(`- generated: ${formatLocalTimeWithOffset(ctx.flags.nowMs)} by vibebill ${vibebillVersion()}`);
  lines.push(`- pricing: ${ctx.prices.table.asOf} (${ctx.prices.origin})`);
  lines.push('');
  lines.push(
    '> Provenance legend: **measured** — priced from actual token records at a known model price. ' +
      '**repriced** — the same measured traffic priced on a different model card (counterfactual). ' +
      '**advisory** — attribution was low-confidence or tokens could not be tied to a commit.' +
      planNote,
  );
  lines.push('');

  lines.push('## Summary');
  lines.push('');
  const costWord = ctx.plan === null ? 'Total measured cost' : 'Total API-equivalent value';
  lines.push(`**${costWord}: ${formatUsd(all.cost.total)}** across ${all.events} events, ${all.sessions.size} sessions, ${perCommit.size} costed commits.`);
  lines.push('');
  lines.push('| tokens | input | output | cache write | cache read |');
  lines.push('|---|---:|---:|---:|---:|');
  lines.push(
    `| ${formatTokens(totalTokens(all.tokens))} | ${formatTokens(all.tokens.input)} | ${formatTokens(all.tokens.output)} | ${formatTokens(all.tokens.cacheWrite)} | ${formatTokens(all.tokens.cacheRead)} |`,
  );
  lines.push('');
  lines.push(
    `Provenance mix (events): ${provenance.measured} measured, ${provenance.advisory} advisory, ${provenance.repriced} repriced.`,
  );
  if (totalTokens(all.unpricedTokens) > 0) {
    lines.push('');
    lines.push(
      `Unpriced: ${formatTokens(totalTokens(all.unpricedTokens))} tokens across ${all.unpricedEvents} events had no known model price ($—).`,
    );
  }
  lines.push('');

  lines.push('## Per-commit costs');
  lines.push('');
  lines.push('| cost | confidence | commit | date | subject |');
  lines.push('|---:|---|---|---|---|');
  for (const commit of commits) {
    const r = perCommit.get(commit.hash);
    const commitRows = rowsByHash.get(commit.hash) ?? [];
    const cost = r === undefined ? '$0.00 (human?)' : formatUsd(r.cost.total);
    lines.push(
      `| ${cost} | ${commitConfidence(commitRows)} | \`${commit.hash.slice(0, 7)}\` | ${fmtDateUTC(commit.authorTs)} | ${mdCell(commit.subject)} |`,
    );
  }
  lines.push('');

  lines.push('## Waste and in-progress');
  lines.push('');
  lines.push(
    `- waste: ${formatUsd(waste.cost.total)} (${formatTokens(totalTokens(waste.tokens))} tokens, ${waste.sessions.size} sessions) never landed in a commit within the horizon.`,
  );
  lines.push(
    `- in progress (uncommitted): ${formatUsd(inProgress.cost.total)} (${inProgress.sessions.size} sessions) — newer than the newest commit, not counted as waste.`,
  );
  lines.push(
    `- overhead: ${formatUsd(overhead.cost.total)} (${overhead.sessions.size} sessions with no file edits; advisory).`,
  );
  lines.push('');

  lines.push('## Model mix');
  lines.push('');
  lines.push('| model | events | tokens | cost |');
  lines.push('|---|---:|---:|---:|');
  for (const { model, r } of sortedModelRollups([...rows])) {
    const cost = r.unpricedEvents === r.events ? '$—' : formatUsd(r.cost.total);
    lines.push(
      `| ${mdCell(model)} | ${r.events} | ${formatTokens(totalTokens(r.tokens))} | ${cost} |`,
    );
  }
  lines.push('');

  lines.push('## Methodology');
  lines.push('');
  lines.push(
    'vibebill reads local agent transcripts (metadata only — token counts, model names, session ids, ' +
      'edited file paths; never prompt or response text) and attributes each API call to a commit by ' +
      'matching edited files, timing, and branch hints against git history, so every dollar figure ' +
      'derives from measured per-call token usage, never from diff-size estimates. Attribution is ' +
      'probabilistic (see confidence column); unmatched work is reported honestly as waste or overhead, ' +
      'and the token-conservation invariant (attributed + waste + overhead + out-of-scope == total) is ' +
      'checked on every run.',
  );
  lines.push('');
  return lines.join('\n');
}

/** Run `vibebill report`; returns the process exit code. */
export async function runReport(ctx: CliContext, opts: ReportOptions, io: CliIO): Promise<number> {
  if (!opts.md) {
    throw new CliUserError(
      'report currently supports only markdown output.',
      'Pass --md (optionally with --out <file>).',
    );
  }
  const check = checkAccounting(ctx.rows, ctx.ingest);
  let rows = scopedRows(ctx);
  let commits = ctx.commits;
  let label: string | null = null;

  if (opts.range !== null) {
    const scope = await resolveCommitScope(ctx, opts.range);
    commits = scope.commits;
    rows = rows.filter(
      (r) => r.entry.attribution.kind !== 'commit' || scope.hashes.has(r.entry.attribution.hash),
    );
    label = `vibebill ledger — ${opts.range}`;
  }

  const outPath = path.resolve(process.cwd(), opts.out);
  if (!opts.force) {
    try {
      await fs.access(outPath);
      throw new CliUserError(
        `${opts.out} already exists.`,
        'Pass --force to overwrite, or --out <other-file>.',
      );
    } catch (err) {
      if (err instanceof CliUserError) throw err;
      // ENOENT: target does not exist — safe to write.
    }
  }

  const markdown = buildLedgerMarkdown(ctx, rows, commits, label);
  await fs.writeFile(outPath, markdown + '\n', 'utf8');

  if (ctx.flags.json) {
    printJson(
      { ...baseJson('report', ctx, check), out: outPath, commits: commits.length },
      (l) => io.out(l),
    );
    return exitCodeFor(check, ctx.flags.strict);
  }
  io.out(`wrote ${opts.out} (${commits.length} commits)`);
  return exitCodeFor(check, ctx.flags.strict);
}
