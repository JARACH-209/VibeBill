/**
 * Streaming parser for Codex CLI rollout JSONL files (docs/contracts.md,
 * VERIFIED against real v0.138 rollouts; tolerance rules per spec §5.1.3,
 * §7.12, §7.13). Unlike Claude Code transcripts, rollout files are STATEFUL:
 * `session_meta` names the session and initial cwd, `turn_context` supplies
 * model/cwd for subsequent events, and `apply_patch` calls accumulate edited
 * file paths that attach to the NEXT `token_count`. Resuming at a byte offset
 * therefore replays the prefix for state only (no events, no stats) before
 * emitting from the offset onward.
 */
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

import type { FileParseStats, TokenCounts, UsageEvent } from '../../core/types.js';
import {
  applyPatchArgumentsSchema,
  envelopeSchema,
  eventMsgPayloadSchema,
  execArgumentsSchema,
  functionCallPayloadSchema,
  responseItemPayloadSchema,
  sessionMetaPayloadSchema,
  tokenCountPayloadSchema,
  turnContextPayloadSchema,
} from './schema.js';
import type { RawTokenUsage } from './schema.js';

/** Hard per-line byte cap (spec §7.13): longer lines are skipped, never buffered whole. */
export const MAX_LINE_BYTES = 10 * 1024 * 1024;

const NEWLINE = 0x0a;

/**
 * Patch header lines carrying file paths — the ONLY thing ever read out of a
 * patch body (privacy, spec §14.3.2). Contract: docs/contracts.md Codex section.
 */
const PATCH_FILE_HEADER = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm;

/** shell/exec_command string form: the command line invokes apply_patch directly. */
const APPLY_PATCH_COMMAND_STRING = /^\s*apply_patch(\s|$)/;

/**
 * Cheap prescreen for replay mode: every state-bearing line must contain one
 * of these type discriminators literally, so other lines need no JSON.parse.
 */
const REPLAY_MARKER = /session_meta|turn_context|token_count|function_call/;

/** Classification of one complete rollout line. */
export type LineOutcome =
  | { kind: 'event'; event: UsageEvent }
  /** Parsed fine but not usage-bearing (meta/context/function_call/other event_msg). */
  | { kind: 'ignored' }
  /** Failed JSON.parse or zod validation at a parse boundary — counted as skipped. */
  | { kind: 'malformed' };

const MALFORMED: LineOutcome = { kind: 'malformed' };
const IGNORED: LineOutcome = { kind: 'ignored' };

/** Normalized (input, cached, output) counts from one raw usage object. */
interface UsageTriple {
  input: number;
  cached: number;
  output: number;
}

/** Mutable per-file parse state (rollout files are stateful; see module docs). */
export interface CodexFileState {
  /** For UsageEvent.sourceFile and the sessionId fallback before session_meta. */
  readonly sourceFile: string;
  sessionId: string | null;
  isSidechain: boolean;
  gitBranch: string | null;
  cwd: string | null;
  /** null until the first turn_context names one (session_meta never does). */
  model: string | null;
  /** Last seen total_token_usage — baseline for the delta fallback. */
  prevTotals: UsageTriple | null;
  /** Absolute edited paths accumulated since the last emitted token_count. */
  pendingEdits: Set<string>;
}

/** Fresh state for one rollout file. */
export function newCodexFileState(sourceFile: string): CodexFileState {
  return {
    sourceFile,
    sessionId: null,
    isSidechain: false,
    gitBranch: null,
    cwd: null,
    model: null,
    prevTotals: null,
    pendingEdits: new Set(),
  };
}

/** JSON with recursively sorted object keys, so identical info objects hash identically. */
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

/** `source` marks a subagent session when it is an object with a `subagent` member. */
function hasSubagentSource(source: unknown): boolean {
  if (typeof source !== 'object' || source === null || Array.isArray(source)) {
    return false; // real user sessions carry a scalar here ("cli"/"vscode")
  }
  const subagent = (source as Record<string, unknown>)['subagent'];
  return subagent !== undefined && subagent !== null;
}

/** `git` may be an object, boolean, null, or absent — only an object can name a branch. */
function extractGitBranch(git: unknown): string | null {
  if (typeof git !== 'object' || git === null || Array.isArray(git)) {
    return null;
  }
  const branch = (git as Record<string, unknown>)['branch'];
  return typeof branch === 'string' && branch.length > 0 ? branch : null;
}

/**
 * Collect absolute file paths from `*** (Add|Update|Delete) File:` header
 * lines of a patch text. Relative paths resolve against the current cwd;
 * with no cwd known a relative path is dropped (an absolute path cannot be
 * derived without guessing, spec §14.3.4). Patch bodies are never stored.
 */
function collectPatchPaths(patchText: string, cwd: string | null, into: Set<string>): void {
  for (const match of patchText.matchAll(PATCH_FILE_HEADER)) {
    const raw = (match[1] ?? '').replace(/\r$/, '');
    if (raw.length === 0) {
      continue;
    }
    if (isAbsolute(raw)) {
      into.add(resolve(raw));
    } else if (cwd !== null) {
      into.add(resolve(cwd, raw));
    }
  }
}

/** Normalize one raw usage object to the (input, cached, output) triple we bill from. */
function toTriple(usage: RawTokenUsage): UsageTriple {
  return {
    input: usage.input_tokens,
    cached: usage.cached_input_tokens,
    output: usage.output_tokens,
  };
}

/** Per-field positive delta of cumulative totals vs the previous baseline (clamped at 0). */
function positiveDelta(current: UsageTriple, previous: UsageTriple | null): UsageTriple {
  return {
    input: Math.max(0, current.input - (previous?.input ?? 0)),
    cached: Math.max(0, current.cached - (previous?.cached ?? 0)),
    output: Math.max(0, current.output - (previous?.output ?? 0)),
  };
}

/**
 * Contract token mapping: `input_tokens` INCLUDES `cached_input_tokens` and
 * `output_tokens` includes reasoning, so input = input − cached (clamped),
 * cacheRead = cached, cacheWrite = 0 (Codex never bills cache writes).
 */
function tripleToTokens(triple: UsageTriple): TokenCounts {
  const cacheRead = Math.max(0, triple.cached);
  return {
    input: Math.max(0, triple.input - cacheRead),
    output: Math.max(0, triple.output),
    cacheWrite: 0,
    cacheRead,
  };
}

/** session_meta: session id, initial cwd, sidechain flag, git branch. */
function handleSessionMeta(payload: unknown, state: CodexFileState): LineOutcome {
  const parsed = sessionMetaPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return MALFORMED;
  }
  const meta = parsed.data;
  state.sessionId = meta.id;
  if (typeof meta.cwd === 'string' && meta.cwd.length > 0) {
    state.cwd = meta.cwd;
  }
  state.isSidechain = meta.thread_source === 'subagent' || hasSubagentSource(meta.source);
  state.gitBranch = extractGitBranch(meta.git);
  return IGNORED;
}

/** turn_context: latest one supplies model and cwd for subsequent events. */
function handleTurnContext(payload: unknown, state: CodexFileState): LineOutcome {
  const parsed = turnContextPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return MALFORMED;
  }
  if (typeof parsed.data.model === 'string' && parsed.data.model.length > 0) {
    state.model = parsed.data.model;
  }
  if (typeof parsed.data.cwd === 'string' && parsed.data.cwd.length > 0) {
    state.cwd = parsed.data.cwd;
  }
  return IGNORED;
}

/** event_msg: only token_count records with usage info emit a UsageEvent. */
function handleEventMsg(
  rawTimestamp: string | undefined,
  payload: unknown,
  state: CodexFileState,
): LineOutcome {
  const head = eventMsgPayloadSchema.safeParse(payload);
  if (!head.success) {
    return MALFORMED;
  }
  if (head.data.type !== 'token_count') {
    return IGNORED; // task_started/agent_message/… — not usage-bearing
  }
  const parsed = tokenCountPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    return MALFORMED;
  }
  const info = parsed.data.info;
  if (info === null || info === undefined) {
    return IGNORED; // contract: `info == null` emits nothing
  }
  const last = info.last_token_usage ?? null;
  const totals = info.total_token_usage ?? null;
  if (last === null && totals === null) {
    return IGNORED; // info carries no usage at all — nothing to bill
  }
  if (rawTimestamp === undefined) {
    return MALFORMED;
  }
  const ts = Date.parse(rawTimestamp);
  if (Number.isNaN(ts)) {
    return MALFORMED; // skipped whole: state untouched so no tokens are lost to the baseline
  }

  // Contract: use per-turn last_token_usage when present; else the positive
  // delta of cumulative total_token_usage vs the previous token_count in file.
  const triple =
    last !== null
      ? toTriple(last)
      : positiveDelta(toTriple(totals ?? { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 }), state.prevTotals);
  if (totals !== null) {
    state.prevTotals = toTriple(totals);
  }

  const editedFiles = [...state.pendingEdits];
  state.pendingEdits.clear();

  // No session_meta seen yet (defensive): the source file path is a
  // deterministic, collision-free stand-in — never guess the real id.
  const sessionId = state.sessionId ?? state.sourceFile;

  // No per-call message id in rollout files ⇒ contract fallback dedupe id.
  const hash = createHash('sha256').update(canonicalJson(info)).digest('hex').slice(0, 16);

  return {
    kind: 'event',
    event: {
      id: `${sessionId}:${rawTimestamp}:${hash}`,
      agent: 'codex',
      sessionId,
      ts,
      // Model is unknown until the first turn_context (session_meta never
      // names one). Spec §1.6: the traffic still happened and is never
      // dropped or guessed — such events carry model "" which matches no
      // price-table prefix, so the pricing engine reports them as
      // unpriced/unknown (tokens shown, `$—`, aggregated warning).
      model: state.model ?? '',
      tokens: tripleToTokens(triple),
      cwd: state.cwd,
      gitBranch: state.gitBranch,
      editedFiles,
      isSidechain: state.isSidechain,
      sourceFile: state.sourceFile,
    },
  };
}

/** response_item: apply_patch (direct or via shell/exec_command) accumulates edit paths. */
function handleResponseItem(payload: unknown, state: CodexFileState): LineOutcome {
  const head = responseItemPayloadSchema.safeParse(payload);
  if (!head.success) {
    return MALFORMED;
  }
  if (head.data.type !== 'function_call') {
    return IGNORED; // message/reasoning/function_call_output/… — never read
  }
  const call = functionCallPayloadSchema.safeParse(payload);
  if (!call.success) {
    return MALFORMED;
  }
  if (call.data.name !== 'apply_patch' && call.data.name !== 'shell' && call.data.name !== 'exec_command') {
    return IGNORED;
  }

  let argsJson: unknown;
  try {
    argsJson = JSON.parse(call.data.arguments);
  } catch {
    return MALFORMED; // arguments is an untrusted JSON string — a zod-boundary failure
  }

  if (call.data.name === 'apply_patch') {
    const args = applyPatchArgumentsSchema.safeParse(argsJson);
    if (!args.success) {
      return MALFORMED;
    }
    collectPatchPaths(args.data.input, state.cwd, state.pendingEdits);
    return IGNORED;
  }

  const args = execArgumentsSchema.safeParse(argsJson);
  if (!args.success) {
    return MALFORMED;
  }
  const command = args.data.command ?? args.data.cmd;
  if (Array.isArray(command)) {
    // Contract form: argv array with argv[0] == "apply_patch", patch in argv[1].
    if (command[0] === 'apply_patch' && typeof command[1] === 'string') {
      collectPatchPaths(command[1], state.cwd, state.pendingEdits);
    }
  } else if (typeof command === 'string' && APPLY_PATCH_COMMAND_STRING.test(command)) {
    // v0.138 exec_command carries one shell string under `cmd` (verified
    // locally). When it invokes apply_patch the heredoc/quoted patch is
    // inline and its `*** … File:` headers are still line-anchored — the
    // same header scan extracts paths only, never the body.
    collectPatchPaths(command, state.cwd, state.pendingEdits);
  }
  return IGNORED;
}

/**
 * Classify one complete rollout line, mutating `state`: a UsageEvent for
 * usage-bearing token_count records, `ignored` for other well-formed records,
 * `malformed` otherwise. Malformed lines never mutate state.
 */
export function handleCodexLine(line: string, state: CodexFileState): LineOutcome {
  let json: unknown;
  try {
    json = JSON.parse(line);
  } catch {
    return MALFORMED;
  }
  const envelope = envelopeSchema.safeParse(json);
  if (!envelope.success) {
    return MALFORMED;
  }
  switch (envelope.data.type) {
    case 'session_meta':
      return handleSessionMeta(envelope.data.payload, state);
    case 'turn_context':
      return handleTurnContext(envelope.data.payload, state);
    case 'event_msg':
      return handleEventMsg(envelope.data.timestamp, envelope.data.payload, state);
    case 'response_item':
      return handleResponseItem(envelope.data.payload, state);
    default:
      return IGNORED; // unknown record types are tolerated, never an error
  }
}

/**
 * Stream-parse one rollout file, emitting UsageEvents into `sink`; never
 * throws on malformed content (skipped + counted) but does reject on I/O
 * errors so the ingest layer can count the file as skipped. `opts.startOffset`
 * resumes at a byte offset previously reported as `bytesConsumed` (a
 * complete-line boundary): because rollout parsing is stateful the prefix is
 * re-read and replayed for state only — stats and events cover the resumed
 * region exclusively, so resume output is identical to what a full parse
 * would have produced for those lines. `bytesConsumed` is the absolute offset
 * after the last complete line; a truncated final line (agent mid-write,
 * spec §7.12) is skipped + counted but NOT consumed.
 */
export async function parseCodexFile(
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
  const state = newCodexFileState(filePath);

  // Carry state for the line under construction across chunk boundaries.
  let consumed = 0; // absolute offset after the last complete line
  let parts: Buffer[] = []; // retained content (only while under the cap)
  let lineBytes = 0; // true byte length so far, including discarded bytes
  let oversized = false;

  const finishLine = (finalSegment: Buffer): void => {
    const replay = consumed < startOffset; // line began before the resume point
    const totalLen = lineBytes + finalSegment.length;
    if (oversized || totalLen > MAX_LINE_BYTES) {
      if (!replay) {
        stats.linesRead += 1;
        stats.linesSkipped += 1; // oversized line (spec §7.13): cheap skip, content discarded
      }
    } else {
      const buf = parts.length === 0 ? finalSegment : Buffer.concat([...parts, finalSegment]);
      let text = buf.toString('utf8');
      if (text.endsWith('\r')) {
        text = text.slice(0, -1);
      }
      if (text.length > 0) {
        if (replay) {
          // State-only replay: no events, no stats. The marker prescreen is
          // safe — every state-bearing line contains its type discriminator.
          if (REPLAY_MARKER.test(text)) {
            handleCodexLine(text, state);
          }
        } else {
          stats.linesRead += 1;
          const outcome = handleCodexLine(text, state);
          if (outcome.kind === 'event') {
            stats.eventsExtracted += 1;
            sink(outcome.event);
          } else if (outcome.kind === 'malformed') {
            stats.linesSkipped += 1;
          }
        }
      }
      // Truly empty lines are consumed silently: no data, no stats.
    }
    consumed += totalLen + 1; // +1 for the newline: line is complete
    if (consumed > startOffset) {
      stats.bytesConsumed = consumed;
    }
    parts = [];
    lineBytes = 0;
    oversized = false;
  };

  // Always read from byte 0: the prefix must be replayed to rebuild state.
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

  if (lineBytes > 0 && consumed >= startOffset) {
    // Final line without trailing newline: truncated mid-write (spec §7.12).
    // Skipped + counted, and bytesConsumed does NOT advance past it.
    stats.linesRead += 1;
    stats.linesSkipped += 1;
  }

  return stats;
}
