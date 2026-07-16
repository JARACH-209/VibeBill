/**
 * `vibebill notes sync [range]` and `notes sync --clear` (spec §6.8):
 * idempotent per-commit cost annotations under refs/notes/vibebill only —
 * vibebill never touches the default notes ref.
 */

import { byCommit, dominantConfidence, scopeProvenance } from '../../core/aggregate.js';
import { CliUserError } from '../../core/errors.js';
import type { LedgerEntry } from '../../core/types.js';
import { totalTokens } from '../../core/types.js';
import { listNotes, removeNote, writeNote } from '../../git/index.js';
import type { CliContext } from '../context.js';
import { checkAccounting, resolveCommitScope, scopedRows } from '../context.js';
import type { CliIO } from '../io.js';
import { baseJson, exitCodeFor, printJson } from '../render.js';
import { vibebillVersion } from '../version.js';

export interface NotesOptions {
  /** Optional revision range restricting which commits are annotated. */
  range: string | null;
  /** Remove vibebill notes in scope instead of writing them. */
  clear: boolean;
}

/**
 * The note payload for one commit (spec §6.8). Key order is fixed so repeated
 * syncs produce byte-identical notes (idempotence, test S14).
 */
export function notePayload(entries: readonly LedgerEntry[]): string {
  let cost = 0n;
  let input = 0;
  let output = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  for (const e of entries) {
    if (e.cost !== null) cost += e.cost.total;
    input += e.event.tokens.input;
    output += e.event.tokens.output;
    cacheWrite += e.event.tokens.cacheWrite;
    cacheRead += e.event.tokens.cacheRead;
  }
  const provenance = scopeProvenance(entries);
  return JSON.stringify({
    v: 1,
    costNanoUsd: cost.toString(),
    tokens: {
      input,
      output,
      cacheWrite,
      cacheRead,
      total: input + output + cacheWrite + cacheRead,
    },
    confidence: dominantConfidence(entries),
    // One label per note: a commit with ANY advisory contribution is advisory.
    provenance: provenance.advisory > 0 ? 'advisory' : 'measured',
    generatedBy: `vibebill@${vibebillVersion()}`,
  });
}

/** Run `vibebill notes sync [range] [--clear]`; returns the process exit code. */
export async function runNotes(ctx: CliContext, opts: NotesOptions, io: CliIO): Promise<number> {
  const check = checkAccounting(ctx.rows, ctx.ingest);
  const rows = scopedRows(ctx);

  let scopeHashes: Set<string> | null = null;
  if (opts.range !== null) {
    if (!opts.range.includes('..')) {
      throw new CliUserError(
        `notes sync expects a revision range like A..B, got ${JSON.stringify(opts.range)}.`,
        'Example: vibebill notes sync v1.0.0..HEAD',
      );
    }
    scopeHashes = (await resolveCommitScope(ctx, opts.range)).hashes;
  }

  if (opts.clear) {
    // Remove ONLY vibebill's own notes (its dedicated ref), only in scope.
    const existing = await listNotes(ctx.repoRoot);
    const toClear = existing
      .map((n) => n.hash)
      .filter((h) => scopeHashes === null || scopeHashes.has(h))
      .sort();
    for (const hash of toClear) await removeNote(ctx.repoRoot, hash);
    if (ctx.flags.json) {
      printJson({ ...baseJson('notes', ctx, check), cleared: toClear }, (l) => io.out(l));
    } else {
      io.out(
        `cleared ${toClear.length} vibebill note${toClear.length === 1 ? '' : 's'} ` +
          '(refs/notes/vibebill only; other notes untouched)',
      );
    }
    return exitCodeFor(check, ctx.flags.strict);
  }

  const perCommit = byCommit(rows.map((r) => r.entry));
  const entriesByHash = new Map<string, LedgerEntry[]>();
  for (const row of rows) {
    if (row.entry.attribution.kind !== 'commit') continue;
    const hash = row.entry.attribution.hash;
    if (scopeHashes !== null && !scopeHashes.has(hash)) continue;
    const list = entriesByHash.get(hash);
    if (list === undefined) entriesByHash.set(hash, [row.entry]);
    else list.push(row.entry);
  }

  const synced: Array<{ hash: string; costNanoUsd: string; tokens: number }> = [];
  for (const hash of [...entriesByHash.keys()].sort()) {
    const entries = entriesByHash.get(hash) as LedgerEntry[];
    await writeNote(ctx.repoRoot, hash, notePayload(entries));
    let tokens = 0;
    for (const e of entries) tokens += totalTokens(e.event.tokens);
    const r = perCommit.get(hash);
    synced.push({
      hash,
      costNanoUsd: (r?.cost.total ?? 0n).toString(),
      tokens,
    });
  }

  if (ctx.flags.json) {
    printJson({ ...baseJson('notes', ctx, check), synced }, (l) => io.out(l));
    return exitCodeFor(check, ctx.flags.strict);
  }

  io.out(`synced cost notes to ${synced.length} commit${synced.length === 1 ? '' : 's'}`);
  io.out('view them with: git log --notes=vibebill');
  return exitCodeFor(check, ctx.flags.strict);
}
