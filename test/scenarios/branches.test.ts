/**
 * Scenarios S3 & S5 (spec §11) — branch attribution correctness, driven through
 * the real CLI (direct in-process invocation, permitted by §11) and asserted on
 * `--json` output (docs/json-schemas.md).
 *
 * S3 — two branches, interleaved sessions, same time window: file(+branch)
 *      scores must route every event to its own branch's commit with ZERO
 *      cross-contamination (`show --json` per commit must not even mention the
 *      other session's id).
 *
 *      Scope choice (assignment asks to document it): both branches are merged
 *      into main with true --no-ff merges and the CLI runs with the DEFAULT
 *      HEAD scope, because spec §5.3.1 declares HEAD-history attribution the
 *      primary use case (--all-refs is off by default). This also exercises
 *      §7.5 en passant: the two merge commits appear in `log` but are never
 *      attribution targets. Under HEAD enumeration commits carry no branchHint
 *      (%S sources exist only in --all-refs mode), so branchScore is the
 *      neutral 0.5 ("unknown ≠ mismatch", §5.4) for every candidate and the
 *      routing is carried entirely by fileScore — the evidence assertions pin
 *      exactly that down (fileScore 1, branchScore 0.5).
 *
 * S5 — feature branch squash-merged: the squash commit on main is a normal
 *      1-parent commit whose file list matches the session's edits, so Step A
 *      attributes the branch session to it naturally (§7.5) with file-match
 *      confidence — evidence fileScore > 0, provenance `measured`, and no
 *      pure-time-fallback `advisory` entries anywhere.
 *
 * Determinism: fixture repos pin author+committer dates and identity (helpers),
 * transcript timestamps derive from FIXTURE_EPOCH_MS, session ids are fixed,
 * and VIBEBILL_NOW is stubbed. All timings are minutes apart, well inside the
 * default horizon (14 d) / grace (120 s) windows of §5.4.
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { captureIO } from '../../src/cli/io.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';
import { FIXTURE_EPOCH_MS, session, writeTranscripts } from '../helpers/transcripts.js';

const MIN = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * claude-opus-4-8 in the bundled price table (prices/prices.json, asOf
 * 2026-07-14): input $5/MTok, output $25/MTok, cache write $6.25/MTok,
 * cache read $0.50/MTok. Exact nano-USD per token (spec §8):
 * nanoPerTok = dollarsPerMTok × 10^9 / 10^6.
 */
const NANO_PER_TOKEN = {
  input: 5000n,
  output: 25000n,
  cacheWrite: 6250n,
  cacheRead: 500n,
} as const;

/** Hand-computed bigint expectation for a token vector priced on claude-opus-4-8. */
function expectedNanoUsd(t: {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}): string {
  const total =
    BigInt(t.input) * NANO_PER_TOKEN.input +
    BigInt(t.output) * NANO_PER_TOKEN.output +
    BigInt(t.cacheWrite ?? 0) * NANO_PER_TOKEN.cacheWrite +
    BigInt(t.cacheRead ?? 0) * NANO_PER_TOKEN.cacheRead;
  return total.toString();
}

// ---- minimal --json shapes we assert on (docs/json-schemas.md) -------------

interface MoneyJson {
  nanoUsd: string;
  usd: string;
}

interface TokensJson {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}

interface InvariantJson {
  ok: boolean;
  totalTokens: number;
  attributed: number;
  waste: number;
  overhead: number;
  outOfScope: number;
  deltaTokens: number;
}

interface BreakdownJson {
  input: MoneyJson;
  output: MoneyJson;
  cacheWrite: MoneyJson;
  cacheRead: MoneyJson;
  total: MoneyJson;
}

interface ShowJson {
  command: string;
  invariant: InvariantJson;
  commit: {
    hash: string;
    subject: string | null;
    isMerge: boolean | null;
    files: string[];
    inEnumeratedHistory: boolean;
  };
  attributed: boolean;
  cost: BreakdownJson | null;
  tokens: TokensJson;
  events: number;
  confidence: string | null;
  provenance: { measured: number; advisory: number; repriced: number };
  sessions: Array<{
    sessionId: string;
    idPrefix: string;
    events: number;
    tokens: TokensJson;
    cost: MoneyJson;
  }>;
  byModel: Array<{ model: string; events: number; tokens: TokensJson; cost: MoneyJson | null }>;
  evidence: Array<{
    eventId: string;
    ts: string;
    editedFiles: number;
    matchedFiles: number;
    fileScore: number;
    timeScore: number;
    branchScore: number;
    score: number;
    confidence: string;
  }>;
  adoptedEvents: number;
  advisoryEvents: number;
  filesMatched: { matched: string[]; unmatched: string[] };
}

interface LogJson {
  invariant: InvariantJson;
  inProgress: unknown;
  commits: Array<{
    hash: string;
    subject: string;
    attributed: boolean;
    cost: MoneyJson | null;
    confidence: string | null;
    sessions: number;
    events: number;
  }>;
  totals: {
    attributedCost: MoneyJson;
    commitsShown: number;
    commitsCosted: number;
    waste: MoneyJson;
    overhead: MoneyJson;
    inProgress: MoneyJson;
  };
}

// ---- plumbing ---------------------------------------------------------------

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Drive the real CLI entry in-process from the fixture repo root (spec §11). */
async function runCli(repoRoot: string, args: string[]): Promise<CliRun> {
  const io = captureIO();
  const prevCwd = process.cwd();
  process.chdir(repoRoot);
  process.exitCode = 0;
  try {
    await buildProgram(io).parseAsync(['node', 'vibebill', ...args]);
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
    return { exitCode, stdout: io.stdout.join('\n'), stderr: io.stderr.join('\n') };
  } finally {
    process.exitCode = 0;
    process.chdir(prevCwd);
  }
}

/** Hermetic isolation: no host agent logs, no host refreshed prices, fixed clock. */
function stubHermeticEnv(opts: { claudeDir: string; configDir: string; nowMs: number }): void {
  vi.stubEnv('VIBEBILL_CLAUDE_DIR', opts.claudeDir);
  vi.stubEnv('VIBEBILL_CODEX_DIR', '/nonexistent');
  vi.stubEnv('VIBEBILL_GEMINI_DIR', '/nonexistent');
  vi.stubEnv('VIBEBILL_CONFIG_DIR', opts.configDir);
  vi.stubEnv('VIBEBILL_NOW', String(opts.nowMs));
}

/** Narrowing helper for noUncheckedIndexedAccess / nullable JSON fields. */
function req<T>(value: T | null | undefined, label: string): T {
  if (value === null || value === undefined) {
    throw new Error(`expected ${label} to be present`);
  }
  return value;
}

// =============================================================================
// S3 — two branches, interleaved sessions, same window
// =============================================================================

describe('S3 — two branches, interleaved sessions, same window (spec §11)', () => {
  const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

  const A1 = 'src/alpha/one.ts';
  const A2 = 'src/alpha/two.ts';
  const B1 = 'src/beta/one.ts';
  const B2 = 'src/beta/two.ts';

  // Interleaved in time: A 10:00 · B 10:05 · A 10:10 · B 10:15 · A 10:20 · B 10:25,
  // then commit A at 11:00 (feat-a), commit B at 11:05 (feat-b), merges at noon.
  const T_BASE = FIXTURE_EPOCH_MS;
  const T_A_EDIT1 = FIXTURE_EPOCH_MS + 10 * HOUR;
  const T_B_EDIT1 = FIXTURE_EPOCH_MS + 10 * HOUR + 5 * MIN;
  const T_A_EDIT2 = FIXTURE_EPOCH_MS + 10 * HOUR + 10 * MIN;
  const T_B_EDIT2 = FIXTURE_EPOCH_MS + 10 * HOUR + 15 * MIN;
  const T_A_PLAN = FIXTURE_EPOCH_MS + 10 * HOUR + 20 * MIN;
  const T_B_PLAN = FIXTURE_EPOCH_MS + 10 * HOUR + 25 * MIN;
  const T_COMMIT_A = FIXTURE_EPOCH_MS + 11 * HOUR;
  const T_COMMIT_B = FIXTURE_EPOCH_MS + 11 * HOUR + 5 * MIN;
  const T_MERGE_A = FIXTURE_EPOCH_MS + 12 * HOUR;
  const T_MERGE_B = FIXTURE_EPOCH_MS + 12 * HOUR + 5 * MIN;

  // Per-session fixture sums (input/output only; cache classes exercised in S5).
  const TOKENS_A: TokensJson = { input: 3300, output: 1300, cacheWrite: 0, cacheRead: 0, total: 4600 };
  const TOKENS_B: TokensJson = { input: 4400, output: 1550, cacheWrite: 0, cacheRead: 0, total: 5950 };
  const NANO_A = expectedNanoUsd(TOKENS_A); // 3300×5000 + 1300×25000 = 49_000_000
  const NANO_B = expectedNanoUsd(TOKENS_B); // 4400×5000 + 1550×25000 = 60_750_000

  let tmpDir: string;
  let repo: FixtureRepo;
  let commitA: string;
  let commitB: string;
  let mergeA: string;
  let mergeB: string;
  let baseHash: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibebill-s3-'));
    const claudeDir = path.join(tmpDir, 'claude');
    const configDir = path.join(tmpDir, 'config');
    await mkdir(configDir, { recursive: true });

    repo = await makeRepo(tmpDir);
    baseHash = await repo.commitFile('README.md', '# fixture\n', {
      authorDate: T_BASE,
      message: 'chore: base',
    });

    // Branch A commits fileset A; branch B commits fileset B; both fork from base.
    await repo.branch('feat-a');
    await repo.checkout('feat-a');
    commitA = await repo.commitFiles(
      [
        [A1, 'alpha one — session A\n'],
        [A2, 'alpha two — session A\n'],
      ],
      { authorDate: T_COMMIT_A, message: 'feat(alpha): implement alpha' },
    );
    await repo.checkout('main');
    await repo.branch('feat-b');
    await repo.checkout('feat-b');
    commitB = await repo.commitFiles(
      [
        [B1, 'beta one — session B\n'],
        [B2, 'beta two — session B\n'],
      ],
      { authorDate: T_COMMIT_B, message: 'feat(beta): implement beta' },
    );

    // Merge BOTH branches into HEAD so the default (primary, spec §5.3.1) HEAD
    // scope enumerates every branch commit; the --no-ff merge commits are never
    // attribution targets (§7.5).
    await repo.checkout('main');
    mergeA = await repo.merge('feat-a', { authorDate: T_MERGE_A });
    mergeB = await repo.merge('feat-b', { authorDate: T_MERGE_B });

    // Two sessions, each with gitBranch set, edits confined to its own fileset,
    // interleaved in the same hour. The third call of each session is a non-edit
    // (planning) event that must forward/backward-attach within its session (§5.4 C).
    const sessionA = session({ sessionId: SESSION_A, defaultCwd: repo.root, defaultBranch: 'feat-a' })
      .at(T_A_EDIT1)
      .call({ usage: { input: 1000, output: 500 }, edits: [path.join(repo.root, A1)] })
      .at(T_A_EDIT2)
      .call({ usage: { input: 2000, output: 700 }, edits: [path.join(repo.root, A2)] })
      .at(T_A_PLAN)
      .call({ usage: { input: 300, output: 100 } });
    const sessionB = session({ sessionId: SESSION_B, defaultCwd: repo.root, defaultBranch: 'feat-b' })
      .at(T_B_EDIT1)
      .call({ usage: { input: 1500, output: 600 }, edits: [path.join(repo.root, B1)] })
      .at(T_B_EDIT2)
      .call({ usage: { input: 2500, output: 800 }, edits: [path.join(repo.root, B2)] })
      .at(T_B_PLAN)
      .call({ usage: { input: 400, output: 150 } });
    await writeTranscripts(claudeDir, [sessionA, sessionB]);

    stubHermeticEnv({ claudeDir, configDir, nowMs: FIXTURE_EPOCH_MS + 30 * DAY });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(tmpDir, { recursive: true, force: true });
  });

  /** Both directions of the isolation claim share these assertions. */
  async function assertIsolation(opts: {
    hash: string;
    ownSession: string;
    otherSession: string;
    tokens: TokensJson;
    nanoUsd: string;
    files: string[];
    editTimestamps: number[];
  }): Promise<void> {
    const run = await runCli(repo.root, ['show', opts.hash, '--json']);
    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as ShowJson;

    // Zero cross-contamination: the other session's id (or even its 8-char
    // display prefix) must not appear ANYWHERE in the payload.
    expect(run.stdout).not.toContain(opts.otherSession);
    expect(run.stdout).not.toContain(opts.otherSession.slice(0, 8));

    // Exactly one contributing session — the branch's own — carrying the whole
    // session (3 events: 2 edits + 1 adopted planning event).
    expect(payload.attributed).toBe(true);
    expect(payload.sessions.map((s) => s.sessionId)).toEqual([opts.ownSession]);
    const own = req(payload.sessions[0], 'sessions[0]');
    expect(own.events).toBe(3);
    expect(own.tokens).toEqual(opts.tokens);
    expect(own.cost.nanoUsd).toBe(opts.nanoUsd);

    // The commit's cost is exactly the session's cost (hand-computed bigint).
    expect(payload.tokens).toEqual(opts.tokens);
    expect(payload.events).toBe(3);
    expect(req(payload.cost, 'cost').total.nanoUsd).toBe(opts.nanoUsd);
    expect(payload.byModel.map((m) => m.model)).toEqual(['claude-opus-4-8']);

    // All three events are measured file-matched attributions, dominant
    // confidence high (fileScore 1 and the only positive-fileScore candidate).
    expect(payload.confidence).toBe('high');
    expect(payload.provenance).toEqual({ measured: 3, advisory: 0, repriced: 0 });
    expect(payload.advisoryEvents).toBe(0);
    expect(payload.adoptedEvents).toBe(1); // the planning event (§5.4 Step C)

    // Evidence (§6.4 the "why"): two scored edit events; routing carried by
    // fileScore == 1 while branchScore is the neutral 0.5 (HEAD scope has no
    // branch hints; unknown ≠ mismatch — §5.4).
    expect(payload.evidence).toHaveLength(2);
    expect(payload.evidence.map((e) => e.ts)).toEqual(
      opts.editTimestamps.map((ts) => new Date(ts).toISOString()),
    );
    for (const ev of payload.evidence) {
      expect(ev.fileScore).toBe(1);
      expect(ev.branchScore).toBe(0.5);
      expect(ev.timeScore).toBeGreaterThan(0.9); // ~1 h before the commit, 14 d horizon
      expect(ev.timeScore).toBeLessThanOrEqual(1);
      expect(ev.matchedFiles).toBe(1);
      expect(ev.editedFiles).toBe(1);
      expect(ev.confidence).toBe('high');
    }

    // Every file in the commit is matched by the session's edits, none unmatched.
    expect(payload.commit.inEnumeratedHistory).toBe(true);
    expect(payload.commit.isMerge).toBe(false);
    expect([...payload.filesMatched.matched].sort()).toEqual(opts.files);
    expect(payload.filesMatched.unmatched).toEqual([]);

    // Invariant (§5.4 Step D): everything attributed, nothing in waste/overhead.
    expect(payload.invariant).toEqual({
      ok: true,
      totalTokens: TOKENS_A.total + TOKENS_B.total,
      attributed: TOKENS_A.total + TOKENS_B.total,
      waste: 0,
      overhead: 0,
      outOfScope: 0,
      deltaTokens: 0,
    });
  }

  it('attributes session A entirely to commit A — session B never appears (show --json)', async () => {
    await assertIsolation({
      hash: commitA,
      ownSession: SESSION_A,
      otherSession: SESSION_B,
      tokens: TOKENS_A,
      nanoUsd: NANO_A,
      files: [A1, A2],
      editTimestamps: [T_A_EDIT1, T_A_EDIT2],
    });
  });

  it('attributes session B entirely to commit B — session A never appears (show --json)', async () => {
    await assertIsolation({
      hash: commitB,
      ownSession: SESSION_B,
      otherSession: SESSION_A,
      tokens: TOKENS_B,
      nanoUsd: NANO_B,
      files: [B1, B2],
      editTimestamps: [T_B_EDIT1, T_B_EDIT2],
    });
  });

  it('log --json: each branch commit carries only its own cost; merges and base are uncosted; books balance', async () => {
    const run = await runCli(repo.root, ['log', '--json']);
    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as LogJson;

    const byHash = new Map(payload.commits.map((c) => [c.hash, c]));
    expect(byHash.size).toBe(5); // base, commitA, commitB, mergeA, mergeB

    const rowA = req(byHash.get(commitA), 'commit A row');
    expect(rowA.attributed).toBe(true);
    expect(req(rowA.cost, 'commit A cost').nanoUsd).toBe(NANO_A);
    expect(rowA.confidence).toBe('high');
    expect(rowA.sessions).toBe(1);
    expect(rowA.events).toBe(3);

    const rowB = req(byHash.get(commitB), 'commit B row');
    expect(rowB.attributed).toBe(true);
    expect(req(rowB.cost, 'commit B cost').nanoUsd).toBe(NANO_B);
    expect(rowB.confidence).toBe('high');
    expect(rowB.sessions).toBe(1);
    expect(rowB.events).toBe(3);

    // Merge commits are never attribution targets (§7.5): definitionally $0.
    for (const hash of [mergeA, mergeB, baseHash]) {
      const row = req(byHash.get(hash), `uncosted row ${hash}`);
      expect(row.attributed).toBe(false);
      expect(row.cost).toBeNull();
    }

    expect(payload.inProgress).toBeNull();
    expect(payload.totals.commitsCosted).toBe(2);
    expect(payload.totals.attributedCost.nanoUsd).toBe(
      (BigInt(NANO_A) + BigInt(NANO_B)).toString(),
    );
    expect(payload.totals.waste.nanoUsd).toBe('0');
    expect(payload.totals.overhead.nanoUsd).toBe('0');
    expect(payload.invariant.ok).toBe(true);
    expect(payload.invariant.deltaTokens).toBe(0);
  });
});

// =============================================================================
// S5 — feature branch squash-merged
// =============================================================================

describe('S5 — feature branch squash-merged (spec §11, §7.5)', () => {
  const SESSION_F = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

  const F1 = 'src/feature/f1.ts';
  const F2 = 'src/feature/f2.ts';

  const T_BASE = FIXTURE_EPOCH_MS;
  const T_EDIT1 = FIXTURE_EPOCH_MS + 9 * HOUR;
  const T_EDIT2 = FIXTURE_EPOCH_MS + 9 * HOUR + 10 * MIN;
  const T_PLAN = FIXTURE_EPOCH_MS + 9 * HOUR + 20 * MIN;
  const T_WIP = FIXTURE_EPOCH_MS + 9 * HOUR + 30 * MIN; // wip commit on the branch
  const T_SQUASH = FIXTURE_EPOCH_MS + 10 * HOUR; // squash commit on main

  // Session totals — cache classes included so the full breakdown is exercised.
  const TOKENS_F: TokensJson = {
    input: 2350, // 1200 + 900 + 250
    output: 780, // 400 + 300 + 80
    cacheWrite: 800,
    cacheRead: 5000,
    total: 8930,
  };
  const NANO_F = expectedNanoUsd(TOKENS_F); // 38_750_000

  let tmpDir: string;
  let repo: FixtureRepo;
  let squashHash: string;
  let baseHash: string;
  let wipHash: string;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibebill-s5-'));
    const claudeDir = path.join(tmpDir, 'claude');
    const configDir = path.join(tmpDir, 'config');
    await mkdir(configDir, { recursive: true });

    repo = await makeRepo(tmpDir);
    baseHash = await repo.commitFile('README.md', '# fixture\n', {
      authorDate: T_BASE,
      message: 'chore: base',
    });

    // Feature branch does the work…
    await repo.branch('feature');
    await repo.checkout('feature');
    wipHash = await repo.commitFiles(
      [
        [F1, 'feature one — session F\n'],
        [F2, 'feature two — session F\n'],
      ],
      { authorDate: T_WIP, message: 'wip: feature work' },
    );

    // …and main receives it as ONE normal 1-parent squash commit. The wip
    // commit stays outside HEAD history (squash discards the parent link), so
    // under the default HEAD scope the squash commit is the only candidate
    // whose files match the session's edits.
    await repo.checkout('main');
    squashHash = await repo.squashMerge('feature', 'feat: add feature (squash)', T_SQUASH);

    const sessionF = session({ sessionId: SESSION_F, defaultCwd: repo.root, defaultBranch: 'feature' })
      .at(T_EDIT1)
      .call({
        usage: { input: 1200, output: 400, cacheWrite: 800, cacheRead: 5000 },
        edits: [path.join(repo.root, F1)],
      })
      .at(T_EDIT2)
      .call({ usage: { input: 900, output: 300 }, edits: [path.join(repo.root, F2)] })
      .at(T_PLAN)
      .call({ usage: { input: 250, output: 80 } }); // trailing non-edit: adopts the last edit (§5.4 C)
    await writeTranscripts(claudeDir, [sessionF]);

    stubHermeticEnv({ claudeDir, configDir, nowMs: FIXTURE_EPOCH_MS + 30 * DAY });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('gives the squash commit the session cost with file-match confidence, not the pure-time fallback (show --json)', async () => {
    const run = await runCli(repo.root, ['show', squashHash, '--json']);
    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as ShowJson;

    // The squash commit is a NORMAL commit (1 parent), and it got the session.
    expect(payload.commit.isMerge).toBe(false);
    expect(payload.commit.inEnumeratedHistory).toBe(true);
    expect([...payload.commit.files].sort()).toEqual([F1, F2]);
    expect(payload.attributed).toBe(true);
    expect(payload.sessions.map((s) => s.sessionId)).toEqual([SESSION_F]);
    expect(req(payload.sessions[0], 'sessions[0]').events).toBe(3);

    // Full session cost, exact bigint expectation, per price class (§8).
    expect(payload.tokens).toEqual(TOKENS_F);
    const cost = req(payload.cost, 'cost');
    expect(cost.input.nanoUsd).toBe((2350n * NANO_PER_TOKEN.input).toString());
    expect(cost.output.nanoUsd).toBe((780n * NANO_PER_TOKEN.output).toString());
    expect(cost.cacheWrite.nanoUsd).toBe((800n * NANO_PER_TOKEN.cacheWrite).toString());
    expect(cost.cacheRead.nanoUsd).toBe((5000n * NANO_PER_TOKEN.cacheRead).toString());
    expect(cost.total.nanoUsd).toBe(NANO_F);

    // File-match evidence, NOT the pure-time fallback: every scored edit event
    // has fileScore > 0, nothing is advisory, and confidence is high (§5.4).
    expect(payload.evidence).toHaveLength(2);
    for (const ev of payload.evidence) {
      expect(ev.fileScore).toBeGreaterThan(0);
      expect(ev.fileScore).toBe(1);
      expect(ev.matchedFiles).toBe(1);
      expect(ev.confidence).toBe('high');
    }
    expect(payload.confidence).toBe('high');
    expect(payload.provenance).toEqual({ measured: 3, advisory: 0, repriced: 0 });
    expect(payload.advisoryEvents).toBe(0);
    expect(payload.adoptedEvents).toBe(1);
    expect([...payload.filesMatched.matched].sort()).toEqual([F1, F2]);
    expect(payload.filesMatched.unmatched).toEqual([]);

    // Nothing wasted, nothing overheard — the whole session landed (§5.4 D).
    expect(payload.invariant).toEqual({
      ok: true,
      totalTokens: TOKENS_F.total,
      attributed: TOKENS_F.total,
      waste: 0,
      overhead: 0,
      outOfScope: 0,
      deltaTokens: 0,
    });
  });

  it('log --json: HEAD history is base + squash only, squash carries the full cost, zero waste', async () => {
    const run = await runCli(repo.root, ['log', '--json']);
    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as LogJson;

    // The branch's wip commit must not be enumerated under the default HEAD scope.
    const hashes = payload.commits.map((c) => c.hash);
    expect([...hashes].sort()).toEqual([baseHash, squashHash].sort());
    expect(hashes).not.toContain(wipHash);

    const byHash = new Map(payload.commits.map((c) => [c.hash, c]));
    const squashRow = req(byHash.get(squashHash), 'squash row');
    expect(squashRow.attributed).toBe(true);
    expect(req(squashRow.cost, 'squash cost').nanoUsd).toBe(NANO_F);
    expect(squashRow.confidence).toBe('high');
    expect(squashRow.sessions).toBe(1);
    expect(squashRow.events).toBe(3);

    const baseRow = req(byHash.get(baseHash), 'base row');
    expect(baseRow.attributed).toBe(false);
    expect(baseRow.cost).toBeNull();

    expect(payload.inProgress).toBeNull();
    expect(payload.totals.commitsCosted).toBe(1);
    expect(payload.totals.attributedCost.nanoUsd).toBe(NANO_F);
    expect(payload.totals.waste.nanoUsd).toBe('0');
    expect(payload.totals.overhead.nanoUsd).toBe('0');
    expect(payload.invariant.ok).toBe(true);
  });
});
