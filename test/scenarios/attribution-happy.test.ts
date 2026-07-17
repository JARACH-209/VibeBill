/**
 * Scenarios S1, S2 and S13 (spec §11) — attribution happy paths, driven through
 * the real CLI entry (buildProgram + captureIO) against a scripted fixture repo
 * and synthetic Claude Code transcripts, hermetically isolated from any real
 * agent logs on this machine via the VIBEBILL_* env overrides.
 *
 * S1  — one session whose edits belong to exactly one later commit: 100% of the
 *       session's cost lands on that commit, confidence `high`, invariant ok.
 * S2  — ONE session whose edit events interleave in time across 3 disjoint file
 *       groups committed as 3 commits: the per-commit token/cost split matches
 *       the message-grain expectation exactly, and non-edit events
 *       forward-attach to the NEXT edit event's commit (trailing non-edits
 *       attach to the previous edit's commit).
 * S13 — edit events NEWER than the newest commit with no matching commit: the
 *       "in progress (uncommitted)" bucket is non-null in `log --json`, renders
 *       as the (wip) pseudo-row on top in plain text, and summary's waste line
 *       does NOT count it (it gets its own "in progress" line).
 *
 * Expected money is hand-computed from prices/prices.json's claude-opus-4-8
 * card (the fixture builder's default model): $5 / $25 / $6.25 / $0.50 per
 * MTok → 5000 / 25000 / 6250 / 500 nano-USD per token. All four per-token
 * rates are integers, so the engine's single floor division per event and
 * class is exact and the expectations below are exact bigint sums.
 */

import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { captureIO } from '../../src/cli/io.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';
import { FIXTURE_EPOCH_MS, session, writeTranscripts } from '../helpers/transcripts.js';

const MIN = 60_000;

/** The fixture builder's default model (SessionBuilder defaultModel). */
const FIXTURE_MODEL = 'claude-opus-4-8';

/**
 * nano-USD per token for claude-opus-4-8, hand-derived from prices/prices.json
 * ($/MTok × 10^9 / 10^6): input $5, output $25, cache write $6.25, cache read $0.50.
 */
const NANO_PER_TOKEN = {
  input: 5_000n,
  output: 25_000n,
  cacheWrite: 6_250n,
  cacheRead: 500n,
} as const;

interface Usage {
  input: number;
  output: number;
  cacheWrite?: number;
  cacheRead?: number;
}

/** Exact expected nano-USD cost of one API call's usage on the fixture card. */
function usageNano(u: Usage): bigint {
  return (
    BigInt(u.input) * NANO_PER_TOKEN.input +
    BigInt(u.output) * NANO_PER_TOKEN.output +
    BigInt(u.cacheWrite ?? 0) * NANO_PER_TOKEN.cacheWrite +
    BigInt(u.cacheRead ?? 0) * NANO_PER_TOKEN.cacheRead
  );
}

function groupNano(usages: readonly Usage[]): bigint {
  return usages.reduce((sum, u) => sum + usageNano(u), 0n);
}

interface TokensJson {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}

/** Expected --json tokens object (docs/json-schemas.md "Tokens") for a group of calls. */
function groupTokens(usages: readonly Usage[]): TokensJson {
  let input = 0;
  let output = 0;
  let cacheWrite = 0;
  let cacheRead = 0;
  for (const u of usages) {
    input += u.input;
    output += u.output;
    cacheWrite += u.cacheWrite ?? 0;
    cacheRead += u.cacheRead ?? 0;
  }
  return { input, output, cacheWrite, cacheRead, total: input + output + cacheWrite + cacheRead };
}

const ZERO_TOKENS: TokensJson = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, total: 0 };

// ---------------------------------------------------------------------------
// --json payload shapes we assert on (docs/json-schemas.md)
// ---------------------------------------------------------------------------

interface MoneyJson {
  nanoUsd: string;
  usd: string;
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

interface BucketJson {
  cost: MoneyJson;
  tokens: TokensJson;
  sessions: number;
}

interface SummaryJson {
  command: string;
  invariant: InvariantJson;
  totals: { cost: MoneyJson; tokens: TokensJson; events: number; unpricedEvents: number };
  waste: BucketJson;
  inProgress: BucketJson;
  overhead: BucketJson;
  covered: { sessions: number; commits: number };
}

interface LogCommitJson {
  hash: string;
  shortHash: string;
  date: string;
  subject: string;
  attributed: boolean;
  cost: MoneyJson | null;
  tokens: TokensJson | null;
  confidence: 'high' | 'medium' | 'low' | null;
  models: string[];
  sessions: number;
  events: number;
}

interface LogJson {
  command: string;
  invariant: InvariantJson;
  inProgress:
    | (BucketJson & { events: number; newestTs: string | null })
    | null;
  commits: LogCommitJson[];
  totals: {
    attributedCost: MoneyJson;
    commitsShown: number;
    commitsCosted: number;
    waste: MoneyJson;
    overhead: MoneyJson;
    inProgress: MoneyJson;
  };
}

interface ShowJson {
  command: string;
  invariant: InvariantJson;
  commit: { hash: string; subject: string | null };
  attributed: boolean;
  cost: { total: MoneyJson } | null;
  tokens: TokensJson;
  events: number;
  confidence: 'high' | 'medium' | 'low' | null;
  provenance: { measured: number; advisory: number; repriced: number };
  sessions: Array<{ sessionId: string; events: number; cost: MoneyJson }>;
  evidence: Array<{ fileScore: number; timeScore: number; branchScore: number; confidence: string }>;
  adoptedEvents: number;
  filesMatched: { matched: string[]; unmatched: string[] };
}

// ---------------------------------------------------------------------------
// CLI driving + fixture scaffolding
// ---------------------------------------------------------------------------

const ORIGINAL_CWD = process.cwd();

/** Run the real CLI in-process; captures stdout/stderr and the exit code. */
async function runCli(
  args: readonly string[],
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const io = captureIO();
  process.exitCode = 0;
  await buildProgram(io).parseAsync(['node', 'vibebill', ...args]);
  const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
  process.exitCode = 0;
  return { exitCode, stdout: io.stdout.join('\n'), stderr: io.stderr.join('\n') };
}

/** Run with --json and parse the single stdout document. */
async function runJson<T>(args: readonly string[]): Promise<{ exitCode: number; payload: T }> {
  const r = await runCli([...args, '--json']);
  return { exitCode: r.exitCode, payload: JSON.parse(r.stdout) as T };
}

/** Indexed access under noUncheckedIndexedAccess with a hard assertion. */
function nth<T>(arr: readonly T[], i: number): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected element at index ${i}, array has ${arr.length}`);
  return v;
}

interface Fixture {
  base: string;
  claudeDir: string;
  configDir: string;
  repo: FixtureRepo;
  /** realpath of the repo root (macOS tmpdir is symlinked) — used as event cwd. */
  root: string;
}

async function makeFixture(tag: string): Promise<Fixture> {
  const base = await mkdtemp(path.join(os.tmpdir(), `vibebill-${tag}-`));
  const claudeDir = path.join(base, 'claude');
  const configDir = path.join(base, 'config'); // empty: no user prices/config leak in
  await mkdir(configDir, { recursive: true });
  const repo = await makeRepo(base);
  const root = await realpath(repo.root);
  return { base, claudeDir, configDir, repo, root };
}

/** Hermetic isolation (spec §10): no host transcripts, no host prices, fixed clock. */
function stubEnvAndEnter(f: Fixture, nowMs: number): void {
  vi.stubEnv('VIBEBILL_CLAUDE_DIR', f.claudeDir);
  vi.stubEnv('VIBEBILL_CODEX_DIR', '/nonexistent');
  vi.stubEnv('VIBEBILL_GEMINI_DIR', '/nonexistent');
  vi.stubEnv('VIBEBILL_CONFIG_DIR', f.configDir);
  vi.stubEnv('VIBEBILL_AIDER_HISTORY', ''); // empty = ignored; masks any host value
  vi.stubEnv('VIBEBILL_NOW', String(nowMs));
  process.chdir(f.repo.root);
}

async function teardown(f: Fixture | undefined): Promise<void> {
  process.chdir(ORIGINAL_CWD);
  vi.unstubAllEnvs();
  if (f !== undefined) await rm(f.base, { recursive: true, force: true });
}

// ===========================================================================
// S1 — one session → one commit
// ===========================================================================

describe('S1 — one session → one commit (spec §11)', () => {
  const SID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const T0 = FIXTURE_EPOCH_MS + 10 * MIN;

  // Three API calls: a planning call with no edits (must forward-attach to the
  // next edit event, spec §5.4 Step C), then two edit calls touching only the
  // files of the single later commit.
  const USAGE = {
    planning: { input: 1000, output: 200, cacheWrite: 300, cacheRead: 4000 },
    editA: { input: 2000, output: 500, cacheRead: 10_000 },
    editAB: { input: 3000, output: 700, cacheWrite: 100 },
  } as const satisfies Record<string, Usage>;
  const ALL = [USAGE.planning, USAGE.editA, USAGE.editAB];
  const EXPECTED_NANO = groupNano(ALL); // 74_500_000n
  const EXPECTED_TOKENS = groupTokens(ALL); // total 21_800

  let f: Fixture;
  let c1 = '';

  beforeAll(async () => {
    f = await makeFixture('s1');
    const s = session({ sessionId: SID, defaultCwd: f.root, defaultBranch: 'main' });
    s.at(T0).call({ usage: USAGE.planning });
    s.at(T0 + 2 * MIN).call({ usage: USAGE.editA, edits: [path.join(f.root, 'src/a.ts')] });
    s.at(T0 + 4 * MIN).call({
      usage: USAGE.editAB,
      edits: [path.join(f.root, 'src/a.ts'), path.join(f.root, 'src/b.ts')],
    });
    await writeTranscripts(f.claudeDir, [s]);

    // The one commit, 6 minutes after the last edit (well inside grace+horizon).
    c1 = await f.repo.commitFiles(
      [
        ['src/a.ts', 'a\n'],
        ['src/b.ts', 'b\n'],
      ],
      { message: 'feat: implement a and b', authorDate: T0 + 10 * MIN },
    );

    stubEnvAndEnter(f, FIXTURE_EPOCH_MS + 24 * 60 * MIN); // "now" = one day in
  });

  afterAll(async () => {
    await teardown(f);
  });

  it('summary --json: the whole session is attributed, nothing in waste/overhead/in-progress, invariant ok', async () => {
    const { exitCode, payload } = await runJson<SummaryJson>(['summary']);
    expect(exitCode).toBe(0);

    expect(payload.invariant).toEqual({
      ok: true,
      totalTokens: EXPECTED_TOKENS.total,
      attributed: EXPECTED_TOKENS.total,
      waste: 0,
      overhead: 0,
      outOfScope: 0,
      deltaTokens: 0,
    });

    expect(payload.totals.cost).toEqual({ nanoUsd: EXPECTED_NANO.toString(), usd: '0.07' });
    expect(payload.totals.tokens).toEqual(EXPECTED_TOKENS);
    expect(payload.totals.events).toBe(3);
    expect(payload.totals.unpricedEvents).toBe(0);

    expect(payload.waste).toEqual({ cost: { nanoUsd: '0', usd: '0.00' }, tokens: ZERO_TOKENS, sessions: 0 });
    expect(payload.inProgress).toEqual({ cost: { nanoUsd: '0', usd: '0.00' }, tokens: ZERO_TOKENS, sessions: 0 });
    expect(payload.overhead).toEqual({ cost: { nanoUsd: '0', usd: '0.00' }, tokens: ZERO_TOKENS, sessions: 0 });
    expect(payload.covered).toEqual({ sessions: 1, commits: 1 });
  });

  it('log --json: 100% of the session cost lands on the commit at confidence high', async () => {
    const { exitCode, payload } = await runJson<LogJson>(['log']);
    expect(exitCode).toBe(0);

    expect(payload.invariant.ok).toBe(true);
    expect(payload.inProgress).toBeNull();
    expect(payload.commits).toHaveLength(1);

    const row = nth(payload.commits, 0);
    expect(row.hash).toBe(c1);
    expect(row.subject).toBe('feat: implement a and b');
    expect(row.attributed).toBe(true);
    expect(row.confidence).toBe('high');
    expect(row.cost).toEqual({ nanoUsd: EXPECTED_NANO.toString(), usd: '0.07' });
    expect(row.tokens).toEqual(EXPECTED_TOKENS);
    expect(row.events).toBe(3); // 2 edit events + 1 forward-attached planning call
    expect(row.sessions).toBe(1);
    expect(row.models).toEqual([FIXTURE_MODEL]);

    // 100%: the commit's cost IS the scope total; every other bucket is zero.
    expect(payload.totals.attributedCost.nanoUsd).toBe(EXPECTED_NANO.toString());
    expect(payload.totals.commitsCosted).toBe(1);
    expect(payload.totals.waste.nanoUsd).toBe('0');
    expect(payload.totals.overhead.nanoUsd).toBe('0');
    expect(payload.totals.inProgress.nanoUsd).toBe('0');
  });
});

// ===========================================================================
// S2 — one session spans 3 commits (interleaved edits, disjoint files)
// ===========================================================================

describe('S2 — one session, interleaved edits across 3 disjoint file groups → 3 commits (spec §11)', () => {
  const SID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const T0 = FIXTURE_EPOCH_MS;

  // ONE session, events 2 minutes apart, interleaving three disjoint file
  // groups A={alpha.ts}, B={beta.ts}, C={gamma.ts} as A, B, A, B, C — with a
  // leading non-edit call, a non-edit call BETWEEN edit events (must
  // forward-attach to the NEXT edit's commit, not the previous one), and a
  // trailing non-edit call (must attach to the PREVIOUS edit's commit).
  const USAGE = {
    e1: { input: 100, output: 10 }, //            +0m  non-edit  → next edit e2 → A
    e2: { input: 200, output: 20 }, //            +2m  edit alpha.ts            → A
    e3: { input: 400, output: 40 }, //            +4m  edit beta.ts             → B
    e4: { input: 800, output: 80, cacheRead: 1000 }, // +6m  edit alpha.ts      → A
    e5: { input: 1600, output: 160 }, //          +8m  non-edit  → next edit e6 → B
    e6: { input: 3200, output: 320, cacheWrite: 2000 }, // +10m edit beta.ts    → B
    e7: { input: 6400, output: 640 }, //          +12m edit gamma.ts            → C
    e8: { input: 12_800, output: 1280, cacheRead: 5000 }, // +14m trailing non-edit → previous edit e7 → C
  } as const satisfies Record<string, Usage>;

  // Message-grain expectation, computed from the fixture numbers above.
  const GROUP_A = [USAGE.e1, USAGE.e2, USAGE.e4];
  const GROUP_B = [USAGE.e3, USAGE.e5, USAGE.e6];
  const GROUP_C = [USAGE.e7, USAGE.e8];
  const ALL = [...GROUP_A, ...GROUP_B, ...GROUP_C];

  let f: Fixture;
  let cA = '';
  let cB = '';
  let cC = '';

  beforeAll(async () => {
    f = await makeFixture('s2');
    const alpha = path.join(f.root, 'alpha.ts');
    const beta = path.join(f.root, 'beta.ts');
    const gamma = path.join(f.root, 'gamma.ts');

    const s = session({ sessionId: SID, defaultCwd: f.root, defaultBranch: 'main' });
    s.at(T0).call({ usage: USAGE.e1 });
    s.at(T0 + 2 * MIN).call({ usage: USAGE.e2, edits: [alpha] });
    s.at(T0 + 4 * MIN).call({ usage: USAGE.e3, edits: [beta] });
    s.at(T0 + 6 * MIN).call({ usage: USAGE.e4, edits: [alpha] });
    s.at(T0 + 8 * MIN).call({ usage: USAGE.e5 });
    s.at(T0 + 10 * MIN).call({ usage: USAGE.e6, edits: [beta] });
    s.at(T0 + 12 * MIN).call({ usage: USAGE.e7, edits: [gamma] });
    s.at(T0 + 14 * MIN).call({ usage: USAGE.e8 });
    await writeTranscripts(f.claudeDir, [s]);

    cA = await f.repo.commitFile('alpha.ts', 'alpha\n', {
      message: 'feat: alpha',
      authorDate: T0 + 30 * MIN,
    });
    cB = await f.repo.commitFile('beta.ts', 'beta\n', {
      message: 'feat: beta',
      authorDate: T0 + 35 * MIN,
    });
    cC = await f.repo.commitFile('gamma.ts', 'gamma\n', {
      message: 'feat: gamma',
      authorDate: T0 + 40 * MIN,
    });

    stubEnvAndEnter(f, FIXTURE_EPOCH_MS + 24 * 60 * MIN);
  });

  afterAll(async () => {
    await teardown(f);
  });

  it('log --json: per-commit token/cost split matches the message-grain expectation exactly', async () => {
    const { exitCode, payload } = await runJson<LogJson>(['log']);
    expect(exitCode).toBe(0);

    expect(payload.invariant.ok).toBe(true);
    expect(payload.invariant.attributed).toBe(groupTokens(ALL).total);
    expect(payload.invariant.waste).toBe(0);
    expect(payload.invariant.overhead).toBe(0);
    expect(payload.inProgress).toBeNull();
    expect(payload.commits).toHaveLength(3);

    // Newest first: gamma, beta, alpha.
    const expectations: Array<{ hash: string; usages: readonly Usage[]; events: number }> = [
      { hash: cC, usages: GROUP_C, events: 2 },
      { hash: cB, usages: GROUP_B, events: 3 },
      { hash: cA, usages: GROUP_A, events: 3 },
    ];
    for (let i = 0; i < expectations.length; i++) {
      const want = nth(expectations, i);
      const row = nth(payload.commits, i);
      expect(row.hash).toBe(want.hash);
      expect(row.attributed).toBe(true);
      expect(row.cost?.nanoUsd).toBe(groupNano(want.usages).toString());
      expect(row.tokens).toEqual(groupTokens(want.usages));
      expect(row.events).toBe(want.events);
      expect(row.sessions).toBe(1); // the SAME single session feeds all three
      expect(row.confidence).toBe('high');
      expect(row.models).toEqual([FIXTURE_MODEL]);
    }

    // Σ per-commit == scope total, exactly (spec §8 conservation of money).
    const perCommitSum = payload.commits.reduce(
      (sum, r) => sum + BigInt(r.cost?.nanoUsd ?? '0'),
      0n,
    );
    expect(perCommitSum).toBe(groupNano(ALL));
    expect(payload.totals.attributedCost.nanoUsd).toBe(groupNano(ALL).toString());
    expect(payload.totals.commitsCosted).toBe(3);
    expect(payload.totals.waste.nanoUsd).toBe('0');
    expect(payload.totals.overhead.nanoUsd).toBe('0');
  });

  it('show --json per commit: non-edit events forward-attach to the NEXT edit (trailing to the previous)', async () => {
    const cases: Array<{
      hash: string;
      usages: readonly Usage[];
      events: number;
      /** Directly-scored edit events (evidence rows). */
      evidence: number;
      /** Non-edit events that adopted an edit's attribution (Step C). */
      adopted: number;
      files: string[];
    }> = [
      // e1 (leading non-edit) forward-attaches to e2 → commit A.
      { hash: cA, usages: GROUP_A, events: 3, evidence: 2, adopted: 1, files: ['alpha.ts'] },
      // e5 (mid-session non-edit) forward-attaches to e6 → commit B, NOT back to e4's commit A.
      { hash: cB, usages: GROUP_B, events: 3, evidence: 2, adopted: 1, files: ['beta.ts'] },
      // e8 (trailing non-edit) attaches backward to e7 → commit C.
      { hash: cC, usages: GROUP_C, events: 2, evidence: 1, adopted: 1, files: ['gamma.ts'] },
    ];

    for (const want of cases) {
      const { exitCode, payload } = await runJson<ShowJson>(['show', want.hash]);
      expect(exitCode).toBe(0);
      expect(payload.invariant.ok).toBe(true);
      expect(payload.commit.hash).toBe(want.hash);
      expect(payload.attributed).toBe(true);
      expect(payload.events).toBe(want.events);
      expect(payload.adoptedEvents).toBe(want.adopted);
      expect(payload.evidence).toHaveLength(want.evidence);
      for (const e of payload.evidence) {
        expect(e.fileScore).toBe(1); // disjoint groups: every scored edit matches fully
        expect(e.confidence).toBe('high');
      }
      expect(payload.tokens).toEqual(groupTokens(want.usages));
      expect(payload.cost?.total.nanoUsd).toBe(groupNano(want.usages).toString());
      expect(payload.confidence).toBe('high');
      expect(payload.provenance).toEqual({ measured: want.events, advisory: 0, repriced: 0 });
      expect(payload.sessions).toHaveLength(1);
      expect(nth(payload.sessions, 0).sessionId).toBe(SID);
      expect(nth(payload.sessions, 0).events).toBe(want.events);
      expect(payload.filesMatched).toEqual({ matched: want.files, unmatched: [] });
    }
  });

  it('summary --json: the session total equals the sum of the three commit splits', async () => {
    const { exitCode, payload } = await runJson<SummaryJson>(['summary']);
    expect(exitCode).toBe(0);
    expect(payload.invariant.ok).toBe(true);
    expect(payload.totals.cost.nanoUsd).toBe(groupNano(ALL).toString());
    expect(payload.totals.tokens).toEqual(groupTokens(ALL));
    expect(payload.totals.events).toBe(8);
    expect(payload.covered).toEqual({ sessions: 1, commits: 3 });
    expect(payload.waste.tokens).toEqual(ZERO_TOKENS);
    expect(payload.overhead.tokens).toEqual(ZERO_TOKENS);
    expect(payload.inProgress.tokens).toEqual(ZERO_TOKENS);
  });
});

// ===========================================================================
// S13 — uncommitted in-progress work
// ===========================================================================

describe('S13 — uncommitted in-progress work (spec §11, §5.4 Step B)', () => {
  const SID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
  const COMMIT_TS = FIXTURE_EPOCH_MS + 60 * MIN; // newest (and only) commit
  const T_PLAN = FIXTURE_EPOCH_MS + 120 * MIN; //  1h AFTER the newest commit
  const T_EDIT = FIXTURE_EPOCH_MS + 122 * MIN;
  const NOW = FIXTURE_EPOCH_MS + 180 * MIN; //     horizon (14d) far from elapsed

  const USAGE = {
    planning: { input: 500, output: 50 }, //          non-edit → adopts the edit's bucket
    editWip: { input: 1500, output: 150, cacheRead: 2000 }, // edits a file no commit has
  } as const satisfies Usage extends never ? never : Record<string, Usage>;
  const ALL = [USAGE.planning, USAGE.editWip];
  const EXPECTED_NANO = groupNano(ALL); // 16_000_000n → $0.02
  const EXPECTED_TOKENS = groupTokens(ALL); // total 4_200

  let f: Fixture;
  let c1 = '';

  beforeAll(async () => {
    f = await makeFixture('s13');
    c1 = await f.repo.commitFile('base.ts', 'base\n', {
      message: 'chore: base',
      authorDate: COMMIT_TS,
    });

    const s = session({ sessionId: SID, defaultCwd: f.root, defaultBranch: 'main' });
    s.at(T_PLAN).call({ usage: USAGE.planning });
    s.at(T_EDIT).call({ usage: USAGE.editWip, edits: [path.join(f.root, 'wip.ts')] });
    await writeTranscripts(f.claudeDir, [s]);

    stubEnvAndEnter(f, NOW);
  });

  afterAll(async () => {
    await teardown(f);
  });

  it('log --json: inProgress bucket is non-null and carries the session; the commit stays uncosted', async () => {
    const { exitCode, payload } = await runJson<LogJson>(['log']);
    expect(exitCode).toBe(0);

    // Storage kind remains waste (spec §5.4 Step B), so the invariant books it
    // under waste — and still balances.
    expect(payload.invariant.ok).toBe(true);
    expect(payload.invariant.waste).toBe(EXPECTED_TOKENS.total);
    expect(payload.invariant.attributed).toBe(0);

    expect(payload.inProgress).not.toBeNull();
    expect(payload.inProgress?.cost).toEqual({ nanoUsd: EXPECTED_NANO.toString(), usd: '0.02' });
    expect(payload.inProgress?.tokens).toEqual(EXPECTED_TOKENS);
    expect(payload.inProgress?.sessions).toBe(1);
    expect(payload.inProgress?.events).toBe(2); // the edit AND its adopted planning call
    expect(payload.inProgress?.newestTs).toBe(new Date(T_EDIT).toISOString());

    expect(payload.commits).toHaveLength(1);
    const row = nth(payload.commits, 0);
    expect(row.hash).toBe(c1);
    expect(row.attributed).toBe(false);
    expect(row.cost).toBeNull();
    expect(row.confidence).toBeNull();
    expect(row.events).toBe(0);

    expect(payload.totals.inProgress.nanoUsd).toBe(EXPECTED_NANO.toString());
    expect(payload.totals.waste.nanoUsd).toBe('0'); // display waste excludes in-progress
  });

  it('log (plain text, --no-color): renders the (wip) pseudo-row on top', async () => {
    const { exitCode, stdout } = await runCli(['log', '--no-color']);
    expect(exitCode).toBe(0);

    const wipRow = stdout.split('\n').find((line) => line.includes('(wip)'));
    expect(wipRow).toBeDefined();
    expect(wipRow).toContain('in progress (uncommitted)');
    expect(wipRow).toContain('$0.02');
    expect(wipRow).toContain(FIXTURE_MODEL);

    // Pseudo-row sits ABOVE the commit row (spec §6.3), which shows $0.00 ·human?.
    expect(stdout.indexOf('(wip)')).toBeGreaterThanOrEqual(0);
    expect(stdout.indexOf('(wip)')).toBeLessThan(stdout.indexOf(c1.slice(0, 7)));
    expect(stdout).toContain('human?');

    // Footer names the bucket separately from waste.
    expect(stdout).toContain('in progress $0.02');
    expect(stdout).toContain('waste $0.00');
  });

  it('summary: waste line does NOT count it — it gets its own "in progress" line', async () => {
    const { exitCode, stdout } = await runCli(['summary', '--no-color']);
    expect(exitCode).toBe(0);

    const wasteLine = stdout.split('\n').find((line) => line.startsWith('waste:'));
    expect(wasteLine).toBe('waste: $0.00 across 0 sessions never landed in a commit');

    expect(stdout).toContain(
      'in progress (uncommitted): $0.02 across 1 session (not counted as waste)',
    );
  });

  it('summary --json: cost sits in inProgress, not waste', async () => {
    const { exitCode, payload } = await runJson<SummaryJson>(['summary']);
    expect(exitCode).toBe(0);
    expect(payload.invariant.ok).toBe(true);
    expect(payload.waste).toEqual({
      cost: { nanoUsd: '0', usd: '0.00' },
      tokens: ZERO_TOKENS,
      sessions: 0,
    });
    expect(payload.inProgress).toEqual({
      cost: { nanoUsd: EXPECTED_NANO.toString(), usd: '0.02' },
      tokens: EXPECTED_TOKENS,
      sessions: 1,
    });
    expect(payload.overhead.tokens).toEqual(ZERO_TOKENS);
  });
});
