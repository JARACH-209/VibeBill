/** Unit tests for the token conservation invariant (spec §1.3, §5.4 Step D). */

import { describe, expect, it } from 'vitest';

import { checkConservation } from './invariant.js';
import type { Attribution, LedgerEntry, TokenCounts, UsageEvent } from './types.js';
import { totalTokens } from './types.js';

let seq = 0;
function entry(attribution: Attribution, tokens: Partial<TokenCounts> = {}): LedgerEntry {
  seq++;
  const event: UsageEvent = {
    id: `inv-e${seq}`,
    agent: 'claude-code',
    sessionId: 'inv-s1',
    ts: Date.UTC(2026, 0, 1) + seq * 1000,
    model: 'claude-opus-4-8',
    tokens: { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, ...tokens },
    cwd: '/repo',
    gitBranch: null,
    editedFiles: [],
    isSidechain: false,
    sourceFile: '/logs/inv.jsonl',
  };
  return { event, attribution, cost: null, provenance: 'measured' };
}

describe('checkConservation', () => {
  it('balances the books across all four buckets plus the ingest tally', () => {
    const entries: LedgerEntry[] = [
      entry({ kind: 'commit', hash: 'c1', confidence: 'high' }, { input: 100, output: 50 }),
      entry({ kind: 'commit', hash: 'c2', confidence: 'low' }, { cacheWrite: 30, cacheRead: 700 }),
      entry({ kind: 'waste' }, { input: 11, output: 7 }),
      entry({ kind: 'overhead' }, { input: 5 }),
      entry({ kind: 'out_of_scope' }, { output: 9 }),
    ];
    const report = checkConservation(entries, 1000);
    expect(report.ok).toBe(true);
    expect(report.deltaTokens).toBe(0);
    expect(report.attributed).toBe(880); // 150 + 730
    expect(report.waste).toBe(18);
    expect(report.overhead).toBe(5);
    expect(report.outOfScope).toBe(1009); // 1000 ingest-time + 9 from the ledger entry
    expect(report.totalTokens).toBe(1912);
    const manual = entries.reduce((acc, en) => acc + totalTokens(en.event.tokens), 0) + 1000;
    expect(report.totalTokens).toBe(manual);
  });

  it('reports all-zero and ok for an empty ledger with no out-of-scope tokens', () => {
    expect(checkConservation([], 0)).toEqual({
      ok: true,
      totalTokens: 0,
      attributed: 0,
      waste: 0,
      overhead: 0,
      outOfScope: 0,
      deltaTokens: 0,
    });
  });

  it('counts a pure out-of-scope tally into both the total and the bucket', () => {
    const report = checkConservation([], 7);
    expect(report.ok).toBe(true);
    expect(report.totalTokens).toBe(7);
    expect(report.outOfScope).toBe(7);
  });

  it('reports the exact delta when an entry carries a corrupted kind (never hides it)', () => {
    const good = entry({ kind: 'waste' }, { input: 3 });
    const bad = entry({ kind: 'bogus' } as unknown as Attribution, { input: 40, output: 2 });
    const report = checkConservation([good, bad], 0);
    expect(report.ok).toBe(false);
    expect(report.deltaTokens).toBe(42); // the corrupted entry's tokens are unbucketed
    expect(report.totalTokens).toBe(45);
    expect(report.waste).toBe(3);
  });

  it('token classes all count toward the totals (input, output, cacheWrite, cacheRead)', () => {
    const report = checkConservation(
      [entry({ kind: 'overhead' }, { input: 1, output: 2, cacheWrite: 3, cacheRead: 4 })],
      0,
    );
    expect(report.overhead).toBe(10);
    expect(report.totalTokens).toBe(10);
    expect(report.ok).toBe(true);
  });
});
