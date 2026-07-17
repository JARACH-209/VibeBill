/**
 * Golden scenarios S6, S7, S8 (spec §11) — ingest robustness, driven through
 * the real CLI (direct `buildProgram().parseAsync` invocation, permitted by
 * §11) against hermetic fixtures:
 *
 * - S6: the SAME logical API call (same message.id + requestId, same usage)
 *   written into TWO transcript files is counted ONCE (spec §5.1.4), and
 *   `doctor --json` reports the dedupe stat.
 * - S7: an unknown model's tokens are reported, its cost renders as $— ($-
 *   plain), exactly ONE aggregated warning names the model, exit 0 (spec §5.5).
 * - S8: malformed lines — truncated final line without newline (§7.12), a
 *   binary-garbage line (§5.1.3), and a line beyond the 10 MB cap (§7.13) —
 *   are skipped + counted without a crash; coverage still reports and the
 *   token-conservation invariant holds.
 *
 * Isolation: VIBEBILL_CLAUDE_DIR / VIBEBILL_CODEX_DIR / VIBEBILL_GEMINI_DIR /
 * VIBEBILL_CONFIG_DIR are stubbed per scenario so no real machine state leaks
 * in, and VIBEBILL_NOW pins the clock. Every id and timestamp is fixed.
 */
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
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

/** Injected "now": 19 days past the fixture epoch, so nothing wall-clock leaks in. */
const FIXED_NOW_MS = FIXTURE_EPOCH_MS + 19 * DAY;

/** Priced fixture model (prices/prices.json: $5/$25/$6.25/$0.50 per MTok). */
const KNOWN_MODEL = 'claude-opus-4-8';
const UNKNOWN_MODEL = 'totally-unknown-model-x';

// ---------------------------------------------------------------------------
// --json payload slices asserted on (docs/json-schemas.md)
// ---------------------------------------------------------------------------

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

interface SummaryJson {
  schemaVersion: number;
  command: string;
  pricing: { asOf: string; origin: string };
  invariant: {
    ok: boolean;
    totalTokens: number;
    attributed: number;
    waste: number;
    overhead: number;
    outOfScope: number;
    deltaTokens: number;
  };
  warnings: string[];
  accountingMismatch?: { tokens: number };
  totals: {
    cost: MoneyJson;
    tokens: TokensJson;
    events: number;
    unpricedEvents: number;
    unpricedTokens: TokensJson;
  };
  byModel: Array<{
    model: string;
    displayName: string | null;
    priced: boolean;
    events: number;
    tokens: TokensJson;
    cost: MoneyJson | null;
  }>;
  covered: { sessions: number; commits: number };
}

interface DoctorJson {
  schemaVersion: number;
  command: string;
  ok: boolean;
  checks: Array<{ name: string; status: string; detail: string; remedy: string | null }>;
  parse: {
    filesFound: number;
    filesRead: number;
    filesSkipped: number;
    linesRead: number;
    eventsExtracted: number;
    linesSkipped: number;
    duplicatesRemoved: number;
    outOfScope: { events: number; tokens: number };
  } | null;
  unknownModels?: string[];
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface CliRun {
  stdout: string[];
  stderr: string[];
  exitCode: number;
}

/** Drive the real CLI in-process from the fixture repo; always restores cwd. */
async function runCli(repoRoot: string, args: string[]): Promise<CliRun> {
  const io = captureIO();
  const prevCwd = process.cwd();
  process.chdir(repoRoot);
  process.exitCode = 0;
  try {
    await buildProgram(io).parseAsync(['node', 'vibebill', ...args]);
    const exitCode = typeof process.exitCode === 'number' ? process.exitCode : 0;
    return { stdout: io.stdout, stderr: io.stderr, exitCode };
  } finally {
    process.exitCode = 0;
    process.chdir(prevCwd);
  }
}

/** Parse the single JSON document a --json run prints on stdout. */
function payload<T>(run: CliRun): T {
  return JSON.parse(run.stdout.join('\n')) as T;
}

function mustFind<T>(items: readonly T[], pred: (t: T) => boolean, what: string): T {
  const hit = items.find(pred);
  if (hit === undefined) throw new Error(`fixture assertion: missing ${what}`);
  return hit;
}

interface ScenarioEnv {
  tmp: string;
  claudeDir: string;
  repo: FixtureRepo;
}

/**
 * Hermetic per-scenario sandbox: fresh temp tree, fixture git repo with one
 * commit at the fixture epoch, and every VIBEBILL_* env override stubbed so
 * the real ~/.claude, ~/.codex, ~/.gemini and ~/.config/vibebill never leak in.
 */
async function setupScenario(slug: string): Promise<ScenarioEnv> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), `vibebill-${slug}-`));
  const claudeDir = path.join(tmp, 'claude');
  const configDir = path.join(tmp, 'config'); // empty: bundled price table only
  await mkdir(claudeDir, { recursive: true });
  await mkdir(configDir, { recursive: true });
  const repo = await makeRepo(tmp);
  await repo.commitFile('README.md', 'fixture repo\n', {
    message: 'chore: seed fixture repo',
    authorDate: FIXTURE_EPOCH_MS,
  });
  vi.stubEnv('VIBEBILL_CLAUDE_DIR', claudeDir);
  vi.stubEnv('VIBEBILL_CODEX_DIR', path.join(tmp, 'nonexistent-codex'));
  vi.stubEnv('VIBEBILL_GEMINI_DIR', path.join(tmp, 'nonexistent-gemini'));
  vi.stubEnv('VIBEBILL_CONFIG_DIR', configDir);
  vi.stubEnv('VIBEBILL_NOW', String(FIXED_NOW_MS));
  return { tmp, claudeDir, repo };
}

async function teardownScenario(env: ScenarioEnv | undefined): Promise<void> {
  vi.unstubAllEnvs();
  if (env !== undefined) {
    await rm(env.tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// S6 — duplicate JSONL entries across two files (spec §5.1.4)
// ---------------------------------------------------------------------------

describe('S6 — duplicate JSONL entries (same message.id + requestId across two files)', () => {
  const SID = '00000000-0000-4000-8000-0000000000s6';
  let env: ScenarioEnv;

  // Token classes use distinct values so a class swap or a double count can
  // never cancel out. Expected deduped totals:
  //   input 100+200+300=600 · output 11+23+31=65
  //   cacheWrite 7+13+17=37 · cacheRead 3+5+19=27  → total 729
  const DUP = { input: 200, output: 23, cacheWrite: 13, cacheRead: 5 };

  beforeAll(async () => {
    env = await setupScenario('s6');
    // File A: one unique call, then THE duplicated call.
    const fileA = session({ sessionId: SID, defaultCwd: env.repo.root, defaultModel: KNOWN_MODEL })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR)
      .call({
        usage: { input: 100, output: 11, cacheWrite: 7, cacheRead: 3 },
        messageId: 'msg_s6_unique_a',
        requestId: 'req_s6_unique_a',
      })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR + 5 * MIN)
      .call({ usage: DUP, messageId: 'msg_s6_dup', requestId: 'req_s6_dup' });
    // File B (same session resumed into a second file): the SAME logical call
    // again — identical message.id, requestId, usage and timestamp — then one
    // more unique call. Every id is explicit so the two builders cannot
    // accidentally collide on their deterministic per-file counters.
    const fileB = session({ sessionId: SID, defaultCwd: env.repo.root, defaultModel: KNOWN_MODEL })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR + 5 * MIN)
      .call({ usage: DUP, messageId: 'msg_s6_dup', requestId: 'req_s6_dup' })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR + 10 * MIN)
      .call({
        usage: { input: 300, output: 31, cacheWrite: 17, cacheRead: 19 },
        messageId: 'msg_s6_unique_b',
        requestId: 'req_s6_unique_b',
      });
    await writeTranscripts(env.claudeDir, [
      fileA,
      { builder: fileB, fileName: `${SID}-resumed.jsonl` },
    ]);
  });

  afterAll(async () => {
    await teardownScenario(env);
  });

  it('summary --json counts the duplicated call exactly once in the totals', async () => {
    const run = await runCli(env.repo.root, ['summary', '--json']);
    expect(run.exitCode).toBe(0);
    const json = payload<SummaryJson>(run);

    expect(json.command).toBe('summary');
    expect(json.pricing.origin).toBe('bundled');

    // Three distinct calls survive; the fourth occurrence was the duplicate.
    expect(json.totals.events).toBe(3);
    expect(json.totals.tokens).toEqual({
      input: 600,
      output: 65,
      cacheWrite: 37,
      cacheRead: 27,
      total: 729,
    });
    // Money counted once too (claude-opus-4-8 card, exact bigint nano-USD):
    // 600×5000 + 65×25000 + 37×6250 + 27×500 = 4,869,750.
    expect(json.totals.cost.nanoUsd).toBe('4869750');

    expect(json.byModel).toHaveLength(1);
    const model = mustFind(json.byModel, (m) => m.model === KNOWN_MODEL, `${KNOWN_MODEL} byModel row`);
    expect(model.priced).toBe(true);
    expect(model.events).toBe(3);
    expect(model.tokens.total).toBe(729);

    // Conservation: one session, no edits → everything is overhead, once.
    expect(json.covered.sessions).toBe(1);
    expect(json.invariant.ok).toBe(true);
    expect(json.invariant.totalTokens).toBe(729);
    expect(json.invariant.overhead).toBe(729);
    expect(json.invariant.deltaTokens).toBe(0);
    expect(json.accountingMismatch).toBeUndefined();
    expect(json.warnings.filter((w) => w.includes('unknown model'))).toHaveLength(0);
  });

  it('doctor --json reports parse.duplicatesRemoved for the cross-file duplicate', async () => {
    const run = await runCli(env.repo.root, ['doctor', '--json']);
    expect(run.exitCode).toBe(0);
    const json = payload<DoctorJson>(run);

    expect(json.command).toBe('doctor');
    expect(json.ok).toBe(true);
    expect(json.parse).not.toBeNull();
    // 2 files × 2 calls × (user + assistant) = 8 lines, 4 raw events, 1 dup.
    expect(json.parse).toEqual({
      filesFound: 2,
      filesRead: 2,
      filesSkipped: 0,
      linesRead: 8,
      eventsExtracted: 4,
      linesSkipped: 0,
      duplicatesRemoved: 1,
      outOfScope: { events: 0, tokens: 0 },
    });
  });
});

// ---------------------------------------------------------------------------
// S7 — unknown model (spec §5.5): tokens reported, cost $—, ONE warning, exit 0
// ---------------------------------------------------------------------------

describe('S7 — unknown model: tokens reported, cost $—, single aggregated warning, exit 0', () => {
  const SID = '00000000-0000-4000-8000-0000000000s7';
  let env: ScenarioEnv;

  // Unknown-model traffic (3 events):
  //   input 10+11+12=33 · output 20+21+22=63 · cacheWrite 30+31+32=93
  //   cacheRead 40+41+42=123 → 312 tokens
  // Known-model traffic (2 events): 2×(1000 input + 500 output) = 3000 tokens.
  beforeAll(async () => {
    env = await setupScenario('s7');
    const transcript = session({
      sessionId: SID,
      defaultCwd: env.repo.root,
      defaultModel: KNOWN_MODEL,
    })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR)
      .call({ usage: { input: 1000, output: 500 } })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR + 1 * MIN)
      .call({ model: UNKNOWN_MODEL, usage: { input: 10, output: 20, cacheWrite: 30, cacheRead: 40 } })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR + 2 * MIN)
      .call({ model: UNKNOWN_MODEL, usage: { input: 11, output: 21, cacheWrite: 31, cacheRead: 41 } })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR + 3 * MIN)
      .call({ model: UNKNOWN_MODEL, usage: { input: 12, output: 22, cacheWrite: 32, cacheRead: 42 } })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR + 4 * MIN)
      .call({ usage: { input: 1000, output: 500 } });
    await writeTranscripts(env.claudeDir, [transcript]);
  });

  afterAll(async () => {
    await teardownScenario(env);
  });

  it('summary --json reports the tokens, prices nothing for the model, and exits 0', async () => {
    const run = await runCli(env.repo.root, ['summary', '--json']);
    expect(run.exitCode).toBe(0);
    const json = payload<SummaryJson>(run);

    // Unknown-model tokens ARE included in the totals (measured, never hidden).
    expect(json.totals.events).toBe(5);
    expect(json.totals.tokens.total).toBe(3312);
    expect(json.totals.unpricedEvents).toBe(3);
    expect(json.totals.unpricedTokens).toEqual({
      input: 33,
      output: 63,
      cacheWrite: 93,
      cacheRead: 123,
      total: 312,
    });

    // …but they contribute zero invented dollars: the grand total is exactly
    // the known-model cost (2000 input × 5000 + 1000 output × 25000 nano-USD).
    expect(json.totals.cost.nanoUsd).toBe('35000000');

    const unknown = mustFind(json.byModel, (m) => m.model === UNKNOWN_MODEL, 'unknown byModel row');
    expect(unknown.priced).toBe(false);
    expect(unknown.cost).toBeNull();
    expect(unknown.displayName).toBeNull();
    expect(unknown.events).toBe(3);
    expect(unknown.tokens.total).toBe(312);

    const known = mustFind(json.byModel, (m) => m.model === KNOWN_MODEL, 'known byModel row');
    expect(known.priced).toBe(true);
    expect(known.cost).not.toBeNull();
    expect(known.cost?.nanoUsd).toBe('35000000');

    expect(json.invariant.ok).toBe(true);
    expect(json.accountingMismatch).toBeUndefined();
  });

  it('emits EXACTLY ONE aggregated warning naming the model (warnings array + stderr)', async () => {
    const run = await runCli(env.repo.root, ['summary', '--json']);
    expect(run.exitCode).toBe(0);
    const json = payload<SummaryJson>(run);

    // One aggregated entry for 3 unpriced events — never one warning per event.
    const inWarnings = json.warnings.filter((w) => w.includes(UNKNOWN_MODEL));
    expect(inWarnings).toHaveLength(1);
    expect(inWarnings[0]).toContain('unknown model');
    expect(inWarnings[0]).toContain('3 events');
    expect(inWarnings[0]).toContain('312 tokens');

    // The same single warning line on stderr, once.
    expect(run.stderr.filter((l) => l.includes(UNKNOWN_MODEL))).toHaveLength(1);
  });

  it('text output shows $- (plain) for the unknown model and warns once on stderr', async () => {
    const run = await runCli(env.repo.root, ['summary', '--no-color']);
    expect(run.exitCode).toBe(0);
    const text = run.stdout.join('\n');

    // Unpriced summary line (spec §6.2): "$—" with color, "$-" plain.
    expect(text).toContain('unpriced: 312 tokens across 3 events ($-) — unknown models');
    // The cost-by-model table renders the unknown model's cost cell as $-.
    expect(text).toMatch(new RegExp(`^${UNKNOWN_MODEL}\\s+3\\s+312\\s+\\$-$`, 'm'));

    expect(run.stderr.filter((l) => l.includes(UNKNOWN_MODEL))).toHaveLength(1);
  });

  it('doctor --json lists the model under unknownModels', async () => {
    const run = await runCli(env.repo.root, ['doctor', '--json']);
    expect(run.exitCode).toBe(0);
    const json = payload<DoctorJson>(run);
    expect(json.unknownModels).toEqual([UNKNOWN_MODEL]);
    const check = mustFind(json.checks, (ch) => ch.name === 'unknown models', 'unknown-models check');
    expect(check.status).toBe('warn');
    expect(check.detail).toContain(UNKNOWN_MODEL);
  });
});

// ---------------------------------------------------------------------------
// S8 — malformed lines (spec §5.1.3, §7.12, §7.13): skipped + counted, no crash
// ---------------------------------------------------------------------------

describe('S8 — malformed lines: truncated tail, binary garbage, >10MB line', () => {
  const SID = '00000000-0000-4000-8000-0000000000s8';
  const VALID_EVENTS = 4; // N
  let env: ScenarioEnv;

  beforeAll(async () => {
    env = await setupScenario('s8');
    // 4 valid calls (8 well-formed lines) with an oversized line mixed in:
    // 11 MiB of 'x' — comfortably past the 10 MiB per-line cap (spec §7.13),
    // generated cheaply as a single repeat.
    const transcript = session({
      sessionId: SID,
      defaultCwd: env.repo.root,
      defaultModel: KNOWN_MODEL,
    })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR)
      .call({ usage: { input: 100, output: 10 } })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR + 1 * MIN)
      .call({ usage: { input: 200, output: 20, cacheWrite: 5 } })
      .at(FIXTURE_EPOCH_MS + 10 * HOUR + 2 * MIN)
      .call({ usage: { input: 300, output: 30, cacheRead: 7 } })
      .raw('x'.repeat(11 * 1024 * 1024))
      .at(FIXTURE_EPOCH_MS + 10 * HOUR + 3 * MIN)
      .call({ usage: { input: 400, output: 40 } });
    const [filePath] = await writeTranscripts(env.claudeDir, [transcript]);
    if (filePath === undefined) throw new Error('writeTranscripts wrote nothing');

    // Append (a) one binary-garbage line — raw bytes, several of them invalid
    // UTF-8 (0xfe, 0xff, overlong 0xc0 0xaf), none of them \n — and (b) a
    // truncated final line with NO trailing newline (agent mid-write, §7.12).
    const binaryGarbage = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0xfe, 0xff, 0xc0, 0xaf]);
    const truncatedTail = `{"type":"assistant","sessionId":"${SID}","timestamp":"2026-01-01T10:0`;
    await appendFile(
      filePath,
      Buffer.concat([binaryGarbage, Buffer.from('\n', 'utf8'), Buffer.from(truncatedTail, 'utf8')]),
    );
  });

  afterAll(async () => {
    await teardownScenario(env);
  });

  it('summary --json does not crash: events == N and the invariant holds', async () => {
    const run = await runCli(env.repo.root, ['summary', '--json']);
    expect(run.exitCode).toBe(0);
    expect(run.stderr.some((l) => l.includes('internal error'))).toBe(false);
    const json = payload<SummaryJson>(run);

    expect(json.totals.events).toBe(VALID_EVENTS);
    expect(json.totals.tokens).toEqual({
      input: 1000,
      output: 100,
      cacheWrite: 5,
      cacheRead: 7,
      total: 1112,
    });
    expect(json.invariant.ok).toBe(true);
    expect(json.invariant.totalTokens).toBe(1112);
    expect(json.invariant.deltaTokens).toBe(0);
    expect(json.accountingMismatch).toBeUndefined();
  });

  it('doctor --json counts the three bad lines as skipped and still reports coverage', async () => {
    const run = await runCli(env.repo.root, ['doctor', '--json']);
    expect(run.exitCode).toBe(0);
    expect(run.stderr.some((l) => l.includes('internal error'))).toBe(false);
    const json = payload<DoctorJson>(run);

    expect(json.ok).toBe(true);
    // 8 well-formed lines + oversized + binary garbage + truncated tail = 11
    // read, of which exactly the 3 bad ones are skipped (spec §5.1.3).
    expect(json.parse).toEqual({
      filesFound: 1,
      filesRead: 1,
      filesSkipped: 0,
      linesRead: 11,
      eventsExtracted: VALID_EVENTS,
      linesSkipped: 3,
      duplicatesRemoved: 0,
      outOfScope: { events: 0, tokens: 0 },
    });

    // Coverage % still reported despite the junk: 8/11 = 72.7%.
    const coverage = mustFind(json.checks, (ch) => ch.name === 'parse coverage', 'coverage check');
    expect(coverage.status).toBe('warn');
    expect(coverage.detail).toContain('3 skipped');
    expect(coverage.detail).toContain('(72.7% coverage)');
  });
});
