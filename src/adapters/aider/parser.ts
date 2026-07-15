/**
 * Streaming parser for aider chat history markdown (`.aider.chat.history.md`),
 * implementing the source-verified format in docs/contracts.md (aider v0.86
 * base_coder.py/io.py; no local samples, so the adapter reports
 * schemaVerified: false). Line-based scan with the shared 10 MB line-cap and
 * byte-offset discipline (spec §7.12/§7.13). Privacy (spec §14.3.2): only
 * session headers, model announcements, token lines, and applied-edit file
 * paths are ever inspected; every other markdown line (prompts, responses,
 * code) is pattern-tested and dropped — never stored or logged.
 */
import { createReadStream } from 'node:fs';
import { resolve } from 'node:path';

import type { FileParseStats, UsageEvent } from '../../core/types.js';

/** Hard per-line byte cap (spec §7.13): longer lines are skipped, never buffered whole. */
export const MAX_LINE_BYTES = 10 * 1024 * 1024;

const NEWLINE = 0x0a;

const SESSION_HEADER_PREFIX = '# aider chat started at ';
const SESSION_HEADER_RE =
  /^# aider chat started at (\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\s*$/;

/**
 * Model announcement; the latest one seen in the file wins (contracts.md).
 * "Weak model:" lines intentionally do not match. The captured model string
 * may be "provider/model" form — it is kept raw, never transformed (spec
 * §1.1/§14.3.4); the pricing engine's longest-prefix match may therefore miss
 * provider-prefixed forms, which surfaces as an honest "unpriced" label.
 */
const MODEL_RE = /^> (?:Main model|Model): (.+?) with .+ edit format/;

/** A line that claims to be a usage line; failing the full parse counts as skipped. */
const USAGE_CANDIDATE_RE = /^(?:> )?Tokens: /;
const NUM = String.raw`\d+(?:\.\d+)?k?`;
/**
 * `Tokens: A sent[, B cache write][, C cache hit], D received.` with or
 * without the `> ` prefix. Anything after `received.` (aider's own `Cost:`
 * clause, same line) is ignored; a `Cost:` clause on the NEXT line is plain
 * unmatched content. We never use aider's cost figures — tokens are priced
 * by our own table (contracts.md).
 */
const USAGE_RE = new RegExp(
  `^(?:> )?Tokens: (${NUM}) sent(?:, (${NUM}) cache write)?(?:, (${NUM}) cache hit)?, (${NUM}) received\\.`,
);

const APPLIED_EDIT_RE = /^> Applied edit to (.+)$/;

/**
 * Parse aider's k-notation token count exactly: "999" = 999, "4.2k" = 4200,
 * "12k" = 12000; a bare decimal without the k suffix is not a token count.
 */
export function parseTokenCount(raw: string): number | null {
  const m = /^(\d+)(?:\.(\d+))?(k)?$/.exec(raw);
  if (m === null || m[1] === undefined) {
    return null;
  }
  const intPart = m[1];
  const fracPart = m[2];
  if (m[3] === undefined) {
    return fracPart === undefined ? Number(intPart) : null;
  }
  // Exact integer scaling of up to three decimal places; aider emits one ("4.2k").
  let value = Number(intPart) * 1000;
  if (fracPart !== undefined) {
    value += Number(fracPart.slice(0, 3).padEnd(3, '0'));
  }
  return value;
}

/**
 * Parse a `# aider chat started at YYYY-MM-DD HH:MM:SS` header to UTC ms.
 * The stamp carries no zone; per contracts.md it is machine-LOCAL time, so we
 * use local `new Date(y, m, d, ...)` semantics — deterministic given the
 * machine TZ (documented limitation). Rollover dates (e.g. Feb 30) are
 * rejected rather than silently guessed (spec §14.3.4).
 */
export function parseSessionHeaderTs(line: string): number | null {
  const m = SESSION_HEADER_RE.exec(line);
  if (m === null) {
    return null;
  }
  const [, y, mo, d, h, mi, s] = m;
  if (
    y === undefined ||
    mo === undefined ||
    d === undefined ||
    h === undefined ||
    mi === undefined ||
    s === undefined
  ) {
    return null;
  }
  const year = Number(y);
  const month = Number(mo);
  const day = Number(d);
  const hour = Number(h);
  const minute = Number(mi);
  const second = Number(s);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }
  const date = new Date(year, month - 1, day, hour, minute, second);
  // Reject calendar rollover (Feb 30 → Mar 2). Time fields are not re-checked:
  // a DST-gap local time legitimately resolves to a shifted hour.
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return null;
  }
  return date.getTime();
}

/** Per-session parse state; aider records no per-message timestamps or ids. */
interface SessionState {
  id: string;
  startTs: number;
  /** Usage lines seen so far — the next event's ordinal within the session. */
  usageCount: number;
  /** `Applied edit` paths seen before the session's first usage line. */
  preUsageEdits: string[];
}

/**
 * Stream-parse one aider history file, emitting UsageEvents into `sink`;
 * never throws on malformed content (skipped + counted) but rejects on I/O
 * errors so the ingest layer can count the file as skipped. Usage events are
 * buffered one-deep and flushed on the next usage line / session header /
 * EOF so trailing `Applied edit to` lines can still attach to the event they
 * follow. `opts.startOffset` is accepted but the file is ALWAYS re-parsed
 * from 0: the format is stateful (session headers and model lines set context
 * for later lines), so a mid-file resume can never reconstruct state — per
 * the SourceAdapter contract, adapters re-parse from 0 when unsure. Event ids
 * are stable across re-parses, so the ingest layer's last-wins dedupe absorbs
 * the re-emission (and picks up edits appended after a previous run's flush).
 */
export async function parseAiderFile(
  filePath: string,
  repoRoot: string,
  sink: (e: UsageEvent) => void,
  opts?: { startOffset?: number },
): Promise<FileParseStats> {
  void opts?.startOffset; // intentionally ignored — see doc comment above
  const stats: FileParseStats = {
    path: filePath,
    linesRead: 0,
    eventsExtracted: 0,
    linesSkipped: 0,
    bytesConsumed: 0,
  };

  let sessionOrdinal = 0; // session index within the file, disambiguates identical start times
  let session: SessionState | null = null;
  let currentModel = ''; // latest model line in the file; '' before any ⇒ unpriced
  let pending: UsageEvent | null = null; // last usage event, held for late edit lines

  const flushPending = (): void => {
    if (pending !== null) {
      stats.eventsExtracted += 1;
      sink(pending);
      pending = null;
    }
  };

  const handleLine = (text: string): void => {
    stats.linesRead += 1;

    if (text.startsWith(SESSION_HEADER_PREFIX)) {
      const startTs = parseSessionHeaderTs(text);
      if (startTs === null) {
        stats.linesSkipped += 1; // header-shaped line with an unparseable timestamp
        return;
      }
      flushPending();
      session = { id: `aider:${startTs}:${sessionOrdinal}`, startTs, usageCount: 0, preUsageEdits: [] };
      sessionOrdinal += 1;
      return;
    }

    if (USAGE_CANDIDATE_RE.test(text)) {
      const m = USAGE_RE.exec(text);
      if (m !== null && session !== null) {
        const g1 = m[1];
        const g2 = m[2];
        const g3 = m[3];
        const g4 = m[4];
        const sent = g1 === undefined ? null : parseTokenCount(g1);
        const cacheWrite = g2 === undefined ? 0 : parseTokenCount(g2);
        const cacheRead = g3 === undefined ? 0 : parseTokenCount(g3);
        const output = g4 === undefined ? null : parseTokenCount(g4);
        if (sent !== null && cacheWrite !== null && cacheRead !== null && output !== null) {
          flushPending();
          // The session's first usage event adopts any edits printed before it.
          const editedFiles = session.usageCount === 0 ? session.preUsageEdits : [];
          session.preUsageEdits = [];
          pending = {
            id: `${session.id}:${session.usageCount}`, // ordinal-of-usage-line: stable across re-parses
            agent: 'aider',
            sessionId: session.id,
            ts: session.startTs, // aider records no per-message timestamps (documented limitation)
            model: currentModel,
            tokens: {
              input: Math.max(0, sent - cacheWrite - cacheRead), // "sent" includes cache traffic
              output,
              cacheWrite,
              cacheRead,
            },
            cwd: repoRoot,
            gitBranch: null,
            editedFiles,
            isSidechain: false,
            sourceFile: filePath,
          };
          session.usageCount += 1;
          return;
        }
      }
      stats.linesSkipped += 1; // unparseable numbers, or a usage line before any session header
      return;
    }

    const model = MODEL_RE.exec(text);
    if (model !== null) {
      currentModel = model[1] ?? ''; // raw, possibly "provider/model" — never transformed
      return;
    }

    const edit = APPLIED_EDIT_RE.exec(text);
    if (edit !== null) {
      const rel = edit[1];
      if (rel === undefined || session === null) {
        return; // stray edit before any session: nothing to attach it to
      }
      const abs = resolve(repoRoot, rel); // repo-relative → absolute (UsageEvent contract)
      if (pending !== null) {
        if (!pending.editedFiles.includes(abs)) {
          pending.editedFiles.push(abs);
        }
      } else if (session.usageCount === 0 && !session.preUsageEdits.includes(abs)) {
        session.preUsageEdits.push(abs);
      }
      return;
    }

    // Ordinary chat/markdown content — ignored entirely, never stored (privacy).
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
        handleLine(text);
      }
      // Truly empty lines are consumed silently: no data, no stats.
    }
    stats.bytesConsumed += totalLen + 1; // +1 for the newline: line is complete
    parts = [];
    lineBytes = 0;
    oversized = false;
  };

  const stream = createReadStream(filePath);
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

  flushPending(); // EOF flushes the last buffered usage event

  return stats;
}
