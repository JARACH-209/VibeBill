/**
 * Programmatic builder for realistic Claude Code JSONL transcript fixtures (spec §11,
 * docs/contracts.md "test/helpers/transcripts.ts").
 *
 * Emitted lines match the VERIFIED v2.1.202 structure recorded in docs/contracts.md:
 * assistant envelope { type, sessionId, timestamp, cwd, gitBranch, isSidechain, requestId,
 * uuid, parentUuid, version, message }, message { id: "msg_...", type: "message",
 * role: "assistant", model, usage, content }, edits as tool_use blocks with
 * `{ file_path, old_string: "[sanitized]", new_string: "[sanitized]" }`. A realistic user
 * record precedes every assistant record.
 *
 * Determinism: all ids derive from an internal per-builder counter plus the sessionId
 * (no randomness). The clock starts at a fixed epoch (2026-01-01T00:00:00Z), `.at()` pins
 * it, and it auto-advances 1 second per `call()` otherwise. The user and assistant records
 * of one call share a timestamp; only the assistant record yields a UsageEvent, so its
 * timestamp is the one that matters for attribution tests.
 *
 * Privacy: every human-readable text field carries the literal "[sanitized]".
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Claude Code version stamped on every emitted line (matches the verified recon). */
export const FIXTURE_CLAUDE_CODE_VERSION = '2.1.202';

/** Fixed clock start when `.at()` was never called: 2026-01-01T00:00:00.000Z. */
export const FIXTURE_EPOCH_MS = Date.UTC(2026, 0, 1, 0, 0, 0, 0);

/**
 * Fixed token counts of the failed/fallback attempt injected by the
 * 'with-iterations' shape (must NOT be summed by a correct parser).
 */
export const FAILED_ITERATION_TOKENS = {
  input_tokens: 11,
  output_tokens: 3,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
} as const;

/** One assistant API call to emit (plus its preceding user record). */
export interface CallSpec {
  model?: string;
  usage: { input: number; output: number; cacheWrite?: number; cacheRead?: number };
  /** Absolute file paths; each becomes an Edit tool_use block on the assistant message. */
  edits?: string[];
  cwd?: string;
  /** null omits the gitBranch envelope field (older Claude Code versions lack it). */
  branch?: string | null;
  sidechain?: boolean;
  /** Override for duplicate-emission scenarios (S6); default is deterministic-unique. */
  messageId?: string;
  /** Override for duplicate-emission scenarios (S6); default is deterministic-unique. */
  requestId?: string;
  /**
   * Shape of message.usage (verified extraction rule in docs/contracts.md):
   * - 'top-level-only' (default): plain usage object, no iterations array.
   * - 'with-iterations': top-level carries the truth AND equals the LAST iteration;
   *   an earlier fallback iteration holds FAILED_ITERATION_TOKENS (must not be summed).
   * - 'zero-top-with-iterations': top-level is all zeros; the truth is the SUM of the
   *   iterations (split deterministically across two 'message' iterations).
   */
  iterationsShape?: 'top-level-only' | 'with-iterations' | 'zero-top-with-iterations';
}

export interface SessionBuilderOpts {
  sessionId?: string;
  defaultCwd?: string;
  defaultBranch?: string | null;
  defaultModel?: string;
}

interface UsageJson {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  iterations?: Array<{
    input_tokens: number;
    output_tokens: number;
    cache_read_input_tokens: number;
    cache_creation_input_tokens: number;
    type: 'message' | 'fallback_message';
  }>;
  service_tier: string;
}

/** Deterministic 32-bit FNV-1a hex tag, used to namespace ids per session. */
function fnv1a8(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

function pad(n: number, width: number): string {
  return String(n).padStart(width, '0');
}

let defaultSessionCounter = 0;

/**
 * Deterministic (counter-based, order-of-construction) UUID-shaped default sessionId.
 * Tests needing ids stable across processes should pass sessionId explicitly.
 */
function nextDefaultSessionId(): string {
  defaultSessionCounter += 1;
  return `00000000-0000-4000-8000-${pad(defaultSessionCounter, 12)}`;
}

/** Fluent builder for one Claude Code session transcript (one JSONL file). */
export class SessionBuilder {
  readonly sessionId: string;
  private readonly defaultCwd: string;
  private readonly defaultBranch: string | null;
  private readonly defaultModel: string;
  private readonly sidTag: string;
  private readonly emitted: string[] = [];
  private nextTsMs: number = FIXTURE_EPOCH_MS;
  private callCounter = 0;
  private lineCounter = 0;
  private toolCounter = 0;
  private lastUuid: string | null = null;

  constructor(opts?: SessionBuilderOpts) {
    this.sessionId = opts?.sessionId ?? nextDefaultSessionId();
    this.defaultCwd = opts?.defaultCwd ?? '/fixture/project';
    this.defaultBranch = opts?.defaultBranch === undefined ? 'main' : opts.defaultBranch;
    this.defaultModel = opts?.defaultModel ?? 'claude-opus-4-8';
    this.sidTag = fnv1a8(this.sessionId);
  }

  /** cwd used for the encoded projects/ directory name in writeTranscripts. */
  get projectCwd(): string {
    return this.defaultCwd;
  }

  /** Pin the clock for the next call(s); without it the clock auto-advances 1s per call. */
  at(tsIsoOrMs: string | number): this {
    const ms = typeof tsIsoOrMs === 'number' ? tsIsoOrMs : Date.parse(tsIsoOrMs);
    if (!Number.isFinite(ms)) {
      throw new Error(`SessionBuilder.at: invalid timestamp ${JSON.stringify(tsIsoOrMs)}`);
    }
    this.nextTsMs = ms;
    return this;
  }

  /** Emit one user record then one assistant record (the API call) at the current clock. */
  call(spec: CallSpec): this {
    const tsIso = new Date(this.nextTsMs).toISOString();
    this.nextTsMs += 1000;
    this.callCounter += 1;

    const cwd = spec.cwd ?? this.defaultCwd;
    const branch = spec.branch === undefined ? this.defaultBranch : spec.branch;
    const sidechain = spec.sidechain ?? false;
    const model = spec.model ?? this.defaultModel;
    const messageId = spec.messageId ?? `msg_01${this.sidTag}${pad(this.callCounter, 10)}`;
    const requestId = spec.requestId ?? `req_011${this.sidTag}${pad(this.callCounter, 6)}`;

    // -- user record (no usage, no requestId) --------------------------------
    const userUuid = this.nextUuid();
    const userLine: Record<string, unknown> = {
      parentUuid: this.lastUuid,
      isSidechain: sidechain,
      userType: 'external',
      cwd,
      sessionId: this.sessionId,
      version: FIXTURE_CLAUDE_CODE_VERSION,
      ...(branch === null ? {} : { gitBranch: branch }),
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: '[sanitized]' }] },
      uuid: userUuid,
      timestamp: tsIso,
    };
    this.emitted.push(JSON.stringify(userLine));

    // -- assistant record (the UsageEvent source) ----------------------------
    const content: Array<Record<string, unknown>> = [{ type: 'text', text: '[sanitized]' }];
    for (const filePath of spec.edits ?? []) {
      this.toolCounter += 1;
      content.push({
        type: 'tool_use',
        id: `toolu_01${this.sidTag}${pad(this.toolCounter, 6)}`,
        name: 'Edit',
        input: { file_path: filePath, old_string: '[sanitized]', new_string: '[sanitized]' },
      });
    }

    const assistantUuid = this.nextUuid();
    const assistantLine: Record<string, unknown> = {
      parentUuid: userUuid,
      isSidechain: sidechain,
      userType: 'external',
      cwd,
      sessionId: this.sessionId,
      version: FIXTURE_CLAUDE_CODE_VERSION,
      ...(branch === null ? {} : { gitBranch: branch }),
      type: 'assistant',
      requestId,
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        model,
        content,
        stop_reason: null,
        stop_sequence: null,
        usage: buildUsage(spec),
      },
      uuid: assistantUuid,
      timestamp: tsIso,
    };
    this.emitted.push(JSON.stringify(assistantLine));
    this.lastUuid = assistantUuid;
    return this;
  }

  /** Inject an arbitrary string verbatim as one line (for malformed-line scenarios). */
  raw(line: string): this {
    this.emitted.push(line);
    return this;
  }

  /** JSONL text of every emitted line, newline-terminated. */
  build(): string {
    return this.emitted.length === 0 ? '' : `${this.emitted.join('\n')}\n`;
  }

  private nextUuid(): string {
    this.lineCounter += 1;
    return `${this.sidTag}-0000-4000-8000-${pad(this.lineCounter, 12)}`;
  }
}

/** Shorthand factory for SessionBuilder. */
export function session(opts?: SessionBuilderOpts): SessionBuilder {
  return new SessionBuilder(opts);
}

function buildUsage(spec: CallSpec): UsageJson {
  const truth = {
    input_tokens: spec.usage.input,
    output_tokens: spec.usage.output,
    cache_creation_input_tokens: spec.usage.cacheWrite ?? 0,
    cache_read_input_tokens: spec.usage.cacheRead ?? 0,
  };
  const shape = spec.iterationsShape ?? 'top-level-only';

  if (shape === 'top-level-only') {
    return { ...truth, service_tier: 'standard' };
  }

  if (shape === 'with-iterations') {
    // Verified: top-level equals the LAST iteration; earlier iterations are failed
    // attempts that a correct parser must NOT add on top.
    return {
      ...truth,
      iterations: [
        { ...reorderIteration(FAILED_ITERATION_TOKENS), type: 'fallback_message' },
        { ...reorderIteration(truth), type: 'message' },
      ],
      service_tier: 'standard',
    };
  }

  // 'zero-top-with-iterations': zeroed top-level; truth is the SUM of iterations.
  const half = {
    input_tokens: Math.floor(truth.input_tokens / 2),
    output_tokens: Math.floor(truth.output_tokens / 2),
    cache_creation_input_tokens: Math.floor(truth.cache_creation_input_tokens / 2),
    cache_read_input_tokens: Math.floor(truth.cache_read_input_tokens / 2),
  };
  const rest = {
    input_tokens: truth.input_tokens - half.input_tokens,
    output_tokens: truth.output_tokens - half.output_tokens,
    cache_creation_input_tokens: truth.cache_creation_input_tokens - half.cache_creation_input_tokens,
    cache_read_input_tokens: truth.cache_read_input_tokens - half.cache_read_input_tokens,
  };
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
    iterations: [
      { ...reorderIteration(half), type: 'message' },
      { ...reorderIteration(rest), type: 'message' },
    ],
    service_tier: 'standard',
  };
}

function reorderIteration(t: {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}): {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
} {
  return {
    input_tokens: t.input_tokens,
    output_tokens: t.output_tokens,
    cache_read_input_tokens: t.cache_read_input_tokens,
    cache_creation_input_tokens: t.cache_creation_input_tokens,
  };
}

/**
 * One transcript file to write: either a bare SessionBuilder (default naming) or a
 * builder with an explicit fileName/dirName override. The override exists so scenario
 * S6 can write the SAME sessionId into TWO files (duplicate emission) — default naming
 * would collide on `<sessionId>.jsonl`.
 */
export type TranscriptFileSpec =
  | SessionBuilder
  | { builder: SessionBuilder; fileName?: string; dirName?: string };

/**
 * Loose fixture version of Claude Code's project-dir encoding: "/" and "." become "-".
 * The real adapter NEVER decodes this directory name (it reads `cwd` from records,
 * spec §5.1.2) and discovers files via `projects/*` / `*.jsonl` globbing, so exact
 * fidelity to the real encoding is not load-bearing.
 */
export function encodeProjectDir(cwd: string): string {
  return cwd.replace(/[/.]/g, '-');
}

/**
 * Write sessions into a fake VIBEBILL_CLAUDE_DIR layout:
 * `<claudeDir>/projects/<encoded-defaultCwd>/<sessionId>.jsonl`. Returns written paths
 * in input order; throws if two specs resolve to the same path (use a fileName override).
 */
export async function writeTranscripts(
  claudeDir: string,
  sessions: TranscriptFileSpec[],
): Promise<string[]> {
  const written: string[] = [];
  const claimed = new Set<string>();
  for (const spec of sessions) {
    const builder = spec instanceof SessionBuilder ? spec : spec.builder;
    const fileName =
      (spec instanceof SessionBuilder ? undefined : spec.fileName) ?? `${builder.sessionId}.jsonl`;
    const dirName =
      (spec instanceof SessionBuilder ? undefined : spec.dirName) ??
      encodeProjectDir(builder.projectCwd);
    const dir = path.join(claudeDir, 'projects', dirName);
    const filePath = path.join(dir, fileName);
    if (claimed.has(filePath)) {
      throw new Error(
        `writeTranscripts: two sessions target ${filePath}; pass { builder, fileName } to disambiguate`,
      );
    }
    claimed.add(filePath);
    await mkdir(dir, { recursive: true });
    await writeFile(filePath, builder.build(), 'utf8');
    written.push(filePath);
  }
  return written;
}
