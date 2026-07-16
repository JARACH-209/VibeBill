/**
 * Streaming parser for Claude Code JSONL transcripts (spec §5.1, §7.12, §7.13):
 * manual byte-level line splitting with a hard per-line cap, byte-offset
 * accounting for incremental resume, and privacy-preserving record extraction
 * (nothing from `content` is read besides tool_use names and file paths).
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';

import type { FileParseStats, TokenCounts, UsageEvent } from '../../core/types.js';
import { assistantRecordSchema } from './schema.js';
import type { RawUsage } from './schema.js';

/** Hard per-line byte cap (spec §7.13): longer lines are skipped, never buffered whole. */
export const MAX_LINE_BYTES = 10 * 1024 * 1024;

/** API-error records carry this model string and no billable usage (contracts.md). */
const SYNTHETIC_MODEL = '<synthetic>';

const EDIT_TOOL_NAMES: ReadonlySet<string> = new Set([
  'Edit',
  'Write',
  'MultiEdit',
  'NotebookEdit',
]);

const NEWLINE = 0x0a;

/** Classification of one complete transcript line. */
export type LineOutcome =
  | { kind: 'event'; event: UsageEvent }
  /** Parsed fine but not a usage-bearing assistant record (user/attachment/…). */
  | { kind: 'ignored' }
  /** Failed JSON.parse, zod validation, or timestamp parsing — counted as skipped. */
  | { kind: 'malformed' };

const MALFORMED: LineOutcome = { kind: 'malformed' };
const IGNORED: LineOutcome = { kind: 'ignored' };

/** JSON with recursively sorted object keys, so identical usage objects hash identically. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const parts = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${parts.join(',')}}`;
}

/**
 * Token extraction rule verified against real logs (contracts.md): prefer the
 * top-level counts (on retry/fallback records they equal the LAST iteration —
 * the call that landed); only when the top level is all zero and `iterations`
 * is non-empty does the truth live in the iterations sum.
 */
function extractTokens(usage: RawUsage): TokenCounts {
  const top: TokenCounts = {
    input: usage.input_tokens ?? 0,
    output: usage.output_tokens ?? 0,
    cacheWrite: usage.cache_creation_input_tokens ?? 0,
    cacheRead: usage.cache_read_input_tokens ?? 0,
  };
  if (top.input + top.output + top.cacheWrite + top.cacheRead > 0) {
    return top;
  }
  const iterations = usage.iterations ?? [];
  if (iterations.length > 0) {
    const sum: TokenCounts = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
    for (const it of iterations) {
      sum.input += it.input_tokens ?? 0;
      sum.output += it.output_tokens ?? 0;
      sum.cacheWrite += it.cache_creation_input_tokens ?? 0;
      sum.cacheRead += it.cache_read_input_tokens ?? 0;
    }
    return sum;
  }
  return top; // genuinely zero usage
}

/**
 * Unique file paths from Edit/Write/MultiEdit/NotebookEdit tool_use blocks, in
 * order. Plain property narrowing instead of zod here: block inputs carry the
 * edit BODIES (old_string/new_string, whole file contents) and a passthrough
 * schema would deep-clone them per block — pure allocation churn on the hot
 * path (spec §9), and we must never even touch that text (spec §14.3.2). Only
 * `type`, `name` and the two path fields are read.
 */
function extractEditedFiles(content: unknown): string[] {
  if (!Array.isArray(content)) {
    return [];
  }
  const seen = new Set<string>();
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b['type'] !== 'tool_use') continue;
    const name = b['name'];
    if (typeof name !== 'string' || !EDIT_TOOL_NAMES.has(name)) continue;
    const input = b['input'];
    if (typeof input !== 'object' || input === null) continue;
    const i = input as Record<string, unknown>;
    const filePath = i['file_path'];
    const notebookPath = i['notebook_path'];
    const path =
      typeof filePath === 'string' && filePath.length > 0
        ? filePath
        : typeof notebookPath === 'string' && notebookPath.length > 0
          ? notebookPath
          : undefined;
    if (path !== undefined) {
      seen.add(path);
    }
  }
  return [...seen];
}

/** Dedupe id (spec §5.1.4): message.id+":"+requestId, else session:timestamp:usage-hash. */
function dedupeId(
  messageId: string | undefined,
  requestId: string | undefined,
  sessionId: string,
  rawTimestamp: string,
  rawUsage: RawUsage,
): string {
  if (messageId !== undefined && messageId.length > 0 && requestId !== undefined && requestId.length > 0) {
    return `${messageId}:${requestId}`;
  }
  const hash = createHash('sha256').update(canonicalJson(rawUsage)).digest('hex').slice(0, 16);
  return `${sessionId}:${rawTimestamp}:${hash}`;
}

/**
 * Classify one complete JSONL line: a UsageEvent for usage-bearing assistant
 * records, `ignored` for other well-formed records, `malformed` otherwise.
 */
export function eventFromLine(line: string, sourceFile: string): LineOutcome {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return MALFORMED;
  }
  // Envelope discriminator via plain narrowing: a passthrough zod parse here
  // would deep-clone EVERY record (including multi-KB content on the majority
  // of lines) just to read one string — pure GC churn at 100s-of-MB scale
  // (spec §9). Semantics match envelopeSchema: object with a string `type`.
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    return MALFORMED;
  }
  const raw = json as Record<string, unknown>;
  if (typeof raw['type'] !== 'string') {
    return MALFORMED;
  }
  if (raw['type'] !== 'assistant') {
    return IGNORED; // user/attachment/ai-title/… — not usage-bearing, not an error
  }

  // Validate a PROJECTION of only the fields we use: zod still guards every
  // value we read, but the untouched `content` body is never cloned. The raw
  // content reference goes straight to extractEditedFiles (paths only).
  const rawMessage = raw['message'];
  let messageProjection: unknown = rawMessage;
  let rawContent: unknown;
  if (typeof rawMessage === 'object' && rawMessage !== null && !Array.isArray(rawMessage)) {
    const m = rawMessage as Record<string, unknown>;
    rawContent = m['content'];
    messageProjection = { id: m['id'], model: m['model'], usage: m['usage'] };
  }
  const parsed = assistantRecordSchema.safeParse({
    type: raw['type'],
    sessionId: raw['sessionId'],
    timestamp: raw['timestamp'],
    cwd: raw['cwd'],
    gitBranch: raw['gitBranch'],
    isSidechain: raw['isSidechain'],
    requestId: raw['requestId'],
    message: messageProjection,
  });
  if (!parsed.success) {
    return MALFORMED;
  }
  const rec = parsed.data;
  const message = rec.message;
  if (message === undefined || message === null || message.usage === undefined || message.usage === null) {
    return IGNORED; // assistant record without usage — produces no UsageEvent (spec §5.1)
  }

  const model = message.model;
  if (model === undefined || model.length === 0) {
    return MALFORMED; // a usage-bearing record must name its model to be priceable
  }
  if (model === SYNTHETIC_MODEL) {
    return IGNORED; // API-error record — produces no UsageEvent (contracts.md)
  }

  const ts = Date.parse(rec.timestamp);
  if (Number.isNaN(ts)) {
    return MALFORMED;
  }

  return {
    kind: 'event',
    event: {
      id: dedupeId(message.id, rec.requestId, rec.sessionId, rec.timestamp, message.usage),
      agent: 'claude-code',
      sessionId: rec.sessionId,
      ts,
      model,
      tokens: extractTokens(message.usage),
      cwd: rec.cwd ?? null,
      gitBranch: rec.gitBranch ?? null,
      editedFiles: extractEditedFiles(rawContent),
      isSidechain: rec.isSidechain ?? false,
      sourceFile,
    },
  };
}

/**
 * Stream-parse one transcript file, emitting UsageEvents into `sink`; never
 * throws on malformed content (skipped + counted), but does reject on I/O
 * errors (unopenable/unreadable file) so the ingest layer can count the file
 * as skipped. `opts.startOffset` resumes at a byte offset previously reported
 * as `bytesConsumed` (a complete-line boundary); `bytesConsumed` in the result
 * is the absolute offset after the last complete line, so a truncated final
 * line (agent mid-write, spec §7.12) is skipped+counted but NOT consumed and
 * is picked up on the next incremental run.
 */
export async function parseClaudeCodeFile(
  filePath: string,
  sink: (e: UsageEvent) => void,
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

  // Carry state for the line under construction across chunk boundaries.
  let parts: Buffer[] = []; // retained content (only while under the cap)
  let lineBytes = 0; // true byte length so far, including discarded bytes
  let oversized = false;

  const finishLine = (finalSegment: Buffer): void => {
    const totalLen = lineBytes + finalSegment.length;
    if (oversized || totalLen > MAX_LINE_BYTES) {
      stats.linesRead += 1;
      stats.linesSkipped += 1; // oversized line (spec §7.13): cheap skip, content discarded
    } else {
      const buf = parts.length === 0 ? finalSegment : Buffer.concat([...parts, finalSegment]);
      let text = buf.toString('utf8');
      if (text.endsWith('\r')) {
        text = text.slice(0, -1);
      }
      if (text.length > 0) {
        stats.linesRead += 1;
        const outcome = eventFromLine(text, filePath);
        if (outcome.kind === 'event') {
          stats.eventsExtracted += 1;
          sink(outcome.event);
        } else if (outcome.kind === 'malformed') {
          stats.linesSkipped += 1;
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
