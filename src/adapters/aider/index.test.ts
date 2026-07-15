/**
 * Tests for the aider adapter. Fixtures are inline sanitized strings that
 * mirror the docs/contracts.md aider history structure, with all chat content
 * replaced by "[sanitized]" placeholders.
 */
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { FileParseStats, UsageEvent } from '../../core/types.js';
import { AIDER_PRECISION_NOTE, AIDER_SCHEMA_VERIFIED, createAiderAdapter } from './index.js';
import { MAX_LINE_BYTES, parseSessionHeaderTs, parseTokenCount } from './parser.js';

const ENV_KEY = 'VIBEBILL_AIDER_HISTORY';

// Session-start timestamps are machine-LOCAL (contracts.md), so expectations
// are computed with the same local-Date semantics — deterministic in any TZ.
const T1 = new Date(2026, 6, 10, 9, 0, 0).getTime(); // 2026-07-10 09:00:00
const T2 = new Date(2026, 6, 11, 14, 30, 5).getTime(); // 2026-07-11 14:30:05

let tempDirs: string[] = [];
let savedEnv: string | undefined;

beforeEach(() => {
  savedEnv = process.env[ENV_KEY];
  delete process.env[ENV_KEY];
});

afterEach(async () => {
  if (savedEnv === undefined) {
    delete process.env[ENV_KEY];
  } else {
    process.env[ENV_KEY] = savedEnv;
  }
  for (const dir of tempDirs) {
    await rm(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibebill-aider-'));
  tempDirs.push(dir);
  return dir;
}

async function repoWithHistory(content: string): Promise<{ repoRoot: string; file: string; adapter: ReturnType<typeof createAiderAdapter> }> {
  const repoRoot = await tempDir();
  const file = join(repoRoot, '.aider.chat.history.md');
  await writeFile(file, content, 'utf8');
  return { repoRoot, file, adapter: createAiderAdapter({ repoRoot }) };
}

async function collect(
  adapter: ReturnType<typeof createAiderAdapter>,
  file: string,
  opts?: { startOffset?: number },
): Promise<{ events: UsageEvent[]; stats: FileParseStats }> {
  const events: UsageEvent[] = [];
  const stats = await adapter.parseFile(file, (e) => events.push(e), opts);
  return { events, stats };
}

// ---------------------------------------------------------------------------
// fixtures (structure per contracts.md "aider" section; content sanitized)
// ---------------------------------------------------------------------------

const MAIN_FIXTURE = [
  '# aider chat started at 2026-07-10 09:00:00',
  '',
  '> Aider v0.86.0',
  '> Main model: anthropic/claude-sonnet-4-5 with diff edit format',
  '> Weak model: anthropic/claude-haiku-4-5 with whole edit format',
  '',
  '#### [sanitized]',
  '',
  '[sanitized]',
  '',
  '> Tokens: 4.2k sent, 999 received. Cost: $0.02 message, $0.02 session.',
  '> Applied edit to src/foo.ts',
  '',
  '#### [sanitized]',
  '',
  '> Model: openai/gpt-5.2-codex with diff edit format',
  '',
  '> Tokens: 12k sent, 3.1k cache write, 8.5k cache hit, 1.5k received.',
  'Cost: $0.04 message, $0.06 session.',
  '> Applied edit to src/bar.ts',
  '> Applied edit to docs/notes.md',
  '> Applied edit to src/bar.ts',
  '',
  '# aider chat started at 2026-07-11 14:30:05',
  '',
  '> Applied edit to pre/attach.ts',
  '',
  'Tokens: 999 sent, 42 received.',
  '',
  '> Applied edit to post/attach.ts',
  '',
].join('\n');

describe('constants', () => {
  it('exports schemaVerified=false and a precision note for doctor', () => {
    expect(AIDER_SCHEMA_VERIFIED).toBe(false);
    expect(AIDER_PRECISION_NOTE).toMatch(/two significant figures/);
  });
});

describe('parseTokenCount', () => {
  it('parses plain and k-notation counts exactly', () => {
    expect(parseTokenCount('999')).toBe(999);
    expect(parseTokenCount('0')).toBe(0);
    expect(parseTokenCount('4.2k')).toBe(4200);
    expect(parseTokenCount('12k')).toBe(12000);
    expect(parseTokenCount('1.25k')).toBe(1250);
  });
  it('rejects non-counts', () => {
    expect(parseTokenCount('4.2')).toBeNull(); // decimal without k is not a count
    expect(parseTokenCount('k')).toBeNull();
    expect(parseTokenCount('')).toBeNull();
    expect(parseTokenCount('4,200')).toBeNull();
  });
});

describe('parseSessionHeaderTs', () => {
  it('parses the header as machine-local time', () => {
    expect(parseSessionHeaderTs('# aider chat started at 2026-07-10 09:00:00')).toBe(T1);
  });
  it('rejects out-of-range and rollover dates', () => {
    expect(parseSessionHeaderTs('# aider chat started at 2026-13-01 09:00:00')).toBeNull();
    expect(parseSessionHeaderTs('# aider chat started at 2026-02-30 09:00:00')).toBeNull();
    expect(parseSessionHeaderTs('# aider chat started at 2026-07-10 09:00')).toBeNull();
  });
});

describe('discover', () => {
  it('returns [] when the repo has no history file', async () => {
    const repoRoot = await tempDir();
    const adapter = createAiderAdapter({ repoRoot });
    expect(await adapter.discover()).toEqual([]);
  });

  it('returns the repo history file when present', async () => {
    const { file, adapter } = await repoWithHistory(MAIN_FIXTURE);
    expect(await adapter.discover()).toEqual([resolve(file)]);
  });

  it('additively includes an existing VIBEBILL_AIDER_HISTORY file, deduped and sorted', async () => {
    const { file, repoRoot } = await repoWithHistory(MAIN_FIXTURE);
    const elsewhere = await tempDir();
    const extra = join(elsewhere, 'history.md');
    await writeFile(extra, MAIN_FIXTURE, 'utf8');

    process.env[ENV_KEY] = extra;
    const adapter = createAiderAdapter({ repoRoot });
    expect(await adapter.discover()).toEqual([resolve(extra), resolve(file)].sort());

    process.env[ENV_KEY] = file; // env pointing at the default file: listed once
    expect(await createAiderAdapter({ repoRoot }).discover()).toEqual([resolve(file)]);
  });

  it('ignores a VIBEBILL_AIDER_HISTORY path that does not exist', async () => {
    const { file, repoRoot } = await repoWithHistory(MAIN_FIXTURE);
    process.env[ENV_KEY] = join(repoRoot, 'nope', 'missing.md');
    const adapter = createAiderAdapter({ repoRoot });
    expect(await adapter.discover()).toEqual([resolve(file)]);
  });
});

describe('parseFile', () => {
  it('parses the multi-session fixture: sessions, model switches, usage variants, edits', async () => {
    const { repoRoot, file, adapter } = await repoWithHistory(MAIN_FIXTURE);
    const { events, stats } = await collect(adapter, file);

    expect(adapter.id).toBe('aider');
    expect(adapter.schemaVerified).toBe(false);
    expect(events).toHaveLength(3);
    expect(stats).toEqual({
      path: file,
      linesRead: 19, // non-empty lines only
      eventsExtracted: 3,
      linesSkipped: 0,
      bytesConsumed: Buffer.byteLength(MAIN_FIXTURE),
    });

    const s1 = `aider:${T1}:0`;
    const s2 = `aider:${T2}:1`;

    // Event 1: plain usage with same-line Cost clause (ignored); edit attaches after.
    expect(events[0]).toEqual({
      id: `${s1}:0`,
      agent: 'aider',
      sessionId: s1,
      ts: T1,
      model: 'anthropic/claude-sonnet-4-5', // "Weak model" line did not overwrite it
      tokens: { input: 4200, output: 999, cacheWrite: 0, cacheRead: 0 },
      cwd: repoRoot,
      gitBranch: null,
      editedFiles: [resolve(repoRoot, 'src/foo.ts')],
      isSidechain: false,
      sourceFile: file,
    });

    // Event 2: mid-session model switch; cache write + hit; Cost on next line
    // (unprefixed) ignored; duplicate Applied-edit collapses; input clamps to
    // sent − cacheWrite − cacheRead.
    expect(events[1]).toEqual({
      id: `${s1}:1`,
      agent: 'aider',
      sessionId: s1,
      ts: T1,
      model: 'openai/gpt-5.2-codex',
      tokens: { input: 400, output: 1500, cacheWrite: 3100, cacheRead: 8500 },
      cwd: repoRoot,
      gitBranch: null,
      editedFiles: [resolve(repoRoot, 'src/bar.ts'), resolve(repoRoot, 'docs/notes.md')],
      isSidechain: false,
      sourceFile: file,
    });

    // Event 3: unprefixed usage line, no Cost; pre-usage edit attaches to the
    // session's FIRST usage event, post-usage edit to the same (previous) one.
    // Model carries over: "latest model line in the file" (contracts.md).
    expect(events[2]).toEqual({
      id: `${s2}:0`,
      agent: 'aider',
      sessionId: s2,
      ts: T2,
      model: 'openai/gpt-5.2-codex',
      tokens: { input: 999, output: 42, cacheWrite: 0, cacheRead: 0 },
      cwd: repoRoot,
      gitBranch: null,
      editedFiles: [resolve(repoRoot, 'pre/attach.ts'), resolve(repoRoot, 'post/attach.ts')],
      isSidechain: false,
      sourceFile: file,
    });
  });

  it('handles token-count variants and clamps input at zero', async () => {
    const fixture = [
      '# aider chat started at 2026-07-10 09:00:00',
      '> Tokens: 100 sent, 200 cache hit, 50 received.',
      '> Tokens: 5.0k sent, 1.2k cache write, 100 received.',
      '> Tokens: 0 sent, 0 received.',
      '',
    ].join('\n');
    const { file, adapter } = await repoWithHistory(fixture);
    const { events, stats } = await collect(adapter, file);
    expect(stats.linesSkipped).toBe(0);
    expect(events.map((e) => e.tokens)).toEqual([
      { input: 0, output: 50, cacheWrite: 0, cacheRead: 200 }, // 100 − 200 clamped
      { input: 3800, output: 100, cacheWrite: 1200, cacheRead: 0 },
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    ]);
  });

  it('emits model "" (unpriced) when no model line was seen', async () => {
    const fixture = [
      '# aider chat started at 2026-07-10 09:00:00',
      'Tokens: 999 sent, 42 received.',
      '',
    ].join('\n');
    const { file, adapter } = await repoWithHistory(fixture);
    const { events } = await collect(adapter, file);
    expect(events).toHaveLength(1);
    expect(events[0]?.model).toBe('');
  });

  it('disambiguates identical session start times via the file ordinal', async () => {
    const fixture = [
      '# aider chat started at 2026-07-10 09:00:00',
      '> Tokens: 1 sent, 2 received.',
      '# aider chat started at 2026-07-10 09:00:00',
      '> Tokens: 3 sent, 4 received.',
      '',
    ].join('\n');
    const { file, adapter } = await repoWithHistory(fixture);
    const { events } = await collect(adapter, file);
    expect(events.map((e) => e.sessionId)).toEqual([`aider:${T1}:0`, `aider:${T1}:1`]);
    expect(events.map((e) => e.id)).toEqual([`aider:${T1}:0:0`, `aider:${T1}:1:0`]);
  });

  it('flushes the buffered event deterministically: order and editedFiles are stable', async () => {
    // Edits between two usage lines attach to the FIRST (previous) event and
    // never leak into the second; the trailing event flushes at EOF.
    const fixture = [
      '# aider chat started at 2026-07-10 09:00:00',
      '> Tokens: 10 sent, 1 received.',
      '> Applied edit to a.ts',
      '> Tokens: 20 sent, 2 received.',
      '',
    ].join('\n');
    const { repoRoot, file, adapter } = await repoWithHistory(fixture);
    const { events } = await collect(adapter, file);
    expect(events.map((e) => e.id)).toEqual([`aider:${T1}:0:0`, `aider:${T1}:0:1`]);
    expect(events[0]?.editedFiles).toEqual([resolve(repoRoot, 'a.ts')]);
    expect(events[1]?.editedFiles).toEqual([]);
  });

  it('counts malformed lines without throwing', async () => {
    const fixture = [
      '> Tokens: 999 sent, 42 received.', // usage before any session header
      '# aider chat started at 2026-13-01 09:00:00', // month 13
      '# aider chat started at 2026-07-10 09:00:00',
      '> Tokens: nope sent, 12 received.', // usage-shaped, numbers unparseable
      '> Tokens: 4.2 sent, 12 received.', // bare decimal is not a token count
      '> Tokens: 999 sent, 42 received.', // good
      '',
    ].join('\n');
    const { file, adapter } = await repoWithHistory(fixture);
    const { events, stats } = await collect(adapter, file);
    expect(events.map((e) => e.id)).toEqual([`aider:${T1}:0:0`]);
    expect(stats.linesRead).toBe(6);
    expect(stats.linesSkipped).toBe(4);
    expect(stats.eventsExtracted).toBe(1);
  });

  it('skips oversized lines cheaply and keeps parsing', async () => {
    const fixture =
      '# aider chat started at 2026-07-10 09:00:00\n' +
      '> Tokens: 999 sent, 42 received.\n' +
      'x'.repeat(MAX_LINE_BYTES + 5) +
      '\n' +
      '> Tokens: 12k sent, 7 received.\n';
    const { file, adapter } = await repoWithHistory(fixture);
    const { events, stats } = await collect(adapter, file);
    expect(events).toHaveLength(2);
    expect(events[1]?.tokens).toEqual({ input: 12000, output: 7, cacheWrite: 0, cacheRead: 0 });
    expect(stats.linesRead).toBe(4);
    expect(stats.linesSkipped).toBe(1);
    expect(stats.bytesConsumed).toBe(Buffer.byteLength(fixture));
  });

  it('skips a truncated final line and does not consume it', async () => {
    const complete =
      '# aider chat started at 2026-07-10 09:00:00\n> Tokens: 999 sent, 42 received.\n';
    const { file, adapter } = await repoWithHistory(complete + '> Tokens: 12k sent');
    const { events, stats } = await collect(adapter, file);
    expect(events).toHaveLength(1); // the buffered event still flushes at EOF
    expect(stats.linesRead).toBe(3);
    expect(stats.linesSkipped).toBe(1);
    expect(stats.bytesConsumed).toBe(Buffer.byteLength(complete));
  });

  it('startOffset resume is equivalent to a full parse (stateful format re-parses from 0)', async () => {
    const part1 = [
      '# aider chat started at 2026-07-10 09:00:00',
      '> Main model: anthropic/claude-sonnet-4-5 with diff edit format',
      '> Tokens: 4.2k sent, 999 received.',
      '',
    ].join('\n');
    const part2 = ['> Applied edit to src/foo.ts', '> Tokens: 12k sent, 1.0k received.', ''].join(
      '\n',
    );

    const { repoRoot, file, adapter } = await repoWithHistory(part1);
    const first = await collect(adapter, file);
    expect(first.stats.bytesConsumed).toBe(Buffer.byteLength(part1));
    expect(first.events[0]?.editedFiles).toEqual([]); // edit not yet written

    await appendFile(file, part2, 'utf8');
    const full = await collect(adapter, file);
    const resumed = await collect(adapter, file, { startOffset: first.stats.bytesConsumed });

    expect(resumed.events).toEqual(full.events);
    expect(resumed.stats).toEqual(full.stats);
    // The re-parse (same stable id, last-wins dedupe upstream) now carries the
    // late-appended edit on the first event.
    expect(full.events[0]?.id).toBe(first.events[0]?.id);
    expect(full.events[0]?.editedFiles).toEqual([resolve(repoRoot, 'src/foo.ts')]);
    expect(full.events).toHaveLength(2);
  });

  it('is deterministic: parsing the same file twice is deep-equal', async () => {
    const { file, adapter } = await repoWithHistory(MAIN_FIXTURE);
    const a = await collect(adapter, file);
    const b = await collect(adapter, file);
    expect(a.events).toEqual(b.events);
    expect(a.stats).toEqual(b.stats);
  });
});
