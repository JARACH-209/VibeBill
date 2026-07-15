/**
 * Tests for the Gemini CLI adapter. Fixture records mirror the source-verified
 * structure from docs/contracts.md (gemini-cli v0.50 chatRecordingService.ts),
 * with all content text replaced by "[sanitized]" placeholders.
 */
import { mkdir, mkdtemp, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import type { SourceAdapter, UsageEvent } from '../../core/types.js';
import { GEMINI_CLI_SCHEMA_VERIFIED, createGeminiCliAdapter } from './index.js';
import { MAX_LEGACY_JSON_BYTES, MAX_LINE_BYTES } from './parser.js';

// ---------------------------------------------------------------------------
// fixture builders (sanitized structure per contracts.md §"Gemini CLI")
// ---------------------------------------------------------------------------

const SESSION = 'e1f2a3b4-5678-4abc-8def-0123456789ab';
const SLUG = 'a1b2c3d4hash';
const PROJECT_ROOT = '/Users/dev/gemini-proj';
const TS = '2026-07-14T10:00:00.000Z';

function tokensObj(spec: {
  input?: number;
  output?: number;
  cached?: number;
  thoughts?: number;
  tool?: number;
}): Record<string, unknown> {
  const input = spec.input ?? 0;
  const output = spec.output ?? 0;
  const cached = spec.cached ?? 0;
  const thoughts = spec.thoughts ?? 0;
  const tool = spec.tool ?? 0;
  return { input, output, cached, thoughts, tool, total: input + output + thoughts + tool };
}

function metaRecord(spec: { sessionId?: string; kind?: string | null } = {}): Record<string, unknown> {
  const rec: Record<string, unknown> = {
    sessionId: spec.sessionId ?? SESSION,
    projectHash: SLUG,
    startTime: '2026-07-14T09:59:00.000Z',
  };
  if (spec.kind !== null) {
    rec['kind'] = spec.kind ?? 'main';
  }
  return rec;
}

function metaLine(spec: { sessionId?: string; kind?: string | null } = {}): string {
  return JSON.stringify(metaRecord(spec));
}

let seq = 0;

interface GeminiSpec {
  /** null ⇒ omit the field entirely. */
  id?: string | null;
  /** null ⇒ omit the field entirely. */
  timestamp?: string | null;
  /** null ⇒ omit the field entirely. */
  model?: string | null;
  /** null ⇒ omit the field entirely. */
  tokens?: Record<string, unknown> | null;
  toolCalls?: unknown[];
}

function geminiRecord(spec: GeminiSpec = {}): Record<string, unknown> {
  seq += 1;
  const rec: Record<string, unknown> = {
    type: 'gemini',
    content: '[sanitized]',
  };
  if (spec.id !== null) {
    rec['id'] = spec.id ?? `m-${String(seq).padStart(4, '0')}`;
  }
  if (spec.timestamp !== null) {
    rec['timestamp'] = spec.timestamp ?? TS;
  }
  if (spec.model !== null) {
    rec['model'] = spec.model ?? 'gemini-2.5-pro';
  }
  if (spec.tokens !== null) {
    rec['tokens'] = spec.tokens ?? tokensObj({ input: 100, output: 10 });
  }
  if (spec.toolCalls !== undefined) {
    rec['toolCalls'] = spec.toolCalls;
  }
  return rec;
}

function geminiLine(spec: GeminiSpec = {}): string {
  return JSON.stringify(geminiRecord(spec));
}

function userRecord(): Record<string, unknown> {
  seq += 1;
  return {
    id: `u-${String(seq).padStart(4, '0')}`,
    timestamp: '2026-07-14T09:59:58.000Z',
    type: 'user',
    content: '[sanitized]',
  };
}

function userLine(): string {
  return JSON.stringify(userRecord());
}

// ---------------------------------------------------------------------------
// tmp-dir plumbing and layout builders
// ---------------------------------------------------------------------------

const tmpDirs: string[] = [];

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibebill-gem-'));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

interface Layout {
  root: string;
  slugDir: string;
  chatsDir: string;
  adapter: SourceAdapter;
}

async function makeLayout(opts?: {
  slug?: string;
  /** null ⇒ do not write a .project_root marker. */
  projectRoot?: string | null;
  projectsJson?: Record<string, string>;
}): Promise<Layout> {
  const root = await makeTmpDir();
  const slug = opts?.slug ?? SLUG;
  const slugDir = join(root, 'tmp', slug);
  const chatsDir = join(slugDir, 'chats');
  await mkdir(chatsDir, { recursive: true });
  if (opts?.projectRoot !== null) {
    await writeFile(join(slugDir, '.project_root'), (opts?.projectRoot ?? PROJECT_ROOT) + '\n', 'utf8');
  }
  if (opts?.projectsJson !== undefined) {
    await writeFile(join(root, 'projects.json'), JSON.stringify({ projects: opts.projectsJson }), 'utf8');
  }
  return { root, slugDir, chatsDir, adapter: createGeminiCliAdapter({ geminiDir: root }) };
}

async function writeChat(
  chatsDir: string,
  name: string,
  lines: string[],
  opts?: { trailingNewline?: boolean },
): Promise<string> {
  const path = join(chatsDir, name);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, lines.join('\n') + (opts?.trailingNewline === false ? '' : '\n'), 'utf8');
  return path;
}

async function collect(
  adapter: SourceAdapter,
  path: string,
  opts?: { startOffset?: number },
): Promise<{ events: UsageEvent[]; stats: Awaited<ReturnType<SourceAdapter['parseFile']>> }> {
  const events: UsageEvent[] = [];
  const stats = await adapter.parseFile(path, (e) => events.push(e), opts);
  return { events, stats };
}

// ---------------------------------------------------------------------------
// JSONL parsing — field mapping and token math
// ---------------------------------------------------------------------------

describe('gemini-cli jsonl parsing', () => {
  it('maps a session file exactly per contract: metadata sessionId, cached/thoughts token math', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const lines = [
      metaLine(),
      userLine(),
      geminiLine({ id: 'm-a', tokens: tokensObj({ input: 1000, cached: 400, output: 200, thoughts: 300, tool: 25 }) }),
      geminiLine({ id: 'm-b', tokens: tokensObj({ input: 100, cached: 150, output: 10 }) }),
    ];
    const path = await writeChat(chatsDir, 'session-1.jsonl', lines);
    const { events, stats } = await collect(adapter, path);

    expect(events).toHaveLength(2);
    expect(events[0]).toEqual({
      id: `${SESSION}:m-a`,
      agent: 'gemini-cli',
      sessionId: SESSION,
      ts: Date.parse(TS),
      model: 'gemini-2.5-pro',
      // input EXCLUDES cached (1000-400); output INCLUDES thoughts (200+300); no cache writes.
      tokens: { input: 600, output: 500, cacheWrite: 0, cacheRead: 400 },
      cwd: PROJECT_ROOT,
      gitBranch: null,
      editedFiles: [],
      isSidechain: false,
      sourceFile: path,
    });
    // input < cached clamps at 0, never negative.
    expect(events[1]!.tokens).toEqual({ input: 0, output: 10, cacheWrite: 0, cacheRead: 150 });
    expect(stats).toEqual({
      path,
      linesRead: 4,
      eventsExtracted: 2,
      linesSkipped: 0,
      bytesConsumed: Buffer.byteLength(lines.join('\n') + '\n'),
    });
  });

  it('produces no events for user/info/unknown records or gemini records without tokens', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const lines = [
      metaLine(),
      userLine(),
      JSON.stringify({ id: 'i-1', timestamp: TS, type: 'info', content: '[sanitized]' }),
      JSON.stringify({ id: 'z-1', timestamp: TS, type: 'some-future-type', content: '[sanitized]' }),
      geminiLine({ tokens: null }), // gemini without usage
      JSON.stringify({ noType: true }), // unknown auxiliary object — tolerated
    ];
    const path = await writeChat(chatsDir, 'session-2.jsonl', lines);
    const { events, stats } = await collect(adapter, path);
    expect(events).toHaveLength(0);
    expect(stats.linesRead).toBe(6);
    expect(stats.linesSkipped).toBe(0);
  });

  it('emits re-appended duplicate message ids every time with the same dedupe id (ingest keeps last)', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const lines = [
      metaLine(),
      geminiLine({ id: 'm-dup', tokens: tokensObj({ input: 10, output: 1 }) }),
      userLine(),
      geminiLine({ id: 'm-dup', tokens: tokensObj({ input: 20, output: 2 }) }),
    ];
    const path = await writeChat(chatsDir, 'session-3.jsonl', lines);
    const { events } = await collect(adapter, path);
    expect(events).toHaveLength(2);
    expect(events[0]!.id).toBe(`${SESSION}:m-dup`);
    expect(events[1]!.id).toBe(`${SESSION}:m-dup`);
    expect(events[0]!.tokens.input).toBe(10);
    expect(events[1]!.tokens.input).toBe(20);
  });

  it('emits events from $set.messages replacement members and ignores $rewindTo markers', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const lines = [
      metaLine(),
      geminiLine({ id: 'm-1', tokens: tokensObj({ input: 10, output: 1 }) }),
      JSON.stringify({
        $set: {
          messages: [
            userRecord(),
            geminiRecord({ id: 'm-1', tokens: tokensObj({ input: 11, output: 2, cached: 5 }) }),
            geminiRecord({ id: 'm-2', tokens: tokensObj({ input: 30, output: 3, thoughts: 7 }) }),
          ],
        },
      }),
      JSON.stringify({ $rewindTo: 'm-1' }),
      JSON.stringify({ $set: { lastUpdated: TS } }), // $set without messages: fine, nothing emitted
    ];
    const path = await writeChat(chatsDir, 'session-4.jsonl', lines);
    const { events, stats } = await collect(adapter, path);

    expect(events.map((e) => e.id)).toEqual([`${SESSION}:m-1`, `${SESSION}:m-1`, `${SESSION}:m-2`]);
    expect(events[1]!.tokens).toEqual({ input: 6, output: 2, cacheWrite: 0, cacheRead: 5 });
    expect(events[2]!.tokens).toEqual({ input: 30, output: 10, cacheWrite: 0, cacheRead: 0 });
    expect(stats.linesRead).toBe(5);
    expect(stats.linesSkipped).toBe(0);
    expect(stats.eventsExtracted).toBe(3);
  });

  it('skips + counts usage-bearing records with missing/invalid timestamp, missing id, or missing model', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const lines = [
      metaLine(),
      geminiLine({ timestamp: null }),
      geminiLine({ timestamp: 'not-a-date' }),
      geminiLine({ id: null }),
      geminiLine({ model: null }),
      geminiLine({ id: 'm-good', tokens: tokensObj({ input: 5, output: 5 }) }),
      // a bad usage-bearing member inside $set marks that line skipped; the good member still emits
      JSON.stringify({
        $set: {
          messages: [
            geminiRecord({ id: 'm-set-bad', timestamp: 'garbage', tokens: tokensObj({ input: 1, output: 1 }) }),
            geminiRecord({ id: 'm-set-good', tokens: tokensObj({ input: 2, output: 2 }) }),
          ],
        },
      }),
    ];
    const path = await writeChat(chatsDir, 'session-5.jsonl', lines);
    const { events, stats } = await collect(adapter, path);
    expect(events.map((e) => e.id)).toEqual([`${SESSION}:m-good`, `${SESSION}:m-set-good`]);
    expect(stats.linesRead).toBe(7);
    expect(stats.linesSkipped).toBe(5);
  });

  it('counts malformed lines and keeps parsing without crashing', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const lines = [
      metaLine(),
      'this is not json {{{',
      '42',
      '[1,2,3]',
      '"gemini"',
      JSON.stringify({ id: 'm-x', timestamp: TS, type: 'gemini', model: 'gemini-2.5-pro', tokens: 'garbage' }),
      geminiLine({ id: 'm-ok', tokens: tokensObj({ input: 9, output: 9 }) }),
    ];
    const path = await writeChat(chatsDir, 'session-6.jsonl', lines);
    const { events, stats } = await collect(adapter, path);
    expect(events).toHaveLength(1);
    expect(events[0]!.id).toBe(`${SESSION}:m-ok`);
    expect(stats.linesRead).toBe(7);
    expect(stats.linesSkipped).toBe(5);
  });

  it('skips lines over the 10 MB cap cheaply and still parses subsequent lines', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const oversized = `{"type":"gemini","padding":"${'x'.repeat(MAX_LINE_BYTES)}"}`;
    const good = geminiLine({ id: 'm-after', tokens: tokensObj({ input: 42, output: 7 }) });
    const path = await writeChat(chatsDir, 'session-7.jsonl', [metaLine(), oversized, good]);
    const { events, stats } = await collect(adapter, path);
    expect(events).toHaveLength(1);
    expect(events[0]!.tokens.input).toBe(42);
    expect(stats.linesRead).toBe(3);
    expect(stats.linesSkipped).toBe(1);
    expect(stats.bytesConsumed).toBe(Buffer.byteLength([metaLine(), oversized, good].join('\n') + '\n'));
  });

  it('skips + counts a truncated final line without consuming it, and resume picks it up', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const first = geminiLine({ id: 'm-1', tokens: tokensObj({ input: 3, output: 4 }) });
    const second = geminiLine({ id: 'm-2', tokens: tokensObj({ input: 30, output: 40 }) });
    const path = join(chatsDir, 'session-8.jsonl');
    const head = metaLine() + '\n' + first + '\n';

    await writeFile(path, head + second.slice(0, Math.floor(second.length / 2)), 'utf8');
    const pass1 = await collect(adapter, path);
    expect(pass1.events).toHaveLength(1);
    expect(pass1.stats.linesRead).toBe(3);
    expect(pass1.stats.linesSkipped).toBe(1); // the truncated tail
    expect(pass1.stats.bytesConsumed).toBe(Buffer.byteLength(head));

    // The agent finishes writing; the next incremental run resumes at bytesConsumed.
    await writeFile(path, head + second + '\n', 'utf8');
    const pass2 = await collect(adapter, path, { startOffset: pass1.stats.bytesConsumed });
    expect(pass2.events).toHaveLength(1);
    expect(pass2.events[0]!.id).toBe(`${SESSION}:m-2`); // metadata sessionId survived the resume
    expect(pass2.stats.linesSkipped).toBe(0);
    expect(pass2.stats.bytesConsumed).toBe(Buffer.byteLength(head + second + '\n'));
  });

  it('startOffset resume is equivalent to a full parse, including the metadata sessionId', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const lines = [
      metaLine(),
      geminiLine({ id: 'm-1', tokens: tokensObj({ input: 10, output: 1 }) }),
      userLine(),
      JSON.stringify({
        $set: { messages: [userRecord(), geminiRecord({ id: 'm-2', tokens: tokensObj({ input: 20, output: 2, cached: 5 }) })] },
      }),
      geminiLine({ id: 'm-3', tokens: tokensObj({ input: 30, output: 3 }) }),
    ];
    const path = join(chatsDir, 'session-9.jsonl');
    const prefix = lines.slice(0, 2).map((l) => l + '\n').join('');
    const full = lines.map((l) => l + '\n').join('');

    await writeFile(path, full, 'utf8');
    const whole = await collect(adapter, path);
    expect(whole.events.map((e) => e.sessionId)).toEqual([SESSION, SESSION, SESSION]);

    await writeFile(path, prefix, 'utf8');
    const part1 = await collect(adapter, path);
    expect(part1.stats.bytesConsumed).toBe(Buffer.byteLength(prefix));
    await writeFile(path, full, 'utf8');
    const part2 = await collect(adapter, path, { startOffset: part1.stats.bytesConsumed });

    expect([...part1.events, ...part2.events]).toEqual(whole.events);
    expect(part1.stats.linesRead + part2.stats.linesRead).toBe(whole.stats.linesRead);
    expect(part1.stats.linesSkipped + part2.stats.linesSkipped).toBe(whole.stats.linesSkipped);
    expect(part1.stats.eventsExtracted + part2.stats.eventsExtracted).toBe(whole.stats.eventsExtracted);
    expect(part2.stats.bytesConsumed).toBe(whole.stats.bytesConsumed);
  });

  it('falls back to the file name for the session id when there is no metadata line', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const path = await writeChat(chatsDir, 'session-77.jsonl', [
      geminiLine({ id: 'm-1', tokens: tokensObj({ input: 1, output: 1 }) }),
    ]);
    const { events } = await collect(adapter, path);
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe('session-77');
    expect(events[0]!.id).toBe('session-77:m-1');
  });

  it('handles empty files and blank lines', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const empty = await writeChat(chatsDir, 'empty.jsonl', [], { trailingNewline: false });
    const emptyRes = await collect(adapter, empty);
    expect(emptyRes.stats).toEqual({ path: empty, linesRead: 0, eventsExtracted: 0, linesSkipped: 0, bytesConsumed: 0 });

    // A blank first line does not steal the metadata slot.
    const lines = ['', metaLine(), geminiLine({ id: 'm-1', tokens: tokensObj({ input: 2, output: 2 }) })];
    const path = await writeChat(chatsDir, 'blank.jsonl', lines);
    const { events, stats } = await collect(adapter, path);
    expect(events).toHaveLength(1);
    expect(events[0]!.sessionId).toBe(SESSION);
    expect(stats.linesRead).toBe(2);
  });

  it('rejects on unopenable files so the ingest layer can count filesSkipped', async () => {
    const { chatsDir, adapter } = await makeLayout();
    await expect(adapter.parseFile(join(chatsDir, 'does-not-exist.jsonl'), () => {})).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// sidechain detection
// ---------------------------------------------------------------------------

describe('sidechain detection', () => {
  it('marks events from nested subagent chat files (chats/<parent>/<child>.jsonl)', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const path = await writeChat(chatsDir, join('parent-session', 'child-session.jsonl'), [
      metaLine({ kind: 'main' }), // nesting wins even when kind says main
      geminiLine({ id: 'm-1', tokens: tokensObj({ input: 1, output: 1 }) }),
    ]);
    const { events } = await collect(adapter, path);
    expect(events).toHaveLength(1);
    expect(events[0]!.isSidechain).toBe(true);
    expect(events[0]!.cwd).toBe(PROJECT_ROOT); // cwd recovery handles the extra nesting level
  });

  it('marks events when metadata kind is present and not "main"', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const sub = await writeChat(chatsDir, 'sub.jsonl', [
      metaLine({ kind: 'subagent' }),
      geminiLine({ id: 'm-1', tokens: tokensObj({ input: 1, output: 1 }) }),
    ]);
    const main = await writeChat(chatsDir, 'main.jsonl', [
      metaLine({ kind: 'main' }),
      geminiLine({ id: 'm-2', tokens: tokensObj({ input: 1, output: 1 }) }),
    ]);
    const noKind = await writeChat(chatsDir, 'nokind.jsonl', [
      metaLine({ kind: null }),
      geminiLine({ id: 'm-3', tokens: tokensObj({ input: 1, output: 1 }) }),
    ]);
    expect((await collect(adapter, sub)).events[0]!.isSidechain).toBe(true);
    expect((await collect(adapter, main)).events[0]!.isSidechain).toBe(false);
    expect((await collect(adapter, noKind)).events[0]!.isSidechain).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// cwd recovery and editedFiles
// ---------------------------------------------------------------------------

describe('cwd recovery and editedFiles', () => {
  it('extracts paths from replace/write_file toolCalls only and never leaks args content', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const path = await writeChat(chatsDir, 'edits.jsonl', [
      metaLine(),
      geminiLine({
        id: 'm-1',
        tokens: tokensObj({ input: 50, output: 5 }),
        toolCalls: [
          { name: 'replace', args: { file_path: '/abs/edited.ts', old_string: 'OLD_SECRET_TEXT', new_string: 'NEW_SECRET_TEXT' } },
          { name: 'write_file', args: { file_path: 'src/rel.ts', content: 'CONTENT_SECRET' } },
          { name: 'replace', args: { file_path: '/abs/edited.ts', old_string: 'OLD_SECRET_TEXT', new_string: 'OTHER_SECRET' } },
          { name: 'read_file', args: { file_path: '/abs/read-only-file.ts' } },
          { name: 'run_shell_command', args: { command: 'CMD_SECRET' } },
          { name: 'replace' }, // no args: tolerated
          'not-an-object',
        ],
      }),
    ]);
    const { events, stats } = await collect(adapter, path);

    expect(events).toHaveLength(1);
    expect(events[0]!.editedFiles).toEqual(['/abs/edited.ts', resolve(PROJECT_ROOT, 'src/rel.ts')]);
    expect(events[0]!.tokens.input).toBe(50);
    expect(stats.linesSkipped).toBe(0);

    // Privacy: nothing from args besides file_path may survive into events or stats.
    const serialized = JSON.stringify(events) + JSON.stringify(stats);
    for (const secret of ['OLD_SECRET_TEXT', 'NEW_SECRET_TEXT', 'OTHER_SECRET', 'CONTENT_SECRET', 'CMD_SECRET', 'read-only-file']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('drops relative edit paths (keeping tokens) when no project root is recoverable', async () => {
    const { chatsDir, adapter } = await makeLayout({ projectRoot: null });
    const path = await writeChat(chatsDir, 'noroot.jsonl', [
      metaLine(),
      geminiLine({
        id: 'm-1',
        tokens: tokensObj({ input: 7, output: 3 }),
        toolCalls: [
          { name: 'replace', args: { file_path: 'src/rel.ts', old_string: 'S', new_string: 'T' } },
          { name: 'write_file', args: { file_path: '/abs/kept.ts', content: 'S' } },
        ],
      }),
    ]);
    const { events } = await collect(adapter, path);
    expect(events).toHaveLength(1);
    expect(events[0]!.cwd).toBeNull();
    expect(events[0]!.editedFiles).toEqual(['/abs/kept.ts']);
    expect(events[0]!.tokens).toEqual({ input: 7, output: 3, cacheWrite: 0, cacheRead: 0 });
  });

  it('recovers cwd from the .project_root marker (trimmed), for flat and nested files', async () => {
    const { chatsDir, adapter } = await makeLayout({ projectRoot: `  ${PROJECT_ROOT}\n` });
    const flat = await writeChat(chatsDir, 'flat.jsonl', [metaLine(), geminiLine({ id: 'm-1' })]);
    const nested = await writeChat(chatsDir, join('parent', 'child.jsonl'), [metaLine(), geminiLine({ id: 'm-2' })]);
    expect((await collect(adapter, flat)).events[0]!.cwd).toBe(PROJECT_ROOT);
    expect((await collect(adapter, nested)).events[0]!.cwd).toBe(PROJECT_ROOT);
  });

  it('falls back to projects.json reverse lookup, deterministically on duplicate slugs', async () => {
    const { chatsDir, adapter } = await makeLayout({
      projectRoot: null,
      projectsJson: { '/abs/proj-b': SLUG, '/abs/proj-a': SLUG, '/abs/other': 'other-slug' },
    });
    const path = await writeChat(chatsDir, 's.jsonl', [metaLine(), geminiLine({ id: 'm-1' })]);
    const { events } = await collect(adapter, path);
    expect(events[0]!.cwd).toBe('/abs/proj-a'); // smallest path wins
  });

  it('ignores a non-absolute marker and falls back; null when nothing is recoverable', async () => {
    const viaProjects = await makeLayout({ projectRoot: 'relative/not/allowed', projectsJson: { '/abs/from-projects': SLUG } });
    const p1 = await writeChat(viaProjects.chatsDir, 's.jsonl', [metaLine(), geminiLine({ id: 'm-1' })]);
    expect((await collect(viaProjects.adapter, p1)).events[0]!.cwd).toBe('/abs/from-projects');

    const nothing = await makeLayout({ projectRoot: null });
    const p2 = await writeChat(nothing.chatsDir, 's.jsonl', [metaLine(), geminiLine({ id: 'm-2' })]);
    expect((await collect(nothing.adapter, p2)).events[0]!.cwd).toBeNull();
  });

  it('caches per-slug lookups within a run (adapter instance)', async () => {
    const { chatsDir, slugDir, adapter, root } = await makeLayout();
    const a = await writeChat(chatsDir, 'a.jsonl', [metaLine(), geminiLine({ id: 'm-1' })]);
    const b = await writeChat(chatsDir, 'b.jsonl', [metaLine(), geminiLine({ id: 'm-2' })]);

    expect((await collect(adapter, a)).events[0]!.cwd).toBe(PROJECT_ROOT);
    await rm(join(slugDir, '.project_root'));
    // Same run: cached slug lookup still answers.
    expect((await collect(adapter, b)).events[0]!.cwd).toBe(PROJECT_ROOT);
    // Fresh run (new adapter): the marker is gone and nothing else exists.
    const fresh = createGeminiCliAdapter({ geminiDir: root });
    const events: UsageEvent[] = [];
    await fresh.parseFile(b, (e) => events.push(e));
    expect(events[0]!.cwd).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// legacy single-document .json files
// ---------------------------------------------------------------------------

describe('legacy .json documents', () => {
  it('parses a legacy document with the same message schema and token math', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const doc = JSON.stringify({
      sessionId: SESSION,
      projectHash: SLUG,
      startTime: '2026-03-01T08:00:00.000Z',
      messages: [
        userRecord(),
        geminiRecord({ id: 'm-1', tokens: tokensObj({ input: 500, cached: 100, output: 40, thoughts: 60 }) }),
        geminiRecord({ id: 'm-2', timestamp: 'garbage', tokens: tokensObj({ input: 1, output: 1 }) }),
      ],
    });
    const path = join(chatsDir, 'session-legacy.json');
    await writeFile(path, doc, 'utf8');
    const { events, stats } = await collect(adapter, path);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      id: `${SESSION}:m-1`,
      agent: 'gemini-cli',
      sessionId: SESSION,
      ts: Date.parse(TS),
      model: 'gemini-2.5-pro',
      tokens: { input: 400, output: 100, cacheWrite: 0, cacheRead: 100 },
      cwd: PROJECT_ROOT,
      gitBranch: null,
      editedFiles: [],
      isSidechain: false,
      sourceFile: path,
    });
    expect(stats).toEqual({
      path,
      linesRead: 4, // document envelope + 3 message records
      eventsExtracted: 1,
      linesSkipped: 1, // the bad-timestamp member
      bytesConsumed: Buffer.byteLength(doc),
    });
  });

  it('legacy documents honor kind and nesting for sidechain, and file-name session fallback', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const doc = JSON.stringify({
      kind: 'subagent',
      messages: [geminiRecord({ id: 'm-1', tokens: tokensObj({ input: 1, output: 1 }) })],
    });
    const path = join(chatsDir, 'legacy-noid.json');
    await writeFile(path, doc, 'utf8');
    const { events } = await collect(adapter, path);
    expect(events).toHaveLength(1);
    expect(events[0]!.isSidechain).toBe(true);
    expect(events[0]!.sessionId).toBe('legacy-noid');
  });

  it('counts an unparseable legacy document as one skipped record without throwing', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const path = join(chatsDir, 'broken.json');
    await writeFile(path, '{"sessionId": "x", "messages": [truncated', 'utf8');
    const { events, stats } = await collect(adapter, path);
    expect(events).toHaveLength(0);
    expect(stats.linesRead).toBe(1);
    expect(stats.linesSkipped).toBe(1);
    expect(stats.bytesConsumed).toBe(0); // unconsumed: a finished rewrite is re-read next run
  });

  it('refuses legacy files at/over the 64 MB guard by rejecting (ingest counts a skipped file)', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const path = join(chatsDir, 'huge.json');
    await writeFile(path, '{"sessionId":"x","messages":[]}', 'utf8');
    await truncate(path, MAX_LEGACY_JSON_BYTES); // sparse extension: cheap
    await expect(adapter.parseFile(path, () => {})).rejects.toThrow(/64|byte cap/);
    // The rejection message names only the path, never transcript content.
    await expect(adapter.parseFile(path, () => {})).rejects.toThrow(path.slice(path.length - 9));
  });

  it('ignores startOffset for legacy documents (single doc cannot resume; re-parses from 0)', async () => {
    const { chatsDir, adapter } = await makeLayout();
    const doc = JSON.stringify({
      sessionId: SESSION,
      messages: [geminiRecord({ id: 'm-1', tokens: tokensObj({ input: 5, output: 5 }) })],
    });
    const path = join(chatsDir, 'resume.json');
    await writeFile(path, doc, 'utf8');
    const full = await collect(adapter, path);
    const offset = await collect(adapter, path, { startOffset: 10 });
    expect(offset.events).toEqual(full.events);
    expect(offset.stats).toEqual(full.stats);
  });
});

// ---------------------------------------------------------------------------
// discover() and adapter surface
// ---------------------------------------------------------------------------

describe('createGeminiCliAdapter', () => {
  it('exposes the contract surface with schemaVerified=false', () => {
    const adapter = createGeminiCliAdapter({ geminiDir: '/nonexistent' });
    expect(adapter.id).toBe('gemini-cli');
    expect(adapter.schemaVerified).toBe(false);
    expect(GEMINI_CLI_SCHEMA_VERIFIED).toBe(false);
  });

  it('discover() returns [] when the root or tmp dir is missing', async () => {
    const dir = await makeTmpDir();
    expect(await createGeminiCliAdapter({ geminiDir: join(dir, 'nope') }).discover()).toEqual([]);
    expect(await createGeminiCliAdapter({ geminiDir: dir }).discover()).toEqual([]); // no tmp/
  });

  it('discover() lists tmp/*/chats/** jsonl and legacy json files, sorted, excluding strays', async () => {
    const root = await makeTmpDir();
    const slugA = join(root, 'tmp', 'slug-a', 'chats');
    const slugB = join(root, 'tmp', 'slug-b', 'chats');
    await mkdir(join(slugA, 'parent-1'), { recursive: true });
    await mkdir(slugB, { recursive: true });
    await writeFile(join(slugA, 'b.jsonl'), '', 'utf8');
    await writeFile(join(slugA, 'a.json'), '', 'utf8'); // legacy
    await writeFile(join(slugA, 'parent-1', 'child.jsonl'), '', 'utf8'); // nested subagent
    await writeFile(join(slugA, 'notes.txt'), '', 'utf8'); // excluded
    await writeFile(join(root, 'tmp', 'slug-a', 'checkpoint.json'), '', 'utf8'); // outside chats/
    await writeFile(join(root, 'projects.json'), '{"projects":{}}', 'utf8'); // outside tmp/
    await writeFile(join(slugB, 'c.jsonl'), '', 'utf8');

    const found = await createGeminiCliAdapter({ geminiDir: root }).discover();
    expect(found).toEqual(
      [join(slugA, 'a.json'), join(slugA, 'b.jsonl'), join(slugA, 'parent-1', 'child.jsonl'), join(slugB, 'c.jsonl')].sort(),
    );
    expect(found).toEqual([...found].sort());
  });

  it('honors VIBEBILL_GEMINI_DIR when no explicit dir is given', async () => {
    const root = await makeTmpDir();
    const chats = join(root, 'tmp', SLUG, 'chats');
    await mkdir(chats, { recursive: true });
    const file = join(chats, 'session-env.jsonl');
    await writeFile(file, metaLine() + '\n', 'utf8');

    const prev = process.env['VIBEBILL_GEMINI_DIR'];
    process.env['VIBEBILL_GEMINI_DIR'] = root;
    try {
      expect(await createGeminiCliAdapter().discover()).toEqual([file]);
    } finally {
      if (prev === undefined) {
        delete process.env['VIBEBILL_GEMINI_DIR'];
      } else {
        process.env['VIBEBILL_GEMINI_DIR'] = prev;
      }
    }
  });

  it('end to end: discover then parse a mixed fixture layout', async () => {
    const { chatsDir, adapter } = await makeLayout();
    await writeChat(chatsDir, 'session-e2e.jsonl', [
      metaLine(),
      userLine(),
      geminiLine({ id: 'm-1', tokens: tokensObj({ input: 11, output: 13, cached: 4, thoughts: 2 }) }),
    ]);
    const files = await adapter.discover();
    expect(files).toHaveLength(1);
    const events: UsageEvent[] = [];
    const stats = await adapter.parseFile(files[0]!, (e) => events.push(e));
    expect(events).toHaveLength(1);
    expect(events[0]!.tokens).toEqual({ input: 7, output: 15, cacheWrite: 0, cacheRead: 4 });
    expect(stats.eventsExtracted).toBe(1);
    expect(stats.linesSkipped).toBe(0);
  });
});
