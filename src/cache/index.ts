/**
 * Disk cache for ingested usage events (spec §5.2). The cache is ALWAYS
 * disposable: any problem reading it (missing file, invalid JSON, schema
 * drift, checksum mismatch, inconsistent contents) makes `readCache` return
 * `null` and the caller silently rebuilds from the transcripts.
 *
 * Layout under `<repo>/.vibebill/cache/`:
 *
 * - `events.ndjson` — PRE-dedupe, in-scope UsageEvents, one JSON object per
 *   line, in deterministic order (files sorted by path, events in file
 *   order). Design note: dedupe spans files with last-occurrence semantics
 *   (spec §5.1.4), so a change to ONE transcript file can change which
 *   occurrence of a duplicated id wins in ANOTHER file's event set. Caching
 *   the deduped result per file would therefore be incorrect under
 *   incremental re-parse. Instead the cache stores each file's raw in-scope
 *   events and ingest re-runs dedupe over (cached events of unchanged files +
 *   freshly parsed events) on every run — a single in-memory Map pass, cheap
 *   even for hundreds of thousands of events. See src/core/ingest.ts.
 *
 * - `manifest.json` — per-file fingerprints (size / mtimeMs / bytesConsumed),
 *   per-file parse stats and out-of-scope tallies (so warm runs report the
 *   exact same ParseStats and conservation inputs as cold runs without
 *   re-reading any transcript), the adapter versions that produced the cache,
 *   and `dedupeIndexHash` — a sha256 checksum of the exact events.ndjson
 *   content (the dedupe input index), used as the integrity check that ties
 *   the two files together.
 *
 * Privacy (spec §14.3 rule 2): UsageEvent carries only metadata — token
 * counts, model names, session ids, cwd and edited file paths — so nothing
 * here ever persists transcript content text.
 */

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { z } from 'zod';
import type { AgentId, UsageEvent } from '../core/types.js';

export const MANIFEST_FILENAME = 'manifest.json';
export const EVENTS_FILENAME = 'events.ndjson';

/** Raw parse counters for one transcript file (subset of FileParseStats). */
export interface CachedFileStats {
  linesRead: number;
  eventsExtracted: number;
  linesSkipped: number;
}

/** Count of parsed events (and their total tokens) that belong to other repos. */
export interface OutOfScopeTally {
  events: number;
  tokens: number;
}

/** Manifest entry for one transcript file. */
export interface CachedFileEntry {
  size: number;
  mtimeMs: number;
  /** Byte offset after the last complete line the adapter consumed (absolute). */
  bytesConsumed: number;
  agent: AgentId;
  stats: CachedFileStats;
  outOfScope: OutOfScopeTally;
}

/** The cache manifest document (spec §5.2). */
export interface CacheManifest {
  schemaVersion: number;
  adapterVersions: Partial<Record<AgentId, string>>;
  files: Record<string, CachedFileEntry>;
  outOfScope: OutOfScopeTally;
  /** sha256 hex of the exact events.ndjson content (integrity checksum). */
  dedupeIndexHash: string;
}

/** A successfully loaded, internally consistent cache. */
export interface LoadedCache {
  manifest: CacheManifest;
  /** Pre-dedupe in-scope events grouped by sourceFile, in file order. */
  eventsByFile: Map<string, UsageEvent[]>;
}

// ---------------------------------------------------------------------------
// zod schemas — the cache lives on disk and is an untrusted boundary (§14.2).
// ---------------------------------------------------------------------------

const agentIdSchema = z.enum(['claude-code', 'codex', 'gemini-cli', 'aider']);

const countSchema = z.number().finite().nonnegative();

const tokenCountsSchema = z.object({
  input: countSchema,
  output: countSchema,
  cacheWrite: countSchema,
  cacheRead: countSchema,
});

const cachedEventSchema = z.object({
  id: z.string().min(1),
  agent: agentIdSchema,
  sessionId: z.string(),
  ts: z.number().finite(),
  model: z.string(),
  tokens: tokenCountsSchema,
  cwd: z.string().nullable(),
  gitBranch: z.string().nullable(),
  editedFiles: z.array(z.string()),
  isSidechain: z.boolean(),
  sourceFile: z.string().min(1),
});

const outOfScopeSchema = z.object({ events: countSchema, tokens: countSchema });

const fileEntrySchema = z.object({
  size: countSchema,
  mtimeMs: z.number().finite(),
  bytesConsumed: countSchema,
  agent: agentIdSchema,
  stats: z.object({
    linesRead: countSchema,
    eventsExtracted: countSchema,
    linesSkipped: countSchema,
  }),
  outOfScope: outOfScopeSchema,
});

const manifestSchema = z.object({
  schemaVersion: z.number().int(),
  adapterVersions: z.record(z.string()),
  files: z.record(fileEntrySchema),
  outOfScope: outOfScopeSchema,
  dedupeIndexHash: z.string(),
});

// ---------------------------------------------------------------------------

/** Serialize one UsageEvent to a canonical single-line JSON (stable key order). */
export function serializeEvent(e: UsageEvent): string {
  return JSON.stringify({
    id: e.id,
    agent: e.agent,
    sessionId: e.sessionId,
    ts: e.ts,
    model: e.model,
    tokens: {
      input: e.tokens.input,
      output: e.tokens.output,
      cacheWrite: e.tokens.cacheWrite,
      cacheRead: e.tokens.cacheRead,
    },
    cwd: e.cwd,
    gitBranch: e.gitBranch,
    editedFiles: e.editedFiles,
    isSidechain: e.isSidechain,
    sourceFile: e.sourceFile,
  });
}

/** sha256 hex of the events.ndjson text — the manifest's `dedupeIndexHash`. */
export function computeDedupeIndexHash(ndjsonText: string): string {
  return createHash('sha256').update(ndjsonText, 'utf8').digest('hex');
}

/** Flush threshold for the buffered streaming cache write. */
const WRITE_CHUNK_CHARS = 256 * 1024;

/**
 * Write the cache: events.ndjson first, then manifest.json carrying the
 * checksum of what was just written. A crash between the two writes leaves a
 * manifest whose checksum does not match the ndjson, which `readCache`
 * detects and treats as corrupt (silent full rebuild) — never wrong data.
 *
 * The events file is written in buffered chunks with the checksum computed
 * incrementally: materializing the whole ndjson (tens of MB on large corpora)
 * would blow the spec §9 RSS ceiling. Content is byte-identical to the
 * previous whole-string implementation.
 */
export async function writeCache(
  cacheDir: string,
  manifest: Omit<CacheManifest, 'dedupeIndexHash'>,
  eventsInOrder: readonly UsageEvent[],
): Promise<void> {
  await fs.mkdir(cacheDir, { recursive: true });
  const hash = createHash('sha256');
  const handle = await fs.open(path.join(cacheDir, EVENTS_FILENAME), 'w');
  try {
    let buffered: string[] = [];
    let bufferedChars = 0;
    const flush = async (): Promise<void> => {
      if (bufferedChars === 0) return;
      const chunk = buffered.join('');
      buffered = [];
      bufferedChars = 0;
      hash.update(chunk, 'utf8');
      await handle.write(chunk, null, 'utf8');
    };
    for (const event of eventsInOrder) {
      const line = serializeEvent(event) + '\n';
      buffered.push(line);
      bufferedChars += line.length;
      if (bufferedChars >= WRITE_CHUNK_CHARS) await flush();
    }
    await flush();
  } finally {
    await handle.close();
  }
  const full: CacheManifest = { ...manifest, dedupeIndexHash: hash.digest('hex') };
  await fs.writeFile(
    path.join(cacheDir, MANIFEST_FILENAME),
    JSON.stringify(full, null, 2) + '\n',
    'utf8',
  );
}

/**
 * Load and validate the cache; returns null on ANY inconsistency (the caller
 * silently rebuilds — spec §5.2 "corrupt/missing cache ⇒ silent full rebuild").
 */
export async function readCache(cacheDir: string): Promise<LoadedCache | null> {
  let manifestRaw: string;
  try {
    manifestRaw = await fs.readFile(path.join(cacheDir, MANIFEST_FILENAME), 'utf8');
  } catch {
    return null;
  }
  let manifestJson: unknown;
  try {
    manifestJson = JSON.parse(manifestRaw);
  } catch {
    return null;
  }
  const parsed = manifestSchema.safeParse(manifestJson);
  if (!parsed.success) return null;

  // Stream the events file line-by-line, hashing raw bytes incrementally —
  // never the whole file as one string (spec §9 RSS ceiling). A missing
  // events file is only valid when the manifest was written for zero cached
  // events (checksum of the empty string); otherwise the hash mismatches.
  const eventsByFile = new Map<string, UsageEvent[]>();
  const hash = createHash('sha256');
  const acceptLine = (line: string): boolean => {
    if (line === '') return true;
    let lineJson: unknown;
    try {
      lineJson = JSON.parse(line);
    } catch {
      return false;
    }
    const event = cachedEventSchema.safeParse(lineJson);
    if (!event.success) return false;
    // Every cached event must belong to a file the manifest knows about.
    if (!Object.prototype.hasOwnProperty.call(parsed.data.files, event.data.sourceFile)) {
      return false;
    }
    const list = eventsByFile.get(event.data.sourceFile);
    if (list === undefined) eventsByFile.set(event.data.sourceFile, [event.data]);
    else list.push(event.data);
    return true;
  };
  try {
    const decoder = new StringDecoder('utf8');
    let carry = '';
    const stream = createReadStream(path.join(cacheDir, EVENTS_FILENAME));
    for await (const chunk of stream) {
      const buf = chunk as Buffer;
      hash.update(buf);
      carry += decoder.write(buf);
      let nl = carry.indexOf('\n');
      while (nl !== -1) {
        if (!acceptLine(carry.slice(0, nl))) return null;
        carry = carry.slice(nl + 1);
        nl = carry.indexOf('\n');
      }
    }
    carry += decoder.end();
    if (carry !== '' && !acceptLine(carry)) return null;
  } catch {
    // Unreadable events file: fall through with whatever was hashed so far —
    // an absent file hashes as empty, matching only a zero-event manifest.
  }
  if (hash.digest('hex') !== parsed.data.dedupeIndexHash) return null;

  const manifest: CacheManifest = {
    schemaVersion: parsed.data.schemaVersion,
    // Parse boundary: unknown agent-id keys are tolerated (and ignored by the
    // version check in ingest); values are plain strings either way.
    adapterVersions: parsed.data.adapterVersions as Partial<Record<AgentId, string>>,
    files: parsed.data.files,
    outOfScope: parsed.data.outOfScope,
    dedupeIndexHash: parsed.data.dedupeIndexHash,
  };
  return { manifest, eventsByFile };
}
