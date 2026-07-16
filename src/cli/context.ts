/**
 * Shared CLI plumbing: repo-root resolution, config+flags merge, and the
 * ingest → attribution → pricing → ledger assembly. Built ONCE per invocation
 * and reused by every command (task contract). All heavy lifting delegates to
 * the engine modules; this file only wires them together.
 */

import { realpathSync } from 'node:fs';
import * as path from 'node:path';

import { createAiderAdapter } from '../adapters/aider/index.js';
import { createClaudeCodeAdapter } from '../adapters/claude-code/index.js';
import { createCodexAdapter } from '../adapters/codex/index.js';
import { createGeminiCliAdapter } from '../adapters/gemini-cli/index.js';
import {
  attributeEvents,
  isInProgress,
  provenanceFor,
  type AttributionExplain,
} from '../core/attribution.js';
import { loadRepoConfig, type RepoConfig } from '../core/config.js';
import { CliUserError } from '../core/errors.js';
import { ingestEvents, type IngestResult } from '../core/ingest.js';
import { checkConservation, type ConservationReport } from '../core/invariant.js';
import type {
  AgentId,
  CommitInfo,
  LedgerEntry,
  PlanId,
  SourceAdapter,
  TokenCounts,
} from '../core/types.js';
import { addTokenCounts, totalTokens, ZERO_TOKENS } from '../core/types.js';
import { enumerateCommits, resolveRepoRoot, revList } from '../git/index.js';
import { loadEffectivePrices, priceTokens, type PriceTable } from '../pricing/engine.js';

/** Parsed global flags shared by every command (spec §6). */
export interface GlobalFlags {
  json: boolean;
  /** UTC ms lower bound for the display scope, or null (no bound). */
  since: number | null;
  /** UTC ms upper bound for the display scope, or null (no bound). */
  until: number | null;
  /** false when --no-color was passed (initial TTY/NO_COLOR detection is separate). */
  color: boolean;
  quiet: boolean;
  strict: boolean;
  debug: boolean;
  plan: PlanId | null;
  allRefs: boolean;
  refreshPricing: boolean;
  /** Injected clock: VIBEBILL_NOW when set, else Date.now() at startup. */
  nowMs: number;
}

/** One priced+attributed event plus its render-time metadata. */
export interface LedgerRow {
  entry: LedgerEntry;
  /** Attribution score evidence; null for waste/overhead rows. */
  explain: AttributionExplain | null;
  /** Render-time "in progress (uncommitted)" bucket (spec §5.4 Step B). */
  inProgress: boolean;
}

/**
 * The runtime accounting cross-check every command prints (spec §5.4 Step D
 * plus the S12 tamper check): raw ingest totals vs the ledger's bucket sum.
 */
export interface AccountingCheck {
  conservation: ConservationReport;
  /** Ground truth: Σ tokens over raw ingest events + out-of-scope tally. */
  rawTokens: number;
  /** Σ over the ledger buckets (attributed + waste + overhead + out-of-scope). */
  ledgerTokens: number;
  /** rawTokens − ledgerTokens; non-zero means the books do not balance. */
  mismatchTokens: number;
  ok: boolean;
}

/** Everything a command needs, assembled once per invocation. */
export interface CliContext {
  repoRoot: string;
  config: RepoConfig;
  /** Effective plan: --plan flag wins over vibebill.config.json. */
  plan: PlanId | null;
  flags: GlobalFlags;
  prices: { table: PriceTable; origin: 'bundled' | 'refreshed'; path: string };
  /** Full commit enumeration (HEAD or --all-refs), newest first. */
  commits: CommitInfo[];
  commitByHash: Map<string, CommitInfo>;
  newestCommitAuthorTs: number | null;
  ingest: IngestResult;
  rows: LedgerRow[];
  /** Maps an absolute path to repo-relative, or null when outside the repo. */
  toRepoRelative: (absPath: string) => string | null;
  /** Config + pricing + unknown-model warnings (printed on stderr, echoed in --json). */
  warnings: string[];
}

/** Cache directory inside the repo (spec §3 filesystem discipline). */
export function cacheDirFor(repoRoot: string): string {
  return path.join(repoRoot, '.vibebill', 'cache');
}

/** Instantiate the configured source adapters (all four by default). */
export function makeAdapters(ids: readonly AgentId[], repoRoot: string): SourceAdapter[] {
  return ids.map((id) => {
    switch (id) {
      case 'claude-code':
        return createClaudeCodeAdapter();
      case 'codex':
        return createCodexAdapter();
      case 'gemini-cli':
        return createGeminiCliAdapter();
      case 'aider':
        return createAiderAdapter({ repoRoot });
    }
  });
}

/**
 * Best-effort path canonicalizer: realpath when the path exists, else the
 * nearest existing ancestor's realpath rejoined with the remainder (deleted
 * files under a symlinked root — e.g. /tmp on macOS — still normalize).
 */
function makeCanonicalizer(): (p: string) => string {
  const memo = new Map<string, string>();
  const canon = (p: string): string => {
    const hit = memo.get(p);
    if (hit !== undefined) return hit;
    let out: string;
    try {
      out = realpathSync(p);
    } catch {
      const dir = path.dirname(p);
      out = dir === p ? p : path.join(canon(dir), path.basename(p));
    }
    memo.set(p, out);
    return out;
  };
  return canon;
}

/** Build the absolute→repo-relative mapper used by attribution (spec §5.3.4). */
export function makeRepoRelativizer(repoRoot: string): (absPath: string) => string | null {
  const canon = makeCanonicalizer();
  const root = canon(path.resolve(repoRoot));
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return (absPath: string): string | null => {
    const p = canon(path.resolve(absPath));
    return p.startsWith(prefix) ? p.slice(prefix.length) : null;
  };
}

/**
 * Runtime accounting check (spec §5.4 Step D + S12): conservation over the
 * ledger AND an independent comparison of the ledger's bucket sum against raw
 * ingest totals, so dropped entries are caught, not just mislabeled ones.
 */
export function checkAccounting(rows: readonly LedgerRow[], ingest: IngestResult): AccountingCheck {
  const entries = rows.map((r) => r.entry);
  const conservation = checkConservation(entries, ingest.outOfScope.tokens);
  let rawTokens = ingest.outOfScope.tokens;
  for (const event of ingest.events) rawTokens += totalTokens(event.tokens);
  const ledgerTokens =
    conservation.attributed + conservation.waste + conservation.overhead + conservation.outOfScope;
  const mismatchTokens = rawTokens - ledgerTokens;
  return { conservation, rawTokens, ledgerTokens, mismatchTokens, ok: mismatchTokens === 0 };
}

/** True when ts falls inside the --since/--until display window. */
export function inWindow(ts: number, flags: Pick<GlobalFlags, 'since' | 'until'>): boolean {
  if (flags.since !== null && ts < flags.since) return false;
  if (flags.until !== null && ts > flags.until) return false;
  return true;
}

/** Rows whose event timestamp falls inside the --since/--until window. */
export function scopedRows(ctx: CliContext): LedgerRow[] {
  if (ctx.flags.since === null && ctx.flags.until === null) return ctx.rows;
  return ctx.rows.filter((r) => inWindow(r.entry.event.ts, ctx.flags));
}

/** Sum token counts across rows. */
export function sumTokens(rows: Iterable<LedgerRow>): TokenCounts {
  let t: TokenCounts = { ...ZERO_TOKENS };
  for (const r of rows) t = addTokenCounts(t, r.entry.event.tokens);
  return t;
}

/**
 * Resolve a `A..B` revision range to the set of commit hashes it contains
 * (anything `git rev-list` accepts); the CommitInfo list preserves ctx order.
 */
export async function resolveCommitScope(
  ctx: CliContext,
  range: string,
): Promise<{ hashes: Set<string>; commits: CommitInfo[] }> {
  const hashes = new Set(await revList(ctx.repoRoot, range));
  const commits = ctx.commits.filter((c) => hashes.has(c.hash));
  return { hashes, commits };
}

/**
 * Build the full CliContext: resolve repo, load config+prices, ingest all
 * configured adapters (cached), enumerate commits, attribute and price every
 * event. Throws CliUserError when the environment cannot support a report.
 */
export async function buildContext(
  flags: GlobalFlags,
  opts?: { cwd?: string },
): Promise<CliContext> {
  const repoRoot = await resolveRepoRoot(opts?.cwd ?? process.cwd());
  const config = await loadRepoConfig(repoRoot);
  const warnings: string[] = [...config.warnings];

  const prices = loadEffectivePrices();
  warnings.push(...prices.warnings);

  const adapters = makeAdapters(config.adapters, repoRoot);
  const [ingest, commits] = await Promise.all([
    ingestEvents({ repoRoot, adapters, cacheDir: cacheDirFor(repoRoot) }),
    enumerateCommits(repoRoot, { allRefs: flags.allRefs }),
  ]);

  if (ingest.stats.filesFound === 0) {
    throw new CliUserError(
      'No agent transcripts found for any configured adapter (claude-code, codex, gemini-cli, aider).',
      'If your logs live elsewhere set VIBEBILL_CLAUDE_DIR / VIBEBILL_CODEX_DIR / VIBEBILL_GEMINI_DIR. Run `vibebill doctor` for a full check.',
    );
  }

  let newestCommitAuthorTs: number | null = null;
  const commitByHash = new Map<string, CommitInfo>();
  for (const commit of commits) {
    commitByHash.set(commit.hash, commit);
    if (newestCommitAuthorTs === null || commit.authorTs > newestCommitAuthorTs) {
      newestCommitAuthorTs = commit.authorTs;
    }
  }

  const toRepoRelative = makeRepoRelativizer(repoRoot);
  const attributed = attributeEvents(ingest.events, commits, config.attribution, {
    nowMs: flags.nowMs,
    toRepoRelative,
  });

  const rows: LedgerRow[] = ingest.events.map((event, i) => {
    const a = attributed[i];
    if (a === undefined) {
      // attributeEvents returns an array parallel to its input; this is unreachable.
      throw new Error('attribution result shorter than event list');
    }
    const entry: LedgerEntry = {
      event,
      attribution: a.attribution,
      cost: priceTokens(prices.table, event.model, event.tokens),
      provenance: provenanceFor(a),
    };
    return {
      entry,
      explain: a.explain,
      inProgress: isInProgress(event, a.attribution, newestCommitAuthorTs),
    };
  });

  // Aggregated unknown-model warning, once per distinct model (spec §1.6, §5.5).
  const unknown = new Map<string, { events: number; tokens: number }>();
  for (const row of rows) {
    if (row.entry.cost !== null) continue;
    const m = row.entry.event.model;
    const cur = unknown.get(m) ?? { events: 0, tokens: 0 };
    cur.events += 1;
    cur.tokens += totalTokens(row.entry.event.tokens);
    unknown.set(m, cur);
  }
  for (const [model, tally] of [...unknown.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    warnings.push(
      `unknown model ${JSON.stringify(model)} — ${tally.events} events, ${tally.tokens} tokens shown unpriced ($—); ` +
        'try --refresh-pricing or contribute a price-table PR',
    );
  }

  return {
    repoRoot,
    config,
    plan: flags.plan ?? config.plan,
    flags,
    prices: { table: prices.table, origin: prices.origin, path: prices.path },
    commits,
    commitByHash,
    newestCommitAuthorTs,
    ingest,
    rows,
    toRepoRelative,
    warnings,
  };
}
