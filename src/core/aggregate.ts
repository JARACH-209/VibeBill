/**
 * On-demand aggregations over LedgerEntry[] (spec §4: no denormalized aggregate storage).
 * Pure functions, zero I/O.
 */

import { addMoney, ZERO_MONEY } from '../pricing/money.js';
import type {
  AttributionConfidence,
  LedgerEntry,
  MoneyBreakdown,
  TokenCounts,
} from './types.js';
import { addTokenCounts, totalTokens, ZERO_TOKENS } from './types.js';

/** One rollup of entries: measured cost plus honest unpriced-token accounting. */
export interface Rollup {
  events: number;
  tokens: TokenCounts;
  /** Sum over entries with a price; unpriced tokens are NOT silently costed. */
  cost: MoneyBreakdown;
  unpricedEvents: number;
  unpricedTokens: TokenCounts;
  sessions: Set<string>;
  models: Set<string>;
  /** Subagent (sidechain) share, reported separately in breakdowns. */
  subagentTokens: number;
  subagentCost: MoneyBreakdown;
  minTs: number | null;
  maxTs: number | null;
}

export function emptyRollup(): Rollup {
  return {
    events: 0,
    tokens: { ...ZERO_TOKENS },
    cost: { ...ZERO_MONEY },
    unpricedEvents: 0,
    unpricedTokens: { ...ZERO_TOKENS },
    sessions: new Set(),
    models: new Set(),
    subagentTokens: 0,
    subagentCost: { ...ZERO_MONEY },
    minTs: null,
    maxTs: null,
  };
}

export function addToRollup(r: Rollup, entry: LedgerEntry): void {
  const e = entry.event;
  r.events += 1;
  r.tokens = addTokenCounts(r.tokens, e.tokens);
  if (entry.cost === null) {
    r.unpricedEvents += 1;
    r.unpricedTokens = addTokenCounts(r.unpricedTokens, e.tokens);
  } else {
    r.cost = addMoney(r.cost, entry.cost);
    if (e.isSidechain) r.subagentCost = addMoney(r.subagentCost, entry.cost);
  }
  if (e.isSidechain) r.subagentTokens += totalTokens(e.tokens);
  r.sessions.add(e.sessionId);
  r.models.add(e.model);
  r.minTs = r.minTs === null ? e.ts : Math.min(r.minTs, e.ts);
  r.maxTs = r.maxTs === null ? e.ts : Math.max(r.maxTs, e.ts);
}

export function rollup(entries: Iterable<LedgerEntry>): Rollup {
  const r = emptyRollup();
  for (const entry of entries) addToRollup(r, entry);
  return r;
}

function groupBy(entries: Iterable<LedgerEntry>, key: (e: LedgerEntry) => string | null): Map<string, Rollup> {
  const out = new Map<string, Rollup>();
  for (const entry of entries) {
    const k = key(entry);
    if (k === null) continue;
    let r = out.get(k);
    if (!r) {
      r = emptyRollup();
      out.set(k, r);
    }
    addToRollup(r, entry);
  }
  return out;
}

/** Rollup per attributed commit hash (entries with kind 'commit' only). */
export function byCommit(entries: Iterable<LedgerEntry>): Map<string, Rollup> {
  return groupBy(entries, (e) => (e.attribution.kind === 'commit' ? e.attribution.hash : null));
}

export function byModel(entries: Iterable<LedgerEntry>): Map<string, Rollup> {
  return groupBy(entries, (e) => e.event.model);
}

export function bySession(entries: Iterable<LedgerEntry>): Map<string, Rollup> {
  return groupBy(entries, (e) => e.event.sessionId);
}

/** Bucket rollups for the conservation report and summary lines. */
export interface BucketRollups {
  attributed: Rollup;
  waste: Rollup;
  overhead: Rollup;
  outOfScope: Rollup;
}

export function byBucket(entries: Iterable<LedgerEntry>): BucketRollups {
  const b: BucketRollups = {
    attributed: emptyRollup(),
    waste: emptyRollup(),
    overhead: emptyRollup(),
    outOfScope: emptyRollup(),
  };
  for (const entry of entries) {
    switch (entry.attribution.kind) {
      case 'commit':
        addToRollup(b.attributed, entry);
        break;
      case 'waste':
        addToRollup(b.waste, entry);
        break;
      case 'overhead':
        addToRollup(b.overhead, entry);
        break;
      case 'out_of_scope':
        addToRollup(b.outOfScope, entry);
        break;
    }
  }
  return b;
}

/** Unknown-model tally for the aggregated unpriced warning (spec §5.5). */
export function unpricedByModel(entries: Iterable<LedgerEntry>): Map<string, { events: number; tokens: TokenCounts }> {
  const out = new Map<string, { events: number; tokens: TokenCounts }>();
  for (const entry of entries) {
    if (entry.cost !== null) continue;
    const m = entry.event.model;
    const cur = out.get(m) ?? { events: 0, tokens: { ...ZERO_TOKENS } };
    cur.events += 1;
    cur.tokens = addTokenCounts(cur.tokens, entry.event.tokens);
    out.set(m, cur);
  }
  return out;
}

const CONFIDENCE_ORDER: AttributionConfidence[] = ['high', 'medium', 'low'];

/**
 * Token-weighted dominant confidence for one commit's entries; ties resolve to the
 * LOWER confidence (honest degradation).
 */
export function dominantConfidence(entries: Iterable<LedgerEntry>): AttributionConfidence {
  const weights: Record<AttributionConfidence, number> = { high: 0, medium: 0, low: 0 };
  for (const entry of entries) {
    if (entry.attribution.kind === 'commit') {
      weights[entry.attribution.confidence] += totalTokens(entry.event.tokens);
    }
  }
  let best: AttributionConfidence = 'low';
  let bestWeight = -1;
  // Iterate low→high preference by scanning in reverse order so ties keep the lower level.
  for (const level of [...CONFIDENCE_ORDER].reverse()) {
    if (weights[level] > bestWeight) {
      best = level;
      bestWeight = weights[level];
    }
  }
  return best;
}

/** True when any entry in the scope was repriced (mixed provenance must be labeled). */
export function scopeProvenance(entries: Iterable<LedgerEntry>): {
  measured: number;
  repriced: number;
  advisory: number;
} {
  const p = { measured: 0, repriced: 0, advisory: 0 };
  for (const entry of entries) p[entry.provenance] += 1;
  return p;
}

/** Cache-efficiency line inputs (spec §6.2): savings = cacheRead × (inputPrice − cacheReadPrice). */
export function cacheSavings(
  entries: Iterable<LedgerEntry>,
  priceFor: (model: string) => { inputPerMTokNano: bigint; cacheReadPerMTokNano: bigint } | null,
): { cacheReadTokens: number; inputTokens: number; savedNano: bigint } {
  let cacheReadTokens = 0;
  let inputTokens = 0;
  let savedNano = 0n;
  for (const entry of entries) {
    const t = entry.event.tokens;
    cacheReadTokens += t.cacheRead;
    inputTokens += t.input;
    const p = priceFor(entry.event.model);
    if (p && p.inputPerMTokNano > p.cacheReadPerMTokNano) {
      savedNano +=
        (BigInt(t.cacheRead) * (p.inputPerMTokNano - p.cacheReadPerMTokNano)) / 1_000_000n;
    }
  }
  return { cacheReadTokens, inputTokens, savedNano };
}
