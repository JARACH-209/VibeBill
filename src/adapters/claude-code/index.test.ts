/**
 * Tests for the Claude Code adapter. Fixture lines mirror the VERIFIED
 * transcript structure from docs/contracts.md (recon against v2.1.202 logs),
 * with all content text replaced by "[sanitized]" placeholders.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { UsageEvent } from '../../core/types.js';
import { CLAUDE_CODE_SCHEMA_VERIFIED, createClaudeCodeAdapter } from './index.js';
import { MAX_LINE_BYTES, eventFromLine, parseClaudeCodeFile } from './parser.js';

// ---------------------------------------------------------------------------
// fixture builders (sanitized-real structure per contracts.md §"Verified log-format facts")
// ---------------------------------------------------------------------------

const SESSION = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const CWD = '/Users/dev/proj';

interface UsageSpec {
  input?: number;
  output?: number;
  cacheWrite?: number;
  cacheRead?: number;
  iterations?: Array<Record<string, unknown>>;
}

function usageObj(spec: UsageSpec = {}): Record<string, unknown> {
  const u: Record<string, unknown> = {
    input_tokens: spec.input ?? 0,
    cache_creation_input_tokens: spec.cacheWrite ?? 0,
    cache_read_input_tokens: spec.cacheRead ?? 0,
    output_tokens: spec.output ?? 0,
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 },
    service_tier: 'standard',
    cache_creation: { ephemeral_1h_input_tokens: spec.cacheWrite ?? 0, ephemeral_5m_input_tokens: 0 },
    inference_geo: 'not_available',
    speed: 'standard',
  };
  if (spec.iterations !== undefined) {
    u['iterations'] = spec.iterations;
  }
  return u;
}

function iteration(
  input: number,
  output: number,
  cacheWrite: number,
  cacheRead: number,
  type: 'message' | 'fallback_message' = 'message',
): Record<string, unknown> {
  return {
    input_tokens: input,
    output_tokens: output,
    cache_read_input_tokens: cacheRead,
    cache_creation_input_tokens: cacheWrite,
    cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: cacheWrite },
    type,
  };
}

interface AssistantLineSpec {
  sessionId?: string;
  timestamp?: string;
  cwd?: string | null;
  gitBranch?: string | null;
  isSidechain?: boolean;
  /** null ⇒ omit the field entirely. */
  requestId?: string | null;
  /** null ⇒ omit the field entirely. */
  messageId?: string | null;
  model?: string;
  /** null ⇒ omit `usage` entirely. */
  usage?: Record<string, unknown> | null;
  content?: unknown[];
}

let seq = 0;

function assistantLine(spec: AssistantLineSpec = {}): string {
  seq += 1;
  const message: Record<string, unknown> = {
    type: 'message',
    role: 'assistant',
    model: spec.model ?? 'claude-opus-4-8',
    content: spec.content ?? [{ type: 'text', text: '[sanitized]' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    stop_details: null,
    usage: spec.usage === null ? undefined : (spec.usage ?? usageObj({ input: 3, output: 120, cacheWrite: 4522, cacheRead: 18201 })),
    diagnostics: null,
  };
  if (spec.messageId !== null) {
    message['id'] = spec.messageId ?? `msg_01SEQ${String(seq).padStart(4, '0')}`;
  }
  const rec: Record<string, unknown> = {
    parentUuid: '11111111-2222-4333-8444-555555555555',
    isSidechain: spec.isSidechain ?? false,
    userType: 'external',
    cwd: spec.cwd === undefined ? CWD : spec.cwd,
    sessionId: spec.sessionId ?? SESSION,
    version: '2.1.202',
    gitBranch: spec.gitBranch === undefined ? 'main' : spec.gitBranch,
    entrypoint: 'cli',
    type: 'assistant',
    uuid: `99999999-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    timestamp: spec.timestamp ?? '2026-07-14T10:00:00.000Z',
    message,
  };
  if (spec.requestId !== null) {
    rec['requestId'] = spec.requestId ?? `req_011SEQ${String(seq).padStart(4, '0')}`;
  }
  return JSON.stringify(rec);
}

function userLine(): string {
  seq += 1;
  return JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: CWD,
    sessionId: SESSION,
    version: '2.1.202',
    gitBranch: 'main',
    type: 'user',
    uuid: `88888888-0000-4000-8000-${String(seq).padStart(12, '0')}`,
    timestamp: '2026-07-14T09:59:58.000Z',
    message: { role: 'user', content: '[sanitized]' },
  });
}

// ---------------------------------------------------------------------------
// tmp-dir plumbing
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibebill-cc-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function writeFixture(lines: string[], opts?: { trailingNewline?: boolean }): Promise<string> {
  const dir = await makeTmpDir();
  const path = join(dir, 'session.jsonl');
  const body = lines.join('\n') + (opts?.trailingNewline === false ? '' : '\n');
  await writeFile(path, body, 'utf8');
  return path;
}

async function collectEvents(
  path: string,
  opts?: { startOffset?: number },
): Promise<{ events: UsageEvent[]; stats: Awaited<ReturnType<typeof parseClaudeCodeFile>> }> {
  const events: UsageEvent[] = [];
  const stats = await parseClaudeCodeFile(path, (e) => events.push(e), opts);
  return { events, stats };
}

// ---------------------------------------------------------------------------
// eventFromLine — field mapping
// ---------------------------------------------------------------------------

describe('eventFromLine', () => {
  it('maps a real-shaped assistant record to a UsageEvent exactly per contract', () => {
    const line = assistantLine({
      messageId: 'msg_01AAA',
      requestId: 'req_011BBB',
      timestamp: '2026-07-14T10:20:30.123Z',
      usage: usageObj({ input: 6554, output: 827, cacheWrite: 13074, cacheRead: 25382, iterations: [iteration(6554, 827, 13074, 25382)] }),
    });
    const outcome = eventFromLine(line, '/logs/s.jsonl');
    expect(outcome.kind).toBe('event');
    if (outcome.kind !== 'event') return;
    expect(outcome.event).toEqual({
      id: 'msg_01AAA:req_011BBB',
      agent: 'claude-code',
      sessionId: SESSION,
      ts: Date.parse('2026-07-14T10:20:30.123Z'),
      model: 'claude-opus-4-8',
      tokens: { input: 6554, output: 827, cacheWrite: 13074, cacheRead: 25382 },
      cwd: CWD,
      gitBranch: 'main',
      editedFiles: [],
      isSidechain: false,
      sourceFile: '/logs/s.jsonl',
    });
  });

  it('maps isSidechain true and null-ish cwd/gitBranch', () => {
    const line = assistantLine({ isSidechain: true, cwd: null, gitBranch: null });
    const outcome = eventFromLine(line, 'f');
    expect(outcome.kind).toBe('event');
    if (outcome.kind !== 'event') return;
    expect(outcome.event.isSidechain).toBe(true);
    expect(outcome.event.cwd).toBeNull();
    expect(outcome.event.gitBranch).toBeNull();
  });

  it('sums iterations when the top level is all zero (verified real shape)', () => {
    const line = assistantLine({
      usage: usageObj({
        iterations: [iteration(2, 1390, 16664, 144495), iteration(3, 10, 0, 100)],
      }),
    });
    const outcome = eventFromLine(line, 'f');
    expect(outcome.kind).toBe('event');
    if (outcome.kind !== 'event') return;
    expect(outcome.event.tokens).toEqual({ input: 5, output: 1400, cacheWrite: 16664, cacheRead: 144595 });
  });

  it('uses top-level, NOT the sum, on multi-iteration fallback_message records', () => {
    // Verified: on retry/fallback records the top level equals the LAST
    // iteration (the call that landed); earlier iterations are failed attempts.
    const line = assistantLine({
      usage: usageObj({
        input: 6554,
        output: 827,
        cacheWrite: 13074,
        cacheRead: 25382,
        iterations: [iteration(4000, 10, 900, 700, 'fallback_message'), iteration(6554, 827, 13074, 25382, 'message')],
      }),
    });
    const outcome = eventFromLine(line, 'f');
    expect(outcome.kind).toBe('event');
    if (outcome.kind !== 'event') return;
    expect(outcome.event.tokens).toEqual({ input: 6554, output: 827, cacheWrite: 13074, cacheRead: 25382 });
  });

  it('emits a zero-token event for a zero-usage record with no iterations', () => {
    const line = assistantLine({ usage: usageObj({}) });
    const outcome = eventFromLine(line, 'f');
    expect(outcome.kind).toBe('event');
    if (outcome.kind !== 'event') return;
    expect(outcome.event.tokens).toEqual({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });
  });

  it('ignores records with model "<synthetic>" (API-error records)', () => {
    const line = assistantLine({ model: '<synthetic>', usage: usageObj({ input: 5, output: 5 }) });
    expect(eventFromLine(line, 'f').kind).toBe('ignored');
  });

  it('ignores non-assistant record types (user/attachment/ai-title/unknown)', () => {
    expect(eventFromLine(userLine(), 'f').kind).toBe('ignored');
    for (const type of ['attachment', 'ai-title', 'custom-title', 'queue-operation', 'last-prompt', 'some-future-type']) {
      expect(eventFromLine(JSON.stringify({ type, sessionId: SESSION }), 'f').kind).toBe('ignored');
    }
  });

  it('ignores assistant records without message.usage', () => {
    expect(eventFromLine(assistantLine({ usage: null }), 'f').kind).toBe('ignored');
  });

  it('treats malformed lines as malformed: bad JSON, non-object, missing type, bad timestamp, usage without model', () => {
    expect(eventFromLine('not json {{{', 'f').kind).toBe('malformed');
    expect(eventFromLine('42', 'f').kind).toBe('malformed');
    expect(eventFromLine('"assistant"', 'f').kind).toBe('malformed');
    expect(eventFromLine('null', 'f').kind).toBe('malformed');
    expect(eventFromLine('{"sessionId":"x"}', 'f').kind).toBe('malformed');
    expect(eventFromLine(assistantLine({ timestamp: 'not-a-date' }), 'f').kind).toBe('malformed');
    // assistant with usage but sessionId missing → zod failure
    const noSession = JSON.parse(assistantLine({})) as Record<string, unknown>;
    delete noSession['sessionId'];
    expect(eventFromLine(JSON.stringify(noSession), 'f').kind).toBe('malformed');
    // usage-bearing record without a model string
    const noModel = JSON.parse(assistantLine({})) as { message: Record<string, unknown> };
    delete noModel.message['model'];
    expect(eventFromLine(JSON.stringify(noModel), 'f').kind).toBe('malformed');
  });

  describe('editedFiles extraction', () => {
    it('collects unique file paths from Edit/Write/MultiEdit/NotebookEdit tool_use blocks only', () => {
      const line = assistantLine({
        content: [
          { type: 'thinking', thinking: '[sanitized]', signature: '[sanitized]' },
          { type: 'text', text: '[sanitized]' },
          { type: 'tool_use', id: 'toolu_01a', name: 'Edit', input: { file_path: '/p/a.ts', old_string: '[sanitized]', new_string: '[sanitized]' } },
          { type: 'tool_use', id: 'toolu_01b', name: 'Write', input: { file_path: '/p/b.ts', content: '[sanitized]' } },
          { type: 'tool_use', id: 'toolu_01c', name: 'MultiEdit', input: { file_path: '/p/c.ts', edits: [] } },
          { type: 'tool_use', id: 'toolu_01d', name: 'NotebookEdit', input: { notebook_path: '/p/d.ipynb', new_source: '[sanitized]' } },
          { type: 'tool_use', id: 'toolu_01e', name: 'Edit', input: { file_path: '/p/a.ts', old_string: '[sanitized]', new_string: '[sanitized]' } },
          { type: 'tool_use', id: 'toolu_01f', name: 'Bash', input: { command: '[sanitized]' } },
          { type: 'tool_use', id: 'toolu_01g', name: 'Read', input: { file_path: '/p/never-edited.ts' } },
        ],
      });
      const outcome = eventFromLine(line, 'f');
      expect(outcome.kind).toBe('event');
      if (outcome.kind !== 'event') return;
      expect(outcome.event.editedFiles).toEqual(['/p/a.ts', '/p/b.ts', '/p/c.ts', '/p/d.ipynb']);
    });

    it('tolerates edit tool_use blocks without a usable path and non-array content', () => {
      const line = assistantLine({
        content: [
          { type: 'tool_use', id: 'toolu_01h', name: 'Edit', input: {} },
          { type: 'tool_use', id: 'toolu_01i', name: 'Write' },
        ],
      });
      const outcome = eventFromLine(line, 'f');
      expect(outcome.kind).toBe('event');
      if (outcome.kind !== 'event') return;
      expect(outcome.event.editedFiles).toEqual([]);

      const strContent = JSON.parse(assistantLine({})) as { message: Record<string, unknown> };
      strContent.message['content'] = '[sanitized]';
      const outcome2 = eventFromLine(JSON.stringify(strContent), 'f');
      expect(outcome2.kind).toBe('event');
      if (outcome2.kind !== 'event') return;
      expect(outcome2.event.editedFiles).toEqual([]);
    });
  });

  describe('dedupe id', () => {
    it('uses message.id + ":" + requestId when both exist', () => {
      const outcome = eventFromLine(assistantLine({ messageId: 'msg_01X', requestId: 'req_011Y' }), 'f');
      expect(outcome.kind).toBe('event');
      if (outcome.kind !== 'event') return;
      expect(outcome.event.id).toBe('msg_01X:req_011Y');
    });

    it('falls back to sessionId:timestamp:sha256-prefix when requestId is missing', () => {
      const ts = '2026-07-14T11:00:00.000Z';
      const outcome = eventFromLine(assistantLine({ requestId: null, timestamp: ts }), 'f');
      expect(outcome.kind).toBe('event');
      if (outcome.kind !== 'event') return;
      expect(outcome.event.id).toMatch(new RegExp(`^${SESSION}:${ts}:[0-9a-f]{16}$`));
    });

    it('fallback id is identical for duplicate lines and key-order independent', () => {
      const a = assistantLine({ requestId: null, messageId: null, usage: usageObj({ input: 7, output: 9 }) });
      const b = a; // literal duplicate line
      // same usage values, different JSON key order
      const reordered = JSON.parse(a) as { message: { usage: Record<string, unknown> } };
      reordered.message.usage = Object.fromEntries(Object.entries(reordered.message.usage).reverse());
      const [oa, ob, oc] = [a, b, JSON.stringify(reordered)].map((l) => eventFromLine(l, 'f'));
      expect(oa!.kind).toBe('event');
      if (oa!.kind !== 'event' || ob!.kind !== 'event' || oc!.kind !== 'event') return;
      expect(ob!.event.id).toBe(oa!.event.id);
      expect(oc!.event.id).toBe(oa!.event.id);
      // different usage ⇒ different id
      const other = eventFromLine(assistantLine({ requestId: null, messageId: null, usage: usageObj({ input: 8, output: 9 }) }), 'f');
      expect(other.kind).toBe('event');
      if (other.kind !== 'event') return;
      expect(other.event.id).not.toBe(oa!.event.id);
    });
  });
});

// ---------------------------------------------------------------------------
// parseClaudeCodeFile — streaming, caps, offsets
// ---------------------------------------------------------------------------

describe('parseClaudeCodeFile', () => {
  it('parses a mixed real-shaped file: events from assistant records only, others read but not skipped', async () => {
    const lines = [
      userLine(),
      assistantLine({ usage: usageObj({ input: 10, output: 20 }) }),
      JSON.stringify({ type: 'ai-title', sessionId: SESSION, title: '[sanitized]' }),
      assistantLine({ usage: usageObj({ input: 1, output: 2, cacheWrite: 3, cacheRead: 4 }) }),
      assistantLine({ model: '<synthetic>', usage: usageObj({ input: 99, output: 99 }) }),
    ];
    const path = await writeFixture(lines);
    const { events, stats } = await collectEvents(path);
    expect(events).toHaveLength(2);
    expect(events[0]!.tokens).toEqual({ input: 10, output: 20, cacheWrite: 0, cacheRead: 0 });
    expect(events[1]!.tokens).toEqual({ input: 1, output: 2, cacheWrite: 3, cacheRead: 4 });
    expect(events.every((e) => e.sourceFile === path)).toBe(true);
    expect(stats).toEqual({
      path,
      linesRead: 5,
      eventsExtracted: 2,
      linesSkipped: 0,
      bytesConsumed: Buffer.byteLength(lines.join('\n') + '\n'),
    });
  });

  it('counts malformed lines as skipped without crashing and keeps parsing', async () => {
    const lines = [
      'this is not json',
      assistantLine({ usage: usageObj({ input: 5, output: 5 }) }),
      ' binary garbage',
      '[1,2,3]',
      assistantLine({ timestamp: 'garbage-date' }),
      assistantLine({ usage: usageObj({ input: 6, output: 6 }) }),
    ];
    const path = await writeFixture(lines);
    const { events, stats } = await collectEvents(path);
    expect(events).toHaveLength(2);
    expect(stats.linesRead).toBe(6);
    expect(stats.linesSkipped).toBe(4);
    expect(stats.eventsExtracted).toBe(2);
    expect(stats.bytesConsumed).toBe(Buffer.byteLength(lines.join('\n') + '\n'));
  });

  it('skips lines over the 10 MB cap cheaply and still parses subsequent lines', async () => {
    const good = assistantLine({ usage: usageObj({ input: 42, output: 7 }) });
    const oversized = `{"type":"assistant","padding":"${'x'.repeat(MAX_LINE_BYTES)}"}`;
    const path = await writeFixture([oversized, good]);
    const { events, stats } = await collectEvents(path);
    expect(events).toHaveLength(1);
    expect(events[0]!.tokens.input).toBe(42);
    expect(stats.linesRead).toBe(2); // oversized(1) + good(1); the oversized line counts once
    expect(stats.linesSkipped).toBe(1);
    expect(stats.bytesConsumed).toBe(Buffer.byteLength([oversized, good].join('\n') + '\n'));
  });

  it('treats an oversized run at EOF (no newline) as a truncated, unconsumed tail', async () => {
    const good = assistantLine({ usage: usageObj({ input: 1, output: 1 }) });
    const dir = await makeTmpDir();
    const path = join(dir, 's.jsonl');
    await writeFile(path, good + '\n' + 'y'.repeat(MAX_LINE_BYTES + 10), 'utf8');
    const { events, stats } = await collectEvents(path);
    expect(events).toHaveLength(1);
    expect(stats.linesRead).toBe(2);
    expect(stats.linesSkipped).toBe(1);
    expect(stats.bytesConsumed).toBe(Buffer.byteLength(good + '\n'));
  });

  it('skips+counts a truncated final line without consuming it, and resume picks it up', async () => {
    const first = assistantLine({ usage: usageObj({ input: 3, output: 4 }) });
    const second = assistantLine({ usage: usageObj({ input: 30, output: 40 }) });
    const cut = Math.floor(second.length / 2);
    const dir = await makeTmpDir();
    const path = join(dir, 's.jsonl');

    await writeFile(path, first + '\n' + second.slice(0, cut), 'utf8');
    const pass1 = await collectEvents(path);
    expect(pass1.events).toHaveLength(1);
    expect(pass1.stats.linesRead).toBe(2);
    expect(pass1.stats.linesSkipped).toBe(1); // the truncated tail
    expect(pass1.stats.bytesConsumed).toBe(Buffer.byteLength(first + '\n'));

    // The agent finishes writing; the next incremental run resumes at bytesConsumed.
    await writeFile(path, first + '\n' + second + '\n', 'utf8');
    const pass2 = await collectEvents(path, { startOffset: pass1.stats.bytesConsumed });
    expect(pass2.events).toHaveLength(1);
    expect(pass2.events[0]!.tokens).toEqual({ input: 30, output: 40, cacheWrite: 0, cacheRead: 0 });
    expect(pass2.stats.linesSkipped).toBe(0);
    expect(pass2.stats.bytesConsumed).toBe(Buffer.byteLength(first + '\n' + second + '\n'));
  });

  it('startOffset resume is equivalent to a full parse (parse full == parse[0..k) + resume)', async () => {
    const lines = [
      userLine(),
      assistantLine({ usage: usageObj({ input: 1, output: 2 }) }),
      assistantLine({ usage: usageObj({ input: 3, output: 4 }) }),
      'malformed {{{',
      assistantLine({ usage: usageObj({ iterations: [iteration(2, 1390, 16664, 144495)] }) }),
      assistantLine({ usage: usageObj({ input: 5, output: 6, cacheRead: 7 }) }),
    ];
    const dir = await makeTmpDir();
    const path = join(dir, 's.jsonl');
    const prefix = lines.slice(0, 3).map((l) => l + '\n').join('');
    const full = lines.map((l) => l + '\n').join('');

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
  });

  it('handles empty files, blank lines, and CRLF line endings', async () => {
    const dir = await makeTmpDir();
    const empty = join(dir, 'empty.jsonl');
    await writeFile(empty, '', 'utf8');
    const emptyRes = await collectEvents(empty);
    expect(emptyRes.stats).toEqual({ path: empty, linesRead: 0, eventsExtracted: 0, linesSkipped: 0, bytesConsumed: 0 });

    const line = assistantLine({ usage: usageObj({ input: 2, output: 2 }) });
    const crlf = join(dir, 'crlf.jsonl');
    const body = line + '\r\n' + '\n' + line + '\r\n';
    await writeFile(crlf, body, 'utf8');
    const crlfRes = await collectEvents(crlf);
    expect(crlfRes.events).toHaveLength(2);
    expect(crlfRes.stats.linesRead).toBe(2); // the blank line is consumed but not counted
    expect(crlfRes.stats.linesSkipped).toBe(0);
    expect(crlfRes.stats.bytesConsumed).toBe(Buffer.byteLength(body));
  });

  it('rejects on unopenable files so the ingest layer can count filesSkipped', async () => {
    const dir = await makeTmpDir();
    await expect(parseClaudeCodeFile(join(dir, 'does-not-exist.jsonl'), () => {})).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// adapter surface — discover(), shape
// ---------------------------------------------------------------------------

describe('createClaudeCodeAdapter', () => {
  it('exposes the contract surface', () => {
    const adapter = createClaudeCodeAdapter({ claudeDir: '/nonexistent' });
    expect(adapter.id).toBe('claude-code');
    expect(adapter.schemaVerified).toBe(true);
    expect(CLAUDE_CODE_SCHEMA_VERIFIED).toBe(true);
  });

  it('discover() returns [] when the root or projects dir is missing', async () => {
    const dir = await makeTmpDir();
    expect(await createClaudeCodeAdapter({ claudeDir: join(dir, 'nope') }).discover()).toEqual([]);
    // root exists but has no projects/ subdir
    expect(await createClaudeCodeAdapter({ claudeDir: dir }).discover()).toEqual([]);
  });

  it('discover() lists only projects/*/*.jsonl, sorted', async () => {
    const root = await makeTmpDir();
    const pA = join(root, 'projects', '-Users-dev-proj');
    const pB = join(root, 'projects', '-Users-dev-other');
    await mkdir(pA, { recursive: true });
    await mkdir(pB, { recursive: true });
    await writeFile(join(pA, 'bbbb.jsonl'), '', 'utf8');
    await writeFile(join(pA, 'aaaa.jsonl'), '', 'utf8');
    await writeFile(join(pB, 'cccc.jsonl'), '', 'utf8');
    await writeFile(join(pA, 'notes.txt'), '', 'utf8');
    await writeFile(join(root, 'projects', 'stray-file'), '', 'utf8');

    const found = await createClaudeCodeAdapter({ claudeDir: root }).discover();
    expect(found).toEqual([join(pB, 'cccc.jsonl'), join(pA, 'aaaa.jsonl'), join(pA, 'bbbb.jsonl')].sort());
    expect(found).toEqual([...found].sort());
  });

  it('honors VIBEBILL_CLAUDE_DIR when no explicit dir is given', async () => {
    const root = await makeTmpDir();
    const proj = join(root, 'projects', '-Users-dev-proj');
    await mkdir(proj, { recursive: true });
    const file = join(proj, SESSION + '.jsonl');
    await writeFile(file, assistantLine({}) + '\n', 'utf8');

    const prev = process.env['VIBEBILL_CLAUDE_DIR'];
    process.env['VIBEBILL_CLAUDE_DIR'] = root;
    try {
      expect(await createClaudeCodeAdapter().discover()).toEqual([file]);
    } finally {
      if (prev === undefined) {
        delete process.env['VIBEBILL_CLAUDE_DIR'];
      } else {
        process.env['VIBEBILL_CLAUDE_DIR'] = prev;
      }
    }
  });

  it('end to end: discover then parse a fixture layout', async () => {
    const root = await makeTmpDir();
    const proj = join(root, 'projects', '-Users-dev-proj');
    await mkdir(proj, { recursive: true });
    await writeFile(
      join(proj, SESSION + '.jsonl'),
      [userLine(), assistantLine({ usage: usageObj({ input: 11, output: 13 }) })].join('\n') + '\n',
      'utf8',
    );
    const adapter = createClaudeCodeAdapter({ claudeDir: root });
    const files = await adapter.discover();
    expect(files).toHaveLength(1);
    const events: UsageEvent[] = [];
    const stats = await adapter.parseFile(files[0]!, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]!.tokens).toEqual({ input: 11, output: 13, cacheWrite: 0, cacheRead: 0 });
    expect(stats.eventsExtracted).toBe(1);
    expect(stats.linesSkipped).toBe(0);
  });
});
