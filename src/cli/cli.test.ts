/**
 * CLI plumbing tests: flag parsing, exit-code mapping, JSON envelope shape,
 * and the notes payload. Full end-to-end behavior lives in test/scenarios/.
 */

import { describe, expect, it } from 'vitest';

import type { LedgerEntry, UsageEvent } from '../core/types.js';
import { notePayload } from './commands/notes.js';
import { buildProgram } from './index.js';
import { captureIO } from './io.js';

function fakeEvent(overrides: Partial<UsageEvent> = {}): UsageEvent {
  return {
    id: 'e1',
    agent: 'claude-code',
    sessionId: 's1',
    ts: 1_700_000_000_000,
    model: 'claude-fable-5',
    tokens: { input: 10, output: 20, cacheWrite: 5, cacheRead: 100 },
    cwd: '/repo',
    gitBranch: null,
    editedFiles: [],
    isSidechain: false,
    sourceFile: '/t.jsonl',
    ...overrides,
  };
}

describe('notePayload', () => {
  it('emits the spec §6.8 JSON shape with fixed key order (idempotence)', () => {
    const entry: LedgerEntry = {
      event: fakeEvent(),
      attribution: { kind: 'commit', hash: 'abc', confidence: 'high' },
      cost: { input: 1n, output: 2n, cacheWrite: 3n, cacheRead: 4n, total: 10n },
      provenance: 'measured',
    };
    const a = notePayload([entry]);
    const b = notePayload([entry]);
    expect(a).toBe(b);
    const parsed = JSON.parse(a) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual([
      'v',
      'costNanoUsd',
      'tokens',
      'confidence',
      'provenance',
      'generatedBy',
    ]);
    expect(parsed['v']).toBe(1);
    expect(parsed['costNanoUsd']).toBe('10');
    expect(parsed['tokens']).toEqual({
      input: 10,
      output: 20,
      cacheWrite: 5,
      cacheRead: 100,
      total: 135,
    });
    expect(parsed['confidence']).toBe('high');
    expect(parsed['provenance']).toBe('measured');
    expect(String(parsed['generatedBy'])).toMatch(/^vibebill@\d/);
  });

  it('labels a commit advisory when any contribution is advisory', () => {
    const measured: LedgerEntry = {
      event: fakeEvent({ id: 'e1' }),
      attribution: { kind: 'commit', hash: 'abc', confidence: 'high' },
      cost: null,
      provenance: 'measured',
    };
    const advisory: LedgerEntry = {
      event: fakeEvent({ id: 'e2' }),
      attribution: { kind: 'commit', hash: 'abc', confidence: 'low' },
      cost: null,
      provenance: 'advisory',
    };
    const parsed = JSON.parse(notePayload([measured, advisory])) as { provenance: string };
    expect(parsed.provenance).toBe('advisory');
  });
});

describe('program wiring', () => {
  it('declares every spec §6 command', () => {
    const program = buildProgram(captureIO());
    const names = program.commands.map((c) => c.name()).sort();
    expect(names).toEqual([
      'doctor',
      'log',
      'notes',
      'pr',
      'range',
      'report',
      'reprice',
      'show',
      'summary',
    ]);
  });

  it('rejects an unknown --plan with a user error (exit 1)', async () => {
    const io = captureIO();
    const program = buildProgram(io).exitOverride();
    process.exitCode = 0;
    await program.parseAsync(['node', 'vibebill', 'doctor', '--plan', 'enterprise']);
    expect(process.exitCode).toBe(1);
    expect(io.stderr.join('\n')).toContain('unknown --plan');
    process.exitCode = 0;
  });

  it('exposes --version from package.json', () => {
    const program = buildProgram(captureIO());
    expect(program.version()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
