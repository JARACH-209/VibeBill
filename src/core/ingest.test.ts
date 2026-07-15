import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ADAPTER_VERSIONS, INGEST_SCHEMA_VERSION, ingestEvents } from './ingest.js';
import type { AgentId, FileParseStats, SourceAdapter, TokenCounts, UsageEvent } from './types.js';

/**
 * Scripted in-memory adapter: each file is a list of "lines" with a byte
 * length and optionally an event or a skip marker. parseFile honors
 * startOffset (line-boundary byte resume) and reports absolute bytesConsumed,
 * mirroring the real adapters' contract. No real transcripts needed.
 */
interface ScriptLine {
  bytes: number;
  event?: Omit<UsageEvent, 'sourceFile'>;
  skip?: boolean;
}

class StubAdapter implements SourceAdapter {
  readonly schemaVerified = true;
  readonly parseCalls: Array<{ path: string; startOffset: number | undefined }> = [];
  constructor(
    readonly scripts: Map<string, ScriptLine[]>,
    readonly id: AgentId = 'claude-code',
  ) {}

  async discover(): Promise<string[]> {
    return [...this.scripts.keys()].sort();
  }

  async parseFile(
    filePath: string,
    sink: (e: UsageEvent) => void,
    opts?: { startOffset?: number },
  ): Promise<FileParseStats> {
    this.parseCalls.push({ path: filePath, startOffset: opts?.startOffset });
    const lines = this.scripts.get(filePath) ?? [];
    const start = opts?.startOffset ?? 0;
    const stats: FileParseStats = {
      path: filePath,
      linesRead: 0,
      eventsExtracted: 0,
      linesSkipped: 0,
      bytesConsumed: 0,
    };
    let offset = 0;
    for (const line of lines) {
      const lineStart = offset;
      offset += line.bytes;
      stats.bytesConsumed = offset; // absolute, even when resuming
      if (lineStart < start) continue; // consumed in a previous run
      stats.linesRead += 1;
      if (line.skip === true) {
        stats.linesSkipped += 1;
      } else if (line.event !== undefined) {
        sink({
          ...line.event,
          tokens: { ...line.event.tokens },
          editedFiles: [...line.event.editedFiles],
          sourceFile: filePath,
        });
        stats.eventsExtracted += 1;
      }
    }
    return stats;
  }
}

/** Write a real file whose on-disk size matches the script (content is filler). */
async function writeScriptFile(filePath: string, lines: ScriptLine[]): Promise<void> {
  const size = lines.reduce((n, l) => n + l.bytes, 0);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, Buffer.alloc(size, 0x6a));
}

function tok(input: number, output = 0, cacheWrite = 0, cacheRead = 0): TokenCounts {
  return { input, output, cacheWrite, cacheRead };
}

const T = 1_750_000_000_000;

describe('ingestEvents', () => {
  let base: string;
  let repo: string;
  let logs: string;
  let cache: string;

  beforeEach(async () => {
    base = await fs.mkdtemp(path.join(os.tmpdir(), 'vibebill-ingest-'));
    repo = path.join(base, 'repo');
    logs = path.join(base, 'logs');
    cache = path.join(repo, '.vibebill', 'cache');
    await fs.mkdir(repo, { recursive: true });
    await fs.mkdir(logs, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(base, { recursive: true, force: true });
  });

  function evt(
    id: string,
    over: Partial<Omit<UsageEvent, 'sourceFile' | 'id'>> = {},
  ): Omit<UsageEvent, 'sourceFile'> {
    return {
      id,
      agent: 'claude-code',
      sessionId: 'sess-1',
      ts: T,
      model: 'claude-opus-4-8',
      tokens: tok(10, 5),
      cwd: repo,
      gitBranch: 'main',
      editedFiles: [],
      isSidechain: false,
      ...over,
    };
  }

  function run(adapters: SourceAdapter | SourceAdapter[], noCache = false) {
    return ingestEvents({
      repoRoot: repo,
      adapters: Array.isArray(adapters) ? adapters : [adapters],
      cacheDir: cache,
      noCache,
    });
  }

  /** Two-file default fixture with a cross-file duplicate and one out-of-scope event. */
  function defaultScripts(): Map<string, ScriptLine[]> {
    const a = path.join(logs, 'a.jsonl');
    const b = path.join(logs, 'b.jsonl');
    return new Map<string, ScriptLine[]>([
      [
        a,
        [
          { bytes: 120, event: evt('e-one', { ts: T + 3000 }) },
          { bytes: 40, skip: true },
          { bytes: 80, event: evt('dup', { ts: T + 1000, gitBranch: 'from-a' }) },
        ],
      ],
      [
        b,
        [
          { bytes: 100, event: evt('e-three', { ts: T + 2000 }) },
          { bytes: 90, event: evt('dup', { ts: T + 1000, gitBranch: 'from-b' }) },
          {
            bytes: 60,
            event: evt('oos', {
              ts: T + 4000,
              cwd: '/definitely/elsewhere',
              tokens: tok(40, 30, 20, 10),
            }),
          },
        ],
      ],
    ]);
  }

  async function writeAll(scripts: Map<string, ScriptLine[]>): Promise<void> {
    for (const [p, lines] of scripts) await writeScriptFile(p, lines);
  }

  it('cold ingest parses everything, dedupes, sorts by (ts, id), and builds the cache', async () => {
    const scripts = defaultScripts();
    await writeAll(scripts);
    const stub = new StubAdapter(scripts);

    const result = await run(stub);

    expect(result.events.map((e) => e.id)).toEqual(['dup', 'e-three', 'e-one']);
    // Cross-file dedupe keeps the LAST occurrence in path order (a.jsonl < b.jsonl).
    expect(result.events[0]?.gitBranch).toBe('from-b');
    expect(result.events[0]?.sourceFile).toBe(path.join(logs, 'b.jsonl'));
    expect(result.stats).toEqual({
      filesFound: 2,
      filesRead: 2,
      filesSkipped: 0,
      linesRead: 6,
      eventsExtracted: 5,
      linesSkipped: 1,
      duplicatesRemoved: 1,
    });
    expect(result.outOfScope).toEqual({ events: 1, tokens: 100 });

    // Cache on disk: manifest fingerprints + pre-dedupe in-scope events only.
    const manifest = JSON.parse(await fs.readFile(path.join(cache, 'manifest.json'), 'utf8')) as {
      schemaVersion: number;
      adapterVersions: Record<string, string>;
      files: Record<
        string,
        { size: number; bytesConsumed: number; outOfScope: { events: number; tokens: number } }
      >;
      outOfScope: { events: number; tokens: number };
    };
    expect(manifest.schemaVersion).toBe(INGEST_SCHEMA_VERSION);
    expect(manifest.adapterVersions['claude-code']).toBe(ADAPTER_VERSIONS['claude-code']);
    expect(manifest.files[path.join(logs, 'a.jsonl')]).toMatchObject({
      size: 240,
      bytesConsumed: 240,
      stats: { linesRead: 3, eventsExtracted: 2, linesSkipped: 1 },
      outOfScope: { events: 0, tokens: 0 },
    });
    expect(manifest.files[path.join(logs, 'b.jsonl')]).toMatchObject({
      size: 250,
      bytesConsumed: 250,
      outOfScope: { events: 1, tokens: 100 },
    });
    expect(manifest.outOfScope).toEqual({ events: 1, tokens: 100 });

    const ndjson = await fs.readFile(path.join(cache, 'events.ndjson'), 'utf8');
    const lines = ndjson.split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(4); // pre-dedupe in-scope (both 'dup' occurrences), no 'oos'
    expect(ndjson).not.toContain('"id":"oos"');
  });

  it('warm run with no changes makes zero parseFile calls and returns an identical result', async () => {
    const scripts = defaultScripts();
    await writeAll(scripts);
    const first = await run(new StubAdapter(scripts));

    const stub2 = new StubAdapter(scripts);
    const second = await run(stub2);

    expect(stub2.parseCalls).toEqual([]);
    expect(second).toEqual(first);
  });

  it('a grown file resumes from bytesConsumed, merges with its cached events, and matches a cold parse exactly', async () => {
    const a = path.join(logs, 'a.jsonl');
    const b = path.join(logs, 'b.jsonl');
    const head: ScriptLine[] = [{ bytes: 100, event: evt('g1', { ts: T + 1000 }) }];
    const bLines: ScriptLine[] = [{ bytes: 50, event: evt('b1', { ts: T + 500 }) }];
    const scripts1 = new Map([
      [a, head],
      [b, bLines],
    ]);
    await writeAll(scripts1);
    await run(new StubAdapter(scripts1));

    const grown: ScriptLine[] = [
      ...head,
      { bytes: 60, event: evt('g2', { ts: T + 2000 }) },
      { bytes: 30, skip: true },
    ];
    const scripts2 = new Map([
      [a, grown],
      [b, bLines],
    ]);
    await writeScriptFile(a, grown); // size 100 -> 190

    const stub2 = new StubAdapter(scripts2);
    const incremental = await run(stub2);

    // Only the grown file was touched, and only its tail.
    expect(stub2.parseCalls).toEqual([{ path: a, startOffset: 100 }]);
    expect(incremental.events.map((e) => e.id)).toEqual(['b1', 'g1', 'g2']);

    // Cold ingest of the same final state (separate cache dir) is identical —
    // events, stats, and even cache bytes.
    const coldCache = path.join(base, 'cold-cache');
    const cold = await ingestEvents({
      repoRoot: repo,
      adapters: [new StubAdapter(scripts2)],
      cacheDir: coldCache,
    });
    expect(incremental).toEqual(cold);
    expect(await fs.readFile(path.join(cache, 'events.ndjson'), 'utf8')).toBe(
      await fs.readFile(path.join(coldCache, 'events.ndjson'), 'utf8'),
    );
    expect(await fs.readFile(path.join(cache, 'manifest.json'), 'utf8')).toBe(
      await fs.readFile(path.join(coldCache, 'manifest.json'), 'utf8'),
    );
  });

  it('an mtime-only change triggers a full re-parse of just that file', async () => {
    const scripts = defaultScripts();
    await writeAll(scripts);
    const first = await run(new StubAdapter(scripts));

    const a = path.join(logs, 'a.jsonl');
    await fs.utimes(a, new Date(T + 86_400_000), new Date(T + 86_400_000));

    const stub2 = new StubAdapter(scripts);
    const second = await run(stub2);

    expect(stub2.parseCalls).toEqual([{ path: a, startOffset: undefined }]);
    expect(second).toEqual(first);
  });

  it('a shrunk file is fully re-parsed and its cached events are replaced', async () => {
    const a = path.join(logs, 'a.jsonl');
    const before: ScriptLine[] = [
      { bytes: 100, event: evt('old-1', { ts: T + 1000 }) },
      { bytes: 80, event: evt('old-2', { ts: T + 2000 }) },
    ];
    await writeScriptFile(a, before);
    await run(new StubAdapter(new Map([[a, before]])));

    const after: ScriptLine[] = [{ bytes: 90, event: evt('new-1', { ts: T + 3000 }) }];
    await writeScriptFile(a, after); // size 180 -> 90
    const stub2 = new StubAdapter(new Map([[a, after]]));
    const result = await run(stub2);

    expect(stub2.parseCalls).toEqual([{ path: a, startOffset: undefined }]);
    expect(result.events.map((e) => e.id)).toEqual(['new-1']);
    expect(result.stats.linesRead).toBe(1);
  });

  it('a corrupt manifest triggers a silent full rebuild with an identical result', async () => {
    const scripts = defaultScripts();
    await writeAll(scripts);
    const first = await run(new StubAdapter(scripts));

    await fs.writeFile(path.join(cache, 'manifest.json'), '{ not json at all', 'utf8');
    const stub2 = new StubAdapter(scripts);
    const second = await run(stub2);

    expect(stub2.parseCalls).toHaveLength(2);
    expect(stub2.parseCalls.every((c) => c.startOffset === undefined)).toBe(true);
    expect(second).toEqual(first);
  });

  it('a corrupt events.ndjson triggers a silent full rebuild with an identical result', async () => {
    const scripts = defaultScripts();
    await writeAll(scripts);
    const first = await run(new StubAdapter(scripts));

    await fs.appendFile(path.join(cache, 'events.ndjson'), 'binary garbage\n', 'utf8');
    const stub2 = new StubAdapter(scripts);
    const second = await run(stub2);

    expect(stub2.parseCalls).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it('an adapter version bump invalidates the cache wholesale', async () => {
    const scripts = defaultScripts();
    await writeAll(scripts);
    const first = await run(new StubAdapter(scripts));

    const manifestPath = path.join(cache, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      adapterVersions: Record<string, string>;
    };
    manifest.adapterVersions['claude-code'] = '0-ancient';
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const stub2 = new StubAdapter(scripts);
    const second = await run(stub2);
    expect(stub2.parseCalls).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it('a schema version bump invalidates the cache wholesale', async () => {
    const scripts = defaultScripts();
    await writeAll(scripts);
    const first = await run(new StubAdapter(scripts));

    const manifestPath = path.join(cache, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as {
      schemaVersion: number;
    };
    manifest.schemaVersion = INGEST_SCHEMA_VERSION + 999;
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf8');

    const stub2 = new StubAdapter(scripts);
    const second = await run(stub2);
    expect(stub2.parseCalls).toHaveLength(2);
    expect(second).toEqual(first);
  });

  it('dedupe keeps the LAST occurrence across files and within a file (S6 shape)', async () => {
    const a = path.join(logs, 'a.jsonl');
    const b = path.join(logs, 'b.jsonl');
    const scripts = new Map<string, ScriptLine[]>([
      [
        a,
        [
          { bytes: 50, event: evt('dup', { gitBranch: 'first' }) },
          { bytes: 50, event: evt('dup', { gitBranch: 'second' }) },
        ],
      ],
      [b, [{ bytes: 50, event: evt('dup', { gitBranch: 'third' }) }]],
    ]);
    await writeAll(scripts);

    const result = await run(new StubAdapter(scripts));

    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.gitBranch).toBe('third');
    expect(result.events[0]?.sourceFile).toBe(b);
    expect(result.stats.duplicatesRemoved).toBe(2);
  });

  it('out-of-scope and null-cwd events are tallied in the manifest but never cached', async () => {
    const a = path.join(logs, 'a.jsonl');
    const scripts = new Map<string, ScriptLine[]>([
      [
        a,
        [
          { bytes: 50, event: evt('in-1', { ts: T + 1000 }) },
          { bytes: 50, event: evt('null-cwd', { cwd: null, tokens: tok(1, 2, 3, 4) }) },
          {
            bytes: 50,
            event: evt('other-repo', { cwd: '/somewhere/else/deep', tokens: tok(5, 5) }),
          },
        ],
      ],
    ]);
    await writeAll(scripts);

    const first = await run(new StubAdapter(scripts));
    expect(first.events.map((e) => e.id)).toEqual(['in-1']);
    expect(first.outOfScope).toEqual({ events: 2, tokens: 20 });

    const ndjson = await fs.readFile(path.join(cache, 'events.ndjson'), 'utf8');
    expect(ndjson.split('\n').filter((l) => l !== '')).toHaveLength(1);

    // Warm run reproduces the tally without re-reading anything.
    const stub2 = new StubAdapter(scripts);
    const second = await run(stub2);
    expect(stub2.parseCalls).toEqual([]);
    expect(second.outOfScope).toEqual({ events: 2, tokens: 20 });
    expect(second).toEqual(first);
  });

  it('resolves cwd through symlinks (realpath) and falls back to path.resolve for non-existent cwds', async () => {
    const linkPath = path.join(base, 'repo-link');
    await fs.symlink(repo, linkPath);
    await fs.mkdir(path.join(repo, 'packages', 'app'), { recursive: true });
    const realRepo = await fs.realpath(repo);

    const a = path.join(logs, 'a.jsonl');
    const scripts = new Map<string, ScriptLine[]>([
      [
        a,
        [
          { bytes: 50, event: evt('via-link', { ts: T + 1000, cwd: linkPath }) },
          {
            bytes: 50,
            event: evt('via-link-subdir', {
              ts: T + 2000,
              cwd: path.join(linkPath, 'packages', 'app'),
            }),
          },
          // Does not exist on disk: path.resolve fallback, under the real root.
          {
            bytes: 50,
            event: evt('ghost-subdir', { ts: T + 3000, cwd: path.join(realRepo, 'ghost') }),
          },
          // Sibling directory whose name shares the root as a string prefix: OUT.
          {
            bytes: 50,
            event: evt('prefix-trap', { ts: T + 4000, cwd: `${realRepo}-other`, tokens: tok(7) }),
          },
        ],
      ],
    ]);
    await writeAll(scripts);

    const result = await run(new StubAdapter(scripts));

    expect(result.events.map((e) => e.id)).toEqual(['via-link', 'via-link-subdir', 'ghost-subdir']);
    expect(result.outOfScope).toEqual({ events: 1, tokens: 7 });
  });

  it('returns events deterministically sorted by (ts, id)', async () => {
    const a = path.join(logs, 'a.jsonl');
    const b = path.join(logs, 'b.jsonl');
    const scripts = new Map<string, ScriptLine[]>([
      [
        a,
        [
          { bytes: 10, event: evt('c', { ts: T }) },
          { bytes: 10, event: evt('a', { ts: T }) },
        ],
      ],
      [
        b,
        [
          { bytes: 10, event: evt('b', { ts: T }) },
          { bytes: 10, event: evt('z', { ts: T - 1000 }) },
        ],
      ],
    ]);
    await writeAll(scripts);

    const result = await run(new StubAdapter(scripts));
    expect(result.events.map((e) => e.id)).toEqual(['z', 'a', 'b', 'c']);
  });

  it('noCache forces a full re-parse and neither reads nor writes the cache', async () => {
    const scripts = defaultScripts();
    await writeAll(scripts);
    const first = await run(new StubAdapter(scripts));
    const manifestBefore = await fs.readFile(path.join(cache, 'manifest.json'), 'utf8');

    const stub2 = new StubAdapter(scripts);
    const second = await run(stub2, true);
    expect(stub2.parseCalls).toHaveLength(2);
    expect(second).toEqual(first);
    expect(await fs.readFile(path.join(cache, 'manifest.json'), 'utf8')).toBe(manifestBefore);

    // The untouched cache still serves the next normal run warm.
    const stub3 = new StubAdapter(scripts);
    const third = await run(stub3);
    expect(stub3.parseCalls).toEqual([]);
    expect(third).toEqual(first);
  });

  it('skips files that cannot be statted and files whose adapter throws, without crashing', async () => {
    const a = path.join(logs, 'a.jsonl');
    const b = path.join(logs, 'b.jsonl');
    const missing = path.join(logs, 'missing.jsonl'); // discovered, never written
    const scripts = new Map<string, ScriptLine[]>([
      [a, [{ bytes: 50, event: evt('a1') }]],
      [b, [{ bytes: 50, event: evt('b1', { ts: T + 1000 }) }]],
      [missing, [{ bytes: 50, event: evt('never') }]],
    ]);
    await writeScriptFile(a, scripts.get(a) ?? []);
    await writeScriptFile(b, scripts.get(b) ?? []);

    const inner = new StubAdapter(scripts);
    const throwing: SourceAdapter = {
      id: inner.id,
      schemaVerified: true,
      discover: () => inner.discover(),
      parseFile: (p, sink, opts) => {
        if (p === a) throw new Error('boom');
        return inner.parseFile(p, sink, opts);
      },
    };

    const result = await run(throwing);
    expect(result.events.map((e) => e.id)).toEqual(['b1']);
    expect(result.stats.filesFound).toBe(3);
    expect(result.stats.filesRead).toBe(1);
    expect(result.stats.filesSkipped).toBe(2);

    // Skipped files get no manifest entry, so the next run retries them.
    const manifest = JSON.parse(await fs.readFile(path.join(cache, 'manifest.json'), 'utf8')) as {
      files: Record<string, unknown>;
    };
    expect(Object.keys(manifest.files)).toEqual([b]);
  });

  it('handles multiple adapters, recording a version per adapter id', async () => {
    const a = path.join(logs, 'claude', 'a.jsonl');
    const c = path.join(logs, 'codex', 'c.jsonl');
    const claudeScripts = new Map<string, ScriptLine[]>([
      [a, [{ bytes: 50, event: evt('cl-1', { ts: T + 1000 }) }]],
    ]);
    const codexScripts = new Map<string, ScriptLine[]>([
      [c, [{ bytes: 50, event: evt('cx-1', { ts: T + 2000, agent: 'codex' }) }]],
    ]);
    await writeAll(claudeScripts);
    await writeAll(codexScripts);

    const first = await run([
      new StubAdapter(claudeScripts, 'claude-code'),
      new StubAdapter(codexScripts, 'codex'),
    ]);
    expect(first.events.map((e) => e.id)).toEqual(['cl-1', 'cx-1']);

    const manifest = JSON.parse(await fs.readFile(path.join(cache, 'manifest.json'), 'utf8')) as {
      adapterVersions: Record<string, string>;
    };
    expect(manifest.adapterVersions).toEqual({
      'claude-code': ADAPTER_VERSIONS['claude-code'],
      codex: ADAPTER_VERSIONS.codex,
    });

    const warmClaude = new StubAdapter(claudeScripts, 'claude-code');
    const warmCodex = new StubAdapter(codexScripts, 'codex');
    const second = await run([warmClaude, warmCodex]);
    expect(warmClaude.parseCalls).toEqual([]);
    expect(warmCodex.parseCalls).toEqual([]);
    expect(second).toEqual(first);
  });
});
