/**
 * Domain model for vibebill (spec §4). All timestamps are UTC epoch milliseconds.
 * All token counts are `number` (< 2^53). All money is `bigint` nano-USD (spec §8).
 */

/** Source adapter identifiers. v0.1 shipped claude-code; v0.2 adds the rest. */
export type AgentId = 'claude-code' | 'codex' | 'gemini-cli' | 'aider';

export const ALL_AGENT_IDS: readonly AgentId[] = ['claude-code', 'codex', 'gemini-cli', 'aider'];

/** Per-call token counts by billing class. */
export interface TokenCounts {
  /** Non-cached input tokens. */
  input: number;
  output: number;
  /** cache_creation_input_tokens (0 for providers that don't bill cache writes). */
  cacheWrite: number;
  /** cache_read_input_tokens / cached_input_tokens. */
  cacheRead: number;
}

/** One priced API call record parsed from an agent transcript. The atomic unit. */
export interface UsageEvent {
  /** Stable dedupe key, adapter-defined (spec §5.1.4). */
  id: string;
  agent: AgentId;
  sessionId: string;
  /** UTC ms. */
  ts: number;
  /** Raw model string from the log, e.g. "claude-opus-4-8". */
  model: string;
  tokens: TokenCounts;
  /** Absolute path if present in the record. */
  cwd: string | null;
  gitBranch: string | null;
  /** Absolute paths from edit tool calls in this message; [] if none. */
  editedFiles: string[];
  /** Subagent traffic; attributed like normal traffic, reported as "subagents". */
  isSidechain: boolean;
  /** Transcript path (for doctor/debugging only). */
  sourceFile: string;
}

/** A commit as vibebill sees it. */
export interface CommitInfo {
  hash: string;
  parents: string[];
  /** Author date, UTC ms — preserved by rebase (committer date is not); spec §7.6. */
  authorTs: number;
  subject: string;
  /** Best-effort: from `git log --source` when walking refs. */
  branchHint: string | null;
  /** Repo-root-relative paths changed (merge commits: [] — spec §7.5). */
  files: string[];
  insertions: number;
  deletions: number;
  isMerge: boolean;
}

export type AttributionConfidence = 'high' | 'medium' | 'low';

/** Result of attribution for one UsageEvent. */
export type Attribution =
  | { kind: 'commit'; hash: string; confidence: AttributionConfidence }
  | { kind: 'waste' } // edits that never landed in any commit within horizon
  | { kind: 'overhead' } // session had zero edit events; advisory bucket
  | { kind: 'out_of_scope' }; // event belongs to a different repo / filtered out

export type Provenance = 'measured' | 'repriced' | 'advisory';

/** All bigint nano-USD. */
export interface MoneyBreakdown {
  input: bigint;
  output: bigint;
  cacheWrite: bigint;
  cacheRead: bigint;
  total: bigint;
}

/** Priced, attributed event — the row everything else aggregates. */
export interface LedgerEntry {
  event: UsageEvent;
  attribution: Attribution;
  /** null when model is unpriced. */
  cost: MoneyBreakdown | null;
  provenance: Provenance;
}

/** Per-file parse statistics reported by adapters. */
export interface FileParseStats {
  path: string;
  linesRead: number;
  eventsExtracted: number;
  linesSkipped: number;
  /** Byte offset consumed up to the last complete line (for incremental resume). */
  bytesConsumed: number;
}

/** Aggregated parse statistics across an ingest run. */
export interface ParseStats {
  filesFound: number;
  filesRead: number;
  filesSkipped: number;
  linesRead: number;
  eventsExtracted: number;
  linesSkipped: number;
  duplicatesRemoved: number;
}

/** Source adapter interface (spec §5.1.5). Adapters are read-only over transcript dirs. */
export interface SourceAdapter {
  id: AgentId;
  /**
   * True when the field mapping was verified against real transcripts on a
   * developer machine; false means "implemented against documented format only"
   * and `vibebill doctor` must surface parse coverage prominently.
   */
  schemaVerified: boolean;
  /** Transcript file paths, deterministic order. */
  discover(): Promise<string[]>;
  /**
   * Stream-parse one file; emit UsageEvents into sink. Never throws on bad data.
   * opts.startOffset resumes at a byte offset previously reported as bytesConsumed
   * (callers guarantee it was a line boundary; adapters re-parse from 0 if unsure).
   */
  parseFile(
    path: string,
    sink: (e: UsageEvent) => void,
    opts?: { startOffset?: number },
  ): Promise<FileParseStats>;
}

/** Attribution engine configuration (spec §5.4). */
export interface AttributionConfig {
  horizonDays: number;
  graceSeconds: number;
  weights: { file: number; time: number; branch: number };
}

export const DEFAULT_ATTRIBUTION_CONFIG: AttributionConfig = {
  horizonDays: 14,
  graceSeconds: 120,
  weights: { file: 0.6, time: 0.25, branch: 0.15 },
};

/** Subscription plan ids — affect wording only, never math (spec §5.5). */
export type PlanId = 'pro' | 'max5' | 'max20';

export const ZERO_TOKENS: TokenCounts = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };

export function addTokenCounts(a: TokenCounts, b: TokenCounts): TokenCounts {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    cacheRead: a.cacheRead + b.cacheRead,
  };
}

export function totalTokens(t: TokenCounts): number {
  return t.input + t.output + t.cacheWrite + t.cacheRead;
}
