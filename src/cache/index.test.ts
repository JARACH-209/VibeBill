import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UsageEvent } from '../core/types.js';
import {
  computeDedupeIndexHash,
  EVENTS_FILENAME,
  MANIFEST_FILENAME,
  readCache,
  serializeEvent,
  writeCache,
  type CacheManifest,
} from './index.js';

function makeEvent(id: string, sourceFile: string, over: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id,
    agent: 'claude-code',
    sessionId: 'sess-1',
    ts: 1_750_000_000_000,
    model: 'claude-opus-4-8',
    tokens: { input: 10, output: 5, cacheWrite: 2, cacheRead: 100 },
    cwd: '/repo',
    gitBranch: 'main',
    editedFiles: [],
    isSidechain: false,
    sourceFile,
    ...over,
  };
}

function makeManifest(
  files: Record<string, { events: number }>,
): Omit<CacheManifest, 'dedupeIndexHash'> {
  const fileEntries: CacheManifest['files'] = {};
  for (const [p, info] of Object.entries(files)) {
    fileEntries[p] = {
      size: 1000,
      mtimeMs: 1_750_000_000_123.5,
      bytesConsumed: 1000,
      agent: 'claude-code',
      stats: { linesRead: 10, eventsExtracted: info.events, linesSkipped: 1 },
      outOfScope: { events: 0, tokens: 0 },
    };
  }
  return {
    schemaVersion: 1,
    adapterVersions: { 'claude-code': '1' },
    files: fileEntries,
    outOfScope: { events: 0, tokens: 0 },
  };
}

describe('cache read/write', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'vibebill-cache-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('round-trips manifest and events grouped by sourceFile in order', async () => {
    const a1 = makeEvent('a1', '/logs/a.jsonl', { ts: 3 });
    const a2 = makeEvent('a2', '/logs/a.jsonl', { ts: 1, cwd: null, gitBranch: null });
    const b1 = makeEvent('b1', '/logs/b.jsonl', { editedFiles: ['/repo/x.ts'] });
    const manifest = makeManifest({
      '/logs/a.jsonl': { events: 2 },
      '/logs/b.jsonl': { events: 1 },
    });

    await writeCache(dir, manifest, [a1, a2, b1]);
    const loaded = await readCache(dir);

    expect(loaded).not.toBeNull();
    expect(loaded?.manifest.schemaVersion).toBe(1);
    expect(loaded?.manifest.adapterVersions['claude-code']).toBe('1');
    expect(loaded?.manifest.files['/logs/a.jsonl']?.mtimeMs).toBe(1_750_000_000_123.5);
    expect(loaded?.eventsByFile.get('/logs/a.jsonl')).toEqual([a1, a2]);
    expect(loaded?.eventsByFile.get('/logs/b.jsonl')).toEqual([b1]);
  });

  it('round-trips zero events (and tolerates the ndjson file being deleted)', async () => {
    await writeCache(dir, makeManifest({}), []);
    expect(await readCache(dir)).not.toBeNull();
    await fs.rm(path.join(dir, EVENTS_FILENAME));
    // checksum of '' still matches a zero-event manifest
    expect(await readCache(dir)).not.toBeNull();
  });

  it('returns null when the cache directory or manifest is missing', async () => {
    expect(await readCache(path.join(dir, 'nope'))).toBeNull();
    expect(await readCache(dir)).toBeNull();
  });

  it('returns null on malformed manifest JSON', async () => {
    await writeCache(dir, makeManifest({}), []);
    await fs.writeFile(path.join(dir, MANIFEST_FILENAME), '{ this is not json', 'utf8');
    expect(await readCache(dir)).toBeNull();
  });

  it('returns null when the manifest fails schema validation', async () => {
    await writeCache(dir, makeManifest({}), []);
    await fs.writeFile(
      path.join(dir, MANIFEST_FILENAME),
      JSON.stringify({ schemaVersion: 'one', files: {} }),
      'utf8',
    );
    expect(await readCache(dir)).toBeNull();
  });

  it('returns null when events.ndjson does not match the manifest checksum', async () => {
    const e = makeEvent('e1', '/logs/a.jsonl');
    await writeCache(dir, makeManifest({ '/logs/a.jsonl': { events: 1 } }), [e]);
    await fs.appendFile(path.join(dir, EVENTS_FILENAME), 'garbage\n', 'utf8');
    expect(await readCache(dir)).toBeNull();
  });

  it('returns null when an event line fails schema validation (checksum forged)', async () => {
    const badLine = JSON.stringify({ id: 'x', agent: 'not-an-agent' }) + '\n';
    const manifest: CacheManifest = {
      ...makeManifest({ '/logs/a.jsonl': { events: 1 } }),
      dedupeIndexHash: computeDedupeIndexHash(badLine),
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, EVENTS_FILENAME), badLine, 'utf8');
    await fs.writeFile(path.join(dir, MANIFEST_FILENAME), JSON.stringify(manifest), 'utf8');
    expect(await readCache(dir)).toBeNull();
  });

  it('returns null when an event references a file the manifest does not know', async () => {
    const orphan = serializeEvent(makeEvent('e1', '/logs/unknown.jsonl')) + '\n';
    const manifest: CacheManifest = {
      ...makeManifest({}),
      dedupeIndexHash: computeDedupeIndexHash(orphan),
    };
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, EVENTS_FILENAME), orphan, 'utf8');
    await fs.writeFile(path.join(dir, MANIFEST_FILENAME), JSON.stringify(manifest), 'utf8');
    expect(await readCache(dir)).toBeNull();
  });

  it('serializes events deterministically regardless of input key order', () => {
    const shuffled = {
      sourceFile: '/logs/a.jsonl',
      isSidechain: false,
      id: 'e1',
      tokens: { cacheRead: 100, input: 10, cacheWrite: 2, output: 5 },
      agent: 'claude-code',
      ts: 1_750_000_000_000,
      cwd: '/repo',
      editedFiles: [],
      gitBranch: 'main',
      model: 'claude-opus-4-8',
      sessionId: 'sess-1',
    } satisfies UsageEvent;
    expect(serializeEvent(shuffled)).toBe(serializeEvent(makeEvent('e1', '/logs/a.jsonl')));
  });
});
