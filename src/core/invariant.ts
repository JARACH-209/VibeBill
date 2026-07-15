/**
 * Token conservation invariant (spec §1.3): every parsed token lands in exactly one
 * bucket — total == attributed + waste + overhead + out_of_scope. Pure, zero I/O.
 */

import type { LedgerEntry } from './types.js';
import { totalTokens } from './types.js';

/** Bucket totals plus the delta; ok is false whenever the books do not balance. */
export interface ConservationReport {
  ok: boolean;
  totalTokens: number;
  attributed: number;
  waste: number;
  overhead: number;
  outOfScope: number;
  deltaTokens: number;
}

/**
 * Sums ledger buckets plus the ingest-time out-of-scope tally and reports whether they
 * equal the total token count (spec §5.4 Step D — checked at runtime, every command).
 */
export function checkConservation(
  entries: LedgerEntry[],
  outOfScopeTokens: number,
): ConservationReport {
  let attributed = 0;
  let waste = 0;
  let overhead = 0;
  let outOfScope = outOfScopeTokens;
  let total = outOfScopeTokens;

  for (const entry of entries) {
    const t = totalTokens(entry.event.tokens);
    total += t;
    switch (entry.attribution.kind) {
      case 'commit':
        attributed += t;
        break;
      case 'waste':
        waste += t;
        break;
      case 'overhead':
        overhead += t;
        break;
      case 'out_of_scope':
        outOfScope += t;
        break;
      // No default: the union is exhaustive in TS, but a corrupted kind arriving at
      // runtime (e.g. from a stale cache) leaves its tokens unbucketed so the delta
      // reports the imbalance loudly instead of hiding it (spec §1.3).
    }
  }

  const deltaTokens = total - (attributed + waste + overhead + outOfScope);
  return {
    ok: deltaTokens === 0,
    totalTokens: total,
    attributed,
    waste,
    overhead,
    outOfScope,
    deltaTokens,
  };
}
