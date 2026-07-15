/**
 * Git layer (spec §5.3): every git access shells out to the `git` binary via
 * execFile/spawn with explicit argument arrays — never a shell string. Bounded
 * outputs (rev-parse, notes, rev-list) use execFile with a generous maxBuffer;
 * `git log` is parsed streaming from child stdout so huge histories never
 * buffer wholesale in memory.
 */

import { execFile, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { promisify } from 'node:util';

import { CliUserError } from '../core/errors.js';
import type { CommitInfo } from '../core/types.js';
import { LOG_FORMAT, LOG_FORMAT_WITH_SOURCE, LogRecordParser } from './parse.js';

const execFileAsync = promisify(execFile);

/** vibebill writes/reads notes ONLY under this ref; the default notes ref is never touched. */
const NOTES_REF = 'refs/notes/vibebill';

/** Bounded-output ceiling: 64 MiB covers ~1.5M rev-list hashes; log output streams instead. */
const MAX_BUFFER = 64 * 1024 * 1024;

/** Unexpected git failure (exit code / stderr preserved for --debug diagnostics). */
export class GitError extends Error {
  readonly stderr: string;
  constructor(message: string, stderr = '') {
    super(message);
    this.name = 'GitError';
    this.stderr = stderr;
  }
}

interface ExecErrorLike {
  code?: string | number;
  stderr?: string;
  message?: string;
}

function asExecError(err: unknown): ExecErrorLike {
  return typeof err === 'object' && err !== null ? (err as ExecErrorLike) : {};
}

function isSpawnEnoent(err: unknown): boolean {
  return asExecError(err).code === 'ENOENT';
}

function stderrOf(err: unknown): string {
  const raw = asExecError(err).stderr;
  return typeof raw === 'string' ? raw.trim() : '';
}

/** True when git rejected the ref/range itself (a user input problem, not an internal one). */
function isBadRevisionError(stderr: string): boolean {
  return /unknown revision|bad revision|ambiguous argument|not a valid ref|needed a single revision/i.test(
    stderr,
  );
}

function gitNotFoundError(): CliUserError {
  return new CliUserError(
    'git executable not found on PATH.',
    'Install git (https://git-scm.com/downloads) and re-run.',
  );
}

/** Run a bounded-output git command in repoRoot; throws GitError/CliUserError on failure. */
async function execGit(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: repoRoot,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (err) {
    if (isSpawnEnoent(err)) throw gitNotFoundError();
    throw new GitError(`git ${args[0] ?? ''} failed: ${stderrOf(err) || String(err)}`, stderrOf(err));
  }
}

/** Resolve the repository root via `git rev-parse --show-toplevel`; CliUserError when not a repo. */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  if (!existsSync(cwd)) {
    throw new CliUserError(
      `Directory does not exist: ${cwd}`,
      'Run vibebill from inside the repository you want to analyze.',
    );
  }
  try {
    const { stdout } = await execFileAsync('git', ['rev-parse', '--show-toplevel'], {
      cwd,
      encoding: 'utf8',
    });
    return stdout.trim();
  } catch (err) {
    if (isSpawnEnoent(err)) throw gitNotFoundError();
    throw new CliUserError(
      `Not a git repository: ${cwd}`,
      'Run vibebill from inside a git repository (or `git init` one). `vibebill doctor` shows the full environment check.',
    );
  }
}

/** True when the repo is a shallow clone (history-based attribution is truncated; spec §7.15). */
export async function isShallowRepository(repoRoot: string): Promise<boolean> {
  const out = await execGit(repoRoot, ['rev-parse', '--is-shallow-repository']);
  return out.trim() === 'true';
}

/** True when HEAD resolves to a commit; false in an empty (no-commit) repository. */
async function hasHeadCommit(repoRoot: string): Promise<boolean> {
  try {
    await execFileAsync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: repoRoot,
      encoding: 'utf8',
    });
    return true;
  } catch (err) {
    if (isSpawnEnoent(err)) throw gitNotFoundError();
    return false;
  }
}

/**
 * Enumerate commits (HEAD history by default; opts.range limits, opts.allRefs adds
 * --all --source for branch hints), parsed streaming from `git log` stdout.
 * Empty repository (no HEAD commit) returns [] — never crashes (spec §7.16).
 */
export async function enumerateCommits(
  repoRoot: string,
  opts?: { allRefs?: boolean; range?: string },
): Promise<CommitInfo[]> {
  const allRefs = opts?.allRefs ?? false;
  if (!(await hasHeadCommit(repoRoot))) return [];

  const args = [
    // Pin output-shaping config so user gitconfig cannot corrupt the parse.
    '-c',
    'core.quotepath=false',
    '-c',
    'log.showSignature=false',
    '-c',
    'diff.renames=true',
    'log',
  ];
  if (allRefs) {
    // No positional HEAD here: an explicit rev would win the --source race and
    // stamp its commits "HEAD" instead of their branch ref (verified empirically).
    // --all already includes HEAD; notes/stash refs are excluded so vibebill's own
    // notes commits (refs/notes/vibebill) never pollute enumeration.
    if (opts?.range !== undefined) args.push(opts.range);
    args.push('--exclude=refs/notes/*', '--exclude=refs/stash', '--all', '--source');
  } else {
    args.push(opts?.range ?? 'HEAD');
  }
  args.push(
    '--date-order',
    '--no-color',
    `--pretty=format:${allRefs ? LOG_FORMAT_WITH_SOURCE : LOG_FORMAT}`,
    '--numstat',
  );

  return new Promise<CommitInfo[]>((resolve, reject) => {
    const commits: CommitInfo[] = [];
    const parser = new LogRecordParser(allRefs, (c) => commits.push(c));
    const child = spawn('git', args, { cwd: repoRoot, stdio: ['ignore', 'pipe', 'pipe'] });

    let stderrBuf = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => parser.push(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      if (stderrBuf.length < 16384) stderrBuf += chunk;
    });
    child.on('error', (err) => {
      reject(
        isSpawnEnoent(err) ? gitNotFoundError() : new GitError(`git log failed to start: ${String(err)}`),
      );
    });
    child.on('close', (code) => {
      if (code === 0) {
        parser.end();
        resolve(commits);
        return;
      }
      const stderr = stderrBuf.trim();
      if (isBadRevisionError(stderr)) {
        reject(
          new CliUserError(
            `Unknown revision or range: ${opts?.range ?? 'HEAD'}`,
            'Check the range with `git log <range>` — vibebill accepts anything git rev-list accepts.',
          ),
        );
        return;
      }
      reject(new GitError(`git log exited with code ${String(code)}`, stderr));
    });
  });
}

/** List commit hashes in a range via `git rev-list <range>`, newest first. */
export async function revList(repoRoot: string, range: string): Promise<string[]> {
  try {
    const out = await execGit(repoRoot, ['rev-list', range]);
    return out.split('\n').filter((line) => line !== '');
  } catch (err) {
    if (err instanceof GitError && isBadRevisionError(err.stderr)) {
      throw new CliUserError(
        `Unknown revision or range: ${range}`,
        'Check the range with `git log <range>` — vibebill accepts anything git rev-list accepts.',
      );
    }
    throw err;
  }
}

/** Resolve a ref to its full commit hash (annotated tags are peeled to the commit). */
export async function resolveRef(repoRoot: string, ref: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`],
      { cwd: repoRoot, encoding: 'utf8' },
    );
    return stdout.trim();
  } catch (err) {
    if (isSpawnEnoent(err)) throw gitNotFoundError();
    throw new CliUserError(
      `Unknown revision: ${ref}`,
      'Check the ref with `git rev-parse <ref>`; vibebill needs a ref that resolves to a commit.',
    );
  }
}

/** Read the vibebill note (refs/notes/vibebill) for a commit; null when no note exists. */
export async function readNote(repoRoot: string, hash: string): Promise<string | null> {
  try {
    const out = await execGit(repoRoot, ['notes', `--ref=${NOTES_REF}`, 'show', hash]);
    // `git notes show` appends one newline to the stored message; strip it for round-tripping.
    return out.endsWith('\n') ? out.slice(0, -1) : out;
  } catch (err) {
    if (err instanceof GitError && /no note found/i.test(err.stderr)) return null;
    throw err;
  }
}

/** Write (add -f, overwriting vibebill's own prior note) a note under refs/notes/vibebill. */
export async function writeNote(repoRoot: string, hash: string, message: string): Promise<void> {
  await execGit(repoRoot, ['notes', `--ref=${NOTES_REF}`, 'add', '-f', '-m', message, hash]);
}

/** Remove the vibebill note for a commit; a missing note is not an error (idempotent). */
export async function removeNote(repoRoot: string, hash: string): Promise<void> {
  await execGit(repoRoot, ['notes', `--ref=${NOTES_REF}`, 'remove', '--ignore-missing', hash]);
}

/** List commits that carry a vibebill note (annotated object hashes from refs/notes/vibebill). */
export async function listNotes(repoRoot: string): Promise<Array<{ hash: string }>> {
  // `git notes list` prints "<note-blob-sha> <annotated-object-sha>" per line; empty ref → empty output.
  const out = await execGit(repoRoot, ['notes', `--ref=${NOTES_REF}`, 'list']);
  const result: Array<{ hash: string }> = [];
  for (const line of out.split('\n')) {
    if (line === '') continue;
    const sp = line.indexOf(' ');
    if (sp === -1) continue;
    result.push({ hash: line.slice(sp + 1) });
  }
  return result;
}
