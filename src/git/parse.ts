/**
 * Pure parsing helpers for `git log` output (no I/O). The log invocation uses
 * `%x1e`-delimited records with `%x1f`-separated fields so that subjects
 * containing spaces/tabs can never confuse the parser (spec §5.3).
 */

import type { CommitInfo } from '../core/types.js';

/** ASCII record separator: marks the start of each commit record in the pretty format. */
export const RECORD_SEP = '\x1e';
/** ASCII unit separator: separates fields inside one commit header line. */
export const FIELD_SEP = '\x1f';

/** Pretty format for HEAD/range mode: hash, parents, strict-ISO author date, subject. */
export const LOG_FORMAT = '%x1e%H%x1f%P%x1f%aI%x1f%s';
/** Pretty format for --all --source mode: adds %S (the ref by which the commit was reached). */
export const LOG_FORMAT_WITH_SOURCE = '%x1e%H%x1f%P%x1f%aI%x1f%s%x1f%S';

/**
 * Convert a %S source ref to a branch hint: refs/heads/x → "x"; anything else
 * (HEAD, tags, remotes) → null — only local branch names can ever match an
 * event's recorded gitBranch, and "unknown" scores fairer than "mismatch".
 */
export function branchHintFromSource(source: string): string | null {
  return source.startsWith('refs/heads/') ? source.slice('refs/heads/'.length) : null;
}

/**
 * Decode a git C-style quoted path ("a\"b\303\244.txt") to its literal form; passthrough
 * when unquoted. We run log with core.quotepath=false so this only fires for paths
 * containing quotes, backslashes, or control characters.
 */
export function unquoteGitPath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw;
  const inner = raw.slice(1, -1);
  const bytes: number[] = [];
  for (let i = 0; i < inner.length; i += 1) {
    const ch = inner[i] as string;
    if (ch !== '\\') {
      for (const b of Buffer.from(ch, 'utf8')) bytes.push(b);
      continue;
    }
    i += 1;
    const esc = inner[i];
    if (esc === undefined) break;
    switch (esc) {
      case 'a':
        bytes.push(7);
        break;
      case 'b':
        bytes.push(8);
        break;
      case 'f':
        bytes.push(12);
        break;
      case 'n':
        bytes.push(10);
        break;
      case 'r':
        bytes.push(13);
        break;
      case 't':
        bytes.push(9);
        break;
      case 'v':
        bytes.push(11);
        break;
      case '\\':
        bytes.push(92);
        break;
      case '"':
        bytes.push(34);
        break;
      default: {
        if (esc >= '0' && esc <= '7') {
          let oct = esc;
          while (oct.length < 3) {
            const next = inner[i + 1];
            if (next === undefined || next < '0' || next > '7') break;
            oct += next;
            i += 1;
          }
          bytes.push(Number.parseInt(oct, 8) & 0xff);
        } else {
          for (const b of Buffer.from(esc, 'utf8')) bytes.push(b);
        }
      }
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * Collapse a numstat rename path to the NEW path: handles "old => new",
 * "pre/{old => new}/post" and "{old => new}" forms (spec §7.11).
 */
export function collapseRenamePath(p: string): string {
  const open = p.indexOf('{');
  if (open !== -1) {
    const close = p.indexOf('}', open);
    if (close !== -1) {
      const inner = p.slice(open + 1, close);
      const arrow = inner.indexOf(' => ');
      if (arrow !== -1) {
        const newPart = inner.slice(arrow + 4);
        // "src/{old => }/x" collapses to "src//x"; squeeze duplicate slashes.
        return (p.slice(0, open) + newPart + p.slice(close + 1)).replace(/\/{2,}/g, '/');
      }
    }
  }
  const arrow = p.indexOf(' => ');
  if (arrow !== -1) return p.slice(arrow + 4);
  return p;
}

const NUMSTAT_LINE = /^(\d+|-)\t(\d+|-)\t(.+)$/;

/**
 * Incremental parser for `git log` stdout in our record format: feed chunks with
 * push(), flush with end(). Holds at most one record in memory (streaming; spec §5.3).
 */
export class LogRecordParser {
  private buf = '';

  constructor(
    private readonly withSource: boolean,
    private readonly onCommit: (c: CommitInfo) => void,
  ) {}

  /** Consume the next stdout chunk, emitting every record completed by it. */
  push(chunk: string): void {
    this.buf += chunk;
    for (;;) {
      const start = this.buf.indexOf(RECORD_SEP);
      if (start === -1) {
        // No record started yet (e.g. empty output); drop noise before the first separator.
        this.buf = '';
        return;
      }
      const next = this.buf.indexOf(RECORD_SEP, start + 1);
      if (next === -1) {
        this.buf = this.buf.slice(start);
        return;
      }
      const record = this.buf.slice(start + 1, next);
      this.buf = this.buf.slice(next);
      this.emit(record);
    }
  }

  /** Flush the trailing record after stdout ends. */
  end(): void {
    const start = this.buf.indexOf(RECORD_SEP);
    if (start !== -1) this.emit(this.buf.slice(start + 1));
    this.buf = '';
  }

  private emit(record: string): void {
    const nl = record.indexOf('\n');
    const header = nl === -1 ? record : record.slice(0, nl);
    const body = nl === -1 ? '' : record.slice(nl + 1);
    const fields = header.split(FIELD_SEP);
    const hash = fields[0] ?? '';
    if (hash === '') return;
    const parentsRaw = fields[1] ?? '';
    const authorIso = fields[2] ?? '';
    const subject = fields[3] ?? '';
    const parents = parentsRaw === '' ? [] : parentsRaw.split(' ');
    const authorTs = Date.parse(authorIso);
    if (Number.isNaN(authorTs)) return; // defensive: never crash on malformed output
    const isMerge = parents.length > 1;

    let branchHint: string | null = null;
    if (this.withSource) {
      branchHint = branchHintFromSource(fields[4] ?? '');
    }

    const files: string[] = [];
    let insertions = 0;
    let deletions = 0;
    // Merge commits are never attribution targets: files [], 0/0 (spec §7.5).
    if (!isMerge && body !== '') {
      for (const line of body.split('\n')) {
        if (line === '') continue;
        const m = NUMSTAT_LINE.exec(line);
        if (m === null) continue;
        const ins = m[1] ?? '-';
        const del = m[2] ?? '-';
        const rawPath = m[3] ?? '';
        if (rawPath === '') continue;
        // Binary files report "-" for both counts: contribute 0/0, path still recorded.
        if (ins !== '-') insertions += Number.parseInt(ins, 10);
        if (del !== '-') deletions += Number.parseInt(del, 10);
        files.push(collapseRenamePath(unquoteGitPath(rawPath)));
      }
    }

    this.onCommit({ hash, parents, authorTs, subject, branchHint, files, insertions, deletions, isMerge });
  }
}
