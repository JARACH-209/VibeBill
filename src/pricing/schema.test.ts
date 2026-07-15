import { describe, expect, it } from 'vitest';
import { parsePriceTable } from './schema.js';

function validTable(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    asOf: '2026-07-14',
    source: 'test',
    models: {
      'claude-opus-4-8': {
        displayName: 'claude-opus-4-8',
        inputPerMTok: '5',
        outputPerMTok: '25',
        cacheWritePerMTok: '6.25',
        cacheReadPerMTok: '0.5',
      },
    },
  };
}

describe('parsePriceTable', () => {
  it('accepts a valid table with no warnings', () => {
    const { table, warnings } = parsePriceTable(validTable(), 'test');
    expect(warnings).toEqual([]);
    expect(table.schemaVersion).toBe(1);
    expect(table.models['claude-opus-4-8']?.cacheReadPerMTok).toBe('0.5');
  });

  it('tolerates unknown keys with a warning per key', () => {
    const raw = validTable();
    raw['futureField'] = true;
    (raw['models'] as Record<string, Record<string, unknown>>)['claude-opus-4-8']![
      'contextWindow'
    ] = 200000;
    const { table, warnings } = parsePriceTable(raw, 'test');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('futureField');
    expect(warnings[1]).toContain('contextWindow');
    // unknown keys are stripped from the returned table
    expect('futureField' in table).toBe(false);
    expect('contextWindow' in table.models['claude-opus-4-8']!).toBe(false);
  });

  it('rejects bad price strings', () => {
    for (const bad of ['abc', '-5', '1e-5', '1.2.3', '1,5', '', '.5', '1.']) {
      const raw = validTable();
      (raw['models'] as Record<string, Record<string, unknown>>)['claude-opus-4-8']![
        'inputPerMTok'
      ] = bad;
      expect(() => parsePriceTable(raw, 'test'), bad).toThrow();
    }
  });

  it('rejects prices with more than 9 fractional digits', () => {
    const raw = validTable();
    (raw['models'] as Record<string, Record<string, unknown>>)['claude-opus-4-8']![
      'outputPerMTok'
    ] = '1.0000000001';
    expect(() => parsePriceTable(raw, 'test')).toThrow(/fractional digits|invalid price table/);
  });

  it('rejects wrong schemaVersion, missing fields, empty model ids, and non-objects', () => {
    const wrongVersion = { ...validTable(), schemaVersion: 2 };
    expect(() => parsePriceTable(wrongVersion, 'test')).toThrow();

    const noAsOf = validTable();
    delete noAsOf['asOf'];
    expect(() => parsePriceTable(noAsOf, 'test')).toThrow();

    const emptyId = validTable();
    (emptyId['models'] as Record<string, unknown>)[''] = {
      displayName: 'x',
      inputPerMTok: '1',
      outputPerMTok: '2',
    };
    expect(() => parsePriceTable(emptyId, 'test')).toThrow();

    expect(() => parsePriceTable(null, 'test')).toThrow();
    expect(() => parsePriceTable('{}', 'test')).toThrow();
  });

  it('rejects numeric prices (must be decimal strings)', () => {
    const raw = validTable();
    (raw['models'] as Record<string, Record<string, unknown>>)['claude-opus-4-8']![
      'inputPerMTok'
    ] = 5;
    expect(() => parsePriceTable(raw, 'test')).toThrow();
  });
});
