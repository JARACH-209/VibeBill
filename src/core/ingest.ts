/**
 * Ingest orchestration (spec §5.2): discovers transcript files across source
 * adapters, incrementally re-parses only what changed (size/mtime compare,
 * byte-offset resume for grown files), filters events to this repo by
 * realpath-normalized cwd (spec §7.1/§7.2), dedupes across all files, and
 * maintains the disposable disk cache in `<repo>/.vibebill/cache/`.
 *
 * Dedupe/caching design (IMPORTANT): dedupe is last-occurrence-wins ACROSS
 * files (spec §5.1.4), so a change to one file can change which occurrence of
 * a duplicated id survives from another file. The cache therefore stores
 * PRE-dedupe in-scope events per file (see src/cache/index.ts), and dedupe
 * re-runs on every ingest over (cached events of unchanged files + freshly
 * parsed events) — one in-memory Map pass. duplicatesRemoved = raw − deduped.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  readCache,
  writeCache,
  type CachedFileEntry,
  type CacheManifest,
  type OutOfScopeTally,
} from '../cache/index.js';
import type { AgentId, FileParseStats, ParseStats, SourceAdapter, UsageEvent } from './types.js';
import { totalTokens } from './types.js';

/** Cache layout version; bumping invalidates every existing cache wholesale. */
export const INGEST_SCHEMA_VERSION = 1;

/**
 * Per-adapter parser versions recorded in the manifest. Bump an entry whenever
 * that adapter's parsing/mapping changes; a mismatch invalidates the cache
 * wholesale (spec §5.2) because cached events and stats may have been produced
 * by the older parser.
 */
export const ADAPTER_VERSIONS: Record<AgentId, string> = {
  'claude-code': '1',
  codex: '1',
  'gemini-cli': '1',
  aider: '1',
};

/** Result of one ingest run across all adapters. */
export interface IngestResult {
  /** Deduped, cwd inside repo root (realpath), sorted by (ts, id). */
  events: UsageEvent[];
  /** Aggregated across ALL files including unchanged-cached ones (warm == cold). */
  stats: ParseStats;
  /** Parsed but outside this repo — feeds the conservation invariant (spec §1.3). */
  outOfScope: { events: number; tokens: number };
  unknownRecordTypes?: never; // ParseStats stays the single stats surface
}

interface ParsedFile {
  stats: FileParseStats;
  inScope: UsageEvent[];
  outOfScope: OutOfScopeTally;
}

/** Deterministic, locale-independent string ordering. */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** realpath when the path exists; plain resolution otherwise (best evidence we have). */
async function realpathOrResolve(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return path.resolve(p);
  }
}

/**
 * Build the cwd → in-scope predicate: an event is in scope iff
 * realpath(event.cwd) equals or sits under realpath(repoRoot) (spec §7.1).
 * Each DISTINCT cwd string is resolved exactly once per run; null cwd cannot
 * prove membership and is out of scope.
 */
function makeScopeChecker(realRoot: string): (cwd: string | null) => Promise<boolean> {
  const rootPrefix = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
  const memo = new Map<string, boolean>();
  return async (cwd: string | null): Promise<boolean> => {
    if (cwd === null) return false;
    const hit = memo.get(cwd);
    if (hit !== undefined) return hit;
    const resolved = await realpathOrResolve(cwd);
    const inScope = resolved === realRoot || resolved.startsWith(rootPrefix);
    memo.set(cwd, inScope);
    return inScope;
  };
}

/** True when the cached manifest was produced by the current schema + adapter versions. */
function cacheIsCurrent(manifest: CacheManifest, adapters: readonly SourceAdapter[]): boolean {
  if (manifest.schemaVersion !== INGEST_SCHEMA_VERSION) return false;
  return adapters.every((a) => manifest.adapterVersions[a.id] === ADAPTER_VERSIONS[a.id]);
}

/**
 * Parse one file through its adapter and split the emitted events into
 * in-scope / out-of-scope. Returns null when the adapter itself throws
 * (adapters shouldn't — spec §5.1.3 — but a bad file must never crash us).
 */
async function parseAndClassify(
  adapter: SourceAdapter,
  filePath: string,
  startOffset: number | undefined,
  isInScope: (cwd: string | null) => Promise<boolean>,
): Promise<ParsedFile | null> {
  const collected: UsageEvent[] = [];
  let stats: FileParseStats;
  try {
    stats = await adapter.parseFile(
      filePath,
      (e) => collected.push(e),
      startOffset === undefined ? undefined : { startOffset },
    );
  } catch {
    return null;
  }
  const inScope: UsageEvent[] = [];
  const outOfScope: OutOfScopeTally = { events: 0, tokens: 0 };
  for (const event of collected) {
    if (await isInScope(event.cwd)) {
      inScope.push(event);
    } else {
      // Counted (events + total tokens) so the conservation invariant can be
      // checked against raw parse totals (spec §1.3, §5.2) — but never cached.
      outOfScope.events += 1;
      outOfScope.tokens += totalTokens(event.tokens);
    }
  }
  return { stats, inScope, outOfScope };
}

/**
 * Incremental, cached ingest across adapters (spec §5.2): re-parses only
 * changed transcript files, resumes grown files from the recorded byte offset,
 * dedupes across all files (last occurrence wins), and returns this repo's
 * events sorted by (ts, id) plus parse stats identical between warm and cold runs.
 */
export async function ingestEvents(opts: {
  repoRoot: string;
  adapters: SourceAdapter[];
  cacheDir: string;
  /** Force full re-parse; neither reads nor writes the cache (doctor dry runs). */
  noCache?: boolean;
}): Promise<IngestResult> {
  const noCache = opts.noCache ?? false;
  const realRoot = await realpathOrResolve(opts.repoRoot);
  const isInScope = makeScopeChecker(realRoot);

  let cache = noCache ? null : await readCache(opts.cacheDir);
  if (cache !== null && !cacheIsCurrent(cache.manifest, opts.adapters)) cache = null;

  // Discovery. First adapter to claim a path owns it; the combined list is
  // sorted by path so dedupe order (and everything downstream) is deterministic.
  const adapterByPath = new Map<string, SourceAdapter>();
  for (const adapter of opts.adapters) {
    for (const p of await adapter.discover()) {
      if (!adapterByPath.has(p)) adapterByPath.set(p, adapter);
    }
  }
  const sortedFiles = [...adapterByPath.entries()].sort(([a], [b]) => compareStrings(a, b));

  const stats: ParseStats = {
    filesFound: sortedFiles.length,
    filesRead: 0,
    filesSkipped: 0,
    linesRead: 0,
    eventsExtracted: 0,
    linesSkipped: 0,
    duplicatesRemoved: 0,
  };
  const outOfScope: OutOfScopeTally = { events: 0, tokens: 0 };
  const manifestFiles: Record<string, CachedFileEntry> = {};
  /** Pre-dedupe in-scope events: files sorted by path, events in file order. */
  const rawInScope: UsageEvent[] = [];

  for (const [filePath, adapter] of sortedFiles) {
    let stat;
    try {
      stat = await fs.stat(filePath);
    } catch {
      // Discovered but not statable (deleted mid-run, permissions): skip;
      // no manifest entry, so the next run reconsiders it from scratch.
      stats.filesSkipped += 1;
      continue;
    }

    const prior = cache?.manifest.files[filePath];
    const priorEvents = cache?.eventsByFile.get(filePath) ?? [];
    const priorUsable = prior !== undefined && prior.agent === adapter.id;

    let entry: CachedFileEntry;
    let fileEvents: UsageEvent[];

    if (priorUsable && stat.size === prior.size && stat.mtimeMs === prior.mtimeMs) {
      // Unchanged: reuse cached events AND cached per-file stats without
      // touching the transcript, so warm runs report identical ParseStats.
      entry = prior;
      fileEvents = priorEvents;
    } else if (priorUsable && stat.size > prior.size && prior.bytesConsumed <= prior.size) {
      // Grew: resume from bytesConsumed — a line boundary the adapter itself
      // reported last run — and merge the fresh tail with that file's cached
      // events (which stay in file order: cached head, then new tail).
      // Adapters return ABSOLUTE bytesConsumed even when resuming.
      const parsed = await parseAndClassify(adapter, filePath, prior.bytesConsumed, isInScope);
      if (parsed === null) {
        stats.filesSkipped += 1;
        continue;
      }
      entry = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        bytesConsumed: parsed.stats.bytesConsumed,
        agent: adapter.id,
        stats: {
          linesRead: prior.stats.linesRead + parsed.stats.linesRead,
          eventsExtracted: prior.stats.eventsExtracted + parsed.stats.eventsExtracted,
          linesSkipped: prior.stats.linesSkipped + parsed.stats.linesSkipped,
        },
        outOfScope: {
          events: prior.outOfScope.events + parsed.outOfScope.events,
          tokens: prior.outOfScope.tokens + parsed.outOfScope.tokens,
        },
      };
      fileEvents = [...priorEvents, ...parsed.inScope];
    } else {
      // New file, shrunk, rewritten in place (mtime-only change), or produced
      // by a different adapter: full re-parse REPLACES that file's cached events.
      const parsed = await parseAndClassify(adapter, filePath, undefined, isInScope);
      if (parsed === null) {
        stats.filesSkipped += 1;
        continue;
      }
      entry = {
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        bytesConsumed: parsed.stats.bytesConsumed,
        agent: adapter.id,
        stats: {
          linesRead: parsed.stats.linesRead,
          eventsExtracted: parsed.stats.eventsExtracted,
          linesSkipped: parsed.stats.linesSkipped,
        },
        outOfScope: parsed.outOfScope,
      };
      fileEvents = parsed.inScope;
    }

    manifestFiles[filePath] = entry;
    stats.filesRead += 1;
    stats.linesRead += entry.stats.linesRead;
    stats.eventsExtracted += entry.stats.eventsExtracted;
    stats.linesSkipped += entry.stats.linesSkipped;
    outOfScope.events += entry.outOfScope.events;
    outOfScope.tokens += entry.outOfScope.tokens;
    for (const event of fileEvents) rawInScope.push(event);
  }

  // Dedupe across ALL files by event id, LAST occurrence winning in the
  // deterministic order built above (spec §5.1.4). Map.set naturally keeps
  // the last write per key.
  const byId = new Map<string, UsageEvent>();
  for (const event of rawInScope) byId.set(event.id, event);
  stats.duplicatesRemoved = rawInScope.length - byId.size;

  const events = [...byId.values()].sort((a, b) => a.ts - b.ts || compareStrings(a.id, b.id));

  if (!noCache) {
    const manifest: Omit<CacheManifest, 'dedupeIndexHash'> = {
      schemaVersion: INGEST_SCHEMA_VERSION,
      adapterVersions: Object.fromEntries(
        opts.adapters.map((a) => [a.id, ADAPTER_VERSIONS[a.id]]),
      ) as Partial<Record<AgentId, string>>,
      files: manifestFiles,
      outOfScope: { ...outOfScope },
    };
    try {
      await writeCache(opts.cacheDir, manifest, rawInScope);
    } catch {
      // The cache is best-effort and disposable; a failed write (read-only
      // disk, ENOSPC) must never fail the ingest itself.
    }
  }

  return { events, stats, outOfScope };
}
