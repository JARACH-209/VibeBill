/** Unit tests for the pure `git log` output parsing helpers (no I/O). */

import { describe, expect, it } from 'vitest';

import type { CommitInfo } from '../core/types.js';
import {
  FIELD_SEP,
  LOG_FORMAT,
  LOG_FORMAT_WITH_SOURCE,
  LogRecordParser,
  RECORD_SEP,
  branchHintFromSource,
  collapseRenamePath,
  unquoteGitPath,
} from './parse.js';

describe('collapseRenamePath', () => {
  it('records the new path for the plain "old => new" form', () => {
    expect(collapseRenamePath('a.txt => other/dir/c.txt')).toBe('other/dir/c.txt');
  });

  it('collapses the "pre/{old => new}/post" brace form', () => {
    expect(collapseRenamePath('src/{old => new}/mod.ts')).toBe('src/new/mod.ts');
  });

  it('collapses the bare "{old => new}" brace form', () => {
    expect(collapseRenamePath('{old.txt => new.txt}')).toBe('new.txt');
  });

  it('collapses a same-directory rename "dir/{a.txt => b.txt}"', () => {
    expect(collapseRenamePath('src/deep/{a.txt => b.txt}')).toBe('src/deep/b.txt');
  });

  it('squeezes the double slash left by an emptied brace segment', () => {
    expect(collapseRenamePath('src/{old => }/x.ts')).toBe('src/x.ts');
  });

  it('passes non-rename paths through untouched', () => {
    expect(collapseRenamePath('plain/path.ts')).toBe('plain/path.ts');
  });
});

describe('branchHintFromSource', () => {
  it('strips refs/heads/ so hints read as branch names', () => {
    expect(branchHintFromSource('refs/heads/feature/x')).toBe('feature/x');
    expect(branchHintFromSource('refs/heads/main')).toBe('main');
  });

  it('maps non-branch sources (tags, HEAD, empty) to null — unknown, not mismatch', () => {
    expect(branchHintFromSource('refs/tags/v1')).toBeNull();
    expect(branchHintFromSource('HEAD')).toBeNull();
    expect(branchHintFromSource('')).toBeNull();
  });
});

describe('unquoteGitPath', () => {
  it('passes unquoted paths through', () => {
    expect(unquoteGitPath('src/a.ts')).toBe('src/a.ts');
  });

  it('decodes C-style escapes and octal UTF-8 bytes', () => {
    expect(unquoteGitPath('"a\\"b.txt"')).toBe('a"b.txt');
    expect(unquoteGitPath('"tab\\there"')).toBe('tab\there');
    // ä is UTF-8 0xC3 0xA4 → octal \303\244
    expect(unquoteGitPath('"gr\\303\\244n.txt"')).toBe('grän.txt');
  });
});

/** Build one raw log record exactly as `git log` emits it for our pretty format. */
function record(opts: {
  hash: string;
  parents?: string[];
  authorIso?: string;
  subject?: string;
  source?: string;
  numstat?: string[];
}): string {
  const fields = [
    opts.hash,
    (opts.parents ?? []).join(' '),
    opts.authorIso ?? '2026-01-01T00:00:00+00:00',
    opts.subject ?? 'subject',
  ];
  if (opts.source !== undefined) fields.push(opts.source);
  const header = RECORD_SEP + fields.join(FIELD_SEP);
  if (opts.numstat === undefined || opts.numstat.length === 0) return `${header}\n`;
  return `${header}\n\n${opts.numstat.join('\n')}\n\n`;
}

function parseAll(text: string, withSource: boolean, chunkSize?: number): CommitInfo[] {
  const out: CommitInfo[] = [];
  const parser = new LogRecordParser(withSource, (c) => out.push(c));
  if (chunkSize === undefined) {
    parser.push(text);
  } else {
    for (let i = 0; i < text.length; i += chunkSize) parser.push(text.slice(i, i + chunkSize));
  }
  parser.end();
  return out;
}

describe('LogRecordParser', () => {
  const HASH_A = 'a'.repeat(40);
  const HASH_B = 'b'.repeat(40);
  const HASH_C = 'c'.repeat(40);

  it('parses a linear two-record stream exactly', () => {
    const text =
      record({
        hash: HASH_B,
        parents: [HASH_A],
        authorIso: '2026-02-01T10:00:00+02:00',
        subject: 'feat: two',
        numstat: ['3\t1\tsrc/two.ts'],
      }) +
      record({
        hash: HASH_A,
        authorIso: '2026-01-01T09:00:00+00:00',
        subject: 'chore: one',
        numstat: ['5\t0\tREADME.md'],
      });
    const commits = parseAll(text, false);
    expect(commits).toEqual([
      {
        hash: HASH_B,
        parents: [HASH_A],
        authorTs: Date.parse('2026-02-01T10:00:00+02:00'),
        subject: 'feat: two',
        branchHint: null,
        files: ['src/two.ts'],
        insertions: 3,
        deletions: 1,
        isMerge: false,
      },
      {
        hash: HASH_A,
        parents: [],
        authorTs: Date.parse('2026-01-01T09:00:00+00:00'),
        subject: 'chore: one',
        branchHint: null,
        files: ['README.md'],
        insertions: 5,
        deletions: 0,
        isMerge: false,
      },
    ]);
  });

  it('is chunk-boundary independent (streaming)', () => {
    const text =
      record({ hash: HASH_C, parents: [HASH_B], numstat: ['1\t2\ta.ts', '0\t4\tb.ts'] }) +
      record({ hash: HASH_B, parents: [HASH_A], numstat: ['9\t9\tc.ts'] }) +
      record({ hash: HASH_A, numstat: ['1\t0\td.ts'] });
    const whole = parseAll(text, false);
    for (const size of [1, 2, 3, 7, 64]) {
      expect(parseAll(text, false, size)).toEqual(whole);
    }
  });

  it('treats binary numstat "-" as 0/0 but still records the path', () => {
    const [c] = parseAll(
      record({ hash: HASH_A, numstat: ['-\t-\tblob.bin', '2\t0\ttext.ts'] }),
      false,
    );
    expect(c?.files).toEqual(['blob.bin', 'text.ts']);
    expect(c?.insertions).toBe(2);
    expect(c?.deletions).toBe(0);
  });

  it('collapses rename numstat forms to the new path', () => {
    const [c] = parseAll(
      record({
        hash: HASH_A,
        numstat: ['0\t0\told.txt => dir/new.txt', '1\t1\tsrc/{a => b}/x.ts', '0\t0\t{p.ts => q.ts}'],
      }),
      false,
    );
    expect(c?.files).toEqual(['dir/new.txt', 'src/b/x.ts', 'q.ts']);
  });

  it('shapes merge commits as files [], 0/0, isMerge true — and still returns them', () => {
    const [c] = parseAll(record({ hash: HASH_C, parents: [HASH_A, HASH_B] }), false);
    expect(c).toMatchObject({ hash: HASH_C, isMerge: true, files: [], insertions: 0, deletions: 0 });
    expect(c?.parents).toEqual([HASH_A, HASH_B]);
  });

  it('extracts branchHint from %S in source mode, stripping refs/heads/', () => {
    const text =
      record({ hash: HASH_B, parents: [HASH_A], source: 'refs/heads/feature' }) +
      record({ hash: HASH_A, source: 'refs/heads/main' });
    const commits = parseAll(text, true);
    expect(commits.map((c) => c.branchHint)).toEqual(['feature', 'main']);
  });

  it('reports null branchHint for HEAD/tag sources in source mode', () => {
    const text =
      record({ hash: HASH_B, parents: [HASH_A], source: 'HEAD' }) +
      record({ hash: HASH_A, source: 'refs/tags/v1' });
    expect(parseAll(text, true).map((c) => c.branchHint)).toEqual([null, null]);
  });

  it('never crashes on malformed records (bad date, empty hash, junk lines)', () => {
    const junk =
      `${RECORD_SEP}${'d'.repeat(40)}${FIELD_SEP}${FIELD_SEP}not-a-date${FIELD_SEP}bad\n` +
      `${RECORD_SEP}${FIELD_SEP}${FIELD_SEP}${FIELD_SEP}\n` +
      record({ hash: HASH_A, numstat: ['not a numstat line', '1\t0\tok.ts'] });
    const commits = parseAll(junk, false);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.files).toEqual(['ok.ts']);
  });

  it('parses empty output to zero commits', () => {
    expect(parseAll('', false)).toEqual([]);
  });

  it('exports the pretty formats the git layer shells out with', () => {
    expect(LOG_FORMAT).toBe('%x1e%H%x1f%P%x1f%aI%x1f%s');
    expect(LOG_FORMAT_WITH_SOURCE).toBe('%x1e%H%x1f%P%x1f%aI%x1f%s%x1f%S');
  });
});
