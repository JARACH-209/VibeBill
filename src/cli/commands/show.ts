/**
 * `vibebill show <ref>` (spec §6.4): deep-dive on one commit — cost breakdown,
 * contributing sessions, per-model split, subagent share, and the attribution
 * evidence (fileScore/timeScore/branchScore) behind the numbers.
 */

import { bySession, dominantConfidence, rollup, scopeProvenance } from '../../core/aggregate.js';
import { totalTokens } from '../../core/types.js';
import { resolveRef } from '../../git/index.js';
import { formatUsd, moneyToJson } from '../../pricing/money.js';
import { formatTokens } from '../../render/format.js';
import { c, renderTable } from '../../render/table.js';
import type { CliContext } from '../context.js';
import { checkAccounting, inWindow } from '../context.js';
import type { CliIO } from '../io.js';
import {
  baseJson,
  confMark,
  costCell,
  exitCodeFor,
  fmtDateTimeUTC,
  fmtDateUTC,
  glyphs,
  invariantLines,
  moneyBreakdownToJson,
  pct1,
  planTotalSuffix,
  printJson,
  tokensLine,
  tokensToJson,
} from '../render.js';
import { sortedModelRollups } from './summary.js';
import { shortModel } from './log.js';

export interface ShowOptions {
  ref: string;
}

const MAX_EVIDENCE_ROWS = 12;
const MAX_FILE_ROWS = 20;

/** Format a score to two decimals for evidence tables. */
function score2(n: number): string {
  return n.toFixed(2);
}

/** Run `vibebill show <ref>`; returns the process exit code. */
export async function runShow(ctx: CliContext, opts: ShowOptions, io: CliIO): Promise<number> {
  const check = checkAccounting(ctx.rows, ctx.ingest);
  const hash = await resolveRef(ctx.repoRoot, opts.ref);
  const commit = ctx.commitByHash.get(hash) ?? null;

  const rows = ctx.rows.filter(
    (r) =>
      r.entry.attribution.kind === 'commit' &&
      r.entry.attribution.hash === hash &&
      inWindow(r.entry.event.ts, ctx.flags),
  );
  const entries = rows.map((r) => r.entry);
  const total = rollup(entries);
  const provenance = scopeProvenance(entries);

  // Evidence: directly-scored edit events only (adopted rows echo their source).
  const evidence = rows.filter(
    (r) => r.explain !== null && r.explain.adoptedFromEventId === undefined,
  );
  const adopted = rows.length - evidence.length;
  const advisory = rows.filter((r) => r.entry.provenance === 'advisory').length;

  // Files matched: union of repo-relative edited files across evidence events,
  // intersected with the commit's own file list (spec §6.4 "the evidence").
  const editedRel = new Set<string>();
  for (const r of evidence) {
    for (const p of r.entry.event.editedFiles) {
      const rel = ctx.toRepoRelative(p);
      if (rel !== null) editedRel.add(rel);
    }
  }
  const commitFiles = commit?.files ?? [];
  const matchedFiles = commitFiles.filter((f) => editedRel.has(f));
  const unmatchedFiles = commitFiles.filter((f) => !editedRel.has(f));

  const sessions = [...bySession(entries).entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
  const models = sortedModelRollups(rows);
  const subagentSharePct = pct1(total.subagentTokens, totalTokens(total.tokens));

  const evidenceData = evidence
    .slice()
    .sort((a, b) => a.entry.event.ts - b.entry.event.ts)
    .map((r) => {
      const ex = r.explain;
      const conf = r.entry.attribution.kind === 'commit' ? r.entry.attribution.confidence : 'low';
      const rel = r.entry.event.editedFiles
        .map((p) => ctx.toRepoRelative(p))
        .filter((p): p is string => p !== null);
      const matched = rel.filter((p) => commitFiles.includes(p)).length;
      return {
        eventId: r.entry.event.id,
        ts: r.entry.event.ts,
        editedFiles: rel.length,
        matchedFiles: matched,
        fileScore: ex?.fileScore ?? 0,
        timeScore: ex?.timeScore ?? 0,
        branchScore: ex?.branchScore ?? 0,
        score: ex?.score ?? 0,
        confidence: conf,
      };
    });

  if (ctx.flags.json) {
    printJson(
      {
        ...baseJson('show', ctx, check),
        ref: opts.ref,
        commit: {
          hash,
          shortHash: hash.slice(0, 7),
          subject: commit?.subject ?? null,
          authorTs: commit?.authorTs ?? null,
          date: commit === null ? null : fmtDateUTC(commit.authorTs),
          files: commitFiles,
          insertions: commit?.insertions ?? null,
          deletions: commit?.deletions ?? null,
          isMerge: commit?.isMerge ?? null,
          inEnumeratedHistory: commit !== null,
        },
        attributed: entries.length > 0,
        cost: entries.length === 0 ? null : moneyBreakdownToJson(total.cost),
        tokens: tokensToJson(total.tokens),
        unpricedTokens: tokensToJson(total.unpricedTokens),
        events: total.events,
        confidence: entries.length === 0 ? null : dominantConfidence(entries),
        provenance,
        sessions: sessions.map(([id, r]) => ({
          sessionId: id,
          idPrefix: id.slice(0, 8),
          from: r.minTs === null ? null : new Date(r.minTs).toISOString(),
          to: r.maxTs === null ? null : new Date(r.maxTs).toISOString(),
          events: r.events,
          tokens: tokensToJson(r.tokens),
          cost: moneyToJson(r.cost.total),
        })),
        byModel: models.map(({ model, r }) => ({
          model,
          events: r.events,
          tokens: tokensToJson(r.tokens),
          cost: r.unpricedEvents === r.events ? null : moneyToJson(r.cost.total),
        })),
        subagents: {
          tokens: total.subagentTokens,
          cost: moneyToJson(total.subagentCost.total),
          sharePctOfTokens: subagentSharePct,
        },
        evidence: evidenceData.map((e) => ({
          ...e,
          ts: new Date(e.ts).toISOString(),
        })),
        adoptedEvents: adopted,
        advisoryEvents: advisory,
        filesMatched: { matched: matchedFiles, unmatched: unmatchedFiles },
      },
      (l) => io.out(l),
    );
    return exitCodeFor(check, ctx.flags.strict);
  }

  const g = glyphs();
  const subjectLine = commit === null ? '(commit not in enumerated history)' : commit.subject;
  io.out(c.bold(`commit ${c.yellow(hash.slice(0, 7))} ${g.dot} ${subjectLine}`));
  if (commit !== null) {
    io.out(
      c.dim(
        `author date ${fmtDateUTC(commit.authorTs)} (UTC) ${g.dot} ` +
          `${commit.files.length} files changed (+${commit.insertions} -${commit.deletions})` +
          (commit.isMerge ? ' [merge — never an attribution target]' : ''),
      ),
    );
  }
  io.out('');

  if (entries.length === 0) {
    io.out(`no attributed events — likely human-written. cost: $0.00`);
    for (const line of invariantLines(check)) io.out(line);
    return exitCodeFor(check, ctx.flags.strict);
  }

  io.out(
    `cost: ${c.bold(formatUsd(total.cost.total))}${planTotalSuffix(ctx.plan)}  ` +
      c.dim(
        `(input ${formatUsd(total.cost.input)}, output ${formatUsd(total.cost.output)}, ` +
          `cache write ${formatUsd(total.cost.cacheWrite)}, cache read ${formatUsd(total.cost.cacheRead)})`,
      ),
  );
  io.out(`tokens: ${tokensLine(total.tokens)}`);
  if (totalTokens(total.unpricedTokens) > 0) {
    io.out(c.yellow(`unpriced: ${formatTokens(totalTokens(total.unpricedTokens))} tokens (unknown model)`));
  }
  const conf = dominantConfidence(entries);
  io.out(`confidence: ${confMark(conf)} ${conf} (token-weighted)`);
  io.out(
    `provenance: ${provenance.measured} measured, ${provenance.advisory} advisory, ${provenance.repriced} repriced (events)`,
  );
  io.out('');

  io.out(c.bold(`sessions (${sessions.length})`));
  io.out(
    renderTable(
      [
        { header: 'session' },
        { header: 'span (UTC)' },
        { header: 'events', align: 'right' },
        { header: 'tokens', align: 'right' },
        { header: 'cost', align: 'right' },
      ],
      sessions.map(([id, r]) => [
        id.slice(0, 8),
        r.minTs === null || r.maxTs === null
          ? ''
          : `${fmtDateTimeUTC(r.minTs)} ${g.arrow} ${fmtDateTimeUTC(r.maxTs)}`,
        String(r.events),
        formatTokens(totalTokens(r.tokens)),
        formatUsd(r.cost.total),
      ]),
    ),
  );
  io.out('');

  io.out(c.bold('models'));
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

  if (total.subagentTokens > 0) {
    io.out(
      `subagents: ${formatTokens(total.subagentTokens)} tokens, ${formatUsd(total.subagentCost.total)}` +
        (subagentSharePct === null ? '' : ` (${subagentSharePct}% of commit tokens)`),
    );
    io.out('');
  }

  io.out(c.bold('attribution evidence (scored edit events)'));
  io.out(
    renderTable(
      [
        { header: 'time (UTC)' },
        { header: 'files', align: 'right' },
        { header: 'fileScore', align: 'right' },
        { header: 'timeScore', align: 'right' },
        { header: 'branchScore', align: 'right' },
        { header: 'score', align: 'right' },
        { header: 'conf' },
      ],
      evidenceData.slice(0, MAX_EVIDENCE_ROWS).map((e) => [
        fmtDateTimeUTC(e.ts),
        `${e.matchedFiles}/${e.editedFiles}`,
        score2(e.fileScore),
        score2(e.timeScore),
        score2(e.branchScore),
        score2(e.score),
        confMark(e.confidence),
      ]),
    ),
  );
  if (evidenceData.length > MAX_EVIDENCE_ROWS) {
    io.out(c.dim(`  ${g.ellipsis} and ${evidenceData.length - MAX_EVIDENCE_ROWS} more edit events`));
  }
  io.out(
    c.dim(
      `${adopted} non-edit events adopted these attributions (planning/reads forward-attach, spec §5.4 Step C)`,
    ),
  );
  io.out('');

  io.out(c.bold(`files in commit matched by attributed edits: ${matchedFiles.length}/${commitFiles.length}`));
  const fileLines: string[] = [];
  for (const f of matchedFiles.slice(0, MAX_FILE_ROWS)) fileLines.push(`  ${c.green(g.check)} ${f}`);
  for (const f of unmatchedFiles.slice(0, Math.max(0, MAX_FILE_ROWS - matchedFiles.length))) {
    fileLines.push(c.dim(`  ${g.dot} ${f}`));
  }
  for (const line of fileLines) io.out(line);
  if (commitFiles.length > MAX_FILE_ROWS) {
    io.out(c.dim(`  ${g.ellipsis} and ${commitFiles.length - MAX_FILE_ROWS} more files`));
  }
  if (advisory > 0) {
    io.out('');
    io.out(
      c.yellow(
        `advisory: ${advisory} events attributed without file overlap (pure-time fallback or adoption) — labeled advisory`,
      ),
    );
  }
  io.out('');
  for (const line of invariantLines(check)) io.out(line);
  return exitCodeFor(check, ctx.flags.strict);
}
