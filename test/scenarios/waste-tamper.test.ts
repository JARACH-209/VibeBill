/**
 * Scenario S4 (spec §11): abandoned session — edit events whose files never
 * appear in any commit, with the repo's newest commit more than the horizon
 * (14 days) past the events AND "now" far past. The full session cost must
 * land in the `waste` bucket (exact tokens), the summary text output must
 * carry the waste line, and the conservation invariant must hold.
 *
 * Scenario S12 (spec §11): invariant tamper — on a healthy fully-attributed
 * fixture, splice ONE attributed row out of ctx.rows post-hoc. The runtime
 * accounting check (spec §5.4 Step D) must detect the drop: red ACCOUNTING
 * MISMATCH warning in text output, `accountingMismatch.tokens` equal to the
 * dropped event's total tokens with `invariant.ok` false in --json, exit
 * code 3 with --strict and 0 without.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { runSummary } from '../../src/cli/commands/summary.js';
import { buildContext, checkAccounting, type GlobalFlags } from '../../src/cli/context.js';
import { buildProgram } from '../../src/cli/index.js';
import { captureIO } from '../../src/cli/io.js';
import { totalTokens } from '../../src/core/types.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';
import { session, writeTranscripts } from '../helpers/transcripts.js';

// ---------------------------------------------------------------------------
// Shared plumbing
// ---------------------------------------------------------------------------

/** The slices of the summary --json payload these scenarios assert on. */
interface TokensJson {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  total: number;
}
interface MoneyJson {
  nanoUsd: string;
  usd: string;
}
interface BucketJson {
  cost: MoneyJson;
  tokens: TokensJson;
  sessions: number;
}
interface SummaryJson {
  schemaVersion: number;
  command: string;
  invariant: {
    ok: boolean;
    totalTokens: number;
    attributed: number;
    waste: number;
    overhead: number;
    outOfScope: number;
    deltaTokens: number;
  };
  accountingMismatch?: { tokens: number };
  totals: { cost: MoneyJson; tokens: TokensJson; events: number };
  waste: BucketJson;
  inProgress: BucketJson;
  overhead: BucketJson;
  covered: { sessions: number; commits: number };
}

/** Point every adapter/config lookup at fixture space so no host state leaks in. */
function stubIsolationEnv(claudeDir: string, configDir: string, nowMs: number): void {
  vi.stubEnv('VIBEBILL_CLAUDE_DIR', claudeDir);
  vi.stubEnv('VIBEBILL_CODEX_DIR', '/nonexistent');
  vi.stubEnv('VIBEBILL_GEMINI_DIR', '/nonexistent');
  vi.stubEnv('VIBEBILL_CONFIG_DIR', configDir);
  vi.stubEnv('VIBEBILL_NOW', String(nowMs));
}

/** Drive the real CLI entry in-process and capture output + exit code. */
async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const io = captureIO();
  process.exitCode = 0;
  await buildProgram(io).parseAsync(['node', 'vibebill', ...args]);
  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  return { exitCode, stdout: io.stdout.join('\n'), stderr: io.stderr.join('\n') };
}

/** Hand-built GlobalFlags for direct buildContext/runSummary invocation (S12). */
function flagsFor(nowMs: number, overrides: Partial<GlobalFlags> = {}): GlobalFlags {
  return {
    json: false,
    since: null,
    until: null,
    color: false,
    quiet: true,
    strict: false,
    debug: false,
    plan: null,
    allRefs: false,
    refreshPricing: false,
    nowMs,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// S4 — abandoned session: full session cost in waste
// ---------------------------------------------------------------------------

describe('S4 — abandoned session lands fully in waste (spec §5.4 Step B, §6.2, §11)', () => {
  // Timeline (all UTC, minutes/days apart so windows are unambiguous):
  //   2026-01-01 00:00  commit "init" (README.md)                — 4 days before events,
  //                     outside the 120 s grace, so never a candidate
  //   2026-01-05 10:00  session events (edits to files never committed)
  //   2026-01-25 12:00  newest commit (docs/notes.txt)           — 20 days AFTER the
  //                     events, past the 14-day horizon, so not a candidate either
  //   2026-03-01 00:00  "now" — far past; waste, not "in progress"
  const NOW_MS = Date.parse('2026-03-01T00:00:00.000Z');
  const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000004';

  // Session token totals (the fixture's ground truth):
  //   input 1000+2000+1500+800 = 5300, output 200+400+350+150 = 1100,
  //   cacheWrite 300, cacheRead 5000+8000+2500 = 15500, total 22200.
  // claude-opus-4-8 card: $5 / $25 / $6.25 / $0.5 per MTok →
  //   5300×5000 + 1100×25000 + 300×6250 + 15500×500 = 63_625_000 nano-USD.
  const EXPECTED_TOKENS: TokensJson = {
    input: 5300,
    output: 1100,
    cacheWrite: 300,
    cacheRead: 15500,
    total: 22200,
  };
  const EXPECTED_WASTE_NANO = '63625000';
  const EXPECTED_WASTE_USD = '0.06';

  let tmp: string;
  let repo: FixtureRepo;
  let originalCwd: string;

  beforeAll(async () => {
    originalCwd = process.cwd();
    tmp = await mkdtemp(path.join(os.tmpdir(), 'vibebill-s4-'));
    const claudeDir = path.join(tmp, 'claude');
    const configDir = path.join(tmp, 'config');
    await mkdir(configDir, { recursive: true });

    repo = await makeRepo(tmp);
    await repo.commitFile('README.md', 'hello\n', {
      message: 'init',
      authorDate: '2026-01-01T00:00:00+00:00',
    });

    // The abandoned session: edits target files that NEVER appear in a commit.
    const orphanA = path.join(repo.root, 'src', 'orphan.ts');
    const orphanB = path.join(repo.root, 'src', 'orphan-helper.ts');
    const s = session({
      sessionId: SESSION_ID,
      defaultCwd: repo.root,
      defaultBranch: 'main',
      defaultModel: 'claude-opus-4-8',
    });
    s.at('2026-01-05T10:00:00.000Z') // leading non-edit: forward-attaches to the edit
      .call({ usage: { input: 1000, output: 200, cacheWrite: 300, cacheRead: 5000 } })
      .at('2026-01-05T10:01:00.000Z')
      .call({ usage: { input: 2000, output: 400, cacheRead: 8000 }, edits: [orphanA] })
      .at('2026-01-05T10:02:00.000Z')
      .call({ usage: { input: 1500, output: 350 }, edits: [orphanA, orphanB] })
      .at('2026-01-05T10:03:00.000Z') // trailing non-edit: back-attaches to the edit
      .call({ usage: { input: 800, output: 150, cacheRead: 2500 } });
    await writeTranscripts(claudeDir, [s]);

    // Newest commit: > horizon past the events (so the horizon has elapsed and
    // the events are NOT "in progress"), touching an unrelated file.
    await repo.commitFile('docs/notes.txt', 'later\n', {
      message: 'later work',
      authorDate: '2026-01-25T12:00:00+00:00',
    });

    stubIsolationEnv(claudeDir, configDir, NOW_MS);
    process.chdir(repo.root);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it('summary --json puts the full session cost in the waste bucket with the invariant holding', async () => {
    const run = await runCli(['summary', '--json']);
    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as SummaryJson;

    // The invariant holds and every parsed token is in the waste bucket.
    expect(payload.invariant.ok).toBe(true);
    expect(payload.accountingMismatch).toBeUndefined();
    expect(payload.invariant).toEqual({
      ok: true,
      totalTokens: EXPECTED_TOKENS.total,
      attributed: 0,
      waste: EXPECTED_TOKENS.total,
      overhead: 0,
      outOfScope: 0,
      deltaTokens: 0,
    });

    // Full session cost — exact token classes and exact nano-USD money.
    expect(payload.waste.tokens).toEqual(EXPECTED_TOKENS);
    expect(payload.waste.sessions).toBe(1);
    expect(payload.waste.cost).toEqual({ nanoUsd: EXPECTED_WASTE_NANO, usd: EXPECTED_WASTE_USD });

    // The horizon elapsed, so nothing may leak into the in-progress pseudo-bucket
    // (or anywhere else): the session's whole traffic is waste.
    expect(payload.inProgress.tokens.total).toBe(0);
    expect(payload.inProgress.sessions).toBe(0);
    expect(payload.overhead.tokens.total).toBe(0);
    expect(payload.totals.tokens).toEqual(EXPECTED_TOKENS);
    expect(payload.totals.events).toBe(4);
    expect(payload.covered).toEqual({ sessions: 1, commits: 0 });
  });

  it('summary text output carries the waste line', async () => {
    const run = await runCli(['summary', '--no-color']);
    expect(run.exitCode).toBe(0);
    expect(run.stdout).toContain('waste: $0.06 across 1 session never landed in a commit');
    expect(run.stdout).not.toContain('in progress (uncommitted)');
    expect(run.stdout).not.toContain('ACCOUNTING MISMATCH');
    const accountingLine = run.stdout.split('\n').find((l) => l.startsWith('accounting:'));
    expect(accountingLine).toBeDefined();
    expect(accountingLine).toContain('waste 22.2k');
  });
});

// ---------------------------------------------------------------------------
// S12 — invariant tamper: a dropped attributed row must be detected
// ---------------------------------------------------------------------------

describe('S12 — invariant tamper is detected (spec §5.4 Step D, §11)', () => {
  // Healthy fixture: one session whose edit lands cleanly in one commit
  // (edit 2026-01-02 10:02, commit 2026-01-02 11:00 → well inside the window).
  const NOW_MS = Date.parse('2026-01-30T00:00:00.000Z');
  const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000012';
  const DROPPED_EVENT_TOKENS = 1200 + 300 + 50 + 700; // the edit event, 2250 total

  let tmp: string;
  let repo: FixtureRepo;
  let appCommit: string;

  beforeAll(async () => {
    tmp = await mkdtemp(path.join(os.tmpdir(), 'vibebill-s12-'));
    const claudeDir = path.join(tmp, 'claude');
    const configDir = path.join(tmp, 'config');
    await mkdir(configDir, { recursive: true });

    repo = await makeRepo(tmp);
    await repo.commitFile('README.md', 'hello\n', {
      message: 'init',
      authorDate: '2026-01-01T00:00:00+00:00',
    });

    const appFile = path.join(repo.root, 'src', 'app.ts');
    const s = session({
      sessionId: SESSION_ID,
      defaultCwd: repo.root,
      defaultBranch: 'main',
      defaultModel: 'claude-opus-4-8',
    });
    s.at('2026-01-02T10:00:00.000Z')
      .call({ usage: { input: 500, output: 100 } })
      .at('2026-01-02T10:02:00.000Z')
      .call({
        usage: { input: 1200, output: 300, cacheWrite: 50, cacheRead: 700 },
        edits: [appFile],
      })
      .at('2026-01-02T10:04:00.000Z')
      .call({ usage: { input: 400, output: 80 } });
    await writeTranscripts(claudeDir, [s]);

    appCommit = await repo.commitFile('src/app.ts', 'export const app = 1;\n', {
      message: 'feat: app',
      authorDate: '2026-01-02T11:00:00+00:00',
    });

    stubIsolationEnv(claudeDir, configDir, NOW_MS);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await rm(tmp, { recursive: true, force: true });
  });

  afterEach(() => {
    process.exitCode = 0;
  });

  it('splicing one attributed row fires the mismatch warning; --strict exits 3, otherwise 0', async () => {
    const ctx = await buildContext(flagsFor(NOW_MS, { strict: true }), { cwd: repo.root });

    // Sanity: the fixture is healthy BEFORE tampering — books balance and
    // every event is attributed to the app commit.
    expect(checkAccounting(ctx.rows, ctx.ingest).ok).toBe(true);
    expect(ctx.rows).toHaveLength(3);
    for (const row of ctx.rows) {
      expect(row.entry.attribution).toMatchObject({ kind: 'commit', hash: appCommit });
    }

    // Tamper: splice the attributed edit event's row out of ctx.rows.
    const idx = ctx.rows.findIndex(
      (r) => r.entry.attribution.kind === 'commit' && r.entry.event.editedFiles.length > 0,
    );
    expect(idx).toBeGreaterThanOrEqual(0);
    const dropped = ctx.rows.splice(idx, 1)[0];
    if (dropped === undefined) throw new Error('splice returned no row');
    expect(totalTokens(dropped.entry.event.tokens)).toBe(DROPPED_EVENT_TOKENS);

    // (a) text output with --strict: red ACCOUNTING MISMATCH warning, exit 3.
    const ioText = captureIO();
    const exitStrict = await runSummary(
      { ...ctx, flags: { ...ctx.flags, json: false, strict: true } },
      ioText,
    );
    const text = ioText.stdout.join('\n');
    expect(text).toContain('ACCOUNTING MISMATCH');
    expect(text).toContain(`${DROPPED_EVENT_TOKENS} tokens unaccounted for`);
    expect(exitStrict).toBe(3);

    // (b) --json equivalent: accountingMismatch.tokens === dropped event's
    // total tokens, invariant.ok false.
    const ioJson = captureIO();
    const exitJson = await runSummary(
      { ...ctx, flags: { ...ctx.flags, json: true, strict: true } },
      ioJson,
    );
    const payload = JSON.parse(ioJson.stdout.join('\n')) as SummaryJson;
    expect(payload.invariant.ok).toBe(false);
    expect(payload.accountingMismatch).toEqual({ tokens: DROPPED_EVENT_TOKENS });
    expect(payload.invariant.deltaTokens).toBe(DROPPED_EVENT_TOKENS);
    expect(exitJson).toBe(3);

    // (c) without --strict: same warning, but exit 0.
    const ioLoose = captureIO();
    const exitLoose = await runSummary(
      { ...ctx, flags: { ...ctx.flags, json: false, strict: false } },
      ioLoose,
    );
    expect(ioLoose.stdout.join('\n')).toContain('ACCOUNTING MISMATCH');
    expect(exitLoose).toBe(0);
  });
});
