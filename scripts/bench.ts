/**
 * Ingest performance benchmark (spec §9): generates deterministic synthetic
 * Claude Code JSONL of parameterized size, then times (a) a cold ingest with
 * cache write and (b) a warm run served from the cache, printing wall time,
 * peak RSS, event counts, and throughput next to the spec §9 targets
 * (cold 500 MB < 30 s, RSS < 300 MB, warm < 2 s).
 *
 * How to run:
 *   npm run bench -- --mb 500          # compiled: tsc build, then node dist/scripts/bench.js
 *   npx tsx scripts/bench.ts --mb 500  # straight from source
 *   npx vite-node scripts/bench.ts -- --mb 500
 *
 * Dependency note (spec §14.3.6): no TS runner was added to package.json for
 * this script. Node's native type stripping cannot resolve this repo's
 * NodeNext-style `.js` import specifiers back to `.ts` sources (verified:
 * ERR_MODULE_NOT_FOUND on Node 25), but the repo already carries vite-node
 * through vitest, `npm run bench` runs the tsc-compiled output with zero extra
 * dependencies, and `npx tsx` resolves tsx ad hoc — so a new devDependency
 * would be redundant.
 *
 * Determinism (spec §1.5): all content derives from plain integer counters —
 * no Math.random(), no Date.now() in generated data. Same --mb ⇒ byte-identical
 * synthetic logs.
 *
 * Line mix (realistic per docs/contracts.md "Verified log-format facts"):
 * usage-bearing assistant records (three iterations shapes: top-level-only,
 * retry-with-iterations, zeroed-top-with-iterations), user records, tool_use
 * edit blocks (Edit/Write/MultiEdit), tool_result records, duplicate assistant
 * lines (dedupe is real, §5.1.4), out-of-scope and null-cwd records,
 * `<synthetic>` API-error records, meta records, and occasional junk lines.
 *
 * The scenario test test/scenarios/s10-perf.test.ts imports
 * `generateSyntheticClaudeLogs` and `measureIngest` from this file; the
 * benchmark itself only runs when this file is the process entry point.
 */

import { once } from 'node:events';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { finished } from 'node:stream/promises';
import { pathToFileURL } from 'node:url';

import { createClaudeCodeAdapter } from '../src/adapters/claude-code/index.js';
import { ingestEvents, type IngestResult } from '../src/core/ingest.js';
import type { SourceAdapter } from '../src/core/types.js';

export const MIB = 1024 * 1024;

/** Spec §9 targets. */
export const COLD_TARGET_MS_AT_500MB = 30_000;
export const WARM_TARGET_MS = 2_000;
export const RSS_TARGET_BYTES = 300 * MIB;

/** Fixed clock start for generated timestamps: 2026-01-01T00:00:00.000Z. */
const EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);
/** Clock advance per generated turn (ms). */
const TURN_STEP_MS = 2_100;
/** ASCII filler pool sliced to deterministic lengths (never contains JSON-escaped chars). */
const FILLER_POOL = 'sanitized placeholder content for realistic transcript line volume '.repeat(
  90,
);

/** Options for the synthetic Claude Code JSONL generator. */
export interface SyntheticLogSpec {
  /** Fake VIBEBILL_CLAUDE_DIR root; files land under `<claudeDir>/projects/<encoded>/`. */
  claudeDir: string;
  /** Directory stamped as `cwd` on in-scope records; created (with a subdir) if missing. */
  repoRoot: string;
  /** Total JSONL bytes to generate (last turn may overshoot by a few KB). */
  targetBytes: number;
  /** Bytes per session file before rolling to the next one (default 8 MiB). */
  bytesPerFile?: number;
}

/** Ground-truth counters emitted by the generator, for exact ingest assertions. */
export interface SyntheticLogStats {
  bytesWritten: number;
  files: number;
  linesWritten: number;
  /** Usage-bearing assistant lines written, ANY cwd, INCLUDING duplicate emissions. */
  usageOccurrences: number;
  /** Distinct in-scope event ids — what a correct ingest returns after dedupe. */
  expectedEvents: number;
  /** In-scope occurrences minus distinct ids (spec §5.1.4 last-wins dedupe). */
  expectedDuplicatesRemoved: number;
  /** Per-occurrence tally of parsed events whose cwd falls outside repoRoot (or is null). */
  expectedOutOfScope: { events: number; tokens: number };
  /** Lines that must be counted as skipped (invalid JSON / invalid envelope). */
  junkLines: number;
}

interface TruthTokens {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
}

/** Deterministic ASCII filler of exactly `n` characters. */
function filler(n: number): string {
  return FILLER_POOL.slice(0, Math.max(0, Math.min(n, FILLER_POOL.length)));
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

/**
 * Loose fixture version of Claude Code's project-dir encoding ("/" and "." → "-").
 * The adapter never decodes this name (spec §5.1.2), so fidelity is not load-bearing.
 * Kept local so the compiled build never pulls test helpers into dist.
 */
function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/** message.usage JSON for the three verified shapes (docs/contracts.md). */
function usageJson(
  truth: TruthTokens,
  shape: 'top' | 'retry' | 'zero-top',
): Record<string, unknown> {
  const top = {
    input_tokens: truth.input,
    output_tokens: truth.output,
    cache_creation_input_tokens: truth.cacheWrite,
    cache_read_input_tokens: truth.cacheRead,
  };
  if (shape === 'top') {
    return { ...top, service_tier: 'standard' };
  }
  if (shape === 'retry') {
    // Top level equals the LAST iteration (the call that landed); the earlier
    // fallback iteration must NOT be summed by a correct parser.
    return {
      ...top,
      iterations: [
        {
          input_tokens: 11,
          output_tokens: 3,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          type: 'fallback_message',
        },
        {
          input_tokens: truth.input,
          output_tokens: truth.output,
          cache_read_input_tokens: truth.cacheRead,
          cache_creation_input_tokens: truth.cacheWrite,
          type: 'message',
        },
      ],
      service_tier: 'standard',
    };
  }
  // 'zero-top': zeroed top level; the truth is the SUM of the iterations.
  const half: TruthTokens = {
    input: Math.floor(truth.input / 2),
    output: Math.floor(truth.output / 2),
    cacheWrite: Math.floor(truth.cacheWrite / 2),
    cacheRead: Math.floor(truth.cacheRead / 2),
  };
  const iteration = (t: TruthTokens): Record<string, unknown> => ({
    input_tokens: t.input,
    output_tokens: t.output,
    cache_read_input_tokens: t.cacheRead,
    cache_creation_input_tokens: t.cacheWrite,
    type: 'message',
  });
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    iterations: [
      iteration(half),
      iteration({
        input: truth.input - half.input,
        output: truth.output - half.output,
        cacheWrite: truth.cacheWrite - half.cacheWrite,
        cacheRead: truth.cacheRead - half.cacheRead,
      }),
    ],
    service_tier: 'standard',
  };
}

/** Backpressure-aware buffered line writer (ASCII-only content by construction). */
class LineWriter {
  private readonly stream;
  private parts: string[] = [];
  private buffered = 0;
  bytesWritten = 0;

  constructor(filePath: string) {
    this.stream = createWriteStream(filePath);
  }

  async line(text: string): Promise<void> {
    this.parts.push(text, '\n');
    this.buffered += text.length + 1;
    this.bytesWritten += text.length + 1;
    if (this.buffered >= 256 * 1024) {
      await this.flush();
    }
  }

  private async flush(): Promise<void> {
    const chunk = this.parts.join('');
    this.parts = [];
    this.buffered = 0;
    if (chunk.length > 0 && !this.stream.write(chunk)) {
      await once(this.stream, 'drain');
    }
  }

  async close(): Promise<void> {
    await this.flush();
    this.stream.end();
    await finished(this.stream);
  }
}

/**
 * Stream-write deterministic synthetic Claude Code JSONL session files into a
 * fake claude dir and return exact ground-truth counters for what a correct
 * ingest must extract. Never buffers more than ~256 KB in memory.
 */
export async function generateSyntheticClaudeLogs(
  spec: SyntheticLogSpec,
): Promise<SyntheticLogStats> {
  const bytesPerFile = spec.bytesPerFile ?? 8 * MIB;

  await mkdir(spec.repoRoot, { recursive: true });
  const realRoot = await realpath(spec.repoRoot); // macOS tmpdir is symlinked; stamp real paths
  const subdirCwd = path.join(realRoot, 'packages', 'app');
  await mkdir(subdirCwd, { recursive: true });
  const outOfScopeCwd = path.join(path.dirname(realRoot), 'vibebill-bench-other-repo');
  const projectDir = path.join(spec.claudeDir, 'projects', encodeProjectDir(realRoot));
  await mkdir(projectDir, { recursive: true });

  const stats: SyntheticLogStats = {
    bytesWritten: 0,
    files: 0,
    linesWritten: 0,
    usageOccurrences: 0,
    expectedEvents: 0,
    expectedDuplicatesRemoved: 0,
    expectedOutOfScope: { events: 0, tokens: 0 },
    junkLines: 0,
  };
  let inScopeOccurrences = 0;
  let committedBytes = 0;
  let g = 0; // global turn counter — the seed for every deterministic choice
  let toolCounter = 0;

  while (committedBytes < spec.targetBytes) {
    stats.files += 1;
    const sessionId = `be9c0000-0000-4000-8000-${pad(stats.files, 12)}`;
    const writer = new LineWriter(path.join(projectDir, `${sessionId}.jsonl`));
    let lineIdx = 0;
    let lastUuid: string | null = null;
    const nextUuid = (): string => {
      lineIdx += 1;
      return `${pad(stats.files, 8)}-0000-4000-8000-${pad(lineIdx, 12)}`;
    };

    while (
      writer.bytesWritten < bytesPerFile &&
      committedBytes + writer.bytesWritten < spec.targetBytes
    ) {
      g += 1;
      const ts = new Date(EPOCH_MS + g * TURN_STEP_MS).toISOString();

      let cwd: string | null;
      let inScope: boolean;
      if (g % 97 === 0) {
        cwd = null; // no cwd recorded ⇒ cannot prove membership ⇒ out of scope
        inScope = false;
      } else if (g % 37 === 0) {
        cwd = outOfScopeCwd;
        inScope = false;
      } else {
        cwd = g % 13 === 0 ? subdirCwd : realRoot; // monorepo subdir stays in scope (§7.2)
        inScope = true;
      }
      const branch = g % 29 === 0 ? null : g % 11 === 0 ? 'feature/bench-load' : 'main';
      const sidechain = g % 23 === 0;
      const model = g % 5 === 0 ? 'claude-sonnet-4-6' : 'claude-opus-4-8';
      const shape: 'top' | 'retry' | 'zero-top' =
        g % 41 === 0 ? 'zero-top' : g % 17 === 0 ? 'retry' : 'top';
      const truth: TruthTokens = {
        input: 3 + (g % 900),
        output: 60 + ((g * 7) % 1400),
        cacheWrite: g % 3 === 0 ? 400 + ((g * 11) % 3000) : 0,
        cacheRead: g % 4 === 0 ? 0 : 15_000 + ((g * 13) % 45_000),
      };

      const envelope = (extra: Record<string, unknown>): Record<string, unknown> => ({
        parentUuid: lastUuid,
        isSidechain: sidechain,
        userType: 'external',
        cwd,
        sessionId,
        version: '2.1.202',
        ...(branch === null ? {} : { gitBranch: branch }),
        ...extra,
        timestamp: ts,
      });

      // -- user record ------------------------------------------------------
      const userUuid = nextUuid();
      await writer.line(
        JSON.stringify(
          envelope({
            type: 'user',
            message: {
              role: 'user',
              content: [{ type: 'text', text: filler(80 + ((g * 17) % 700)) }],
            },
            uuid: userUuid,
          }),
        ),
      );
      stats.linesWritten += 1;

      // -- assistant record (the UsageEvent source) --------------------------
      const content: Array<Record<string, unknown>> = [
        { type: 'text', text: filler(200 + ((g * 31) % 1400)) },
      ];
      if (g % 3 === 0) {
        const editCount = 1 + (Math.floor(g / 3) % 3);
        for (let k = 0; k < editCount; k += 1) {
          toolCounter += 1;
          const toolId = `toolu_01bench${pad(toolCounter, 8)}`;
          const filePath = path.join(
            realRoot,
            'src',
            `module${(g + k) % 40}`,
            `file${(g * 3 + k) % 173}.ts`,
          );
          const name = (['Edit', 'Write', 'MultiEdit'] as const)[(g + k) % 3] ?? 'Edit';
          const input: Record<string, unknown> =
            name === 'Write'
              ? { file_path: filePath, content: filler(140 + ((g * 7 + k * 61) % 600)) }
              : name === 'MultiEdit'
                ? {
                    file_path: filePath,
                    edits: [
                      {
                        old_string: filler(120 + ((g * 7 + k * 61) % 600)),
                        new_string: filler(120 + ((g * 5 + k * 43) % 600)),
                      },
                    ],
                  }
                : {
                    file_path: filePath,
                    old_string: filler(120 + ((g * 7 + k * 61) % 600)),
                    new_string: filler(120 + ((g * 5 + k * 43) % 600)),
                  };
          content.push({ type: 'tool_use', id: toolId, name, input });
        }
      }
      const assistantUuid = nextUuid();
      const assistantLine = JSON.stringify(
        envelope({
          type: 'assistant',
          requestId: `req_011bench${pad(g, 8)}`,
          message: {
            id: `msg_01bench${pad(g, 12)}`,
            type: 'message',
            role: 'assistant',
            model,
            content,
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: usageJson(truth, shape),
          },
          uuid: assistantUuid,
        }),
      );
      lastUuid = assistantUuid;
      const truthTotal = truth.input + truth.output + truth.cacheWrite + truth.cacheRead;
      const recordOccurrence = (): void => {
        stats.usageOccurrences += 1;
        if (inScope) {
          inScopeOccurrences += 1;
        } else {
          stats.expectedOutOfScope.events += 1;
          stats.expectedOutOfScope.tokens += truthTotal;
        }
      };
      await writer.line(assistantLine);
      stats.linesWritten += 1;
      recordOccurrence();
      if (inScope) {
        stats.expectedEvents += 1;
      }
      if (g % 61 === 0) {
        // Verbatim duplicate emission (real logs repeat lines; spec §5.1.4).
        await writer.line(assistantLine);
        stats.linesWritten += 1;
        recordOccurrence();
      }

      // -- occasional extras --------------------------------------------------
      if (g % 9 === 0) {
        await writer.line(
          JSON.stringify(
            envelope({
              type: 'user',
              message: {
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: `toolu_01bench${pad(toolCounter, 8)}`,
                    content: filler(800 + ((g * 53) % 3200)),
                  },
                ],
              },
              uuid: nextUuid(),
            }),
          ),
        );
        stats.linesWritten += 1;
      }
      if (g % 71 === 0) {
        await writer.line(
          JSON.stringify({
            type: 'queue-operation',
            operation: 'dequeue',
            sessionId,
            timestamp: ts,
          }),
        );
        stats.linesWritten += 1;
      }
      if (g % 83 === 0) {
        // API-error record: model "<synthetic>" ⇒ no UsageEvent (contracts.md).
        await writer.line(
          JSON.stringify(
            envelope({
              type: 'assistant',
              isApiErrorMessage: true,
              message: {
                id: `msg_01bencherr${pad(g, 8)}`,
                type: 'message',
                role: 'assistant',
                model: '<synthetic>',
                content: [{ type: 'text', text: 'API error: [sanitized]' }],
                usage: {
                  input_tokens: 0,
                  output_tokens: 0,
                  cache_creation_input_tokens: 0,
                  cache_read_input_tokens: 0,
                },
              },
              uuid: nextUuid(),
            }),
          ),
        );
        stats.linesWritten += 1;
      }
      if (g % 50 === 0) {
        const junkKind = Math.floor(g / 50) % 3;
        const junk =
          junkKind === 0
            ? `{"type":"assistant","sessionId":"${sessionId}","timestamp":` // truncated JSON
            : junkKind === 1
              ? `%%%%  binary garbage line ${g} %%%%`
              : `{"no_type_field":true,"n":${g}}`; // valid JSON, invalid envelope
        await writer.line(junk);
        stats.linesWritten += 1;
        stats.junkLines += 1;
      }
    }

    await writer.close();
    committedBytes += writer.bytesWritten;
  }

  stats.bytesWritten = committedBytes;
  stats.expectedDuplicatesRemoved = inScopeOccurrences - stats.expectedEvents;
  return stats;
}

/** One timed ingest phase: wall clock plus RSS sampled every 10 ms during the run. */
export interface MeasuredIngest {
  wallMs: number;
  peakRssBytes: number;
  baselineRssBytes: number;
  result: IngestResult;
}

/** Run ingestEvents once, sampling process RSS throughout; pure wrapper, no tuning. */
export async function measureIngest(opts: {
  repoRoot: string;
  adapters: SourceAdapter[];
  cacheDir: string;
}): Promise<MeasuredIngest> {
  const rss = (): number => process.memoryUsage.rss();
  const baselineRssBytes = rss();
  let peakRssBytes = baselineRssBytes;
  const sampler = setInterval(() => {
    const r = rss();
    if (r > peakRssBytes) {
      peakRssBytes = r;
    }
  }, 10);
  const start = performance.now();
  try {
    const result = await ingestEvents(opts);
    const wallMs = performance.now() - start;
    const r = rss();
    if (r > peakRssBytes) {
      peakRssBytes = r;
    }
    return { wallMs, peakRssBytes, baselineRssBytes, result };
  } finally {
    clearInterval(sampler);
  }
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

function usageAndExit(message: string): never {
  console.error(`bench: ${message}`);
  console.error('usage: bench --mb <positive number>   (default 500)');
  process.exit(1);
}

function parseArgs(argv: string[]): { mb: number } {
  let mb = 500;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--mb') {
      const value = argv[i + 1];
      if (value === undefined) {
        usageAndExit('--mb requires a value');
      }
      mb = Number(value);
      i += 1;
    } else if (arg !== undefined && arg.startsWith('--mb=')) {
      mb = Number(arg.slice('--mb='.length));
    } else {
      usageAndExit(`unknown argument: ${String(arg)}`);
    }
    if (!Number.isFinite(mb) || mb <= 0) {
      usageAndExit('--mb must be a positive number');
    }
  }
  return { mb };
}

const num = (n: number): string => Math.round(n).toLocaleString('en-US');
const secsOf = (ms: number): string => (ms / 1000).toFixed(2);
const mibOf = (bytes: number): string => (bytes / MIB).toFixed(1);

interface Row {
  phase: string;
  wall: string;
  wallTarget: string;
  rss: string;
  rssTarget: string;
  events: string;
  eventsPerS: string;
  mibPerS: string;
  status: string;
}

function printTable(rows: Row[]): void {
  const header: Row = {
    phase: 'phase',
    wall: 'wall (s)',
    wallTarget: 'target',
    rss: 'peak RSS (MiB)',
    rssTarget: 'target',
    events: 'events',
    eventsPerS: 'events/s',
    mibPerS: 'MiB/s',
    status: 'status',
  };
  const all = [header, ...rows];
  const keys = Object.keys(header) as Array<keyof Row>;
  const widths = new Map<keyof Row, number>(
    keys.map((k) => [k, Math.max(...all.map((r) => r[k].length))]),
  );
  for (const row of all) {
    const line = keys
      .map((k, i) =>
        i === 0 ? row[k].padEnd(widths.get(k) ?? 0) : row[k].padStart(widths.get(k) ?? 0),
      )
      .join('   ');
    console.log(`  ${line}`);
  }
}

async function main(): Promise<void> {
  const { mb } = parseArgs(process.argv.slice(2));
  const targetBytes = Math.round(mb * MIB);
  const tmp = await mkdtemp(path.join(tmpdir(), 'vibebill-bench-'));
  try {
    const claudeDir = path.join(tmp, 'claude');
    const repoRoot = path.join(tmp, 'repo');
    const cacheDir = path.join(repoRoot, '.vibebill', 'cache');

    console.log(
      `vibebill ingest bench — synthetic Claude Code JSONL, target ${mibOf(targetBytes)} MiB`,
    );
    const genStart = performance.now();
    const gen = await generateSyntheticClaudeLogs({ claudeDir, repoRoot, targetBytes });
    console.log(
      `  generated : ${mibOf(gen.bytesWritten)} MiB across ${gen.files} session files ` +
        `(${num(gen.linesWritten)} lines) in ${secsOf(performance.now() - genStart)} s`,
    );
    console.log(
      `  ground truth: ${num(gen.usageOccurrences)} usage records → ${num(gen.expectedEvents)} unique in-scope events, ` +
        `${num(gen.expectedDuplicatesRemoved)} duplicates, ${num(gen.expectedOutOfScope.events)} out-of-scope, ` +
        `${num(gen.junkLines)} junk lines`,
    );

    const adapter = createClaudeCodeAdapter({ claudeDir });
    const cold = await measureIngest({ repoRoot, adapters: [adapter], cacheDir });
    const warm = await measureIngest({ repoRoot, adapters: [adapter], cacheDir });

    const mismatches: string[] = [];
    if (cold.result.events.length !== gen.expectedEvents) {
      mismatches.push(`cold events ${cold.result.events.length} != expected ${gen.expectedEvents}`);
    }
    if (warm.result.events.length !== cold.result.events.length) {
      mismatches.push(
        `warm events ${warm.result.events.length} != cold ${cold.result.events.length}`,
      );
    }
    if (cold.result.stats.duplicatesRemoved !== gen.expectedDuplicatesRemoved) {
      mismatches.push(
        `duplicatesRemoved ${cold.result.stats.duplicatesRemoved} != expected ${gen.expectedDuplicatesRemoved}`,
      );
    }

    // Spec §9 states the cold target at 500 MB; scale linearly for other sizes
    // (informational at small sizes, where fixed overheads dominate).
    const coldTargetMs = COLD_TARGET_MS_AT_500MB * (targetBytes / (500 * MIB));
    const coldOk = cold.wallMs < coldTargetMs && cold.peakRssBytes < RSS_TARGET_BYTES;
    const warmOk = warm.wallMs < WARM_TARGET_MS && warm.peakRssBytes < RSS_TARGET_BYTES;

    console.log('');
    printTable([
      {
        phase: 'cold',
        wall: secsOf(cold.wallMs),
        wallTarget: `< ${secsOf(coldTargetMs)}*`,
        rss: mibOf(cold.peakRssBytes),
        rssTarget: '< 300',
        events: num(cold.result.stats.eventsExtracted),
        eventsPerS: num(cold.result.stats.eventsExtracted / (cold.wallMs / 1000)),
        mibPerS: (gen.bytesWritten / MIB / (cold.wallMs / 1000)).toFixed(1),
        status: coldOk ? 'PASS' : 'MISS',
      },
      {
        phase: 'warm',
        wall: secsOf(warm.wallMs),
        wallTarget: `< ${secsOf(WARM_TARGET_MS)}`,
        rss: `${mibOf(warm.peakRssBytes)}†`,
        rssTarget: '< 300',
        events: num(warm.result.stats.eventsExtracted),
        eventsPerS: num(warm.result.stats.eventsExtracted / (warm.wallMs / 1000)),
        mibPerS: '—',
        status: warmOk ? 'PASS' : 'MISS',
      },
    ]);
    console.log('');
    console.log(
      `  * spec §9: cold 500 MB < 30 s, scaled linearly to the requested ${mibOf(targetBytes)} MiB`,
    );
    console.log('  † warm peak RSS includes memory retained from the cold phase (same process)');
    console.log(`  process RSS baseline before cold ingest: ${mibOf(cold.baselineRssBytes)} MiB`);
    console.log(
      '  note: peak RSS reflects V8’s default grow-lazily heap policy, not the live set —',
    );
    console.log(
      '  the same ingest meets the §9 ceiling under a constrained heap (docs/decisions.md D13)',
    );
    console.log(
      `  in-scope deduped events: ${num(cold.result.events.length)} (cold == warm: ${String(
        warm.result.events.length === cold.result.events.length,
      )})`,
    );
    if (mismatches.length > 0) {
      console.error(`  COUNT MISMATCH: ${mismatches.join('; ')}`);
      process.exitCode = 1;
    }
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

// Run only as a process entry point (node dist/scripts/bench.js, npx tsx
// scripts/bench.ts); importing this module (the S10 test does) must not
// kick off a benchmark.
const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err: unknown) => {
    console.error(err);
    process.exit(2);
  });
}
