/**
 * Integration tests for the git layer against real temporary repositories.
 * Repos are built with execFile('git', ...) under isolated config
 * (GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM=/dev/null) and deterministic
 * GIT_AUTHOR_DATE/GIT_COMMITTER_DATE values.
 */

import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { CliUserError } from '../core/errors.js';
import {
  enumerateCommits,
  isShallowRepository,
  listNotes,
  readNote,
  removeNote,
  resolveRef,
  resolveRepoRoot,
  revList,
  writeNote,
} from './index.js';

const execFileAsync = promisify(execFile);

const tempDirs: string[] = [];

beforeAll(() => {
  // Isolate BOTH the fixture-building git calls and the module's own git
  // invocations (which inherit process.env) from the developer's gitconfig.
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null');
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.map((d) => rm(d, { recursive: true, force: true })));
});

async function git(cwd: string, args: string[], dates?: string): Promise<string> {
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (dates !== undefined) {
    env['GIT_AUTHOR_DATE'] = dates;
    env['GIT_COMMITTER_DATE'] = dates;
  }
  const { stdout } = await execFileAsync('git', args, { cwd, encoding: 'utf8', env });
  return stdout;
}

/** Create an isolated temp repo on branch main with a local user identity. */
async function makeRepo(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibebill-git-'));
  tempDirs.push(dir);
  const root = await realpath(dir);
  await git(root, ['init', '-q', '-b', 'main']);
  await git(root, ['config', 'user.name', 'Vibebill Test']);
  await git(root, ['config', 'user.email', 'test@vibebill.invalid']);
  return root;
}

/** Create a bare temp dir that is NOT a git repo. */
async function makeBareDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'vibebill-norepo-'));
  tempDirs.push(dir);
  return realpath(dir);
}

async function commitFiles(
  root: string,
  files: Array<[string, string | Buffer]>,
  message: string,
  isoDate: string,
): Promise<string> {
  for (const [rel, content] of files) {
    await mkdir(dirname(join(root, rel)), { recursive: true });
    await writeFile(join(root, rel), content);
  }
  await git(root, ['add', '-A']);
  await git(root, ['commit', '-q', '-m', message], isoDate);
  return (await git(root, ['rev-parse', 'HEAD'])).trim();
}

const D1 = '2026-03-01T10:00:00+02:00';
const D2 = '2026-03-02T11:30:00+00:00';
const D3 = '2026-03-03T08:15:00-05:00';
const D4 = '2026-03-04T09:00:00+00:00';

describe('resolveRepoRoot', () => {
  it('resolves the toplevel from the root and from a subdirectory', async () => {
    const root = await makeRepo();
    await commitFiles(root, [['a.txt', 'a\n']], 'init', D1);
    const sub = join(root, 'nested', 'dir');
    await mkdir(sub, { recursive: true });
    expect(await realpath(await resolveRepoRoot(root))).toBe(root);
    expect(await realpath(await resolveRepoRoot(sub))).toBe(root);
  });

  it('throws CliUserError with a remedy when not inside a repository', async () => {
    const dir = await makeBareDir();
    const err = await resolveRepoRoot(dir).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliUserError);
    expect((err as CliUserError).message).toContain('Not a git repository');
    expect((err as CliUserError).remedy).toBeTruthy();
  });

  it('throws CliUserError for a nonexistent directory', async () => {
    const err = await resolveRepoRoot('/nonexistent/vibebill/path').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliUserError);
  });
});

describe('enumerateCommits — linear history', () => {
  it('parses hash/parents/authorTs/subject/files/insertions/deletions exactly, newest first', async () => {
    const root = await makeRepo();
    const c1 = await commitFiles(root, [['a.txt', 'one\ntwo\nthree\n']], 'chore: first — exact ✓', D1);
    const c2 = await commitFiles(
      root,
      [
        ['a.txt', 'one\nTWO\nthree\n'],
        ['b.txt', 'x\ny\n'],
      ],
      'feat: second',
      D2,
    );

    const commits = await enumerateCommits(root);
    expect(commits).toEqual([
      {
        hash: c2,
        parents: [c1],
        authorTs: Date.parse(D2),
        subject: 'feat: second',
        branchHint: null,
        files: ['a.txt', 'b.txt'],
        insertions: 3, // 1 changed line in a.txt + 2 new lines in b.txt
        deletions: 1,
        isMerge: false,
      },
      {
        hash: c1,
        parents: [],
        authorTs: Date.parse(D1),
        subject: 'chore: first — exact ✓',
        branchHint: null,
        files: ['a.txt'],
        insertions: 3,
        deletions: 0,
        isMerge: false,
      },
    ]);
    expect(c1).toMatch(/^[0-9a-f]{40}$/);
    // Author timestamps preserve the original zone's instant (D1 is +02:00).
    expect(commits[1]?.authorTs).toBe(Date.parse('2026-03-01T08:00:00Z'));
  });

  it('records the NEW path for renames (brace and plain arrow numstat forms)', async () => {
    const root = await makeRepo();
    const c1 = await commitFiles(
      root,
      [
        ['src/deep/a.txt', 'stable content that survives the rename\n'],
        ['top.txt', 'top-level content that survives the rename\n'],
      ],
      'seed',
      D1,
    );
    // Same-directory rename → numstat brace form "src/deep/{a.txt => b.txt}";
    // cross-directory rename → plain arrow form "top.txt => other/dir/c.txt".
    await git(root, ['mv', 'src/deep/a.txt', 'src/deep/b.txt']);
    await mkdir(join(root, 'other', 'dir'), { recursive: true });
    await git(root, ['mv', 'top.txt', 'other/dir/c.txt']);
    await git(root, ['commit', '-q', '-m', 'rename both'], D2);
    const c2 = (await git(root, ['rev-parse', 'HEAD'])).trim();

    const commits = await enumerateCommits(root);
    const renamed = commits.find((c) => c.hash === c2);
    expect(renamed?.files.sort()).toEqual(['other/dir/c.txt', 'src/deep/b.txt']);
    expect(renamed?.insertions).toBe(0);
    expect(renamed?.deletions).toBe(0);
    expect(commits.find((c) => c.hash === c1)?.files.sort()).toEqual(['src/deep/a.txt', 'top.txt']);
  });

  it('treats binary files as 0/0 but still records the path', async () => {
    const root = await makeRepo();
    await commitFiles(root, [['a.txt', 'a\n']], 'seed', D1);
    const c2 = await commitFiles(root, [['blob.bin', Buffer.from([0, 1, 2, 3, 0xff])]], 'bin', D2);
    const commits = await enumerateCommits(root);
    const bin = commits.find((c) => c.hash === c2);
    expect(bin?.files).toEqual(['blob.bin']);
    expect(bin?.insertions).toBe(0);
    expect(bin?.deletions).toBe(0);
  });
});

describe('enumerateCommits — merges, ranges, branch hints', () => {
  it('returns merge commits with parents>1, files [], isMerge true', async () => {
    const root = await makeRepo();
    const c1 = await commitFiles(root, [['base.txt', 'base\n']], 'base', D1);
    await git(root, ['checkout', '-q', '-b', 'feature']);
    const c2 = await commitFiles(root, [['feature.txt', 'f\n']], 'feature work', D2);
    await git(root, ['checkout', '-q', 'main']);
    const c3 = await commitFiles(root, [['main.txt', 'm\n']], 'main work', D3);
    await git(root, ['merge', '-q', '--no-ff', 'feature', '-m', 'merge feature'], D4);
    const mergeHash = (await git(root, ['rev-parse', 'HEAD'])).trim();

    const commits = await enumerateCommits(root);
    expect(commits.map((c) => c.hash)).toEqual([mergeHash, c3, c2, c1]);

    const merge = commits[0];
    expect(merge).toMatchObject({
      isMerge: true,
      files: [],
      insertions: 0,
      deletions: 0,
      subject: 'merge feature',
    });
    expect(merge?.parents).toEqual([c3, c2]);
    // Non-merge commits keep their file lists.
    expect(commits.find((c) => c.hash === c2)?.files).toEqual(['feature.txt']);
  });

  it('limits enumeration to opts.range', async () => {
    const root = await makeRepo();
    const c1 = await commitFiles(root, [['a.txt', '1\n']], 'one', D1);
    const c2 = await commitFiles(root, [['b.txt', '2\n']], 'two', D2);
    const c3 = await commitFiles(root, [['c.txt', '3\n']], 'three', D3);
    const commits = await enumerateCommits(root, { range: `${c1}..HEAD` });
    expect(commits.map((c) => c.hash)).toEqual([c3, c2]);
  });

  it('rejects an unknown range with CliUserError', async () => {
    const root = await makeRepo();
    await commitFiles(root, [['a.txt', 'a\n']], 'seed', D1);
    const err = await enumerateCommits(root, { range: 'nope..HEAD' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CliUserError);
    expect((err as CliUserError).message).toContain('nope..HEAD');
  });

  it('sets branchHint from %S only in allRefs mode, stripping refs/heads/', async () => {
    const root = await makeRepo();
    const c1 = await commitFiles(root, [['base.txt', 'b\n']], 'base', D1);
    await git(root, ['checkout', '-q', '-b', 'feature']);
    const c2 = await commitFiles(root, [['f.txt', 'f\n']], 'feature-only', D2);
    await git(root, ['checkout', '-q', 'main']);
    const c3 = await commitFiles(root, [['m.txt', 'm\n']], 'main-only', D3);

    // vibebill notes commits (refs/notes/vibebill) must never pollute --all enumeration.
    await writeNote(root, c1, '{"v":1}');

    const all = await enumerateCommits(root, { allRefs: true });
    expect(all.map((c) => c.hash).sort()).toEqual([c1, c2, c3].sort());
    const byHash = new Map(all.map((c) => [c.hash, c]));
    expect(byHash.get(c2)?.branchHint).toBe('feature');
    expect(byHash.get(c3)?.branchHint).toBe('main');
    // c1 is reachable from both branches; the hint must be one of them.
    expect(['main', 'feature']).toContain(byHash.get(c1)?.branchHint);

    // HEAD mode never reports hints (%S would just say "HEAD").
    const headMode = await enumerateCommits(root);
    expect(headMode.every((c) => c.branchHint === null)).toBe(true);
  });

  it('returns [] for an empty repository (no commits) in both modes', async () => {
    const root = await makeRepo();
    expect(await enumerateCommits(root)).toEqual([]);
    expect(await enumerateCommits(root, { allRefs: true })).toEqual([]);
  });
});

describe('revList and resolveRef', () => {
  it('lists range hashes newest first and resolves refs to full hashes', async () => {
    const root = await makeRepo();
    const c1 = await commitFiles(root, [['a.txt', '1\n']], 'one', D1);
    const c2 = await commitFiles(root, [['b.txt', '2\n']], 'two', D2);
    const c3 = await commitFiles(root, [['c.txt', '3\n']], 'three', D3);

    expect(await revList(root, `${c1}..HEAD`)).toEqual([c3, c2]);
    expect(await resolveRef(root, 'HEAD')).toBe(c3);
    expect(await resolveRef(root, 'main')).toBe(c3);
    expect(await resolveRef(root, `${c2.slice(0, 8)}`)).toBe(c2);

    // Annotated tags peel to the commit.
    await git(root, ['tag', '-a', 'v1', '-m', 'v1 tag', c2], D3);
    expect(await resolveRef(root, 'v1')).toBe(c2);
  });

  it('throws CliUserError for unknown refs and ranges', async () => {
    const root = await makeRepo();
    await commitFiles(root, [['a.txt', 'a\n']], 'seed', D1);
    await expect(resolveRef(root, 'does-not-exist')).rejects.toBeInstanceOf(CliUserError);
    await expect(revList(root, 'bogus..HEAD')).rejects.toBeInstanceOf(CliUserError);
  });
});

describe('notes — refs/notes/vibebill isolation', () => {
  it('writes, reads, overwrites, lists and removes notes without touching the default ref', async () => {
    const root = await makeRepo();
    const c1 = await commitFiles(root, [['a.txt', '1\n']], 'one', D1);
    const c2 = await commitFiles(root, [['b.txt', '2\n']], 'two', D2);

    // Pre-existing note on the DEFAULT ref must survive all vibebill operations.
    await git(root, ['notes', 'add', '-m', 'human note', c1]);

    expect(await readNote(root, c1)).toBeNull();

    const payload = '{\n  "v": 1,\n  "costNanoUsd": "123456789"\n}';
    await writeNote(root, c1, payload);
    expect(await readNote(root, c1)).toBe(payload);
    expect(await readNote(root, c2)).toBeNull();

    // add -f overwrites vibebill's own note (idempotent notes sync).
    await writeNote(root, c1, '{"v":1,"costNanoUsd":"42"}');
    expect(await readNote(root, c1)).toBe('{"v":1,"costNanoUsd":"42"}');

    await writeNote(root, c2, '{"v":1}');
    const listed = (await listNotes(root)).map((n) => n.hash).sort();
    expect(listed).toEqual([c1, c2].sort());

    await removeNote(root, c1);
    expect(await readNote(root, c1)).toBeNull();
    // Removing an absent note is not an error (idempotent).
    await removeNote(root, c1);
    expect((await listNotes(root)).map((n) => n.hash)).toEqual([c2]);

    // Default notes ref is completely untouched.
    expect((await git(root, ['notes', 'show', c1])).trimEnd()).toBe('human note');
    const defaultList = await git(root, ['notes', 'list']);
    expect(defaultList.trim().split('\n')).toHaveLength(1);
  });

  it('lists nothing when the vibebill notes ref does not exist yet', async () => {
    const root = await makeRepo();
    await commitFiles(root, [['a.txt', 'a\n']], 'seed', D1);
    expect(await listNotes(root)).toEqual([]);
  });
});

describe('isShallowRepository', () => {
  it('detects a --depth 1 clone as shallow and a full repo as not', async () => {
    const src = await makeRepo();
    await commitFiles(src, [['a.txt', '1\n']], 'one', D1);
    await commitFiles(src, [['b.txt', '2\n']], 'two', D2);

    const cloneParent = await makeBareDir();
    const cloneDir = join(cloneParent, 'shallow');
    await git(cloneParent, ['clone', '-q', '--depth', '1', `file://${src}`, cloneDir]);

    expect(await isShallowRepository(cloneDir)).toBe(true);
    expect(await isShallowRepository(src)).toBe(false);

    // Shallow history still enumerates (truncated), never crashes.
    const commits = await enumerateCommits(cloneDir);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.subject).toBe('two');
  });
});
