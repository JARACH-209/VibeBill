/**
 * Streaming parser for Gemini CLI chat recordings (docs/contracts.md,
 * source-verified against gemini-cli v0.50 chatRecordingService.ts):
 * byte-level line splitting with a hard per-line cap (spec §7.13), byte-offset
 * accounting for incremental resume (spec §7.12), and privacy-preserving
 * extraction — nothing is ever read from message content or tool-call args
 * besides tool names and file paths (spec §14.3.2).
 */
import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import type { FileParseStats, TokenCounts, UsageEvent } from '../../core/types.js';
import {
  legacyDocSchema,
  messageRecordSchema,
  metadataSchema,
  setPatchSchema,
  toolCallSchema,
} from './schema.js';
import type { GeminiTokens } from './schema.js';

/** Hard per-line byte cap (spec §7.13): longer lines are skipped, never buffered whole. */
export const MAX_LINE_BYTES = 10 * 1024 * 1024;

/**
 * Legacy .json chat files are one whole JSON document, so "streaming" them is
 * impossible; as a size guard we only read documents under 64 MB and refuse
 * larger ones (parseFile rejects, so the ingest layer counts a skipped file).
 */
export const MAX_LEGACY_JSON_BYTES = 64 * 1024 * 1024;

/** Only these tool calls carry an edited-file path we may read (contracts.md). */
const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set(['replace', 'write_file']);

const NEWLINE = 0x0a;

/** Per-file context computed by the adapter before parsing begins. */
export interface GeminiFileContext {
  sourceFile: string;
  /** Recovered project root used as event cwd; null when unrecoverable. */
  cwd: string | null;
  /** True when the chat file is nested under chats/<parent>/ (subagent session). */
  nestedSidechain: boolean;
  /** Session id fallback (file basename) when the metadata line is absent or unusable. */
  fallbackSessionId: string;
}

/** Mutable per-file session state, primed by the line-1 metadata record. */
interface GeminiSessionState {
  sessionId: string;
  sidechain: boolean;
}

/** Result of classifying one complete line: emitted events plus a malformed marker. */
interface LineDisposition {
  events: UsageEvent[];
  malformed: boolean;
}

/**
 * Map Gemini token counts to billing classes (contracts.md): `input` INCLUDES
 * `cached` so non-cached input is the difference (clamped at 0); `thoughts`
 * (reasoning) are billed as output tokens; Gemini bills no cache writes. The
 * `tool` and `total` fields are not part of the billing map and are ignored.
 */
function mapTokens(tokens: GeminiTokens): TokenCounts {
  const cached = tokens.cached ?? 0;
  return {
    input: Math.max(0, (tokens.input ?? 0) - cached),
    output: (tokens.output ?? 0) + (tokens.thoughts ?? 0),
    cacheWrite: 0,
    cacheRead: cached,
  };
}

/**
 * Unique file paths from replace/write_file tool calls, in order. Relative
 * paths (rare) resolve against the recovered project root; without a root
 * they are dropped — the event keeps its tokens either way. Nothing besides
 * `name` and `args.file_path` is ever read from a tool call (privacy).
 */
function extractEditedFiles(toolCalls: unknown[] | null | undefined, cwd: string | null): string[] {
  if (toolCalls === null || toolCalls === undefined) {
    return [];
  }
  const seen = new Set<string>();
  for (const call of toolCalls) {
    const parsed = toolCallSchema.safeParse(call);
    if (!parsed.success || parsed.data.name === undefined || !EDIT_TOOL_NAMES.has(parsed.data.name)) {
      continue;
    }
    const filePath = parsed.data.args?.file_path;
    if (filePath === undefined || filePath.length === 0) {
      continue;
    }
    if (isAbsolute(filePath)) {
      seen.add(filePath);
    } else if (cwd !== null) {
      seen.add(resolve(cwd, filePath));
    }
    // No recoverable project root: drop the relative path, keep the tokens.
  }
  return [...seen];
}

/**
 * Map one message record (direct JSONL append, `$set.messages` member, or
 * legacy doc member) to a UsageEvent. Only `type == "gemini"` records with a
 * `tokens` object are usage-bearing; those additionally require an id, a
 * parseable ISO timestamp, and a model name — otherwise they are `malformed`
 * (skipped + counted, never thrown). Everything else is `ignored`.
 */
function mapMessageRecord(
  raw: unknown,
  state: GeminiSessionState,
  ctx: GeminiFileContext,
): UsageEvent | 'ignored' | 'malformed' {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return 'malformed';
  }
  const typeValue = (raw as Record<string, unknown>)['type'];
  if (typeof typeValue !== 'string') {
    return 'ignored'; // unknown auxiliary record — tolerated, not an error
  }
  const parsed = messageRecordSchema.safeParse(raw);
  if (!parsed.success) {
    return 'malformed';
  }
  const rec = parsed.data;
  if (rec.type !== 'gemini') {
    return 'ignored'; // user/info/... — never usage-bearing
  }
  if (rec.tokens === undefined || rec.tokens === null) {
    return 'ignored'; // gemini record without usage
  }
  if (rec.id === undefined || (typeof rec.id === 'string' && rec.id.length === 0)) {
    return 'malformed'; // usage-bearing record needs an id for the dedupe key
  }
  if (rec.timestamp === undefined) {
    return 'malformed'; // missing timestamp on a usage-bearing record: skip + count
  }
  const ts = Date.parse(rec.timestamp);
  if (Number.isNaN(ts)) {
    return 'malformed';
  }
  if (rec.model === undefined || rec.model.length === 0) {
    return 'malformed'; // a usage-bearing record must name its model to be priceable
  }
  return {
    id: `${state.sessionId}:${String(rec.id)}`,
    agent: 'gemini-cli',
    sessionId: state.sessionId,
    ts,
    model: rec.model,
    tokens: mapTokens(rec.tokens),
    cwd: ctx.cwd,
    gitBranch: null, // Gemini CLI does not record the branch
    editedFiles: extractEditedFiles(rec.toolCalls, ctx.cwd),
    isSidechain: state.sidechain,
    sourceFile: ctx.sourceFile,
  };
}

/**
 * If `text` is a valid line-1 metadata record, apply its sessionId and kind to
 * the session state and report true; any other shape reports false untouched.
 */
function applyMetadataLine(text: string | null, state: GeminiSessionState): boolean {
  if (text === null) {
    return false;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return false;
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return false;
  }
  const obj = json as Record<string, unknown>;
  if ('type' in obj || '$set' in obj || '$rewindTo' in obj) {
    return false; // a message/patch record, not metadata
  }
  const meta = metadataSchema.safeParse(obj);
  if (!meta.success) {
    return false;
  }
  if (meta.data.sessionId.length > 0) {
    state.sessionId = meta.data.sessionId;
  }
  if (meta.data.kind !== undefined && meta.data.kind !== 'main') {
    state.sidechain = true; // subagent session; nested-path detection stays ORed in
  }
  return true;
}

/**
 * Classify one complete non-metadata line. `$rewindTo` markers are ignored for
 * accounting (rewound calls still consumed tokens); a `$set.messages` array is
 * a full history replacement whose members are message records — good members
 * emit events even when a sibling member is malformed (the line then counts
 * once in linesSkipped, honesty over silence).
 */
function classifyLine(
  text: string,
  state: GeminiSessionState,
  ctx: GeminiFileContext,
): LineDisposition {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { events: [], malformed: true };
  }
  if (json === null || typeof json !== 'object' || Array.isArray(json)) {
    return { events: [], malformed: true };
  }
  const obj = json as Record<string, unknown>;
  if ('$rewindTo' in obj) {
    return { events: [], malformed: false }; // ignored for accounting (contracts.md)
  }
  if ('$set' in obj) {
    const patch = setPatchSchema.safeParse(obj);
    if (!patch.success) {
      return { events: [], malformed: true };
    }
    const events: UsageEvent[] = [];
    let malformed = false;
    for (const member of patch.data.$set.messages ?? []) {
      const mapped = mapMessageRecord(member, state, ctx);
      if (mapped === 'malformed') {
        malformed = true;
      } else if (mapped !== 'ignored') {
        events.push(mapped);
      }
    }
    return { events, malformed };
  }
  const mapped = mapMessageRecord(obj, state, ctx);
  if (mapped === 'malformed') {
    return { events: [], malformed: true };
  }
  if (mapped === 'ignored') {
    return { events: [], malformed: false };
  }
  return { events: [mapped], malformed: false };
}

/**
 * Read the first complete non-empty line of a file (capped at MAX_LINE_BYTES),
 * used to re-prime session metadata when resuming from a startOffset; null
 * when the file has no usable first line (fallback session id then applies,
 * matching what a full parse would have concluded).
 */
async function readFirstContentLine(filePath: string): Promise<string | null> {
  const stream = createReadStream(filePath);
  let parts: Buffer[] = [];
  let lineBytes = 0;
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    let searchFrom = 0;
    for (;;) {
      const nl = buf.indexOf(NEWLINE, searchFrom);
      if (nl === -1) {
        const rest = buf.subarray(searchFrom);
        lineBytes += rest.length;
        if (lineBytes > MAX_LINE_BYTES) {
          return null; // oversized first line can never be metadata
        }
        parts.push(rest);
        break;
      }
      const segment = buf.subarray(searchFrom, nl);
      lineBytes += segment.length;
      if (lineBytes > MAX_LINE_BYTES) {
        return null;
      }
      let text = Buffer.concat([...parts, segment]).toString('utf8');
      if (text.endsWith('\r')) {
        text = text.slice(0, -1);
      }
      if (text.length > 0) {
        return text;
      }
      parts = [];
      lineBytes = 0;
      searchFrom = nl + 1;
    }
  }
  return null; // no complete non-empty line
}

/**
 * Stream-parse one JSONL chat file, emitting UsageEvents into `sink`; never
 * throws on malformed content (skipped + counted) but does reject on I/O
 * errors so the ingest layer can count the file as skipped. `bytesConsumed`
 * is the absolute offset after the last complete line, so a truncated final
 * line (agent mid-write, spec §7.12) is skipped + counted but NOT consumed.
 * On `opts.startOffset` resume the line-1 metadata (before the offset) is
 * re-primed via a cheap bounded pre-read of the first line.
 */
export async function parseGeminiJsonlFile(
  filePath: string,
  sink: (e: UsageEvent) => void,
  ctx: GeminiFileContext,
  opts?: { startOffset?: number },
): Promise<FileParseStats> {
  const startOffset = opts?.startOffset ?? 0;
  const stats: FileParseStats = {
    path: filePath,
    linesRead: 0,
    eventsExtracted: 0,
    linesSkipped: 0,
    bytesConsumed: startOffset,
  };
  const state: GeminiSessionState = {
    sessionId: ctx.fallbackSessionId,
    sidechain: ctx.nestedSidechain,
  };
  let sawContentLine = startOffset > 0;
  if (startOffset > 0) {
    applyMetadataLine(await readFirstContentLine(filePath), state);
  }

  // Carry state for the line under construction across chunk boundaries.
  let parts: Buffer[] = []; // retained content (only while under the cap)
  let lineBytes = 0; // true byte length so far, including discarded bytes
  let oversized = false;

  const finishLine = (finalSegment: Buffer): void => {
    const totalLen = lineBytes + finalSegment.length;
    if (oversized || totalLen > MAX_LINE_BYTES) {
      stats.linesRead += 1;
      stats.linesSkipped += 1; // oversized line (spec §7.13): cheap skip, content discarded
      sawContentLine = true; // it occupied the line-1 slot even though unreadable
    } else {
      const buf = parts.length === 0 ? finalSegment : Buffer.concat([...parts, finalSegment]);
      let text = buf.toString('utf8');
      if (text.endsWith('\r')) {
        text = text.slice(0, -1);
      }
      if (text.length > 0) {
        stats.linesRead += 1;
        const isFirstContentLine = !sawContentLine;
        sawContentLine = true;
        // Metadata is only recognized on the first content line (contracts.md:
        // "line 1 metadata"), which keeps full parses and offset resumes equivalent.
        if (!(isFirstContentLine && applyMetadataLine(text, state))) {
          const disposition = classifyLine(text, state, ctx);
          for (const event of disposition.events) {
            stats.eventsExtracted += 1;
            sink(event);
          }
          if (disposition.malformed) {
            stats.linesSkipped += 1;
          }
        }
      }
      // Truly empty lines are consumed silently: no data, no stats.
    }
    stats.bytesConsumed += totalLen + 1; // +1 for the newline: line is complete
    parts = [];
    lineBytes = 0;
    oversized = false;
  };

  const stream = createReadStream(filePath, startOffset > 0 ? { start: startOffset } : {});
  for await (const chunk of stream) {
    const buf = chunk as Buffer;
    let searchFrom = 0;
    for (;;) {
      const nl = buf.indexOf(NEWLINE, searchFrom);
      if (nl === -1) {
        const rest = buf.subarray(searchFrom);
        if (rest.length > 0) {
          lineBytes += rest.length;
          if (!oversized) {
            if (lineBytes > MAX_LINE_BYTES) {
              oversized = true;
              parts = []; // discard the carry buffer — never accumulate past the cap
            } else {
              parts.push(rest);
            }
          }
        }
        break;
      }
      finishLine(buf.subarray(searchFrom, nl));
      searchFrom = nl + 1;
    }
  }

  if (lineBytes > 0) {
    // Final line without trailing newline: truncated mid-write (spec §7.12).
    // Skipped + counted, and bytesConsumed does NOT advance past it.
    stats.linesRead += 1;
    stats.linesSkipped += 1;
  }

  return stats;
}

/**
 * Parse one legacy single-document .json chat file. Documents at or over the
 * 64 MB guard are refused by rejecting, so the ingest layer counts a skipped
 * file; an unparseable document is one skipped record, never a throw. Stats
 * treat the document envelope as one line and each `messages` member as one
 * line. The single-document format cannot resume mid-file, so
 * `opts.startOffset` is ignored and the document is always re-parsed from 0
 * (re-emitted events share dedupe ids; ingest keeps the last occurrence).
 */
export async function parseGeminiLegacyJsonFile(
  filePath: string,
  sink: (e: UsageEvent) => void,
  ctx: GeminiFileContext,
): Promise<FileParseStats> {
  const info = await stat(filePath);
  if (info.size >= MAX_LEGACY_JSON_BYTES) {
    throw new Error(
      `legacy Gemini chat file is ${info.size} bytes (>= ${MAX_LEGACY_JSON_BYTES} byte cap), skipping: ${filePath}`,
    );
  }
  const stats: FileParseStats = {
    path: filePath,
    linesRead: 0,
    eventsExtracted: 0,
    linesSkipped: 0,
    bytesConsumed: 0,
  };
  const raw = await readFile(filePath, 'utf8');
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    stats.linesRead = 1;
    stats.linesSkipped = 1; // whole document unparseable (possibly mid-write): skip + count
    return stats;
  }
  const doc = legacyDocSchema.safeParse(json);
  if (!doc.success || json === null || Array.isArray(json)) {
    stats.linesRead = 1;
    stats.linesSkipped = 1;
    return stats;
  }
  stats.linesRead = 1; // the document envelope (metadata equivalent)
  const state: GeminiSessionState = {
    sessionId:
      doc.data.sessionId !== undefined && doc.data.sessionId.length > 0
        ? doc.data.sessionId
        : ctx.fallbackSessionId,
    sidechain:
      ctx.nestedSidechain || (doc.data.kind !== undefined && doc.data.kind !== 'main'),
  };
  for (const member of doc.data.messages ?? []) {
    stats.linesRead += 1;
    const mapped = mapMessageRecord(member, state, ctx);
    if (mapped === 'malformed') {
      stats.linesSkipped += 1;
    } else if (mapped !== 'ignored') {
      stats.eventsExtracted += 1;
      sink(mapped);
    }
  }
  stats.bytesConsumed = info.size; // fully consumed; any change re-parses from 0
  return stats;
}
