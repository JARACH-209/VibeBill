/**
 * Regression: token counts in transcript records must be safe non-negative
 * integers. Fractional values used to pass validation and crash later at the
 * BigInt pricing boundary (spec §14.3.5 — malformed input must never crash);
 * negatives would corrupt conservation sums. Such lines are malformed:
 * skipped + counted, never events.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { UsageEvent } from '../core/types.js';
import { createClaudeCodeAdapter } from './claude-code/index.js';
import { createCodexAdapter } from './codex/index.js';
import { createGeminiCliAdapter } from './gemini-cli/index.js';

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'vibebill-token-bounds-'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** Parse one file through an adapter, returning events + stats. */
async function parse(
  adapter: { parseFile: (p: string, sink: (e: UsageEvent) => void) => Promise<unknown> },
  file: string,
): Promise<{ events: UsageEvent[]; stats: { linesSkipped: number; eventsExtracted: number } }> {
  const events: UsageEvent[] = [];
  const stats = (await adapter.parseFile(file, (e) => events.push(e))) as {
    linesSkipped: number;
    eventsExtracted: number;
  };
  return { events, stats };
}

const CLAUDE_LINE = (usage: string, n: number): string =>
  JSON.stringify({
    type: 'assistant',
    sessionId: 'sess-bounds',
    timestamp: `2026-01-01T00:0${n}:00.000Z`,
    cwd: '/repo',
    isSidechain: false,
    requestId: `req_${n}`,
    message: { id: `msg_${n}`, model: 'claude-opus-4-8', usage: JSON.parse(usage) },
  });

describe('claude-code token bounds', () => {
  it('rejects fractional, negative, and unsafe-magnitude counts as malformed', async () => {
    const file = path.join(dir, 'claude.jsonl');
    await writeFile(
      file,
      [
        CLAUDE_LINE('{"input_tokens":3.5,"output_tokens":1}', 1),
        CLAUDE_LINE('{"input_tokens":-5,"output_tokens":1}', 2),
        CLAUDE_LINE('{"input_tokens":1e308,"output_tokens":1}', 3),
        CLAUDE_LINE('{"input_tokens":10,"output_tokens":20}', 4),
      ].join('\n') + '\n',
      'utf8',
    );
    const { events, stats } = await parse(createClaudeCodeAdapter(), file);
    expect(stats.linesSkipped).toBe(3);
    expect(stats.eventsExtracted).toBe(1);
    expect(events).toHaveLength(1);
    expect(events[0]?.tokens).toEqual({ input: 10, output: 20, cacheWrite: 0, cacheRead: 0 });
  });
});

describe('codex token bounds', () => {
  it('rejects fractional counts in token_count events as malformed', async () => {
    const file = path.join(dir, 'codex.jsonl');
    const meta = JSON.stringify({
      timestamp: '2026-01-01T00:00:00.000Z',
      type: 'session_meta',
      payload: { id: 'sess-codex-bounds', cwd: '/repo', cli_version: '0.138.0' },
    });
    const count = (usage: string, s: number): string =>
      JSON.stringify({
        timestamp: `2026-01-01T00:00:0${s}.000Z`,
        type: 'event_msg',
        payload: { type: 'token_count', info: { last_token_usage: JSON.parse(usage) } },
      });
    await writeFile(
      file,
      [
        meta,
        count('{"input_tokens":11.5,"cached_input_tokens":0,"output_tokens":2}', 1),
        count('{"input_tokens":-3,"cached_input_tokens":0,"output_tokens":2}', 2),
        count('{"input_tokens":100,"cached_input_tokens":40,"output_tokens":7}', 3),
      ].join('\n') + '\n',
      'utf8',
    );
    const { events, stats } = await parse(createCodexAdapter({ codexDir: dir }), file);
    expect(stats.linesSkipped).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]?.tokens).toEqual({ input: 60, output: 7, cacheWrite: 0, cacheRead: 40 });
  });
});

describe('gemini-cli token bounds', () => {
  it('rejects fractional and negative counts on gemini records as malformed', async () => {
    const file = path.join(dir, 'gemini.jsonl');
    const meta = JSON.stringify({
      sessionId: 'sess-gem-bounds',
      projectHash: 'x'.repeat(64),
      startTime: '2026-01-01T00:00:00.000Z',
      kind: 'main',
    });
    const gem = (tokens: string, n: number): string =>
      JSON.stringify({
        id: `m-${n}`,
        timestamp: `2026-01-01T00:0${n}:00.000Z`,
        type: 'gemini',
        model: 'gemini-2.5-pro',
        tokens: JSON.parse(tokens),
      });
    await writeFile(
      file,
      [
        meta,
        gem('{"input":5.25,"output":1,"cached":0}', 1),
        gem('{"input":5,"output":-1,"cached":0}', 2),
        gem('{"input":50,"output":9,"cached":20,"thoughts":3}', 3),
      ].join('\n') + '\n',
      'utf8',
    );
    const { events, stats } = await parse(createGeminiCliAdapter({ geminiDir: dir }), file);
    expect(stats.linesSkipped).toBe(2);
    expect(events).toHaveLength(1);
    expect(events[0]?.tokens).toEqual({ input: 30, output: 12, cacheWrite: 0, cacheRead: 20 });
  });
});
