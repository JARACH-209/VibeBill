/**
 * Token-conservation property test (spec §11): 1000 seeded-PRNG randomized cases of
 * UsageEvents (edit/non-edit, multiple sessions, timestamps in and out of the horizon,
 * branches known/unknown) joined against randomized CommitInfo lists (varying files,
 * authorTs, merge commits), driven DIRECTLY through the pure engine functions
 * `attributeEvents` (spec §5.4) and `checkConservation` (spec §5.4 Step D / §1.3).
 *
 * Properties asserted for every case:
 *  (a) conservation — Σ tokens(events) + outOfScope == attributed + waste + overhead
 *      + out_of_scope, exactly, with LedgerEntries built with null cost;
 *  (b) structure — the attribution output array is parallel to the input, merge commits
 *      never receive attributions, and Step A/B/C session semantics hold per event;
 *  (c) determinism — regenerating and re-attributing the same case yields deep-equal
 *      results (attribution is a pure function of (events, commits, config)).
 *
 * The PRNG is mulberry32 with a fixed seed — no Math.random, no wall clock. Case sizes
 * are modest (≤ 40 events, ≤ 12 commits) to keep the whole file well under 30 s.
 */

import { describe, expect, it } from 'vitest';

import { attributeEvents, provenanceFor } from '../../src/core/attribution.js';
import { checkConservation } from '../../src/core/invariant.js';
import type {
  Attribution,
  AttributionConfig,
  CommitInfo,
  LedgerEntry,
  UsageEvent,
} from '../../src/core/types.js';
import { DEFAULT_ATTRIBUTION_CONFIG, totalTokens } from '../../src/core/types.js';

const CASES = 1000;
const MASTER_SEED = 0x51beb11;

const MS_PER_MIN = 60_000;
const MS_PER_DAY = 86_400_000;

/** Fixed anchor for all generated timestamps (never the wall clock). */
const BASE_TS = Date.UTC(2026, 0, 15, 0, 0, 0, 0);
/** Injected "now" for the engine (spec §5.4 determinism: no Date.now() inside). */
const NOW_MS = BASE_TS + 25 * MS_PER_DAY;

const REPO_ROOT = '/repo';
const REPO_FILES = [
  'src/a.ts',
  'src/b.ts',
  'src/c.ts',
  'lib/d.ts',
  'lib/util/e.ts',
  'README.md',
] as const;
/** Absolute paths OUTSIDE the repo: normalize to null, i.e. contribute no edit files. */
const OUTSIDE_FILES = ['/elsewhere/x.ts', '/other-repo/src/y.ts'] as const;
const BRANCHES = ['main', 'feat/one', 'fix/two'] as const;

/** The path mapper the engine receives (spec §5.4: rel() over editedFiles). */
function toRepoRelative(absPath: string): string | null {
  return absPath.startsWith(`${REPO_ROOT}/`) ? absPath.slice(REPO_ROOT.length + 1) : null;
}

const ENGINE_OPTS = { nowMs: NOW_MS, toRepoRelative } as const;

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32): deterministic across runs and platforms; used only
// to GENERATE inputs — the engine under test consumes no randomness at all.
// ---------------------------------------------------------------------------

type Rng = () => number;

function makeRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t = (t + Math.imul(t ^ (t >>> 7), t | 61)) ^ t;
    return (t ^ (t >>> 14)) >>> 0; // uint32
  };
}

/** Uniform-ish integer in [0, maxExclusive); modulo bias is irrelevant for tests. */
function nextInt(rng: Rng, maxExclusive: number): number {
  return rng() % maxExclusive;
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[nextInt(rng, arr.length)] as T;
}

/** Deterministic partial Fisher–Yates: n distinct picks from the pool. */
function sampleDistinct(rng: Rng, pool: readonly string[], n: number): string[] {
  const copy = pool.slice();
  const take = Math.min(n, copy.length);
  for (let i = 0; i < take; i++) {
    const j = i + nextInt(rng, copy.length - i);
    const tmp = copy[i] as string;
    copy[i] = copy[j] as string;
    copy[j] = tmp;
  }
  return copy.slice(0, take);
}

const HEX = '0123456789abcdef';

/** 40-char fake hash; the uniq prefix guarantees uniqueness within a case. */
function genHash(rng: Rng, uniq: number): string {
  let h = uniq.toString(16).padStart(4, '0');
  for (let i = 0; i < 36; i++) h += HEX[nextInt(rng, 16)] as string;
  return h;
}

// ---------------------------------------------------------------------------
// Case generator
// ---------------------------------------------------------------------------

interface GeneratedCase {
  events: UsageEvent[];
  commits: CommitInfo[];
  config: AttributionConfig;
  /** Ingest-time out-of-scope token tally fed to checkConservation. */
  outOfScopeTokens: number;
}

/** Timestamps: whole minutes within ±20 days of BASE_TS (in/out of every horizon). */
function genTs(rng: Rng): number {
  const spanMin = 20 * 24 * 60;
  return BASE_TS + (nextInt(rng, 2 * spanMin + 1) - spanMin) * MS_PER_MIN;
}

function genCase(seed: number, caseIdx: number): GeneratedCase {
  const rng = makeRng(seed);

  const config: AttributionConfig = {
    horizonDays: pick(rng, [2, 7, 14] as const),
    graceSeconds: pick(rng, [0, 120, 600] as const),
    weights: DEFAULT_ATTRIBUTION_CONFIG.weights,
  };

  // ---- commits: 0..12, ~1 in 5 a merge (files [] per spec §7.5, two parents) ----
  const commitCount = nextInt(rng, 13);
  const commits: CommitInfo[] = [];
  for (let c = 0; c < commitCount; c++) {
    const isMerge = nextInt(rng, 5) === 0;
    const hash = genHash(rng, c);
    commits.push({
      hash,
      parents: isMerge
        ? [genHash(rng, 100 + c), genHash(rng, 200 + c)]
        : c === 0
          ? []
          : [(commits[c - 1] as CommitInfo).hash],
      authorTs: genTs(rng),
      subject: `fixture commit ${c}`,
      branchHint: nextInt(rng, 10) < 3 ? null : pick(rng, BRANCHES),
      files: isMerge ? [] : sampleDistinct(rng, REPO_FILES, nextInt(rng, 5)),
      insertions: nextInt(rng, 200),
      deletions: nextInt(rng, 200),
      isMerge,
    });
  }
  // Input contract (spec §5.4): commits sorted by authorTs (hash tie-break for totality).
  commits.sort((a, b) => a.authorTs - b.authorTs || (a.hash < b.hash ? -1 : 1));

  // ---- events: 0..40 across 1..4 sessions ----
  const sessionCount = 1 + nextInt(rng, 4);
  const eventCount = nextInt(rng, 41);
  const events: UsageEvent[] = [];
  for (let i = 0; i < eventCount; i++) {
    // ~40% repo edits (sometimes plus an outside path), ~10% outside-only edits
    // (normalize to a NON-edit event), ~50% no edits at all.
    const roll = nextInt(rng, 10);
    let editedFiles: string[] = [];
    if (roll < 4) {
      editedFiles = sampleDistinct(rng, REPO_FILES, 1 + nextInt(rng, 3)).map(
        (f) => `${REPO_ROOT}/${f}`,
      );
      if (nextInt(rng, 5) === 0) editedFiles.push(pick(rng, OUTSIDE_FILES));
    } else if (roll === 4) {
      editedFiles = [pick(rng, OUTSIDE_FILES)];
    }
    const allZero = nextInt(rng, 10) === 0;
    const tok = (): number => (allZero ? 0 : nextInt(rng, 1_000_001));
    events.push({
      id: `case${caseIdx}-e${String(i).padStart(2, '0')}`,
      agent: 'claude-code',
      sessionId: `case${caseIdx}-s${nextInt(rng, sessionCount)}`,
      ts: genTs(rng),
      model: 'claude-opus-4-8',
      tokens: { input: tok(), output: tok(), cacheWrite: tok(), cacheRead: tok() },
      cwd: REPO_ROOT,
      gitBranch: nextInt(rng, 4) === 0 ? null : pick(rng, BRANCHES),
      editedFiles,
      isSidechain: nextInt(rng, 10) === 0,
      sourceFile: '/fixtures/transcript.jsonl',
    });
  }
  // Input contract (spec §5.4): events deduped (ids are unique) and sorted by ts.
  events.sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));

  return { events, commits, config, outOfScopeTokens: nextInt(rng, 1_000_001) };
}

// ---------------------------------------------------------------------------
// Test-side helpers (independent recomputation, no engine internals)
// ---------------------------------------------------------------------------

/** Repo-relative distinct edited-file count — an event is an EDIT event iff > 0. */
function relCount(e: UsageEvent): number {
  const s = new Set<string>();
  for (const p of e.editedFiles) {
    const rel = toRepoRelative(p);
    if (rel !== null) s.add(rel);
  }
  return s.size;
}

/** Structural identity key for an Attribution (key-order independent). */
function attrKey(a: Attribution): string {
  return a.kind === 'commit' ? `commit:${a.hash}:${a.confidence}` : a.kind;
}

// ---------------------------------------------------------------------------
// Properties
// ---------------------------------------------------------------------------

describe('token conservation property (spec §11, §5.4, §1.3)', () => {
  it(`(a) every token lands in exactly one bucket for ${CASES} random cases`, () => {
    const master = makeRng(MASTER_SEED);
    for (let i = 0; i < CASES; i++) {
      const seed = master();
      const { events, commits, config, outOfScopeTokens } = genCase(seed, i);
      const results = attributeEvents(events, commits, config, ENGINE_OPTS);

      // LedgerEntries with null cost (unpriced): conservation is about tokens, not money.
      const entries: LedgerEntry[] = events.map((event, j) => {
        const r = results[j];
        if (r === undefined) {
          expect.fail(`case ${i} (seed ${seed}): no attribution for event index ${j}`);
        }
        return { event, attribution: r.attribution, cost: null, provenance: provenanceFor(r) };
      });

      const report = checkConservation(entries, outOfScopeTokens);
      const eventTokens = events.reduce((sum, e) => sum + totalTokens(e.tokens), 0);
      const label =
        `case ${i} (seed ${seed}): ${events.length} events, ${commits.length} commits, ` +
        `horizon ${config.horizonDays}d, grace ${config.graceSeconds}s`;

      expect(report.ok, label).toBe(true);
      expect(report.deltaTokens, label).toBe(0);
      // Independent totals: Σ tokens(events) + outOfScope must equal the bucket sum.
      expect(report.totalTokens, label).toBe(eventTokens + outOfScopeTokens);
      expect(
        report.attributed + report.waste + report.overhead + report.outOfScope,
        label,
      ).toBe(eventTokens + outOfScopeTokens);
      // The engine never emits kind 'out_of_scope' — that bucket is exactly the
      // ingest-time tally, so Σ tokens(events) == attributed + waste + overhead.
      expect(report.outOfScope, label).toBe(outOfScopeTokens);
      expect(report.attributed + report.waste + report.overhead, label).toBe(eventTokens);
    }
  });

  it(`(b) output parallels input, merges never attributed, §5.4 session semantics (${CASES} cases)`, () => {
    const master = makeRng(MASTER_SEED);
    for (let i = 0; i < CASES; i++) {
      const seed = master();
      const { events, commits, config } = genCase(seed, i);
      const results = attributeEvents(events, commits, config, ENGINE_OPTS);
      const label = `case ${i} (seed ${seed})`;

      // Parallel to input: one result per event, in input order.
      expect(results.length, label).toBe(events.length);

      const nonMergeHashes = new Set(commits.filter((c) => !c.isMerge).map((c) => c.hash));
      const mergeHashes = new Set(commits.filter((c) => c.isMerge).map((c) => c.hash));

      // Per-session facts recomputed independently of the engine.
      const sessionHasEdit = new Map<string, boolean>();
      for (const e of events) {
        sessionHasEdit.set(
          e.sessionId,
          (sessionHasEdit.get(e.sessionId) ?? false) || relCount(e) > 0,
        );
      }
      const sessionEditAttrs = new Map<string, Set<string>>();
      for (let j = 0; j < events.length; j++) {
        const e = events[j] as UsageEvent;
        if (relCount(e) === 0) continue;
        const r = results[j];
        if (r === undefined) continue; // length mismatch already reported above
        let set = sessionEditAttrs.get(e.sessionId);
        if (!set) {
          set = new Set<string>();
          sessionEditAttrs.set(e.sessionId, set);
        }
        set.add(attrKey(r.attribution));
      }

      for (let j = 0; j < events.length; j++) {
        const e = events[j] as UsageEvent;
        const r = results[j];
        const elabel = `${label}, event ${e.id}`;
        if (r === undefined) {
          expect.fail(`${elabel}: missing attribution result at index ${j}`);
        }
        const a = r.attribution;

        if (a.kind === 'commit') {
          if (mergeHashes.has(a.hash)) {
            expect.fail(`${elabel}: attributed to MERGE commit ${a.hash} (spec §7.5 forbids)`);
          }
          if (!nonMergeHashes.has(a.hash)) {
            expect.fail(`${elabel}: attributed to unknown commit hash ${a.hash}`);
          }
          if (r.explain === null) {
            expect.fail(`${elabel}: kind 'commit' must carry a non-null explain`);
          }
        } else if (r.explain !== null) {
          expect.fail(`${elabel}: kind '${a.kind}' must carry a null explain`);
        }

        const isEdit = relCount(e) > 0;
        if (sessionHasEdit.get(e.sessionId) !== true) {
          // Step C: sessions with zero edit events — everything is overhead.
          if (a.kind !== 'overhead') {
            expect.fail(`${elabel}: zero-edit session must yield 'overhead', got '${a.kind}'`);
          }
        } else if (isEdit) {
          // Steps A/B: edit events resolve to a commit or to waste, never overhead.
          if (a.kind !== 'commit' && a.kind !== 'waste') {
            expect.fail(`${elabel}: edit event must be 'commit' or 'waste', got '${a.kind}'`);
          }
        } else {
          // Step C: non-edit events adopt an edit event's attribution from their session.
          const adoptable = sessionEditAttrs.get(e.sessionId) as Set<string>;
          if (!adoptable.has(attrKey(a))) {
            expect.fail(
              `${elabel}: non-edit event's attribution ${attrKey(a)} matches no edit ` +
                `event in its session (adoptable: ${[...adoptable].join(', ')})`,
            );
          }
        }
      }
    }
  });

  it(`(c) rerunning the same case yields deep-equal results (${CASES} cases)`, () => {
    const master = makeRng(MASTER_SEED);
    for (let i = 0; i < CASES; i++) {
      const seed = master();
      const first = genCase(seed, i);
      const r1 = attributeEvents(first.events, first.commits, first.config, ENGINE_OPTS);

      const second = genCase(seed, i);
      // Compared AFTER the first engine run: catches both generator instability
      // and any input mutation by the engine (it must be pure, spec §5.4).
      expect(first.events, `case ${i}: events mutated or generator unstable`).toEqual(
        second.events,
      );
      expect(first.commits, `case ${i}: commits mutated or generator unstable`).toEqual(
        second.commits,
      );

      const r2 = attributeEvents(second.events, second.commits, second.config, ENGINE_OPTS);
      expect(r2, `case ${i} (seed ${seed}): attribution is not deterministic`).toEqual(r1);
    }
  });
});
