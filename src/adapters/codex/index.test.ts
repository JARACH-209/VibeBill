/**
 * Tests for the Codex CLI adapter. Fixture lines mirror the VERIFIED rollout
 * structure from docs/contracts.md (recon against v0.138 logs), with all
 * content text replaced by "[sanitized]" placeholders.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { UsageEvent } from '../../core/types.js';
import { CODEX_SCHEMA_VERIFIED, createCodexAdapter } from './index.js';
import { MAX_LINE_BYTES, parseCodexFile } from './parser.js';

// ---------------------------------------------------------------------------
// fixture builders (sanitized-real structure per contracts.md "Codex CLI")
// ---------------------------------------------------------------------------

const SESSION_ID = '019eb558-7357-7030-9833-9f8780ef71bf';
const CWD = '/Users/dev/proj';
const BASE_TS = Date.parse('2026-06-11T11:52:13.000Z');

let seq = 0;

/** Monotonic ISO timestamp per generated line (1 s apart) — deterministic. */
function nextTs(): string {
  seq += 1;
  return new Date(BASE_TS + seq * 1000).toISOString();
}

function envelope(type: string, payload: unknown, timestamp?: string): string {
  return JSON.stringify({ timestamp: timestamp ?? nextTs(), type, payload });
}

interface MetaSpec {
  id?: string;
  cwd?: string | null;
  threadSource?: string;
  source?: unknown;
  /** Merged into the payload verbatim (e.g. { git: ... }); use to control git shape. */
  extra?: Record<string, unknown>;
  timestamp?: string;
}

function metaLine(spec: MetaSpec = {}): string {
  const payload: Record<string, unknown> = {
    id: spec.id ?? SESSION_ID,
    timestamp: spec.timestamp ?? '2026-06-11T11:52:13.000Z',
    cwd: spec.cwd === undefined ? CWD : spec.cwd,
    originator: 'codex_cli_rs',
    cli_version: '0.138.0',
    source: spec.source ?? 'cli',
    thread_source: spec.threadSource ?? 'user',
    model_provider: 'openai',
    base_instructions: { text: '[sanitized]' },
    ...(spec.extra ?? {}),
  };
  return envelope('session_meta', payload, spec.timestamp);
}

function turnContextLine(spec: { model?: string; cwd?: string; timestamp?: string } = {}): string {
  const payload: Record<string, unknown> = {
    turn_id: `turn-${seq + 1}`,
    cwd: spec.cwd ?? CWD,
    approval_policy: 'on-request',
    sandbox_policy: { type: 'workspace-write', network_access: false },
    personality: '[sanitized]',
    effort: 'medium',
    summary: 'auto',
  };
  if (spec.model !== undefined) {
    payload['model'] = spec.model;
  }
  return envelope('turn_context', payload, spec.timestamp);
}

interface RawUsage {
  input_tokens: number;
  cached_input_tokens: number;
  output_tokens: number;
  reasoning_output_tokens: number;
  total_tokens: number;
}

function rawUsage(input: number, cached: number, output: number, reasoning = 0): RawUsage {
  return {
    input_tokens: input,
    cached_input_tokens: cached,
    output_tokens: output,
    reasoning_output_tokens: reasoning,
    total_tokens: input + output,
  };
}

interface TokenCountSpec {
  last?: RawUsage;
  totals?: RawUsage;
  /** true ⇒ payload.info is null (real shape between turns). */
  infoNull?: boolean;
  timestamp?: string;
}

function tokenCountLine(spec: TokenCountSpec = {}): string {
  let info: unknown;
  if (spec.infoNull === true) {
    info = null;
  } else {
    const obj: Record<string, unknown> = { model_context_window: 272000 };
    if (spec.last !== undefined) {
      obj['last_token_usage'] = spec.last;
    }
    if (spec.totals !== undefined) {
      obj['total_token_usage'] = spec.totals;
    }
    info = obj;
  }
  const payload = {
    type: 'token_count',
    info,
    rate_limits: { limit_id: 'codex-[sanitized]', plan_type: 'pro' },
  };
  return envelope('event_msg', payload, spec.timestamp);
}

function functionCallLine(name: string, args: unknown, timestamp?: string): string {
  return envelope(
    'response_item',
    { type: 'function_call', name, arguments: typeof args === 'string' ? args : JSON.stringify(args), call_id: `call_${seq + 1}` },
    timestamp,
  );
}

function applyPatchLine(patch: string): string {
  return functionCallLine('apply_patch', { input: patch });
}

function patchText(headers: string[]): string {
  const body = headers.map((h) => `${h}\n+[sanitized]`).join('\n');
  return `*** Begin Patch\n${body}\n*** End Patch`;
}

// ---------------------------------------------------------------------------
// tmp-dir plumbing
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibebill-codex-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeFixture(lines: string[], opts?: { trailingNewline?: boolean }): Promise<string> {
  const dir = await makeTmpDir();
  const path = join(dir, 'rollout-2026-06-11T11-52-13-fixture.jsonl');
  const body = lines.join('\n') + (opts?.trailingNewline === false ? '' : '\n');
  await writeFile(path, body, 'utf8');
  return path;
}

async function collectEvents(
  path: string,
  opts?: { startOffset?: number },
): Promise<{ events: UsageEvent[]; stats: Awaited<ReturnType<typeof parseCodexFile>> }> {
  const events: UsageEvent[] = [];
  const stats = await parseCodexFile(path, (e) => events.push(e), opts);
  return { events, stats };
}

// ---------------------------------------------------------------------------
// token math
// ---------------------------------------------------------------------------

describe('token extraction', () => {
  it('maps last_token_usage per contract: cached is a subset of input, cacheWrite always 0', async () => {
    const ts = nextTs();
    const lines = [
      metaLine({ extra: { git: { branch: 'main', commit_hash: 'abc123' } } }),
      turnContextLine({ model: 'gpt-5.3-codex' }),
      tokenCountLine({ last: rawUsage(1000, 700, 50, 12), totals: rawUsage(1000, 700, 50, 12), timestamp: ts }),
    ];
    const path = await writeFixture(lines);
    const { events, stats } = await collectEvents(path);
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e).toEqual({
      id: e.id, // asserted by regex below
      agent: 'codex',
      sessionId: SESSION_ID,
      ts: Date.parse(ts),
      model: 'gpt-5.3-codex',
      tokens: { input: 300, output: 50, cacheWrite: 0, cacheRead: 700 },
      cwd: CWD,
      gitBranch: 'main',
      editedFiles: [],
      isSidechain: false,
      sourceFile: path,
    });
    expect(e.id).toMatch(new RegExp(`^${SESSION_ID}:${ts}:[0-9a-f]{16}$`));
    expect(stats).toEqual({ path, linesRead: 3, eventsExtracted: 1, linesSkipped: 0, bytesConsumed: Buffer.byteLength(lines.join('\n') + '\n') });
  });

  it('clamps input at 0 when cached_input_tokens exceeds input_tokens', async () => {
    const path = await writeFixture([metaLine(), tokenCountLine({ last: rawUsage(500, 600, 10) })]);
    const { events } = await collectEvents(path);
    expect(events[0]!.tokens).toEqual({ input: 0, output: 10, cacheWrite: 0, cacheRead: 600 });
  });

  it('emits nothing for token_count with info null, without consuming pending edits', async () => {
    const lines = [
      metaLine(),
      applyPatchLine(patchText(['*** Add File: src/kept.ts'])),
      tokenCountLine({ infoNull: true }),
      tokenCountLine({ last: rawUsage(10, 0, 5) }),
    ];
    const path = await writeFixture(lines);
    const { events, stats } = await collectEvents(path);
    expect(events).toHaveLength(1);
    expect(events[0]!.editedFiles).toEqual([join(CWD, 'src/kept.ts')]);
    expect(stats.linesSkipped).toBe(0);
    expect(stats.eventsExtracted).toBe(1);
  });

  describe('delta fallback via total_token_usage', () => {
    it('first token_count with only totals emits the totals as-is', async () => {
      const path = await writeFixture([metaLine(), tokenCountLine({ totals: rawUsage(1000, 200, 50) })]);
      const { events } = await collectEvents(path);
      expect(events[0]!.tokens).toEqual({ input: 800, output: 50, cacheWrite: 0, cacheRead: 200 });
    });

    it('subsequent totals-only token_counts emit the positive delta vs the previous one', async () => {
      const lines = [
        metaLine(),
        tokenCountLine({ totals: rawUsage(1000, 200, 50) }),
        tokenCountLine({ totals: rawUsage(1800, 500, 90) }),
        // cumulative counters went DOWN (reset/weird) ⇒ clamp every class at 0
        tokenCountLine({ totals: rawUsage(100, 50, 10) }),
      ];
      const path = await writeFixture(lines);
      const { events } = await collectEvents(path);
      expect(events).toHaveLength(3);
      // delta: input 800 (incl. 300 cached), cached 300, output 40
      expect(events[1]!.tokens).toEqual({ input: 500, output: 40, cacheWrite: 0, cacheRead: 300 });
      expect(events[2]!.tokens).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
    });

    it('a token_count served from last_token_usage still advances the delta baseline', async () => {
      const lines = [
        metaLine(),
        tokenCountLine({ last: rawUsage(1000, 200, 50), totals: rawUsage(1000, 200, 50) }),
        tokenCountLine({ totals: rawUsage(1400, 300, 75) }),
      ];
      const path = await writeFixture(lines);
      const { events } = await collectEvents(path);
      expect(events).toHaveLength(2);
      // delta vs (1000, 200, 50), NOT vs zero: input 400 (incl. 100 cached)
      expect(events[1]!.tokens).toEqual({ input: 300, output: 25, cacheWrite: 0, cacheRead: 100 });
    });
  });
});

// ---------------------------------------------------------------------------
// editedFiles via apply_patch
// ---------------------------------------------------------------------------

describe('apply_patch path extraction', () => {
  it('extracts Add/Update/Delete header paths, resolves relative against cwd, attaches to the NEXT token_count, then resets', async () => {
    const lines = [
      metaLine(),
      turnContextLine({ model: 'gpt-5.3-codex', cwd: '/work/proj' }),
      applyPatchLine(
        patchText(['*** Add File: src/new.ts', '*** Update File: /abs/lib/old.ts', '*** Delete File: docs/dead.md']),
      ),
      tokenCountLine({ last: rawUsage(100, 0, 20) }),
      tokenCountLine({ last: rawUsage(50, 0, 10) }),
    ];
    const path = await writeFixture(lines);
    const { events } = await collectEvents(path);
    expect(events).toHaveLength(2);
    expect(events[0]!.editedFiles).toEqual(['/work/proj/src/new.ts', '/abs/lib/old.ts', '/work/proj/docs/dead.md']);
    expect(events[1]!.editedFiles).toEqual([]); // accumulator was reset
  });

  it('accumulates unique paths across multiple calls and follows cwd changes from turn_context', async () => {
    const lines = [
      metaLine(),
      turnContextLine({ model: 'gpt-5.3-codex', cwd: '/work/a' }),
      applyPatchLine(patchText(['*** Add File: x.ts'])),
      turnContextLine({ model: 'gpt-5.3-codex', cwd: '/work/b' }),
      applyPatchLine(patchText(['*** Update File: y.ts'])),
      applyPatchLine(patchText(['*** Update File: y.ts'])), // duplicate — collected once
      tokenCountLine({ last: rawUsage(10, 0, 5) }),
    ];
    const path = await writeFixture(lines);
    const { events } = await collectEvents(path);
    expect(events[0]!.editedFiles).toEqual(['/work/a/x.ts', '/work/b/y.ts']);
  });

  it('drops relative paths when no cwd is known but keeps absolute ones (never guess)', async () => {
    const lines = [
      // no session_meta, no turn_context ⇒ cwd unknown
      applyPatchLine(patchText(['*** Add File: rel/unresolvable.ts', '*** Add File: /abs/ok.ts'])),
      tokenCountLine({ last: rawUsage(10, 0, 5) }),
    ];
    const path = await writeFixture(lines);
    const { events } = await collectEvents(path);
    expect(events[0]!.editedFiles).toEqual(['/abs/ok.ts']);
  });

  it('extracts from shell/exec_command argv form when argv[0] is apply_patch', async () => {
    const patch = patchText(['*** Add File: src/via-shell.ts']);
    const lines = [
      metaLine(),
      functionCallLine('shell', { command: ['apply_patch', patch] }),
      functionCallLine('exec_command', { command: ['bash', '-lc', 'echo [sanitized]'] }), // not apply_patch
      tokenCountLine({ last: rawUsage(10, 0, 5) }),
    ];
    const path = await writeFixture(lines);
    const { events, stats } = await collectEvents(path);
    expect(events[0]!.editedFiles).toEqual([join(CWD, 'src/via-shell.ts')]);
    expect(stats.linesSkipped).toBe(0);
  });

  it('extracts from the v0.138 exec_command string form (cmd) when it invokes apply_patch', async () => {
    const patch = patchText(['*** Update File: src/via-cmd.ts']);
    const lines = [
      metaLine(),
      functionCallLine('exec_command', { cmd: `apply_patch <<'EOF'\n${patch}\nEOF`, workdir: CWD, max_output_tokens: 10000 }),
      functionCallLine('exec_command', { cmd: 'sed -n 1,10p README.md', workdir: CWD }), // no patch
      tokenCountLine({ last: rawUsage(10, 0, 5) }),
    ];
    const path = await writeFixture(lines);
    const { events, stats } = await collectEvents(path);
    expect(events[0]!.editedFiles).toEqual([join(CWD, 'src/via-cmd.ts')]);
    expect(stats.linesSkipped).toBe(0);
  });

  it('ignores non-edit function calls and non-function_call response items', async () => {
    const lines = [
      metaLine(),
      envelope('response_item', { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '[sanitized]' }] }),
      envelope('response_item', { type: 'reasoning', summary: [], content: null }),
      functionCallLine('update_plan', { plan: '[sanitized]' }),
      tokenCountLine({ last: rawUsage(10, 0, 5) }),
    ];
    const path = await writeFixture(lines);
    const { events, stats } = await collectEvents(path);
    expect(events[0]!.editedFiles).toEqual([]);
    expect(stats.linesSkipped).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// session_meta: sidechain flag, git branch, session id
// ---------------------------------------------------------------------------

describe('session_meta state', () => {
  async function firstEvent(lines: string[]): Promise<UsageEvent> {
    const path = await writeFixture([...lines, tokenCountLine({ last: rawUsage(10, 0, 5) })]);
    const { events } = await collectEvents(path);
    expect(events).toHaveLength(1);
    return events[0]!;
  }

  it('flags subagent sessions via thread_source == "subagent"', async () => {
    expect((await firstEvent([metaLine({ threadSource: 'subagent' })])).isSidechain).toBe(true);
  });

  it('flags subagent sessions via source.subagent presence', async () => {
    expect((await firstEvent([metaLine({ source: { subagent: { session_id: SESSION_ID } } })])).isSidechain).toBe(true);
  });

  it('does not flag user sessions (scalar source, thread_source "user")', async () => {
    expect((await firstEvent([metaLine({ source: 'vscode' })])).isSidechain).toBe(false);
  });

  it('reads gitBranch from git.branch and tolerates boolean/null/absent/branchless git', async () => {
    expect((await firstEvent([metaLine({ extra: { git: { branch: 'feat/x', commit_hash: 'ff00' } } })])).gitBranch).toBe('feat/x');
    expect((await firstEvent([metaLine({ extra: { git: false } })])).gitBranch).toBeNull();
    expect((await firstEvent([metaLine({ extra: { git: null } })])).gitBranch).toBeNull();
    expect((await firstEvent([metaLine()])).gitBranch).toBeNull();
    expect((await firstEvent([metaLine({ extra: { git: { commit_hash: 'ff00' } } })])).gitBranch).toBeNull();
  });

  it('uses the session_meta cwd until a turn_context overrides it', async () => {
    const lines = [
      metaLine({ cwd: '/from/meta' }),
      tokenCountLine({ last: rawUsage(1, 0, 1) }),
      turnContextLine({ model: 'gpt-5.3-codex', cwd: '/from/turn' }),
      tokenCountLine({ last: rawUsage(2, 0, 2) }),
    ];
    const path = await writeFixture(lines);
    const { events } = await collectEvents(path);
    expect(events[0]!.cwd).toBe('/from/meta');
    expect(events[1]!.cwd).toBe('/from/turn');
  });

  it('falls back to the source file path as sessionId when no session_meta was seen', async () => {
    const path = await writeFixture([tokenCountLine({ last: rawUsage(10, 0, 5) })]);
    const { events } = await collectEvents(path);
    expect(events[0]!.sessionId).toBe(path);
    expect(events[0]!.id.startsWith(`${path}:`)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// model state via turn_context
// ---------------------------------------------------------------------------

describe('model tracking', () => {
  it('emits model "" before any turn_context (unknown ⇒ unpriced, never guessed) and switches mid-file', async () => {
    const lines = [
      metaLine(),
      tokenCountLine({ last: rawUsage(10, 0, 5) }), // before any turn_context
      turnContextLine({ model: 'gpt-5.3-codex' }),
      tokenCountLine({ last: rawUsage(20, 0, 6) }),
      turnContextLine({ model: 'gpt-5.3-codex-mini' }),
      tokenCountLine({ last: rawUsage(30, 0, 7) }),
      turnContextLine({}), // no model field — must not clobber the current model
      tokenCountLine({ last: rawUsage(40, 0, 8) }),
    ];
    const path = await writeFixture(lines);
    const { events } = await collectEvents(path);
    expect(events.map((e) => e.model)).toEqual(['', 'gpt-5.3-codex', 'gpt-5.3-codex-mini', 'gpt-5.3-codex-mini']);
  });
});

// ---------------------------------------------------------------------------
// dedupe ids
// ---------------------------------------------------------------------------

describe('dedupe id fallback', () => {
  it('is identical for identical duplicated lines and differs when usage differs', async () => {
    const ts = nextTs();
    const line = tokenCountLine({ last: rawUsage(10, 2, 5), totals: rawUsage(10, 2, 5), timestamp: ts });
    const other = tokenCountLine({ last: rawUsage(11, 2, 5), totals: rawUsage(11, 2, 5), timestamp: ts });
    const path = await writeFixture([metaLine(), line, line, other]);
    const { events } = await collectEvents(path);
    expect(events).toHaveLength(3);
    expect(events[0]!.id).toBe(events[1]!.id); // ingest-layer dedupe keeps the last
    expect(events[2]!.id).not.toBe(events[0]!.id);
  });
});

// ---------------------------------------------------------------------------
// tolerance: malformed, oversized, truncated
// ---------------------------------------------------------------------------

describe('tolerance', () => {
  it('counts malformed lines as skipped without crashing and keeps parsing', async () => {
    const lines = [
      'this is not json',
      metaLine(),
      '42',
      '"session_meta"',
      envelope('session_meta', { cwd: CWD }), // payload missing id ⇒ zod failure
      envelope('turn_context', null), // payload not an object
      tokenCountLine({ last: rawUsage(10, 0, 5), timestamp: 'garbage-date' }),
      functionCallLine('apply_patch', 'not-json {{{'),
      functionCallLine('shell', 'also not json'),
      tokenCountLine({ last: rawUsage(7, 0, 3) }),
    ];
    const path = await writeFixture(lines);
    const { events, stats } = await collectEvents(path);
    expect(events).toHaveLength(1);
    expect(events[0]!.tokens).toEqual({ input: 7, output: 3, cacheWrite: 0, cacheRead: 0 });
    expect(stats.linesRead).toBe(10);
    expect(stats.linesSkipped).toBe(8); // every line above except session_meta and the final token_count
    expect(stats.eventsExtracted).toBe(1);
  });

  it('ignores unknown record and event types (never an error)', async () => {
    const lines = [
      metaLine(),
      envelope('event_msg', { type: 'task_started', model_context_window: 272000 }),
      envelope('event_msg', { type: 'agent_message', message: '[sanitized]' }),
      envelope('compacted', { message: '[sanitized]' }),
      envelope('some_future_type', { anything: true }),
      tokenCountLine({ last: rawUsage(5, 0, 5) }),
    ];
    const path = await writeFixture(lines);
    const { events, stats } = await collectEvents(path);
    expect(events).toHaveLength(1);
    expect(stats.linesSkipped).toBe(0);
    expect(stats.linesRead).toBe(6);
  });

  it('skips lines over the 10 MB cap cheaply and still parses subsequent lines', async () => {
    const lines = [
      metaLine(),
      `{"type":"event_msg","padding":"${'x'.repeat(MAX_LINE_BYTES)}"}`,
      tokenCountLine({ last: rawUsage(42, 0, 7) }),
    ];
    const path = await writeFixture(lines);
    const { events, stats } = await collectEvents(path);
    expect(events).toHaveLength(1);
    expect(events[0]!.tokens.input).toBe(42);
    expect(stats.linesRead).toBe(3);
    expect(stats.linesSkipped).toBe(1);
    expect(stats.bytesConsumed).toBe(Buffer.byteLength(lines.join('\n') + '\n'));
  });

  it('skips+counts a truncated final line without consuming it, and resume picks it up', async () => {
    const meta = metaLine();
    const second = tokenCountLine({ last: rawUsage(30, 0, 40) });
    const cut = Math.floor(second.length / 2);
    const dir = await makeTmpDir();
    const path = join(dir, 'rollout.jsonl');

    await writeFile(path, meta + '\n' + second.slice(0, cut), 'utf8');
    const pass1 = await collectEvents(path);
    expect(pass1.events).toHaveLength(0);
    expect(pass1.stats.linesRead).toBe(2);
    expect(pass1.stats.linesSkipped).toBe(1); // the truncated tail
    expect(pass1.stats.bytesConsumed).toBe(Buffer.byteLength(meta + '\n'));

    // The agent finishes writing; the next incremental run resumes at bytesConsumed.
    await writeFile(path, meta + '\n' + second + '\n', 'utf8');
    const pass2 = await collectEvents(path, { startOffset: pass1.stats.bytesConsumed });
    expect(pass2.events).toHaveLength(1);
    expect(pass2.events[0]!.tokens).toEqual({ input: 30, output: 40, cacheWrite: 0, cacheRead: 0 });
    expect(pass2.events[0]!.sessionId).toBe(SESSION_ID); // state replayed from the prefix
    expect(pass2.stats.linesSkipped).toBe(0);
    expect(pass2.stats.bytesConsumed).toBe(Buffer.byteLength(meta + '\n' + second + '\n'));
  });

  it('handles empty files, blank lines, and CRLF line endings', async () => {
    const dir = await makeTmpDir();
    const empty = join(dir, 'empty.jsonl');
    await writeFile(empty, '', 'utf8');
    const emptyRes = await collectEvents(empty);
    expect(emptyRes.stats).toEqual({ path: empty, linesRead: 0, eventsExtracted: 0, linesSkipped: 0, bytesConsumed: 0 });

    const crlf = join(dir, 'crlf.jsonl');
    const body = metaLine() + '\r\n' + '\n' + tokenCountLine({ last: rawUsage(2, 0, 2) }) + '\r\n';
    await writeFile(crlf, body, 'utf8');
    const crlfRes = await collectEvents(crlf);
    expect(crlfRes.events).toHaveLength(1);
    expect(crlfRes.stats.linesRead).toBe(2); // the blank line is consumed but not counted
    expect(crlfRes.stats.linesSkipped).toBe(0);
    expect(crlfRes.stats.bytesConsumed).toBe(Buffer.byteLength(body));
  });

  it('rejects on unopenable files so the ingest layer can count filesSkipped', async () => {
    const dir = await makeTmpDir();
    await expect(parseCodexFile(join(dir, 'does-not-exist.jsonl'), () => {})).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// startOffset resume — state must be replayed from the prefix
// ---------------------------------------------------------------------------

describe('startOffset resume', () => {
  it('resume equals full parse, carrying model/cwd/branch, delta baseline, and pending edits across the boundary', async () => {
    const prefixLines = [
      metaLine({ extra: { git: { branch: 'feat/resume' } } }),
      turnContextLine({ model: 'gpt-5.3-codex', cwd: '/work/resume' }),
      tokenCountLine({ totals: rawUsage(1000, 200, 50) }),
      applyPatchLine(patchText(['*** Add File: src/pending.ts'])),
    ];
    const suffixLines = [
      tokenCountLine({ totals: rawUsage(1400, 300, 75) }), // delta vs the PRE-boundary totals
      tokenCountLine({ last: rawUsage(11, 4, 6), totals: rawUsage(1411, 304, 81) }),
    ];
    const all = [...prefixLines, ...suffixLines];
    const dir = await makeTmpDir();
    const path = join(dir, 'rollout.jsonl');
    const prefix = prefixLines.map((l) => l + '\n').join('');
    const full = all.map((l) => l + '\n').join('');

    // Full parse from zero.
    await writeFile(path, full, 'utf8');
    const whole = await collectEvents(path);

    // Prefix parse, then the file grows, then resume from bytesConsumed.
    await writeFile(path, prefix, 'utf8');
    const part1 = await collectEvents(path);
    expect(part1.stats.bytesConsumed).toBe(Buffer.byteLength(prefix));
    await writeFile(path, full, 'utf8');
    const part2 = await collectEvents(path, { startOffset: part1.stats.bytesConsumed });

    expect([...part1.events, ...part2.events]).toEqual(whole.events);
    expect(part1.stats.linesRead + part2.stats.linesRead).toBe(whole.stats.linesRead);
    expect(part1.stats.linesSkipped + part2.stats.linesSkipped).toBe(whole.stats.linesSkipped);
    expect(part1.stats.eventsExtracted + part2.stats.eventsExtracted).toBe(whole.stats.eventsExtracted);
    expect(part2.stats.bytesConsumed).toBe(whole.stats.bytesConsumed);

    // The resumed events must carry the replayed prefix state.
    const resumed = part2.events[0]!;
    expect(resumed.model).toBe('gpt-5.3-codex');
    expect(resumed.cwd).toBe('/work/resume');
    expect(resumed.gitBranch).toBe('feat/resume');
    expect(resumed.sessionId).toBe(SESSION_ID);
    expect(resumed.tokens).toEqual({ input: 300, output: 25, cacheWrite: 0, cacheRead: 100 });
    expect(resumed.editedFiles).toEqual(['/work/resume/src/pending.ts']);
    expect(part2.events[1]!.editedFiles).toEqual([]);
  });

  it('a resume at exactly EOF re-emits nothing and reports the same bytesConsumed', async () => {
    const lines = [metaLine(), tokenCountLine({ last: rawUsage(10, 0, 5) })];
    const path = await writeFixture(lines);
    const first = await collectEvents(path);
    const again = await collectEvents(path, { startOffset: first.stats.bytesConsumed });
    expect(again.events).toEqual([]);
    expect(again.stats).toEqual({ path, linesRead: 0, eventsExtracted: 0, linesSkipped: 0, bytesConsumed: first.stats.bytesConsumed });
  });
});

// ---------------------------------------------------------------------------
// adapter surface — discover(), shape
// ---------------------------------------------------------------------------

describe('createCodexAdapter', () => {
  it('exposes the contract surface', () => {
    const adapter = createCodexAdapter({ codexDir: '/nonexistent' });
    expect(adapter.id).toBe('codex');
    expect(adapter.schemaVerified).toBe(true);
    expect(CODEX_SCHEMA_VERIFIED).toBe(true);
  });

  it('discover() returns [] when the root or sessions dir is missing', async () => {
    const dir = await makeTmpDir();
    expect(await createCodexAdapter({ codexDir: join(dir, 'nope') }).discover()).toEqual([]);
    expect(await createCodexAdapter({ codexDir: dir }).discover()).toEqual([]); // no sessions/ subdir
  });

  it('discover() walks sessions/** recursively, keeps only *.jsonl, sorted', async () => {
    const root = await makeTmpDir();
    const d1 = join(root, 'sessions', '2026', '06', '11');
    const d2 = join(root, 'sessions', '2026', '07', '01');
    await mkdir(d1, { recursive: true });
    await mkdir(d2, { recursive: true });
    const f1 = join(d1, 'rollout-2026-06-11T11-52-13-bbbb.jsonl');
    const f2 = join(d1, 'rollout-2026-06-11T11-51-49-aaaa.jsonl');
    const f3 = join(d2, 'rollout-2026-07-01T09-00-00-cccc.jsonl');
    await writeFile(f1, '', 'utf8');
    await writeFile(f2, '', 'utf8');
    await writeFile(f3, '', 'utf8');
    await writeFile(join(d1, 'notes.txt'), '', 'utf8');
    await writeFile(join(root, 'sessions', 'stray.log'), '', 'utf8');

    const found = await createCodexAdapter({ codexDir: root }).discover();
    expect(found).toEqual([f2, f1, f3]);
    expect(found).toEqual([...found].sort());
  });

  it('honors VIBEBILL_CODEX_DIR, with opts.codexDir taking precedence', async () => {
    const envRoot = await makeTmpDir();
    const optRoot = await makeTmpDir();
    for (const root of [envRoot, optRoot]) {
      const d = join(root, 'sessions', '2026', '06', '11');
      await mkdir(d, { recursive: true });
      await writeFile(join(d, `rollout-${root === envRoot ? 'env' : 'opt'}.jsonl`), '', 'utf8');
    }
    const prev = process.env['VIBEBILL_CODEX_DIR'];
    process.env['VIBEBILL_CODEX_DIR'] = envRoot;
    try {
      const viaEnv = await createCodexAdapter().discover();
      expect(viaEnv).toHaveLength(1);
      expect(viaEnv[0]!.startsWith(envRoot)).toBe(true);
      const viaOpt = await createCodexAdapter({ codexDir: optRoot }).discover();
      expect(viaOpt).toHaveLength(1);
      expect(viaOpt[0]!.startsWith(optRoot)).toBe(true);
    } finally {
      if (prev === undefined) {
        delete process.env['VIBEBILL_CODEX_DIR'];
      } else {
        process.env['VIBEBILL_CODEX_DIR'] = prev;
      }
    }
  });

  it('end to end: discover then parse a fixture layout', async () => {
    const root = await makeTmpDir();
    const d = join(root, 'sessions', '2026', '06', '11');
    await mkdir(d, { recursive: true });
    await writeFile(
      join(d, `rollout-2026-06-11T11-52-13-${SESSION_ID}.jsonl`),
      [metaLine(), turnContextLine({ model: 'gpt-5.3-codex' }), tokenCountLine({ last: rawUsage(11, 2, 13) })].join('\n') + '\n',
      'utf8',
    );
    const adapter = createCodexAdapter({ codexDir: root });
    const files = await adapter.discover();
    expect(files).toHaveLength(1);
    const events: UsageEvent[] = [];
    const stats = await adapter.parseFile(files[0]!, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]!.model).toBe('gpt-5.3-codex');
    expect(events[0]!.tokens).toEqual({ input: 9, output: 13, cacheWrite: 0, cacheRead: 2 });
    expect(stats.eventsExtracted).toBe(1);
    expect(stats.linesSkipped).toBe(0);
  });
});
