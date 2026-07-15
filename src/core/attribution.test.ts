/**
 * Exhaustive unit tests for the attribution engine (spec §5.4) — pure function, so
 * everything here is deterministic in-memory fixtures, no I/O.
 */

import { describe, expect, it } from 'vitest';

import {
  attributeEvents,
  isInProgress,
  provenanceFor,
  type AttributedEvent,
} from './attribution.js';
import { checkConservation } from './invariant.js';
import type {
  Attribution,
  AttributionConfidence,
  CommitInfo,
  LedgerEntry,
  TokenCounts,
  UsageEvent,
} from './types.js';
import { DEFAULT_ATTRIBUTION_CONFIG, totalTokens } from './types.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 0, 1); // fixed epoch for all fixtures
const HORIZON = DEFAULT_ATTRIBUTION_CONFIG.horizonDays * DAY; // 14 days
const GRACE = DEFAULT_ATTRIBUTION_CONFIG.graceSeconds * 1000; // 120 s
const W = DEFAULT_ATTRIBUTION_CONFIG.weights;

const REPO = '/repo';
const toRel = (p: string): string | null =>
  p.startsWith(`${REPO}/`) ? p.slice(REPO.length + 1) : null;
const abs = (p: string): string => `${REPO}/${p}`;

const TOKENS: TokenCounts = { input: 100, output: 50, cacheWrite: 10, cacheRead: 20 };

function ev(over: Partial<UsageEvent> & { id: string; ts: number }): UsageEvent {
  return {
    agent: 'claude-code',
    sessionId: 's1',
    model: 'claude-opus-4-8',
    tokens: { ...TOKENS },
    cwd: REPO,
    gitBranch: null,
    editedFiles: [],
    isSidechain: false,
    sourceFile: '/logs/s1.jsonl',
    ...over,
  };
}

/** Edit event editing repo-relative `files` (converted to absolute paths). */
function edit(
  id: string,
  ts: number,
  files: string[],
  over?: Partial<UsageEvent>,
): UsageEvent {
  return ev({ id, ts, editedFiles: files.map(abs), ...over });
}

function commit(over: Partial<CommitInfo> & { hash: string; authorTs: number }): CommitInfo {
  return {
    parents: ['deadbeef'],
    subject: 'test commit',
    branchHint: null,
    files: [],
    insertions: 1,
    deletions: 0,
    isMerge: false,
    ...over,
  };
}

function run(
  events: UsageEvent[],
  commits: CommitInfo[],
  nowMs: number = T0 + 60 * DAY,
): AttributedEvent[] {
  return attributeEvents(events, commits, DEFAULT_ATTRIBUTION_CONFIG, {
    nowMs,
    toRepoRelative: toRel,
  });
}

function asCommit(r: AttributedEvent): Extract<Attribution, { kind: 'commit' }> {
  if (r.attribution.kind !== 'commit') {
    throw new Error(`expected kind 'commit', got '${r.attribution.kind}'`);
  }
  return r.attribution;
}

function at(rs: AttributedEvent[], i: number): AttributedEvent {
  const r = rs[i];
  if (!r) throw new Error(`no result at index ${i}`);
  return r;
}

describe('Step A — scoring and candidate window', () => {
  it('attributes a single edit event to the single matching commit with exact scores (S1 shape)', () => {
    const e = edit('e1', T0, ['src/a.ts'], { gitBranch: 'main' });
    const c = commit({
      hash: 'c1',
      authorTs: T0 + 7 * DAY, // exactly half the horizon
      files: ['src/a.ts'],
      branchHint: 'main',
    });
    const [r] = run([e], [c]);
    const a = asCommit(at([r as AttributedEvent], 0));
    expect(a.hash).toBe('c1');
    expect(a.confidence).toBe('high');
    const ex = (r as AttributedEvent).explain;
    expect(ex).not.toBeNull();
    expect(ex?.fileScore).toBe(1);
    expect(ex?.timeScore).toBe(0.5);
    expect(ex?.branchScore).toBe(1);
    expect(ex?.score).toBeCloseTo(W.file * 1 + W.time * 0.5 + W.branch * 1, 12);
    expect(provenanceFor(r as AttributedEvent)).toBe('measured');
  });

  it('excludes commits more than grace before the event', () => {
    const e = edit('e1', T0, ['src/a.ts']);
    const c = commit({ hash: 'c1', authorTs: T0 - GRACE - 1, files: ['src/a.ts'] });
    const [r] = run([e], [c]);
    expect((r as AttributedEvent).attribution).toEqual({ kind: 'waste' });
  });

  it('includes a commit exactly grace before the event (window inclusive) with clamped timeScore', () => {
    const e = edit('e1', T0, ['src/a.ts']);
    const c = commit({ hash: 'c1', authorTs: T0 - GRACE, files: ['src/a.ts'] });
    const [r] = run([e], [c]);
    expect(asCommit(at([r as AttributedEvent], 0)).hash).toBe('c1');
    expect((r as AttributedEvent).explain?.timeScore).toBe(1); // clamped to the declared [0,1]
  });

  it('includes a commit exactly at the horizon with timeScore 0', () => {
    const e = edit('e1', T0, ['src/a.ts']);
    const c = commit({ hash: 'c1', authorTs: T0 + HORIZON, files: ['src/a.ts'] });
    const [r] = run([e], [c]);
    expect(asCommit(at([r as AttributedEvent], 0)).hash).toBe('c1');
    expect((r as AttributedEvent).explain?.timeScore).toBe(0);
  });

  it('excludes commits past the horizon (event becomes waste, no fallback outside window)', () => {
    const e = edit('e1', T0, ['src/a.ts']);
    const c = commit({ hash: 'c1', authorTs: T0 + HORIZON + 1, files: ['src/a.ts'] });
    const [r] = run([e], [c]);
    expect((r as AttributedEvent).attribution).toEqual({ kind: 'waste' });
  });

  it('grace window edge: event 1 second after its commit still matches (spec §7.9)', () => {
    const c = commit({ hash: 'cg', authorTs: T0, files: ['src/f1.ts'] });
    const e = edit('e1', T0 + 1000, ['src/f1.ts']);
    const [r] = run([e], [c]);
    const a = asCommit(at([r as AttributedEvent], 0));
    expect(a.hash).toBe('cg');
    expect(a.confidence).toBe('high');
    expect((r as AttributedEvent).explain?.timeScore).toBe(1); // raw value > 1, clamped
  });

  it('grace window edge: event exactly grace after the commit matches; one ms past does not', () => {
    const c = commit({ hash: 'cg', authorTs: T0, files: ['src/f1.ts'] });
    const [rAt] = run([edit('e1', T0 + GRACE, ['src/f1.ts'])], [c]);
    expect(asCommit(at([rAt as AttributedEvent], 0)).hash).toBe('cg');
    const [rPast] = run([edit('e2', T0 + GRACE + 1, ['src/f1.ts'])], [c]);
    expect((rPast as AttributedEvent).attribution).toEqual({ kind: 'waste' });
  });

  it('fileScore uses set semantics over edited paths', () => {
    // Same file edited twice + one other file => 2 unique paths, 1 matched => 0.5.
    const e = ev({
      id: 'e1',
      ts: T0,
      editedFiles: [abs('src/a.ts'), abs('src/a.ts'), abs('src/b.ts')],
    });
    const c = commit({ hash: 'c1', authorTs: T0 + HOUR, files: ['src/a.ts'] });
    const [r] = run([e], [c]);
    expect((r as AttributedEvent).explain?.fileScore).toBe(0.5);
    expect(asCommit(at([r as AttributedEvent], 0)).confidence).toBe('medium');
  });

  it('drops edited paths outside the repo from file matching', () => {
    const e = ev({ id: 'e1', ts: T0, editedFiles: [abs('src/a.ts'), '/elsewhere/x.ts'] });
    const c = commit({ hash: 'c1', authorTs: T0 + HOUR, files: ['src/a.ts'] });
    const [r] = run([e], [c]);
    expect((r as AttributedEvent).explain?.fileScore).toBe(1);
    expect(asCommit(at([r as AttributedEvent], 0)).confidence).toBe('high');
  });

  it('merge commits are never attribution targets even with matching files (spec §7.5)', () => {
    const e = edit('e1', T0, ['src/a.ts']);
    const merge = commit({
      hash: 'm1',
      authorTs: T0 + 10 * MIN,
      parents: ['p1', 'p2'],
      isMerge: true,
      files: ['src/a.ts'], // defensive: git layer sets [], engine must not care
    });
    const [rWaste] = run([e], [merge]);
    expect((rWaste as AttributedEvent).attribution).toEqual({ kind: 'waste' });

    const normal = commit({ hash: 'n1', authorTs: T0 + 20 * MIN, files: ['src/a.ts'] });
    const [rNormal] = run([e], [merge, normal]);
    expect(asCommit(at([rNormal as AttributedEvent], 0)).hash).toBe('n1');
  });

  it('defensively excludes commits with multiple parents even when isMerge is false', () => {
    const e = edit('e1', T0, ['src/a.ts']);
    const sneaky = commit({
      hash: 'm2',
      authorTs: T0 + 10 * MIN,
      parents: ['p1', 'p2'],
      isMerge: false,
      files: ['src/a.ts'],
    });
    const [r] = run([e], [sneaky]);
    expect((r as AttributedEvent).attribution).toEqual({ kind: 'waste' });
  });

  it('squash-merge shape: squash commit receives the branch session edits (S5 shape)', () => {
    const e0 = ev({ id: 'e0', ts: T0 - 5 * MIN, sessionId: 'feat-sess', gitBranch: 'feat' });
    const e1 = edit('e1', T0, ['src/a.ts'], { sessionId: 'feat-sess', gitBranch: 'feat' });
    const e2 = edit('e2', T0 + 10 * MIN, ['src/b.ts'], {
      sessionId: 'feat-sess',
      gitBranch: 'feat',
    });
    const squash = commit({
      hash: 'squash1',
      authorTs: T0 + HOUR,
      files: ['src/a.ts', 'src/b.ts'],
      branchHint: 'main', // squash commit lands on main; branch mismatch must not block
    });
    const rs = run([e0, e1, e2], [squash]);
    for (const i of [0, 1, 2]) {
      const a = asCommit(at(rs, i));
      expect(a.hash).toBe('squash1');
      expect(a.confidence).toBe('high'); // fileScore 1, single positive candidate
    }
    expect(at(rs, 0).explain?.adoptedFromEventId).toBe('e1');
  });
});

describe('branch scoring', () => {
  const cases: Array<{
    name: string;
    eventBranch: string | null;
    hint: string | null;
    expected: number;
  }> = [
    { name: '1 when both known and equal', eventBranch: 'main', hint: 'main', expected: 1 },
    { name: '0.5 when the event branch is null', eventBranch: null, hint: 'main', expected: 0.5 },
    { name: '0.5 when the commit hint is null', eventBranch: 'main', hint: null, expected: 0.5 },
    { name: '0 when both known and different', eventBranch: 'feat', hint: 'main', expected: 0 },
  ];
  for (const tc of cases) {
    it(tc.name, () => {
      const e = edit('e1', T0, ['src/a.ts'], { gitBranch: tc.eventBranch });
      const c = commit({
        hash: 'c1',
        authorTs: T0 + HOUR,
        files: ['src/a.ts'],
        branchHint: tc.hint,
      });
      const [r] = run([e], [c]);
      expect((r as AttributedEvent).explain?.branchScore).toBe(tc.expected);
    });
  }

  it('routes interleaved same-file events to the right branch commits (S3 shape)', () => {
    const ea = edit('ea', T0, ['src/shared.ts'], { sessionId: 'sa', gitBranch: 'feat-a' });
    const eb = edit('eb', T0 + MIN, ['src/shared.ts'], { sessionId: 'sb', gitBranch: 'feat-b' });
    const ca = commit({
      hash: 'ca',
      authorTs: T0 + 30 * MIN,
      files: ['src/shared.ts'],
      branchHint: 'feat-a',
    });
    const cb = commit({
      hash: 'cb',
      authorTs: T0 + 31 * MIN,
      files: ['src/shared.ts'],
      branchHint: 'feat-b',
    });
    const rs = run([ea, eb], [ca, cb]);
    const aa = asCommit(at(rs, 0));
    const ab = asCommit(at(rs, 1));
    expect(aa.hash).toBe('ca'); // zero cross-contamination
    expect(ab.hash).toBe('cb');
    expect(aa.confidence).toBe('high'); // fileScore 1 + branch match
    expect(ab.confidence).toBe('high');
  });
});

describe('confidence rules', () => {
  it('high when fileScore >= 0.8 and branch matches, even with several positive candidates', () => {
    const e = edit('e1', T0, ['src/a.ts'], { gitBranch: 'feat' });
    const c1 = commit({
      hash: 'c1',
      authorTs: T0 + 10 * MIN,
      files: ['src/a.ts'],
      branchHint: 'feat',
    });
    const c2 = commit({ hash: 'c2', authorTs: T0 + 20 * MIN, files: ['src/a.ts'] });
    const [r] = run([e], [c1, c2]);
    const a = asCommit(at([r as AttributedEvent], 0));
    expect(a.hash).toBe('c1');
    expect(a.confidence).toBe('high');
  });

  it('high when fileScore >= 0.8 and exactly one candidate had fileScore > 0 (branch unknown)', () => {
    const e = edit('e1', T0, ['src/a.ts']);
    const c1 = commit({ hash: 'c1', authorTs: T0 + 10 * MIN, files: ['src/a.ts'] });
    const c2 = commit({ hash: 'c2', authorTs: T0 + 20 * MIN, files: ['src/other.ts'] });
    const [r] = run([e], [c1, c2]);
    expect(asCommit(at([r as AttributedEvent], 0)).confidence).toBe('high');
  });

  it('medium when fileScore is 1 but two candidates matched and no branch confirmation', () => {
    const e = edit('e1', T0, ['src/a.ts']);
    const c1 = commit({ hash: 'c1', authorTs: T0 + 10 * MIN, files: ['src/a.ts'] });
    const c2 = commit({ hash: 'c2', authorTs: T0 + 20 * MIN, files: ['src/a.ts'] });
    const [r] = run([e], [c1, c2]);
    const a = asCommit(at([r as AttributedEvent], 0));
    expect(a.hash).toBe('c1'); // closer in time wins
    expect(a.confidence).toBe('medium');
  });

  it('boundary: fileScore exactly 0.8 (4 of 5 files) is high with a single candidate', () => {
    const files = ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts'];
    const e = edit('e1', T0, files);
    const c = commit({ hash: 'c1', authorTs: T0 + HOUR, files: files.slice(0, 4) });
    const [r] = run([e], [c]);
    expect((r as AttributedEvent).explain?.fileScore).toBe(0.8);
    expect(asCommit(at([r as AttributedEvent], 0)).confidence).toBe('high');
  });

  it('boundary: fileScore exactly 0.4 (2 of 5 files) is medium', () => {
    const files = ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts', 'f5.ts'];
    const e = edit('e1', T0, files);
    const c = commit({ hash: 'c1', authorTs: T0 + HOUR, files: files.slice(0, 2) });
    const [r] = run([e], [c]);
    expect((r as AttributedEvent).explain?.fileScore).toBe(0.4);
    expect(asCommit(at([r as AttributedEvent], 0)).confidence).toBe('medium');
  });

  it('low when fileScore is positive but below 0.4', () => {
    const files = ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts'];
    const e = edit('e1', T0, files);
    const c = commit({ hash: 'c1', authorTs: T0 + HOUR, files: ['f1.ts'] });
    const [r] = run([e], [c]);
    expect((r as AttributedEvent).explain?.fileScore).toBe(0.25);
    expect(asCommit(at([r as AttributedEvent], 0)).confidence).toBe('low');
    // Positive fileScore is a real (if weak) measurement — not advisory.
    expect(provenanceFor(r as AttributedEvent)).toBe('measured');
  });
});

describe('tie-breaking determinism', () => {
  it('equal score and equal authorTs: lexicographically smallest hash wins', () => {
    const e = edit('e1', T0, ['src/a.ts']);
    const cB = commit({ hash: 'bbbbbb', authorTs: T0 + 10 * MIN, files: ['src/a.ts'] });
    const cA = commit({ hash: 'aaaaaa', authorTs: T0 + 10 * MIN, files: ['src/a.ts'] });
    // Pass in non-sorted order to prove input order does not matter.
    const [r1] = run([e], [cB, cA]);
    const [r2] = run([e], [cA, cB]);
    expect(asCommit(at([r1 as AttributedEvent], 0)).hash).toBe('aaaaaa');
    expect(asCommit(at([r2 as AttributedEvent], 0)).hash).toBe('aaaaaa');
  });

  it('equal score via clamped timeScore: smallest authorTs(C) - e.ts wins (literal spec rule)', () => {
    // Both commits are before the event within grace, so both timeScores clamp to 1 and
    // the scores tie exactly. The spec breaks ties by smallest authorTs(C) - e.ts:
    // -60s < -30s, so the EARLIER commit wins.
    const e = edit('e1', T0, ['src/a.ts']);
    const early = commit({ hash: 'early1', authorTs: T0 - 60_000, files: ['src/a.ts'] });
    const late = commit({ hash: 'late1', authorTs: T0 - 30_000, files: ['src/a.ts'] });
    const [r] = run([e], [late, early]);
    expect(asCommit(at([r as AttributedEvent], 0)).hash).toBe('early1');
  });

  it('same inputs produce deep-equal outputs across runs', () => {
    const events = [
      ev({ id: 'n0', ts: T0, sessionId: 'sX' }),
      edit('e1', T0 + MIN, ['src/a.ts'], { sessionId: 'sX' }),
      ev({ id: 'n2', ts: T0 + 2 * MIN, sessionId: 'sX' }),
      edit('e3', T0 + 3 * MIN, ['nowhere.ts'], { sessionId: 'sX' }),
      ev({ id: 'z0', ts: T0, sessionId: 'sY' }),
    ];
    const commits = [
      commit({ hash: 'c1', authorTs: T0 + 10 * MIN, files: ['src/a.ts'] }),
      commit({ hash: 'c2', authorTs: T0 + 20 * MIN, files: ['src/b.ts'] }),
    ];
    expect(run(events, commits)).toStrictEqual(run(events, commits));
  });
});

describe('pure-time fallback', () => {
  it('falls back to the next commit at-or-after the event when no candidate matches on files', () => {
    const e = edit('e1', T0, ['src/zed.ts']);
    const c = commit({ hash: 'c1', authorTs: T0 + HOUR, files: ['src/other.ts'] });
    const [r] = run([e], [c]);
    const a = asCommit(at([r as AttributedEvent], 0));
    expect(a.hash).toBe('c1');
    expect(a.confidence).toBe('low'); // fallback is always low
    expect((r as AttributedEvent).explain?.fileScore).toBe(0);
    expect(provenanceFor(r as AttributedEvent)).toBe('advisory'); // and always advisory
  });

  it('prefers the next commit on the event branch over a sooner commit on another branch', () => {
    const e = edit('e1', T0, ['src/zed.ts'], { gitBranch: 'feat' });
    const cMain = commit({
      hash: 'cmain',
      authorTs: T0 + 10 * MIN,
      files: ['a.ts'],
      branchHint: 'main',
    });
    const cFeat = commit({
      hash: 'cfeat',
      authorTs: T0 + 30 * MIN,
      files: ['b.ts'],
      branchHint: 'feat',
    });
    const [r] = run([e], [cMain, cFeat]);
    const a = asCommit(at([r as AttributedEvent], 0));
    expect(a.hash).toBe('cfeat');
    expect(a.confidence).toBe('low');
    expect((r as AttributedEvent).explain?.branchScore).toBe(1);
  });

  it('uses the nearest next commit when no same-branch candidate follows the event', () => {
    const e = edit('e1', T0, ['src/zed.ts'], { gitBranch: 'feat' });
    const cMain = commit({
      hash: 'cmain',
      authorTs: T0 + 10 * MIN,
      files: ['a.ts'],
      branchHint: 'main',
    });
    const [r] = run([e], [cMain]);
    expect(asCommit(at([r as AttributedEvent], 0)).hash).toBe('cmain');
  });

  it('uses the nearest next commit when the event has no branch', () => {
    const e = edit('e1', T0, ['src/zed.ts']);
    const c1 = commit({ hash: 'c1', authorTs: T0 + 10 * MIN, files: ['a.ts'], branchHint: 'x' });
    const c2 = commit({ hash: 'c2', authorTs: T0 + 20 * MIN, files: ['b.ts'], branchHint: 'y' });
    const [r] = run([e], [c1, c2]);
    expect(asCommit(at([r as AttributedEvent], 0)).hash).toBe('c1');
  });

  it('does not fall back to a commit before the event (must be at-or-after)', () => {
    const e = edit('e1', T0, ['src/zed.ts']);
    // Within grace before the event: a candidate, but not a fallback target.
    const c = commit({ hash: 'cb4', authorTs: T0 - MIN, files: ['a.ts'] });
    const [r] = run([e], [c]);
    expect((r as AttributedEvent).attribution).toEqual({ kind: 'waste' });
  });

  it('never fires when any candidate has fileScore > 0, however weak or distant', () => {
    const e = edit('e1', T0, ['f1.ts', 'f2.ts', 'f3.ts', 'f4.ts']);
    const near = commit({ hash: 'near1', authorTs: T0 + MIN, files: ['unrelated.ts'] });
    const far = commit({ hash: 'far1', authorTs: T0 + 10 * DAY, files: ['f1.ts'] });
    const [r] = run([e], [near, far]);
    const a = asCommit(at([r as AttributedEvent], 0));
    expect(a.hash).toBe('far1'); // the only positive-fileScore candidate
    expect(a.confidence).toBe('low'); // 0.25 < 0.4
    expect(provenanceFor(r as AttributedEvent)).toBe('measured');
  });
});

describe('Step B — waste and the in-progress render bucket', () => {
  it('unmatched edits are waste once the newest commit is past the horizon (S4 shape)', () => {
    const e = edit('e1', T0, ['src/lost.ts']);
    const newer = commit({
      hash: 'cnew',
      authorTs: T0 + HORIZON + DAY,
      files: ['src/other.ts'],
    });
    const [r] = run([e], [newer]);
    expect((r as AttributedEvent).attribution).toEqual({ kind: 'waste' });
    expect((r as AttributedEvent).explain).toBeNull();
    // Newest commit is newer than the event: definitively abandoned, not in progress.
    expect(isInProgress(e, (r as AttributedEvent).attribution, newer.authorTs)).toBe(false);
    // Waste is a measured fact (tokens really spent, really never landed).
    expect(provenanceFor(r as AttributedEvent)).toBe('measured');
  });

  it('unmatched edits newer than every commit are waste in storage, in-progress at render (S13)', () => {
    const old = commit({ hash: 'cold', authorTs: T0 - DAY, files: ['src/other.ts'] });
    const e = edit('e1', T0, ['src/wip.ts']);
    // Horizon has NOT elapsed: nowMs is one hour after the event.
    const [r] = run([e], [old], T0 + HOUR);
    expect((r as AttributedEvent).attribution).toEqual({ kind: 'waste' });
    expect(isInProgress(e, (r as AttributedEvent).attribution, old.authorTs)).toBe(true);
  });

  it('isInProgress is true for waste when the repo has no commits at all', () => {
    const e = edit('e1', T0, ['src/wip.ts']);
    const [r] = run([e], []);
    expect((r as AttributedEvent).attribution).toEqual({ kind: 'waste' });
    expect(isInProgress(e, (r as AttributedEvent).attribution, null)).toBe(true);
  });

  it('isInProgress is false for every non-waste kind', () => {
    const e = ev({ id: 'e1', ts: T0 });
    expect(isInProgress(e, { kind: 'commit', hash: 'c', confidence: 'high' }, null)).toBe(false);
    expect(isInProgress(e, { kind: 'overhead' }, null)).toBe(false);
    expect(isInProgress(e, { kind: 'out_of_scope' }, null)).toBe(false);
    expect(isInProgress(e, { kind: 'waste' }, T0 + 1)).toBe(false); // commit newer than event
    expect(isInProgress(e, { kind: 'waste' }, T0 - 1)).toBe(true);
  });

  it('nowMs does not change stored kinds (attribution is clock-independent)', () => {
    const events = [
      edit('e1', T0, ['src/wip.ts']),
      ev({ id: 'n1', ts: T0 + MIN }),
      edit('e2', T0 + 2 * MIN, ['src/a.ts']),
    ];
    const commits = [commit({ hash: 'c1', authorTs: T0 + HOUR, files: ['src/a.ts'] })];
    const soon = run(events, commits, T0 + HOUR);
    const later = run(events, commits, T0 + 100 * DAY);
    expect(soon).toStrictEqual(later);
  });
});

describe('Step C — sessions, forward/backward attach, overhead', () => {
  it('splits one session across three commits with forward-attach (S2 shape)', () => {
    const S = 'sess2';
    const events = [
      ev({ id: 'e0', ts: T0, sessionId: S }),
      edit('e1', T0 + 10 * MIN, ['src/f1.ts'], { sessionId: S }),
      ev({ id: 'e2', ts: T0 + 20 * MIN, sessionId: S }),
      edit('e3', T0 + 30 * MIN, ['src/f2.ts'], { sessionId: S }),
      ev({ id: 'e4', ts: T0 + 40 * MIN, sessionId: S }),
      edit('e5', T0 + 50 * MIN, ['src/f3.ts'], { sessionId: S }),
      ev({ id: 'e6', ts: T0 + 60 * MIN, sessionId: S }),
    ];
    const commits = [
      commit({ hash: 'c1', authorTs: T0 + 15 * MIN, files: ['src/f1.ts'] }),
      commit({ hash: 'c2', authorTs: T0 + 35 * MIN, files: ['src/f2.ts'] }),
      commit({ hash: 'c3', authorTs: T0 + 55 * MIN, files: ['src/f3.ts'] }),
    ];
    const rs = run(events, commits);
    const expected: Array<[hash: string, adoptedFrom: string | undefined]> = [
      ['c1', 'e1'], // e0 forward-attaches to next edit e1
      ['c1', undefined],
      ['c2', 'e3'], // e2 forward-attaches to e3
      ['c2', undefined],
      ['c3', 'e5'], // e4 forward-attaches to e5
      ['c3', undefined],
      ['c3', 'e5'], // e6 trails the last edit: backward-attach to e5
    ];
    expected.forEach(([hash, adoptedFrom], i) => {
      const r = at(rs, i);
      const a = asCommit(r);
      expect(a.hash).toBe(hash);
      expect(a.confidence).toBe('high'); // adopted events keep the edit event's confidence
      expect(r.explain?.adoptedFromEventId).toBe(adoptedFrom);
      expect(provenanceFor(r)).toBe('measured');
    });
    // Adopted explain carries the source edit event's scores.
    expect(at(rs, 0).explain?.fileScore).toBe(at(rs, 1).explain?.fileScore);
    expect(at(rs, 0).explain?.score).toBe(at(rs, 1).explain?.score);
  });

  it('sessions with zero edit events are pure overhead (advisory)', () => {
    const events = [
      ev({ id: 'n1', ts: T0, sessionId: 'chat' }),
      ev({ id: 'n2', ts: T0 + MIN, sessionId: 'chat' }),
    ];
    const commits = [commit({ hash: 'c1', authorTs: T0 + 10 * MIN, files: ['src/a.ts'] })];
    const rs = run(events, commits);
    for (const i of [0, 1]) {
      expect(at(rs, i).attribution).toEqual({ kind: 'overhead' });
      expect(at(rs, i).explain).toBeNull();
      expect(provenanceFor(at(rs, i))).toBe('advisory');
    }
  });

  it('never adopts across sessions: a zero-edit session stays overhead next to an editing one', () => {
    const events = [
      ev({ id: 'chat1', ts: T0, sessionId: 'chat' }),
      edit('work1', T0 + MIN, ['src/a.ts'], { sessionId: 'work' }),
      ev({ id: 'chat2', ts: T0 + 2 * MIN, sessionId: 'chat' }),
    ];
    const commits = [commit({ hash: 'c1', authorTs: T0 + 10 * MIN, files: ['src/a.ts'] })];
    const rs = run(events, commits);
    expect(at(rs, 0).attribution).toEqual({ kind: 'overhead' });
    expect(asCommit(at(rs, 1)).hash).toBe('c1');
    expect(at(rs, 2).attribution).toEqual({ kind: 'overhead' });
  });

  it('an edit event whose files all map outside the repo behaves as a non-edit event', () => {
    const events = [
      ev({ id: 'x1', ts: T0, sessionId: 'S', editedFiles: ['/elsewhere/notes.md'] }),
      edit('x2', T0 + MIN, ['src/a.ts'], { sessionId: 'S' }),
    ];
    const commits = [commit({ hash: 'c1', authorTs: T0 + 10 * MIN, files: ['src/a.ts'] })];
    const rs = run(events, commits);
    const a = asCommit(at(rs, 0));
    expect(a.hash).toBe('c1');
    expect(at(rs, 0).explain?.adoptedFromEventId).toBe('x2');
  });

  it('a session whose only "edits" map outside the repo is overhead', () => {
    const events = [ev({ id: 'x1', ts: T0, editedFiles: ['/elsewhere/notes.md'] })];
    const commits = [commit({ hash: 'c1', authorTs: T0 + 10 * MIN, files: ['src/a.ts'] })];
    const rs = run(events, commits);
    expect(at(rs, 0).attribution).toEqual({ kind: 'overhead' });
  });

  it('events adopting from an advisory (fallback) edit event are advisory too', () => {
    const events = [
      ev({ id: 'n0', ts: T0 - MIN, sessionId: 'S' }),
      edit('e1', T0, ['src/zed.ts'], { sessionId: 'S' }), // no file match anywhere
    ];
    const commits = [commit({ hash: 'c1', authorTs: T0 + HOUR, files: ['src/other.ts'] })];
    const rs = run(events, commits);
    const adopted = at(rs, 0);
    const a = asCommit(adopted);
    expect(a.hash).toBe('c1');
    expect(a.confidence).toBe('low');
    expect(adopted.explain?.fileScore).toBe(0);
    expect(adopted.explain?.adoptedFromEventId).toBe('e1');
    expect(provenanceFor(adopted)).toBe('advisory');
    expect(provenanceFor(at(rs, 1))).toBe('advisory');
  });

  it('events adopting from a waste edit event become waste with null explain (measured)', () => {
    const events = [
      ev({ id: 'n0', ts: T0 - MIN, sessionId: 'S' }),
      edit('e1', T0, ['src/zed.ts'], { sessionId: 'S' }),
      ev({ id: 'n2', ts: T0 + MIN, sessionId: 'S' }),
    ];
    const rs = run(events, []); // no commits at all
    for (const i of [0, 1, 2]) {
      expect(at(rs, i).attribution).toEqual({ kind: 'waste' });
      expect(at(rs, i).explain).toBeNull();
      expect(provenanceFor(at(rs, i))).toBe('measured');
      expect(isInProgress(events[i] as UsageEvent, at(rs, i).attribution, null)).toBe(true);
    }
  });

  it('orders same-timestamp events by id when deciding next/previous edit', () => {
    const S = 'stie';
    const cA = commit({ hash: 'cA', authorTs: T0 + 10 * MIN, files: ['src/fA.ts'] });
    const cB = commit({ hash: 'cB', authorTs: T0 + 40 * MIN, files: ['src/fB.ts'] });
    const events = [
      ev({ id: 'a', ts: T0, sessionId: S }), // sorts before edit 'b' -> adopts from 'b'
      edit('b', T0, ['src/fA.ts'], { sessionId: S }),
      ev({ id: 'c', ts: T0, sessionId: S }), // sorts after edit 'b' -> next edit is 'd'
      edit('d', T0 + 30 * MIN, ['src/fB.ts'], { sessionId: S }),
    ];
    const rs = run(events, [cA, cB]);
    expect(asCommit(at(rs, 0)).hash).toBe('cA');
    expect(at(rs, 0).explain?.adoptedFromEventId).toBe('b');
    expect(asCommit(at(rs, 2)).hash).toBe('cB');
    expect(at(rs, 2).explain?.adoptedFromEventId).toBe('d');
  });
});

describe('empty inputs and input order', () => {
  it('returns [] for no events', () => {
    expect(run([], [commit({ hash: 'c1', authorTs: T0 })])).toStrictEqual([]);
  });

  it('with an empty commit list everything is waste or overhead per the session rules', () => {
    const events = [
      edit('e1', T0, ['src/a.ts'], { sessionId: 'editing' }),
      ev({ id: 'n1', ts: T0 + MIN, sessionId: 'editing' }),
      ev({ id: 'n2', ts: T0, sessionId: 'chatting' }),
    ];
    const rs = run(events, []);
    expect(at(rs, 0).attribution).toEqual({ kind: 'waste' });
    expect(at(rs, 1).attribution).toEqual({ kind: 'waste' }); // adopts session's edit
    expect(at(rs, 2).attribution).toEqual({ kind: 'overhead' });
    expect(rs.every((r) => r.attribution.kind !== 'commit')).toBe(true);
  });

  it('results are parallel to input order even when events arrive unsorted', () => {
    const S = 'sess2';
    const sorted = [
      ev({ id: 'e0', ts: T0, sessionId: S }),
      edit('e1', T0 + 10 * MIN, ['src/f1.ts'], { sessionId: S }),
      edit('e3', T0 + 30 * MIN, ['src/f2.ts'], { sessionId: S }),
      ev({ id: 'e6', ts: T0 + 60 * MIN, sessionId: S }),
    ];
    const commits = [
      commit({ hash: 'c1', authorTs: T0 + 15 * MIN, files: ['src/f1.ts'] }),
      commit({ hash: 'c2', authorTs: T0 + 35 * MIN, files: ['src/f2.ts'] }),
    ];
    const expectById: Record<string, string> = { e0: 'c1', e1: 'c1', e3: 'c2', e6: 'c2' };
    const shuffled = [sorted[2], sorted[0], sorted[3], sorted[1]] as UsageEvent[];
    const rs = run(shuffled, commits);
    shuffled.forEach((e, i) => {
      expect(asCommit(at(rs, i)).hash).toBe(expectById[e.id]);
    });
  });
});

describe('conservation property over randomized inputs (seeded)', () => {
  /** Deterministic PRNG (mulberry32) so failures are reproducible. */
  function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const FILE_POOL = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'lib/d.ts', 'lib/e.ts'];
  const BRANCH_POOL = [null, 'main', 'feat'];

  it('buckets always sum for 300 random cases, and attribution is deterministic', () => {
    const rnd = mulberry32(0xc0ffee);
    const int = (n: number): number => Math.floor(rnd() * n);
    const pick = <T>(arr: readonly T[]): T => arr[int(arr.length)] as T;

    for (let iter = 0; iter < 300; iter++) {
      const commits: CommitInfo[] = [];
      const nCommits = int(7);
      for (let i = 0; i < nCommits; i++) {
        const isMerge = rnd() < 0.15;
        commits.push(
          commit({
            hash: `h${iter}-${i}`,
            authorTs: T0 + int(30 * DAY),
            files: FILE_POOL.filter(() => rnd() < 0.4),
            isMerge,
            parents: isMerge ? ['p1', 'p2'] : ['p1'],
            branchHint: pick(BRANCH_POOL),
          }),
        );
      }

      const events: UsageEvent[] = [];
      const nSessions = 1 + int(3);
      for (let s = 0; s < nSessions; s++) {
        const nEvents = int(8);
        for (let j = 0; j < nEvents; j++) {
          const editedFiles: string[] = [];
          if (rnd() >= 0.45) {
            const k = 1 + int(3);
            for (let f = 0; f < k; f++) editedFiles.push(abs(pick(FILE_POOL)));
            if (rnd() < 0.2) editedFiles.push('/outside/q.ts');
          }
          events.push(
            ev({
              id: `it${iter}-s${s}-e${j}`,
              ts: T0 + int(30 * DAY),
              sessionId: `it${iter}-s${s}`,
              gitBranch: pick(BRANCH_POOL),
              editedFiles,
              tokens: {
                input: int(500),
                output: int(500),
                cacheWrite: int(100),
                cacheRead: int(1000),
              },
            }),
          );
        }
      }

      const nowMs = T0 + 60 * DAY;
      const rs = run(events, commits, nowMs);
      expect(rs).toHaveLength(events.length);
      // Determinism: same inputs twice => deep-equal outputs.
      expect(run(events, commits, nowMs)).toStrictEqual(rs);

      const targetHashes = new Set(
        commits.filter((c) => !c.isMerge).map((c) => c.hash),
      );
      const entries: LedgerEntry[] = events.map((e, i) => {
        const r = at(rs, i);
        if (r.attribution.kind === 'commit') {
          expect(targetHashes.has(r.attribution.hash)).toBe(true);
          expect(r.explain).not.toBeNull();
          const ex = r.explain;
          if (ex) {
            for (const v of [ex.fileScore, ex.timeScore, ex.branchScore]) {
              expect(v).toBeGreaterThanOrEqual(0);
              expect(v).toBeLessThanOrEqual(1);
            }
          }
        } else {
          expect(['waste', 'overhead']).toContain(r.attribution.kind);
          expect(r.explain).toBeNull();
        }
        return { event: e, attribution: r.attribution, cost: null, provenance: provenanceFor(r) };
      });

      const outOfScopeTokens = int(1000);
      const report = checkConservation(entries, outOfScopeTokens);
      expect(report.ok).toBe(true);
      expect(report.deltaTokens).toBe(0);
      const manualTotal =
        events.reduce((acc, e) => acc + totalTokens(e.tokens), 0) + outOfScopeTokens;
      expect(report.totalTokens).toBe(manualTotal);
      expect(report.attributed + report.waste + report.overhead + report.outOfScope).toBe(
        manualTotal,
      );
    }
  });
});

describe('provenanceFor', () => {
  const base = (attribution: Attribution, explain: AttributedEvent['explain']): AttributedEvent => ({
    attribution,
    explain,
  });
  const ex = (fileScore: number) => ({ fileScore, timeScore: 0.5, branchScore: 0.5, score: 0.5 });

  it('labels overhead advisory', () => {
    expect(provenanceFor(base({ kind: 'overhead' }, null))).toBe('advisory');
  });
  it('labels pure-time fallback (commit with fileScore 0) advisory', () => {
    expect(
      provenanceFor(base({ kind: 'commit', hash: 'c', confidence: 'low' }, ex(0))),
    ).toBe('advisory');
  });
  it('labels file-matched commits measured regardless of confidence', () => {
    for (const confidence of ['high', 'medium', 'low'] as AttributionConfidence[]) {
      expect(
        provenanceFor(base({ kind: 'commit', hash: 'c', confidence }, ex(0.25))),
      ).toBe('measured');
    }
  });
  it('labels waste and out_of_scope measured', () => {
    expect(provenanceFor(base({ kind: 'waste' }, null))).toBe('measured');
    expect(provenanceFor(base({ kind: 'out_of_scope' }, null))).toBe('measured');
  });
});
