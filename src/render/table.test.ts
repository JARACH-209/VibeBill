import { afterAll, beforeEach, describe, expect, it } from 'vitest';

import {
  c,
  isColorEnabled,
  renderTable,
  setColorEnabled,
  stripAnsi,
  visibleWidth,
  type ColumnSpec,
} from './table.js';

const initialColorEnabled = isColorEnabled();

afterAll(() => {
  setColorEnabled(initialColorEnabled);
});

/** Every rendered line must be free of trailing whitespace (contract). */
function expectNoTrailingWhitespace(rendered: string): void {
  for (const line of rendered.split('\n')) {
    expect(line).not.toMatch(/\s$/);
  }
}

describe('stripAnsi / visibleWidth', () => {
  it('strips SGR sequences and measures only visible characters', () => {
    expect(stripAnsi('\x1b[31mred\x1b[39m')).toBe('red');
    expect(visibleWidth('\x1b[1m\x1b[32m$1,234.56\x1b[39m\x1b[22m')).toBe(9);
    expect(visibleWidth('plain')).toBe(5);
    expect(visibleWidth('')).toBe(0);
  });

  it('treats the confidence markers as width 1 (documented limitation: all code points count as 1)', () => {
    expect(visibleWidth('●')).toBe(1);
    expect(visibleWidth('◐')).toBe(1);
    expect(visibleWidth('○')).toBe(1);
  });
});

describe('renderTable', () => {
  const cols: ColumnSpec[] = [
    { header: 'cost', align: 'right' },
    { header: 'hash' },
    { header: 'subject' },
  ];
  const rows = [
    ['$1,234.56', 'a1b2c3d', 'feat: x'],
    ['$0.02', 'deadbee', 'fix'],
  ];

  it('aligns columns with header, dash separator, two-space gaps, no trailing whitespace', () => {
    const out = renderTable(cols, rows);
    expect(out).toBe(
      [
        '     cost  hash     subject',
        '---------  -------  -------',
        '$1,234.56  a1b2c3d  feat: x',
        '    $0.02  deadbee  fix',
      ].join('\n'),
    );
    expectNoTrailingWhitespace(out);
  });

  it('right-aligns money columns so the cents line up', () => {
    const out = renderTable(
      [{ header: 'cost', align: 'right' }],
      [['$1,234.56'], ['$0.02'], ['$—']],
    );
    const lines = out.split('\n');
    // Every value ends at the same right edge.
    expect(lines[2]).toBe('$1,234.56');
    expect(lines[3]).toBe('    $0.02');
    expect(lines[4]).toBe('       $—');
  });

  it('produces identical layout for ANSI-colored and plain cells', () => {
    const coloredRows = rows.map(([cost, hash, subject]) => [
      `\x1b[32m${cost}\x1b[39m`,
      `\x1b[2m${hash}\x1b[22m`,
      subject ?? '',
    ]);
    const colored = renderTable(cols, coloredRows);
    expect(stripAnsi(colored)).toBe(renderTable(cols, rows));
    // Trailing-whitespace rule holds even when escapes are embedded.
    for (const line of colored.split('\n')) {
      expect(stripAnsi(line)).not.toMatch(/\s$/);
    }
  });

  it('renders header and separator only for empty rows', () => {
    const out = renderTable(cols, []);
    expect(out.split('\n')).toEqual(['cost  hash  subject', '----  ----  -------']);
    expectNoTrailingWhitespace(out);
  });

  it('renders the empty string for zero columns', () => {
    expect(renderTable([], [['ignored']])).toBe('');
  });

  it('pads short rows with empty cells and ignores extra cells', () => {
    const out = renderTable(cols, [['$5.00'], ['$6.00', 'abcd123', 'subj', 'EXTRA']]);
    expect(out).toBe(
      [' cost  hash     subject', '-----  -------  -------', '$5.00', '$6.00  abcd123  subj'].join(
        '\n',
      ),
    );
    expect(out).not.toContain('EXTRA');
  });

  it('honors minWidth as a floor for the computed width', () => {
    const out = renderTable([{ header: 'id', minWidth: 6 }, { header: 'x' }], [['a', 'b']]);
    expect(out.split('\n')).toEqual(['id      x', '------  -', 'a       b']);
  });

  it('aligns unicode confidence markers as single-width cells', () => {
    const out = renderTable(
      [{ header: 'conf' }, { header: 'hash' }],
      [
        ['●', 'a1b2c3d'],
        ['◐', '9f8e7d6'],
        ['○', '5c4b3a2'],
      ],
    );
    expect(out.split('\n')).toEqual([
      'conf  hash',
      '----  -------',
      '●     a1b2c3d',
      '◐     9f8e7d6',
      '○     5c4b3a2',
    ]);
  });

  it('is deterministic: identical inputs render byte-identical output', () => {
    expect(renderTable(cols, rows)).toBe(renderTable(cols, rows));
  });

  it('renders representative vibebill log rows within 100 columns (spec §6.3)', () => {
    const logCols: ColumnSpec[] = [
      { header: 'cost', align: 'right' },
      { header: 'conf' },
      { header: 'hash' },
      { header: 'date' },
      { header: 'subject' },
      { header: 'models' },
      { header: 'sessions', align: 'right' },
    ];
    const logRows = [
      ['$3.41', '○', '—', '—', 'in progress (uncommitted)', 'claude-opus-4-8', '1'],
      ['$104.52', '●', 'a1b2c3d', '2026-07-12', 'feat: attribution engine', 'claude-opus-4-8', '3'],
      [
        '$12.07',
        '◐',
        '9f8e7d6',
        '2026-07-11',
        'fix: dedupe retried usage lines',
        'opus-4-8, sonnet-4-6',
        '1',
      ],
      ['$0.00', '○', '5c4b3a2', '2026-07-10', 'docs: limitations ·human?', '—', '0'],
    ];

    for (const rendered of [
      renderTable(logCols, logRows),
      // Colored variant must obey the same width budget.
      renderTable(
        logCols,
        logRows.map((r) => r.map((cell, i) => (i === 0 ? `\x1b[32m${cell}\x1b[39m` : cell))),
      ),
    ]) {
      const lines = rendered.split('\n');
      expect(lines.length).toBe(2 + logRows.length);
      for (const line of lines) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(100);
      }
      const stripped = stripAnsi(rendered);
      expect(stripped).toContain('$104.52  ●     a1b2c3d'); // conf col width = header "conf" (4)
      expect(stripped).toContain('in progress (uncommitted)');
    }
  });
});

describe('color switch', () => {
  beforeEach(() => {
    setColorEnabled(false);
  });

  it('setColorEnabled/isColorEnabled round-trip', () => {
    expect(isColorEnabled()).toBe(false);
    setColorEnabled(true);
    expect(isColorEnabled()).toBe(true);
    setColorEnabled(false);
    expect(isColorEnabled()).toBe(false);
  });

  it('c.* are identity functions when disabled (NO_COLOR-style: pure ASCII out)', () => {
    for (const fn of [c.red, c.green, c.yellow, c.dim, c.bold, c.cyan]) {
      expect(fn('$1,234.56')).toBe('$1,234.56');
    }
    const out = renderTable(
      [{ header: 'cost', align: 'right' }, { header: 'subject' }],
      [[c.green('$9.99'), c.dim('fix: things')]],
    );
    expect(out).not.toContain('\x1b');
    expect(out).toMatch(/^[\x20-\x7e\n]+$/); // printable ASCII + newlines only
  });

  it('c.* emit SGR sequences when enabled, and the table still aligns', () => {
    setColorEnabled(true);
    const red = c.red('err');
    expect(red).toContain('\x1b[');
    expect(stripAnsi(red)).toBe('err');
    expect(stripAnsi(c.bold(c.cyan('deep')))).toBe('deep');

    const colored = renderTable(
      [{ header: 'cost', align: 'right' }, { header: 'subject' }],
      [
        [c.green('$1,234.56'), 'feat: x'],
        [c.red('$0.02'), 'fix'],
      ],
    );
    setColorEnabled(false);
    const plain = renderTable(
      [{ header: 'cost', align: 'right' }, { header: 'subject' }],
      [
        ['$1,234.56', 'feat: x'],
        ['$0.02', 'fix'],
      ],
    );
    expect(stripAnsi(colored)).toBe(plain);
  });
});
