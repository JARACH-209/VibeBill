/**
 * Scenario S10 (spec §11): perf smoke — a CI-sized ~50 MiB synthetic Claude
 * Code log must cold-ingest within a generous CI budget with bounded memory,
 * and a warm re-run from the cache must be fast and yield identical counts.
 * This is the "small variant" of scripts/bench.ts that spec §9 requires CI to
 * run so >2× ingest regressions are caught; the full-size targets
 * (cold 500 MB < 30 s) are exercised manually via `npm run bench -- --mb 500`.
 *
 * Budgets (deliberately generous — CI boxes are slow and shared):
 * - cold ingest of ~50 MiB: < 20 s (spec §9 pro-rata would be 3 s)
 * - peak process RSS during cold ingest: < 300 MiB (the spec §9 ceiling; the
 *   vitest worker's own baseline is included, so this is a strict reading)
 * - warm re-run from cache: < 2 s (the spec §9 warm target, unscaled)
 */
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { generateSyntheticClaudeLogs, measureIngest, MIB } from '../../scripts/bench.js';
import type { SyntheticLogStats } from '../../scripts/bench.js';
import { createClaudeCodeAdapter } from '../../src/adapters/claude-code/index.js';
import { totalTokens } from '../../src/core/types.js';

const TARGET_BYTES = 50 * MIB;
const COLD_BUDGET_MS = 20_000;
const WARM_BUDGET_MS = 2_000;
const RSS_BUDGET_BYTES = 300 * MIB;

describe('S10 — perf smoke (spec §9/§11)', () => {
  let tmpDir: string;
  let repoRoot: string;
  let cacheDir: string;
  let gen: SyntheticLogStats;
  let priorClaudeDir: string | undefined;

  beforeAll(async () => {
    tmpDir = await mkdtemp(path.join(os.tmpdir(), 'vibebill-s10-'));
    const claudeDir = path.join(tmpDir, 'claude');
    repoRoot = path.join(tmpDir, 'repo');
    cacheDir = path.join(repoRoot, '.vibebill', 'cache');
    await mkdir(repoRoot, { recursive: true });
    gen = await generateSyntheticClaudeLogs({ claudeDir, repoRoot, targetBytes: TARGET_BYTES });
    // The adapter must find the fixture through the documented env override (spec §10).
    priorClaudeDir = process.env['VIBEBILL_CLAUDE_DIR'];
    process.env['VIBEBILL_CLAUDE_DIR'] = claudeDir;
  }, 120_000);

  afterAll(async () => {
    if (priorClaudeDir === undefined) {
      delete process.env['VIBEBILL_CLAUDE_DIR'];
    } else {
      process.env['VIBEBILL_CLAUDE_DIR'] = priorClaudeDir;
    }
    await rm(tmpDir, { recursive: true, force: true });
  }, 120_000);

  it('cold-ingests ~50 MiB within budget and bounded RSS; warm re-run is fast and identical', async () => {
    const adapter = createClaudeCodeAdapter(); // resolves via VIBEBILL_CLAUDE_DIR
    const ingestOpts = { repoRoot, adapters: [adapter], cacheDir };

    // -- cold: full parse + cache write ---------------------------------
    const cold = await measureIngest(ingestOpts);

    // Ground truth first: a fast-but-wrong ingest must not pass a perf test.
    expect(cold.result.events.length).toBe(gen.expectedEvents);
    expect(cold.result.stats.eventsExtracted).toBe(gen.usageOccurrences);
    expect(cold.result.stats.duplicatesRemoved).toBe(gen.expectedDuplicatesRemoved);
    expect(cold.result.stats.linesSkipped).toBe(gen.junkLines);
    expect(cold.result.stats.linesRead).toBe(gen.linesWritten);
    expect(cold.result.outOfScope).toEqual(gen.expectedOutOfScope);

    // One honest line in the CI log so regressions are visible before they
    // trip the (deliberately generous) budgets.
    console.info(
      `S10 perf: cold ${(cold.wallMs / 1000).toFixed(2)}s ` +
        `(peak RSS ${(cold.peakRssBytes / MIB).toFixed(1)} MiB, ` +
        `baseline ${(cold.baselineRssBytes / MIB).toFixed(1)} MiB), ` +
        `${cold.result.stats.eventsExtracted} events extracted`,
    );

    expect(cold.wallMs).toBeLessThan(COLD_BUDGET_MS);
    expect(cold.peakRssBytes).toBeLessThan(RSS_BUDGET_BYTES);

    // -- warm: served from the cache, no transcript re-read ---------------
    const warm = await measureIngest(ingestOpts);

    expect(warm.wallMs).toBeLessThan(WARM_BUDGET_MS);
    expect(warm.result.events.length).toBe(cold.result.events.length);
    expect(warm.result.stats).toEqual(cold.result.stats);
    expect(warm.result.outOfScope).toEqual(cold.result.outOfScope);

    // Same events, not merely the same count: token mass must match exactly.
    const tokenSum = (events: { tokens: Parameters<typeof totalTokens>[0] }[]): number =>
      events.reduce((sum, e) => sum + totalTokens(e.tokens), 0);
    expect(tokenSum(warm.result.events)).toBe(tokenSum(cold.result.events));
  }, 180_000);
});
