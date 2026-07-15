/**
 * Scripted git repo fixture builder (spec §11, docs/contracts.md "test/helpers/repo.ts").
 *
 * Every git invocation uses `execFile('git', [...args])` — argument arrays only, never a
 * shell string — with a fully isolated environment (GIT_CONFIG_GLOBAL/GIT_CONFIG_SYSTEM
 * pointed at the null device, HOME inside the temp dir, TZ=UTC) so the developer's own
 * gitconfig, hooks, or signing setup can never leak into fixtures. Author identity is
 * pinned via in-repo `git config`, commit.gpgsign is off, and both GIT_AUTHOR_DATE and
 * GIT_COMMITTER_DATE come from the caller, so a fixed script yields byte-identical
 * commit hashes on every run.
 */
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Deterministic identity baked into every fixture repo. */
export const FIXTURE_GIT_USER = { name: 'Vibe Fixture', email: 'fixture@vibebill.invalid' } as const;

/**
 * Default date for merge()/squashMerge() when the caller omits authorDate — a fixed
 * constant so hashes stay deterministic even when the test does not care about the date.
 */
export const FIXTURE_DEFAULT_MERGE_DATE = '2026-01-01T00:00:00+00:00';

/** A disposable scripted git repository living in a temp dir. */
export interface FixtureRepo {
  root: string;
  /** Run git with the isolated fixture env; resolves to trimmed stdout. */
  git(args: string[]): Promise<string>;
  /** Write one file and commit it at a controlled author+committer date; returns the hash. */
  commitFile(
    relPath: string,
    content: string,
    opts: { message?: string; authorDate: string | number; branch?: string },
  ): Promise<string>;
  /** Write several files and commit them together; returns the hash. */
  commitFiles(
    files: Array<[string, string]>,
    opts: { message?: string; authorDate: string | number },
  ): Promise<string>;
  /** Create a branch (no checkout) at `from` (default: current HEAD). */
  branch(name: string, from?: string): Promise<void>;
  /** Switch to an existing branch. */
  checkout(name: string): Promise<void>;
  /** True merge (--no-ff, always a 2-parent merge commit); returns the merge hash. */
  merge(branch: string, opts?: { message?: string; authorDate?: string | number }): Promise<string>;
  /** `merge --squash` + commit: a normal 1-parent commit carrying the branch's changes. */
  squashMerge(branch: string, message: string, authorDate: string | number): Promise<string>;
  /** Full hash of HEAD. */
  head(): Promise<string>;
}

/**
 * Convert an accepted authorDate (ISO string with offset, or UTC epoch ms) into the
 * strict-ISO string handed to git (`+00:00` offset for numeric input).
 */
export function toGitIsoDate(authorDate: string | number): string {
  if (typeof authorDate === 'number') {
    return new Date(authorDate).toISOString().replace(/\.\d{3}Z$/, '+00:00');
  }
  return authorDate;
}

/**
 * Create an initialized (`init -b main`), config-isolated fixture repo under a fresh
 * temp dir (inside `baseDir`, default os.tmpdir()). Caller removes `root` to clean up.
 */
export async function makeRepo(baseDir?: string): Promise<FixtureRepo> {
  const root = await mkdtemp(path.join(baseDir ?? os.tmpdir(), 'vibebill-fixture-repo-'));

  const baseEnv: Record<string, string> = {
    PATH: process.env['PATH'] ?? '',
    HOME: root,
    GIT_CONFIG_GLOBAL: os.devNull,
    GIT_CONFIG_SYSTEM: os.devNull,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    TZ: 'UTC',
    LC_ALL: 'C',
  };

  async function git(args: string[], extraEnv: Record<string, string> = {}): Promise<string> {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      env: { ...baseEnv, ...extraEnv },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim();
  }

  function dateEnv(authorDate: string | number): Record<string, string> {
    const iso = toGitIsoDate(authorDate);
    return { GIT_AUTHOR_DATE: iso, GIT_COMMITTER_DATE: iso };
  }

  async function checkoutOrCreate(name: string): Promise<void> {
    const existing = await git(['branch', '--list', name]);
    if (existing === '') {
      await git(['checkout', '-b', name]);
    } else {
      await git(['checkout', name]);
    }
  }

  async function head(): Promise<string> {
    return git(['rev-parse', 'HEAD']);
  }

  await git(['init', '-b', 'main']);
  await git(['config', 'user.name', FIXTURE_GIT_USER.name]);
  await git(['config', 'user.email', FIXTURE_GIT_USER.email]);
  await git(['config', 'commit.gpgsign', 'false']);
  await git(['config', 'tag.gpgsign', 'false']);
  await git(['config', 'core.autocrlf', 'false']);

  return {
    root,
    git,
    head,

    async commitFile(relPath, content, opts) {
      if (opts.branch !== undefined) await checkoutOrCreate(opts.branch);
      const abs = path.join(root, relPath);
      await mkdir(path.dirname(abs), { recursive: true });
      await writeFile(abs, content, 'utf8');
      await git(['add', '--', relPath]);
      await git(
        ['commit', '--no-verify', '-m', opts.message ?? `add ${relPath}`],
        dateEnv(opts.authorDate),
      );
      return head();
    },

    async commitFiles(files, opts) {
      for (const [relPath, content] of files) {
        const abs = path.join(root, relPath);
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, content, 'utf8');
        await git(['add', '--', relPath]);
      }
      await git(
        ['commit', '--no-verify', '-m', opts.message ?? `commit ${files.length} files`],
        dateEnv(opts.authorDate),
      );
      return head();
    },

    async branch(name, from) {
      await git(from === undefined ? ['branch', name] : ['branch', name, from]);
    },

    async checkout(name) {
      await git(['checkout', name]);
    },

    async merge(branch, opts) {
      await git(
        ['merge', '--no-ff', '-m', opts?.message ?? `Merge branch '${branch}'`, branch],
        dateEnv(opts?.authorDate ?? FIXTURE_DEFAULT_MERGE_DATE),
      );
      return head();
    },

    async squashMerge(branch, message, authorDate) {
      await git(['merge', '--squash', branch]);
      await git(['commit', '--no-verify', '-m', message], dateEnv(authorDate));
      return head();
    },
  };
}
