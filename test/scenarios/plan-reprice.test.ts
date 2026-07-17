/**
 * Scenarios S9 (plan mode) and S11 (reprice) from spec §11, driving the real
 * CLI in-process (buildProgram + captureIO) against hermetic fixtures.
 *
 * S9  — plan mode is WORDING ONLY (spec §5.5): headers/totals switch to
 *       "API-equivalent value" with the "consumed on your <plan> subscription"
 *       suffix, dollar amounts stay byte-identical (zero plan-price math),
 *       --json carries the plan, and the --plan flag overrides
 *       vibebill.config.json (spec §6.9).
 * S11 — reprice (spec §6.6, §5.5, §8): measured claude traffic repriced on a
 *       cheap card matches an independently implemented bigint nano-USD
 *       expectation (per-event, per-class floor division — LedgerEntry costs
 *       are per event, spec §4/§8), the honesty label appears verbatim in
 *       text AND --json, and an unknown target model exits 1 listing the
 *       known model ids. JSON shapes asserted per docs/json-schemas.md:
 *       `repriced.cost` is a MoneyBreakdown, `cacheFallback` is top-level,
 *       target is `{ id, displayName }`, scope is `{ kind, range, events,
 *       tokens }`.
 */

import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { buildProgram } from '../../src/cli/index.js';
import { captureIO } from '../../src/cli/io.js';
import { makeRepo, toGitIsoDate, type FixtureRepo } from '../helpers/repo.js';
import { FIXTURE_EPOCH_MS, session, writeTranscripts } from '../helpers/transcripts.js';

// ---------------------------------------------------------------------------
// Shared fixture: one session (2 edit events + 1 trailing non-edit event) on a
// claude model, all landing in one commit minutes later — every token is
// attributed, so the invariant is trivially checkable and there is no waste /
// in-progress / overhead noise to disturb S9's byte-identity or S11's totals.
// ---------------------------------------------------------------------------

const MODEL = 'claude-opus-4-8'; // bundled card: 5 / 25 / 6.25 / 0.5 $/MTok
const REPRICE_TARGET = 'deepseek-v4-pro'; // cheap card WITH cache prices (no fallback)

const MIN = 60_000;
const HOUR = 3_600_000;
const EDIT1_TS = FIXTURE_EPOCH_MS + 10 * HOUR; // 2026-01-01T10:00:00Z
const EDIT2_TS = EDIT1_TS + 2 * MIN;
const TRAIL_TS = EDIT1_TS + 4 * MIN;
const COMMIT_TS = EDIT1_TS + 10 * MIN; // grace/horizon unambiguous: minutes, not ms
const NOW_MS = FIXTURE_EPOCH_MS + 24 * HOUR; // 2026-01-02T00:00:00Z

/** Fixture token vectors; cacheRead values chosen so per-class floor division matters. */
const USAGE = [
  { input: 123_457, output: 98_765, cacheWrite: 4_567, cacheRead: 1_234_567 }, // edit
  { input: 33_333, output: 22_222, cacheWrite: 111, cacheRead: 999_999 }, // edit
  { input: 777, output: 555, cacheWrite: 0, cacheRead: 123 }, // trailing non-edit
] as const;

/** Σ over USAGE per token class (ground truth for scope/invariant asserts). */
const TOKEN_SUMS = USAGE.reduce(
  (sum, u) => ({
    input: sum.input + u.input,
    output: sum.output + u.output,
    cacheWrite: sum.cacheWrite + u.cacheWrite,
    cacheRead: sum.cacheRead + u.cacheRead,
  }),
  { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
);

/** Σ over USAGE of every token class (ground truth for the invariant). */
const TOTAL_TOKENS =
  TOKEN_SUMS.input + TOKEN_SUMS.output + TOKEN_SUMS.cacheWrite + TOKEN_SUMS.cacheRead;

interface CliRun {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Drive the real CLI in-process from the fixture repo; always resets exitCode. */
async function runCli(repoRoot: string, args: string[]): Promise<CliRun> {
  const io = captureIO();
  process.chdir(repoRoot);
  process.exitCode = 0;
  await buildProgram(io).exitOverride().parseAsync(['node', 'vibebill', ...args]);
  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;
  return { exitCode, stdout: io.stdout.join('\n'), stderr: io.stderr.join('\n') };
}

interface Fixture {
  tmp: string;
  repo: FixtureRepo;
  claudeDir: string;
  configDir: string;
}

/** Build repo + transcript + empty config dir and stub every VIBEBILL_* env. */
async function makeFixture(tag: string, sessionId: string): Promise<Fixture> {
  const tmp = await mkdtemp(path.join(os.tmpdir(), `vibebill-${tag}-`));
  const claudeDir = path.join(tmp, 'claude');
  const configDir = path.join(tmp, 'config');
  await mkdir(configDir, { recursive: true });

  const repo = await makeRepo(tmp);
  const appPath = path.join(repo.root, 'src', 'app.ts');
  const s = session({ sessionId, defaultCwd: repo.root, defaultBranch: 'main', defaultModel: MODEL });
  s.at(EDIT1_TS).call({ usage: USAGE[0], edits: [appPath] });
  s.at(EDIT2_TS).call({ usage: USAGE[1], edits: [appPath] });
  s.at(TRAIL_TS).call({ usage: USAGE[2] }); // non-edit: forward/backward-attaches (§5.4 Step C)
  await writeTranscripts(claudeDir, [s]);

  await repo.commitFile('src/app.ts', 'export const app = 1;\n', {
    message: 'feat: add app',
    authorDate: toGitIsoDate(COMMIT_TS),
  });

  vi.stubEnv('VIBEBILL_CLAUDE_DIR', claudeDir);
  vi.stubEnv('VIBEBILL_CODEX_DIR', '/nonexistent');
  vi.stubEnv('VIBEBILL_GEMINI_DIR', '/nonexistent');
  vi.stubEnv('VIBEBILL_CONFIG_DIR', configDir);
  vi.stubEnv('VIBEBILL_AIDER_HISTORY', ''); // empty = ignored; masks any host value
  vi.stubEnv('VIBEBILL_NOW', String(NOW_MS));
  return { tmp, repo, claudeDir, configDir };
}

/** Every "$1,234.56"-shaped amount in a text report, in print order. */
function dollarAmounts(text: string): string[] {
  return text.match(/\$\d[\d,]*\.\d{2}/g) ?? [];
}

interface MoneyJson {
  nanoUsd: string;
  usd: string;
}

interface Envelope {
  plan: string | null;
  invariant: {
    ok: boolean;
    totalTokens: number;
    attributed: number;
    waste: number;
    overhead: number;
    outOfScope: number;
    deltaTokens: number;
  };
  [key: string]: unknown;
}

function parsePayload(run: CliRun): Envelope & Record<string, unknown> {
  return JSON.parse(run.stdout) as Envelope & Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Independent §8 money reference (NO imports from src/pricing): decimal price
// string -> exact bigint nano-USD per MTok; cost = floor(tokens × nanoPerMTok
// / 1e6) per event per token class (LedgerEntry costs are per event, §4).
// ---------------------------------------------------------------------------

const NANO_PER_USD = 1_000_000_000n;
const TOKENS_PER_MTOK = 1_000_000n;

function nanoPerMTok(price: string): bigint {
  const m = /^(\d+)(?:\.(\d{1,9}))?$/.exec(price);
  if (m === null || m[1] === undefined) {
    throw new Error(`test reference: unparseable price string ${JSON.stringify(price)}`);
  }
  return BigInt(m[1]) * NANO_PER_USD + BigInt((m[2] ?? '').padEnd(9, '0'));
}

interface PriceCardJson {
  displayName: string;
  inputPerMTok: string;
  outputPerMTok: string;
  cacheWritePerMTok?: string;
  cacheReadPerMTok?: string;
}

/** The bundled pinned price table (spec §5.5), read straight from disk. */
const PRICE_TABLE = JSON.parse(
  readFileSync(new URL('../../prices/prices.json', import.meta.url), 'utf8'),
) as { models: Record<string, PriceCardJson> };

const TOKEN_CLASSES = ['input', 'output', 'cacheWrite', 'cacheRead'] as const;

function referenceCost(card: PriceCardJson): Record<(typeof TOKEN_CLASSES)[number] | 'total', bigint> {
  const rate = {
    input: nanoPerMTok(card.inputPerMTok),
    output: nanoPerMTok(card.outputPerMTok),
    // §5.5: a card lacking cache prices prices cache classes at the input rate.
    cacheWrite: nanoPerMTok(card.cacheWritePerMTok ?? card.inputPerMTok),
    cacheRead: nanoPerMTok(card.cacheReadPerMTok ?? card.inputPerMTok),
  };
  const sum = { input: 0n, output: 0n, cacheWrite: 0n, cacheRead: 0n, total: 0n };
  for (const usage of USAGE) {
    for (const cls of TOKEN_CLASSES) {
      const cost = (BigInt(usage[cls]) * rate[cls]) / TOKENS_PER_MTOK;
      sum[cls] += cost;
      sum.total += cost;
    }
  }
  return sum;
}

// ---------------------------------------------------------------------------
// S9 — plan mode
// ---------------------------------------------------------------------------

describe('S9 — plan mode: API-equivalent wording, zero plan-price math (spec §5.5, §6.9)', () => {
  const originalCwd = process.cwd();
  let fixture: Fixture;
  let plainText: CliRun;
  let plainJson: CliRun;
  let planText: CliRun;
  let planJson: CliRun;
  let configText: CliRun;
  let configJson: CliRun;
  let overrideText: CliRun;
  let overrideJson: CliRun;

  beforeAll(async () => {
    fixture = await makeFixture('s9', '00000000-0000-4000-8000-000000000009');

    // Same fixture, with and without --plan (flag runs precede the config write).
    plainText = await runCli(fixture.repo.root, ['summary', '--no-color']);
    plainJson = await runCli(fixture.repo.root, ['summary', '--json']);
    planText = await runCli(fixture.repo.root, ['summary', '--no-color', '--plan', 'max5']);
    planJson = await runCli(fixture.repo.root, ['summary', '--json', '--plan', 'max5']);

    // Now via config file: vibebill.config.json { "plan": "pro" } (spec §6.9).
    await writeFile(
      path.join(fixture.repo.root, 'vibebill.config.json'),
      `${JSON.stringify({ plan: 'pro' })}\n`,
      'utf8',
    );
    configText = await runCli(fixture.repo.root, ['summary', '--no-color']);
    configJson = await runCli(fixture.repo.root, ['summary', '--json']);
    overrideText = await runCli(fixture.repo.root, ['summary', '--no-color', '--plan', 'max5']);
    overrideJson = await runCli(fixture.repo.root, ['summary', '--json', '--plan', 'max5']);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    await rm(fixture.tmp, { recursive: true, force: true });
  });

  it('all runs exit 0 and the accounting invariant holds', () => {
    for (const run of [plainText, plainJson, planText, planJson, configText, configJson, overrideText, overrideJson]) {
      expect(run.exitCode).toBe(0);
    }
    const payload = parsePayload(plainJson);
    expect(payload.invariant).toEqual({
      ok: true,
      totalTokens: TOTAL_TOKENS,
      attributed: TOTAL_TOKENS,
      waste: 0,
      overhead: 0,
      outOfScope: 0,
      deltaTokens: 0,
    });
  });

  it('without a plan the wording is "measured", with no subscription suffix', () => {
    expect(plainText.stdout).toContain('total measured cost:');
    expect(plainText.stdout).not.toContain('API-equivalent');
    expect(plainText.stdout).not.toContain('consumed on your');
  });

  it('--plan max5 switches headers/totals to API-equivalent wording with the subscription suffix', () => {
    expect(planText.stdout).toContain('(API-equivalent value)'); // header suffix
    expect(planText.stdout).toContain('total API-equivalent value:'); // totals label
    expect(planText.stdout).toContain('consumed on your max5 subscription');
    expect(planText.stdout).not.toContain('total measured cost');
  });

  it('dollar amounts are byte-identical with and without --plan (wording only, zero plan-price math)', () => {
    const plain = dollarAmounts(plainText.stdout);
    const plan = dollarAmounts(planText.stdout);
    expect(plain.length).toBeGreaterThan(0);
    expect(plan).toEqual(plain);
  });

  it('--json differs ONLY in the plan field, which is "max5"', () => {
    const plain = parsePayload(plainJson);
    const plan = parsePayload(planJson);
    expect(plain.plan).toBeNull();
    expect(plan.plan).toBe('max5');
    // Every number — costs, tokens, invariant — must be identical (no plan math).
    expect(plan).toEqual({ ...plain, plan: 'max5' });
  });

  it('vibebill.config.json {"plan":"pro"} applies, without changing any number', () => {
    expect(parsePayload(configJson).plan).toBe('pro');
    expect(configText.stdout).toContain('total API-equivalent value:');
    expect(configText.stdout).toContain('consumed on your pro subscription');
    expect(parsePayload(configJson)).toEqual({ ...parsePayload(plainJson), plan: 'pro' });
  });

  it('--plan max5 overrides the config-file plan (flags win, spec §6.9)', () => {
    expect(parsePayload(overrideJson).plan).toBe('max5');
    expect(overrideText.stdout).toContain('consumed on your max5 subscription');
    expect(overrideText.stdout).not.toContain('consumed on your pro subscription');
  });
});

// ---------------------------------------------------------------------------
// S11 — reprice
// ---------------------------------------------------------------------------

/** The exact honesty label mandated by spec §5.5/§6.6 — byte-for-byte. */
const HONESTY_LABEL =
  'repriced — same traffic, different meter; a different model may need more or fewer turns';

describe('S11 — reprice: hand-computed bigint expectation + honesty label (spec §5.5, §6.6, §8)', () => {
  const originalCwd = process.cwd();
  let fixture: Fixture;
  let jsonRun: CliRun;
  let textRun: CliRun;
  let unknownRun: CliRun;

  beforeAll(async () => {
    fixture = await makeFixture('s11', '00000000-0000-4000-8000-000000000011');
    jsonRun = await runCli(fixture.repo.root, ['reprice', '--model', REPRICE_TARGET, '--json']);
    textRun = await runCli(fixture.repo.root, ['reprice', '--model', REPRICE_TARGET, '--no-color']);
    unknownRun = await runCli(fixture.repo.root, [
      'reprice',
      '--model',
      'definitely-not-a-model-2026',
      '--json',
      '--no-color',
    ]);
  });

  afterAll(async () => {
    process.chdir(originalCwd);
    vi.unstubAllEnvs();
    await rm(fixture.tmp, { recursive: true, force: true });
  });

  it('repriced cost matches the independently computed §8 expectation exactly (--json, docs/json-schemas.md shape)', () => {
    expect(jsonRun.exitCode).toBe(0);
    const payload = parsePayload(jsonRun);
    expect(payload.invariant.ok).toBe(true);

    const targetCard = PRICE_TABLE.models[REPRICE_TARGET];
    expect(targetCard).toBeDefined();
    if (targetCard === undefined) return; // narrowing for TS; unreachable
    // The chosen target must have BOTH cache prices, so no input-rate fallback
    // ambiguity can creep into the expectation (spec §5.5).
    expect(targetCard.cacheWritePerMTok).toBeDefined();
    expect(targetCard.cacheReadPerMTok).toBeDefined();

    const expected = referenceCost(targetCard);
    // Guard the in-test reference itself against silent drift: these literals
    // were hand-computed from prices.json (deepseek-v4-pro: 0.435 / 0.87 / 0 /
    // 0.003625 $/MTok) over the USAGE vectors, flooring per event per class.
    expect(expected).toEqual({
      input: 68_541_645n,
      output: 105_741_540n,
      cacheWrite: 0n,
      cacheRead: 8_100_746n,
      total: 182_383_931n,
    });

    // Measured side (claude-opus-4-8 card), same independent reference.
    const measuredCard = PRICE_TABLE.models[MODEL];
    expect(measuredCard).toBeDefined();
    if (measuredCard === undefined) return;
    const expectedMeasured = referenceCost(measuredCard);
    expect(expectedMeasured.total).toBe(4_972_967_000n);
    expect((payload['measured'] as { cost: MoneyJson }).cost.nanoUsd).toBe(
      expectedMeasured.total.toString(),
    );

    // Target identity + scope (docs/json-schemas.md `reprice`).
    expect(payload['target']).toEqual({
      id: REPRICE_TARGET,
      displayName: targetCard.displayName,
    });
    expect(payload['scope']).toEqual({
      kind: 'repo',
      range: null,
      events: USAGE.length,
      tokens: { ...TOKEN_SUMS, total: TOTAL_TOKENS },
    });

    // docs/json-schemas.md `reprice`: repriced.cost is a MoneyBreakdown and
    // cacheFallback sits at the top level — exact nanoUsd string equality per
    // class and total; usd strings hand-rounded half-even to cents.
    expect(payload['repriced']).toEqual({
      provenance: 'repriced',
      cost: {
        input: { nanoUsd: expected.input.toString(), usd: '0.07' },
        output: { nanoUsd: expected.output.toString(), usd: '0.11' },
        cacheWrite: { nanoUsd: expected.cacheWrite.toString(), usd: '0.00' },
        cacheRead: { nanoUsd: expected.cacheRead.toString(), usd: '0.01' },
        total: { nanoUsd: expected.total.toString(), usd: '0.18' },
      },
    });
    expect(payload['cacheFallback']).toBe(false);

    // Exact-bigint delta per-mille, truncated toward zero, hand-computed:
    // (182,383,931 − 4,972,967,000) × 1000 / 4,972,967,000 = −963 ⇒ −96.3%.
    // String() keeps the assert representation-agnostic (string or number).
    expect(String(payload['deltaPct'])).toBe('-96.3');
  });

  it('the honesty label appears EXACTLY in both text output and the --json label field', () => {
    expect(parsePayload(jsonRun)['label']).toBe(HONESTY_LABEL);
    expect(textRun.exitCode).toBe(0);
    expect(textRun.stdout.split('\n')).toContain(HONESTY_LABEL); // verbatim full line
  });

  it('text output prints the repriced total and no cache-fallback note for a card with cache prices', () => {
    expect(textRun.stdout).toContain('repriced total: $0.18');
    expect(textRun.stdout).not.toContain('priced at the input rate');
  });

  it('an unknown target model exits 1 and the error lists the known model ids', () => {
    expect(unknownRun.exitCode).toBe(1);
    expect(unknownRun.stdout.trim()).toBe(''); // no JSON payload on the error path
    expect(unknownRun.stderr).toContain('unknown reprice target model');
    for (const id of Object.keys(PRICE_TABLE.models)) {
      expect(unknownRun.stderr).toContain(id);
    }
  });
});
