/**
 * Scenario S14 (spec §11) + the determinism property, driven through the real
 * CLI entry (`buildProgram().parseAsync`) against hermetic fixtures.
 *
 * S14 — notes sync idempotence: with 2 costed commits, `notes sync` twice must
 * leave byte-identical note blobs under refs/notes/vibebill (no duplicates),
 * each note matching the spec §6.8 JSON shape
 * `{v:1, costNanoUsd, tokens, confidence, provenance, generatedBy}`; and
 * `notes sync --clear` must remove ONLY the vibebill ref — a pre-existing note
 * on git's DEFAULT notes ref survives untouched.
 *
 * Determinism (spec §11 property): `summary --json` and `log --json` twice on
 * the same fixture (second run served from the warm .vibebill cache) produce
 * deep-equal payloads, and a cold re-run after `rm -rf .vibebill` equals the
 * warm ones too.
 *
 * Fixture timeline (all UTC, minutes after FIXTURE_EPOCH_MS so every event sits
 * unambiguously inside its commit's §5.4 candidate window — horizon 14 d,
 * grace 120 s):
 *   +5 min  session A edits src/alpha.ts   (1000 in / 500 out)
 *   +10 min commit "feat: alpha" (src/alpha.ts)
 *   +20 min session B edits src/beta.ts    (2000 in / 800 out / 100 cw / 400 cr)
 *   +21 min session B non-edit trailing call (50 in / 20 out) → attaches to beta
 *   +25 min commit "feat: beta" (src/beta.ts)
 * Model claude-opus-4-8 (bundled card: $5/$25/$6.25/$0.50 per MTok ⇒ 5000/25000/
 * 6250/500 nano-USD per token), so expected costs are hand-computable exactly:
 *   alpha: 1000×5000 + 500×25000                            = 17_500_000 nano
 *   beta:  2050×5000 + 820×25000 + 100×6250 + 400×500       = 31_575_000 nano
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { captureIO } from '../../src/cli/io.js';
import { makeRepo, type FixtureRepo } from '../helpers/repo.js';
import { FIXTURE_EPOCH_MS, session, writeTranscripts } from '../helpers/transcripts.js';

const execFileAsync = promisify(execFile);

const MIN_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;
const T0 = FIXTURE_EPOCH_MS;
/** Injected "now": 30 days past the fixture epoch, so no in-progress ambiguity. */
const NOW_MS = T0 + 30 * DAY_MS;

/** Hand-computed expectations (see the timeline in the header docblock). */
const ALPHA_COST_NANO = '17500000';
const ALPHA_TOKENS = { input: 1000, output: 500, cacheWrite: 0, cacheRead: 0, total: 1500 };
const BETA_COST_NANO = '31575000';
const BETA_TOKENS = { input: 2050, output: 820, cacheWrite: 100, cacheRead: 400, total: 3370 };
const REPO_COST_NANO = '49075000'; // alpha + beta
const REPO_TOKENS_TOTAL = ALPHA_TOKENS.total + BETA_TOKENS.total; // 4870

interface Fixture {
  tmpDir: string;
  repo: FixtureRepo;
  claudeDir: string;
  configDir: string;
  alphaHash: string;
  betaHash: string;
}

/** Two costed commits, each fed by its own session; one trailing non-edit call. */
async function makeFixture(tag: string): Promise<Fixture> {
  const tmpDir = await mkdtemp(path.join(os.tmpdir(), `vibebill-${tag}-`));
  const repo = await makeRepo(tmpDir);
  const claudeDir = path.join(tmpDir, 'claude');
  const configDir = path.join(tmpDir, 'config'); // empty: no refreshed price table leaks in
  await mkdir(configDir, { recursive: true });

  const sessionAlpha = session({
    sessionId: '514e0000-0000-4000-8000-000000000001',
    defaultCwd: repo.root,
  })
    .at(T0 + 5 * MIN_MS)
    .call({
      usage: { input: 1000, output: 500 },
      edits: [path.join(repo.root, 'src/alpha.ts')],
    });

  const sessionBeta = session({
    sessionId: '514e0000-0000-4000-8000-000000000002',
    defaultCwd: repo.root,
  })
    .at(T0 + 20 * MIN_MS)
    .call({
      usage: { input: 2000, output: 800, cacheWrite: 100, cacheRead: 400 },
      edits: [path.join(repo.root, 'src/beta.ts')],
    })
    // Trailing non-edit call: forward-attach has no later edit, so it adopts the
    // PREVIOUS edit's attribution (spec §5.4 Step C) — the beta commit.
    .at(T0 + 21 * MIN_MS)
    .call({ usage: { input: 50, output: 20 } });

  await writeTranscripts(claudeDir, [sessionAlpha, sessionBeta]);

  const alphaHash = await repo.commitFile('src/alpha.ts', 'export const alpha = 1;\n', {
    message: 'feat: alpha',
    authorDate: T0 + 10 * MIN_MS,
  });
  const betaHash = await repo.commitFile('src/beta.ts', 'export const beta = 2;\n', {
    message: 'feat: beta',
    authorDate: T0 + 25 * MIN_MS,
  });

  return { tmpDir, repo, claudeDir, configDir, alphaHash, betaHash };
}

/** Hermetic isolation: fixture adapters only, empty config dir, pinned clock. */
function stubFixtureEnv(f: Fixture): void {
  vi.stubEnv('VIBEBILL_CLAUDE_DIR', f.claudeDir);
  vi.stubEnv('VIBEBILL_CODEX_DIR', '/nonexistent');
  vi.stubEnv('VIBEBILL_GEMINI_DIR', '/nonexistent');
  vi.stubEnv('VIBEBILL_CONFIG_DIR', f.configDir);
  vi.stubEnv('VIBEBILL_NOW', String(NOW_MS));
}

/** Drive the real CLI in-process; returns exit code and captured streams. */
async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const io = captureIO();
  process.exitCode = 0;
  await buildProgram(io).parseAsync(['node', 'vibebill', ...args]);
  const exitCode = Number(process.exitCode ?? 0);
  process.exitCode = 0;
  return { exitCode, stdout: io.stdout.join('\n'), stderr: io.stderr.join('\n') };
}

/** RAW note blob (untrimmed — byte-identity matters) via execFile, per S14. */
async function showVibebillNote(repoRoot: string, hash: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['notes', '--ref=vibebill', 'show', hash], {
    cwd: repoRoot,
  });
  return stdout;
}

/** `git notes --ref=vibebill list` → [{ noteBlob, annotated }] (empty when none). */
async function listVibebillNotes(repoRoot: string): Promise<Array<{ noteBlob: string; annotated: string }>> {
  const { stdout } = await execFileAsync('git', ['notes', '--ref=vibebill', 'list'], {
    cwd: repoRoot,
  });
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => {
      const [noteBlob = '', annotated = ''] = line.split(' ');
      return { noteBlob, annotated };
    });
}

/** The spec §6.8 note payload shape. */
interface NoteJson {
  v: number;
  costNanoUsd: string;
  tokens: { input: number; output: number; cacheWrite: number; cacheRead: number; total: number };
  confidence: string;
  provenance: string;
  generatedBy: string;
}

interface NotesSyncJson {
  schemaVersion: number;
  command: string;
  vibebill: string;
  invariant: { ok: boolean; deltaTokens: number };
  synced: Array<{ hash: string; costNanoUsd: string; tokens: number }>;
}

interface NotesClearJson {
  command: string;
  cleared: string[];
}

describe('S14 — notes sync idempotence (spec §6.8/§11)', () => {
  let f: Fixture;
  let originalCwd: string;

  beforeAll(async () => {
    f = await makeFixture('s14');
    stubFixtureEnv(f);
    originalCwd = process.cwd();
    process.chdir(f.repo.root);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    await rm(f.tmpDir, { recursive: true, force: true });
  });

  it('writes spec-shaped notes; a second sync is byte-identical with no duplicates', async () => {
    const run1 = await runCli(['notes', 'sync', '--json']);
    expect(run1.exitCode).toBe(0);
    const payload1 = JSON.parse(run1.stdout) as NotesSyncJson;
    expect(payload1.schemaVersion).toBe(1);
    expect(payload1.command).toBe('notes');
    expect(payload1.invariant.ok).toBe(true);
    expect(payload1.invariant.deltaTokens).toBe(0);

    // Exactly the two costed commits, in sorted-hash order.
    const expectedHashes = [f.alphaHash, f.betaHash].sort();
    expect(payload1.synced.map((s) => s.hash)).toEqual(expectedHashes);

    // -- note blobs after the first sync ----------------------------------
    const alpha1 = await showVibebillNote(f.repo.root, f.alphaHash);
    const beta1 = await showVibebillNote(f.repo.root, f.betaHash);

    // Spec §6.8 shape, with the documented fixed key order.
    for (const blob of [alpha1, beta1]) {
      const parsed = JSON.parse(blob) as NoteJson;
      expect(Object.keys(parsed)).toEqual([
        'v',
        'costNanoUsd',
        'tokens',
        'confidence',
        'provenance',
        'generatedBy',
      ]);
      expect(parsed.v).toBe(1);
      expect(parsed.generatedBy).toBe(`vibebill@${payload1.vibebill}`);
      expect(parsed.generatedBy).toMatch(/^vibebill@\d+\.\d+\.\d+/);
    }

    const alphaNote = JSON.parse(alpha1) as NoteJson;
    expect(alphaNote.costNanoUsd).toBe(ALPHA_COST_NANO);
    expect(alphaNote.tokens).toEqual(ALPHA_TOKENS);
    expect(alphaNote.confidence).toBe('high');
    expect(alphaNote.provenance).toBe('measured');

    const betaNote = JSON.parse(beta1) as NoteJson;
    expect(betaNote.costNanoUsd).toBe(BETA_COST_NANO);
    expect(betaNote.tokens).toEqual(BETA_TOKENS);
    expect(betaNote.confidence).toBe('high');
    expect(betaNote.provenance).toBe('measured');

    // The --json synced rows agree with the notes they wrote.
    const syncedByHash = new Map(payload1.synced.map((s) => [s.hash, s]));
    expect(syncedByHash.get(f.alphaHash)).toEqual({
      hash: f.alphaHash,
      costNanoUsd: ALPHA_COST_NANO,
      tokens: ALPHA_TOKENS.total,
    });
    expect(syncedByHash.get(f.betaHash)).toEqual({
      hash: f.betaHash,
      costNanoUsd: BETA_COST_NANO,
      tokens: BETA_TOKENS.total,
    });

    // -- second sync: idempotent -------------------------------------------
    const run2 = await runCli(['notes', 'sync', '--json']);
    expect(run2.exitCode).toBe(0);
    const payload2 = JSON.parse(run2.stdout) as NotesSyncJson;
    expect(payload2.synced).toEqual(payload1.synced);

    const alpha2 = await showVibebillNote(f.repo.root, f.alphaHash);
    const beta2 = await showVibebillNote(f.repo.root, f.betaHash);
    expect(alpha2).toBe(alpha1); // byte-identical
    expect(beta2).toBe(beta1); // byte-identical

    // No duplicate notes: exactly one note per costed commit, none extra.
    const listing = await listVibebillNotes(f.repo.root);
    expect(listing).toHaveLength(2);
    const annotated = listing.map((n) => n.annotated).sort();
    expect(annotated).toEqual(expectedHashes);
    expect(new Set(annotated).size).toBe(2);
  });

  it('--clear removes only refs/notes/vibebill; a default-ref note survives', async () => {
    // Make sure vibebill notes exist (idempotent), and check the teaching line.
    const sync = await runCli(['notes', 'sync']);
    expect(sync.exitCode).toBe(0);
    expect(sync.stdout).toContain('git log --notes=vibebill');

    // A DIFFERENT note on git's DEFAULT notes ref — vibebill must never touch it.
    const humanNote = 'human note (default ref) — not vibebill business';
    await f.repo.git(['notes', 'add', '-m', humanNote, f.alphaHash]);

    const clear = await runCli(['notes', 'sync', '--clear', '--json']);
    expect(clear.exitCode).toBe(0);
    const payload = JSON.parse(clear.stdout) as NotesClearJson;
    expect(payload.command).toBe('notes');
    expect(payload.cleared).toEqual([f.alphaHash, f.betaHash].sort());

    // vibebill's ref is empty: no listing, and `show` fails for both commits.
    expect(await listVibebillNotes(f.repo.root)).toEqual([]);
    await expect(showVibebillNote(f.repo.root, f.alphaHash)).rejects.toThrow();
    await expect(showVibebillNote(f.repo.root, f.betaHash)).rejects.toThrow();

    // The default-ref note survives, byte-for-byte (repo.git trims stdout).
    expect(await f.repo.git(['notes', 'show', f.alphaHash])).toBe(humanNote);
  });
});

interface SummaryJson {
  command: string;
  invariant: { ok: boolean; totalTokens: number; deltaTokens: number };
  totals: { cost: { nanoUsd: string }; tokens: { total: number }; events: number };
  covered: { sessions: number; commits: number };
}

interface LogJson {
  command: string;
  invariant: { ok: boolean };
  commits: Array<{ hash: string; cost: { nanoUsd: string } | null; confidence: string | null }>;
}

describe('determinism — same inputs twice → deep-equal JSON (spec §11 property)', () => {
  let f: Fixture;
  let originalCwd: string;

  beforeAll(async () => {
    f = await makeFixture('det');
    stubFixtureEnv(f);
    originalCwd = process.cwd();
    process.chdir(f.repo.root);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    await rm(f.tmpDir, { recursive: true, force: true });
  });

  it('summary --json and log --json agree across cold, warm, and re-cold runs', async () => {
    // -- run 1: cold (no cache yet) ----------------------------------------
    const coldSummaryRun = await runCli(['summary', '--json']);
    expect(coldSummaryRun.exitCode).toBe(0);
    const coldSummary = JSON.parse(coldSummaryRun.stdout) as SummaryJson;

    const coldLogRun = await runCli(['log', '--json']);
    expect(coldLogRun.exitCode).toBe(0);
    const coldLog = JSON.parse(coldLogRun.stdout) as LogJson;

    // Ground-truth anchors so "deterministically wrong" cannot pass.
    expect(coldSummary.command).toBe('summary');
    expect(coldSummary.invariant.ok).toBe(true);
    expect(coldSummary.invariant.deltaTokens).toBe(0);
    expect(coldSummary.invariant.totalTokens).toBe(REPO_TOKENS_TOTAL);
    expect(coldSummary.totals.cost.nanoUsd).toBe(REPO_COST_NANO);
    expect(coldSummary.totals.tokens.total).toBe(REPO_TOKENS_TOTAL);
    expect(coldSummary.totals.events).toBe(3);
    expect(coldSummary.covered).toEqual({ sessions: 2, commits: 2 });

    expect(coldLog.command).toBe('log');
    expect(coldLog.invariant.ok).toBe(true);
    expect(coldLog.commits.map((c) => c.hash)).toEqual([f.betaHash, f.alphaHash]); // newest first
    expect(coldLog.commits[0]?.cost?.nanoUsd).toBe(BETA_COST_NANO);
    expect(coldLog.commits[1]?.cost?.nanoUsd).toBe(ALPHA_COST_NANO);
    expect(coldLog.commits[0]?.confidence).toBe('high');
    expect(coldLog.commits[1]?.confidence).toBe('high');

    // -- run 2: warm (the first run populated .vibebill/cache) --------------
    const cacheDir = path.join(f.repo.root, '.vibebill');
    expect(existsSync(cacheDir)).toBe(true);

    const warmSummary = JSON.parse((await runCli(['summary', '--json'])).stdout) as SummaryJson;
    const warmLog = JSON.parse((await runCli(['log', '--json'])).stdout) as LogJson;
    expect(warmSummary).toEqual(coldSummary);
    expect(warmLog).toEqual(coldLog);

    // -- run 3: cold again (cache wiped) must equal the warm payloads -------
    await rm(cacheDir, { recursive: true, force: true });
    expect(existsSync(cacheDir)).toBe(false);

    const recoldSummary = JSON.parse((await runCli(['summary', '--json'])).stdout) as SummaryJson;
    const recoldLog = JSON.parse((await runCli(['log', '--json'])).stdout) as LogJson;
    expect(recoldSummary).toEqual(warmSummary);
    expect(recoldLog).toEqual(warmLog);
  });
});
