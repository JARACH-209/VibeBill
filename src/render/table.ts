/**
 * Terminal table renderer + color switch (spec §6, §6.3, §7.14).
 *
 * Width math is ANSI-aware: SGR escape sequences (`\x1b[...m`) are stripped
 * before measuring, so colored cells align identically to plain ones.
 *
 * KNOWN LIMITATION (documented, spec §6): visible width is counted in Unicode
 * code points, each treated as width 1. The confidence markers ● ◐ ○ therefore
 * measure 1 (correct in practically all monospace terminal fonts), but
 * East-Asian wide characters and emoji — which most terminals render 2 cells
 * wide — will misalign. vibebill never emits such characters itself.
 */

import picocolors from 'picocolors';

/** SGR color/style sequences only — the only escapes vibebill ever emits. */
const ANSI_SGR_RE = /\x1b\[[0-9;]*m/g;

/** Remove ANSI SGR (`\x1b[...m`) sequences so the visible text remains. */
export function stripAnsi(s: string): string {
  return s.replace(ANSI_SGR_RE, '');
}

/** Visible terminal width of a string: code points after stripping ANSI SGR codes. */
export function visibleWidth(s: string): number {
  // Spread iterates code points, so surrogate pairs count once.
  return [...stripAnsi(s)].length;
}

export interface ColumnSpec {
  header: string;
  /** Default 'left'. Money and count columns should be 'right'. */
  align?: 'left' | 'right';
  /** Floor for the computed column width. */
  minWidth?: number;
}

const COLUMN_GAP = '  '; // two-space gap between columns (contract)

function padCell(cell: string, width: number, align: 'left' | 'right'): string {
  const pad = width - visibleWidth(cell);
  if (pad <= 0) return cell;
  return align === 'right' ? ' '.repeat(pad) + cell : cell + ' '.repeat(pad);
}

/**
 * Render an aligned plain-text table (header row + dash separator + data rows),
 * ANSI-safe width computation, two-space column gaps, no trailing whitespace,
 * deterministic; returns lines joined by '\n' without a trailing newline.
 *
 * Rows shorter than `cols` are padded with empty cells; extra cells are ignored.
 * Zero columns renders to the empty string.
 */
export function renderTable(cols: ColumnSpec[], rows: string[][]): string {
  if (cols.length === 0) return '';

  const widths = cols.map((col, i) => {
    let w = Math.max(visibleWidth(col.header), col.minWidth ?? 0);
    for (const row of rows) w = Math.max(w, visibleWidth(row[i] ?? ''));
    return w;
  });
  const aligns = cols.map((col) => col.align ?? 'left');

  const renderRow = (cells: string[]): string =>
    cells
      .map((cell, i) => padCell(cell, widths[i] ?? 0, aligns[i] ?? 'left'))
      .join(COLUMN_GAP)
      .replace(/ +$/, '');

  const lines: string[] = [
    renderRow(cols.map((col) => col.header)),
    widths.map((w) => '-'.repeat(w)).join(COLUMN_GAP),
  ];
  for (const row of rows) {
    lines.push(renderRow(cols.map((_, i) => row[i] ?? '')));
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Color switch (spec §7.14). picocolors' own detection handles NO_COLOR /
// non-TTY for the INITIAL state; `--no-color` calls setColorEnabled(false).
// ---------------------------------------------------------------------------

/** Always-on formatters; gating below is vibebill's single source of truth. */
const forcedColors = picocolors.createColors(true);

let colorEnabled = picocolors.isColorSupported;

/** Enable or disable all `c.*` colorizers globally (used by --no-color). */
export function setColorEnabled(enabled: boolean): void {
  colorEnabled = enabled;
}

/** Whether `c.*` currently emit ANSI codes (initially picocolors' own detection). */
export function isColorEnabled(): boolean {
  return colorEnabled;
}

export type ColorFn = (s: string) => string;

function gated(format: (input: string | number | null | undefined) => string): ColorFn {
  return (s: string) => (colorEnabled ? format(s) : s);
}

/** Color wrappers that become identity functions when color is disabled. */
export const c: {
  red: ColorFn;
  green: ColorFn;
  yellow: ColorFn;
  dim: ColorFn;
  bold: ColorFn;
  cyan: ColorFn;
} = {
  red: gated(forcedColors.red),
  green: gated(forcedColors.green),
  yellow: gated(forcedColors.yellow),
  dim: gated(forcedColors.dim),
  bold: gated(forcedColors.bold),
  cyan: gated(forcedColors.cyan),
};
