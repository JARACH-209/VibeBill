/**
 * Smoke tests for the fixture builders themselves (spec §11: build these FIRST —
 * scenario tests depend on this API being exactly right).
 */
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { makeRepo, toGitIsoDate } from './repo.js';
import {
  FAILED_ITERATION_TOKENS,
  FIXTURE_CLAUDE_CODE_VERSION,
  SessionBuilder,
  encodeProjectDir,
  session,
  writeTranscripts,
} from './transcripts.js';

// ---------------------------------------------------------------------------
// typed views of the emitted JSON (parse-boundary casts, test-only)
// ---------------------------------------------------------------------------

interface IterationJson {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  type: string;
}

interface UsageJson {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  iterations?: IterationJson[];
}

interface ContentBlockJson {
  type: string;
  id?: string;
  name?: string;
  text?: string;
  input?: { file_path?: string; old_string?: string; new_string?: string };
}

interface LineJson {
  type: string;
  sessionId: string;
  timestamp: string;
  cwd: string;
  gitBranch?: string;
  isSidechain: boolean;
  requestId?: string;
  uuid: string;
  parentUuid: string | null;
  version: string;
  message?: {
    id?: string;
    type?: string;
    role?: string;
    model?: string;
    usage?: UsageJson;
    content?: ContentBlockJson[];
  };
}

function parseLines(jsonl: string): LineJson[] {
  return jsonl
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as LineJson);
}

// ---------------------------------------------------------------------------
// temp-dir bookkeeping
// ---------------------------------------------------------------------------

const tempDirs: string[] = [];

async function tmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

// ---------------------------------------------------------------------------
// transcripts.ts
// ---------------------------------------------------------------------------

const SID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

function buildSampleSession(): SessionBuilder {
  return session({
    sessionId: SID,
    defaultCwd: '/work/proj',
    defaultBranch: 'main',
    defaultModel: 'claude-opus-4-8',
  })
    .at('2026-03-01T10:00:00.000Z')
    .call({
      usage: { input: 100, output: 50, cacheWrite: 10, cacheRead: 200 },
      edits: ['/work/proj/src/a.ts', '/work/proj/src/b.ts'],
    })
    .call({ usage: { input: 5, output: 6 }, iterationsShape: 'with-iterations' })
    .call({ usage: { input: 8, output: 9, cacheRead: 4 }, iterationsShape: 'zero-top-with-iterations' });
}

describe('SessionBuilder', () => {
  it('emits a user record before each assistant record with the verified envelope', () => {
    const lines = parseLines(buildSampleSession().build());
    expect(lines).toHaveLength(6);

    for (let i = 0; i < lines.length; i += 2) {
      const user = lines[i]!;
      const assistant = lines[i + 1]!;

      // user record: no usage, no requestId
      expect(user.type).toBe('user');
      expect(user.sessionId).toBe(SID);
      expect(user.requestId).toBeUndefined();
      expect(user.message?.role).toBe('user');
      expect(user.message?.usage).toBeUndefined();

      // assistant envelope (verified v2.1.202 structure)
      expect(assistant.type).toBe('assistant');
      expect(assistant.sessionId).toBe(SID);
      expect(assistant.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(assistant.cwd).toBe('/work/proj');
      expect(assistant.gitBranch).toBe('main');
      expect(assistant.isSidechain).toBe(false);
      expect(assistant.requestId).toMatch(/^req_/);
      expect(assistant.version).toBe(FIXTURE_CLAUDE_CODE_VERSION);
      expect(typeof assistant.uuid).toBe('string');
      expect(assistant.parentUuid).toBe(user.uuid);

      // assistant message
      expect(assistant.message?.id).toMatch(/^msg_/);
      expect(assistant.message?.type).toBe('message');
      expect(assistant.message?.role).toBe('assistant');
      expect(assistant.message?.model).toBe('claude-opus-4-8');

      // user/assistant of one call share a timestamp
      expect(user.timestamp).toBe(assistant.timestamp);
    }

    // parentUuid chain: first user has null parent; later users chain to the previous assistant
    expect(lines[0]!.parentUuid).toBeNull();
    expect(lines[2]!.parentUuid).toBe(lines[1]!.uuid);
    expect(lines[4]!.parentUuid).toBe(lines[3]!.uuid);

    // deterministic-unique ids per call
    const messageIds = [lines[1], lines[3], lines[5]].map((l) => l!.message?.id);
    const requestIds = [lines[1], lines[3], lines[5]].map((l) => l!.requestId);
    expect(new Set(messageIds).size).toBe(3);
    expect(new Set(requestIds).size).toBe(3);
    const uuids = lines.map((l) => l.uuid);
    expect(new Set(uuids).size).toBe(6);
  });

  it('pins the clock with .at() and auto-advances 1s per call', () => {
    const lines = parseLines(buildSampleSession().build());
    expect(lines[1]!.timestamp).toBe('2026-03-01T10:00:00.000Z');
    expect(lines[3]!.timestamp).toBe('2026-03-01T10:00:01.000Z');
    expect(lines[5]!.timestamp).toBe('2026-03-01T10:00:02.000Z');
  });

  it('emits edits as sanitized Edit tool_use blocks', () => {
    const lines = parseLines(buildSampleSession().build());
    const content = lines[1]!.message?.content ?? [];
    expect(content[0]?.type).toBe('text');
    expect(content[0]?.text).toBe('[sanitized]');

    const toolUses = content.filter((b) => b.type === 'tool_use');
    expect(toolUses).toHaveLength(2);
    expect(toolUses.map((b) => b.input?.file_path)).toEqual([
      '/work/proj/src/a.ts',
      '/work/proj/src/b.ts',
    ]);
    for (const block of toolUses) {
      expect(block.id).toMatch(/^toolu_/);
      expect(block.name).toBe('Edit');
      expect(block.input?.old_string).toBe('[sanitized]');
      expect(block.input?.new_string).toBe('[sanitized]');
    }

    // no-edit calls carry no tool_use blocks
    const content2 = lines[3]!.message?.content ?? [];
    expect(content2.every((b) => b.type !== 'tool_use')).toBe(true);
  });

  it('shapes usage per iterationsShape exactly as verified in contracts.md', () => {
    const lines = parseLines(buildSampleSession().build());

    // top-level-only: truth at top level, no iterations
    const plain = lines[1]!.message?.usage;
    expect(plain).toMatchObject({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 10,
      cache_read_input_tokens: 200,
    });
    expect(plain?.iterations).toBeUndefined();

    // with-iterations: top-level equals LAST iteration; earlier one is a failed attempt
    const withIter = lines[3]!.message?.usage;
    expect(withIter).toMatchObject({ input_tokens: 5, output_tokens: 6 });
    expect(withIter?.iterations).toHaveLength(2);
    const [failed, landed] = withIter!.iterations!;
    expect(failed).toMatchObject({ ...FAILED_ITERATION_TOKENS, type: 'fallback_message' });
    expect(landed).toMatchObject({
      input_tokens: 5,
      output_tokens: 6,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      type: 'message',
    });

    // zero-top-with-iterations: zeroed top level; iterations SUM to the spec'd usage
    const zeroTop = lines[5]!.message?.usage;
    expect(zeroTop).toMatchObject({
      input_tokens: 0,
      output_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    });
    const iters = zeroTop!.iterations!;
    expect(iters.length).toBeGreaterThan(0);
    const sum = iters.reduce(
      (acc, it2) => ({
        input: acc.input + it2.input_tokens,
        output: acc.output + it2.output_tokens,
        cacheWrite: acc.cacheWrite + it2.cache_creation_input_tokens,
        cacheRead: acc.cacheRead + it2.cache_read_input_tokens,
      }),
      { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 },
    );
    expect(sum).toEqual({ input: 8, output: 9, cacheWrite: 0, cacheRead: 4 });
    for (const it2 of iters) expect(it2.type).toBe('message');
  });

  it('is deterministic: identical scripts build byte-identical JSONL', () => {
    expect(buildSampleSession().build()).toBe(buildSampleSession().build());
  });

  it('honors per-call overrides (cwd, branch:null, sidechain, model, ids)', () => {
    const lines = parseLines(
      session({ sessionId: SID, defaultCwd: '/work/proj' })
        .at('2026-03-02T00:00:00Z')
        .call({
          usage: { input: 1, output: 2 },
          cwd: '/elsewhere/repo',
          branch: null,
          sidechain: true,
          model: 'claude-haiku-5',
          messageId: 'msg_fixed01',
          requestId: 'req_fixed01',
        })
        .build(),
    );
    const assistant = lines[1]!;
    expect(assistant.cwd).toBe('/elsewhere/repo');
    expect('gitBranch' in assistant).toBe(false);
    expect(assistant.isSidechain).toBe(true);
    expect(assistant.message?.model).toBe('claude-haiku-5');
    expect(assistant.message?.id).toBe('msg_fixed01');
    expect(assistant.requestId).toBe('req_fixed01');
  });

  it('injects raw lines verbatim for malformed-line scenarios', () => {
    const text = session({ sessionId: SID })
      .at('2026-03-02T00:00:00Z')
      .call({ usage: { input: 1, output: 1 } })
      .raw('this is not json {{{')
      .raw('{"type":"assistant","truncated":tru')
      .build();
    const rawLines = text.trimEnd().split('\n');
    expect(rawLines[2]).toBe('this is not json {{{');
    expect(rawLines[3]).toBe('{"type":"assistant","truncated":tru');
  });
});

describe('writeTranscripts', () => {
  it('writes <dir>/projects/<encoded-cwd>/<sessionId>.jsonl', async () => {
    const dir = await tmpDir('vibebill-transcripts-');
    const builder = session({ sessionId: SID, defaultCwd: '/work/my.proj' })
      .at('2026-03-01T10:00:00Z')
      .call({ usage: { input: 1, output: 1 } });

    const files = await writeTranscripts(dir, [builder]);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(path.join(dir, 'projects', '-work-my-proj', `${SID}.jsonl`));
    expect(encodeProjectDir('/work/my.proj')).toBe('-work-my-proj');
    expect((await stat(files[0]!)).isFile()).toBe(true);
    expect(await readFile(files[0]!, 'utf8')).toBe(builder.build());
  });

  it('supports duplicate emission: same sessionId in two files via fileName override', async () => {
    const dir = await tmpDir('vibebill-transcripts-');
    const mk = (): SessionBuilder =>
      session({ sessionId: SID, defaultCwd: '/work/proj' })
        .at('2026-03-02T00:00:00Z')
        .call({
          usage: { input: 10, output: 20, cacheRead: 30 },
          messageId: 'msg_fixed01',
          requestId: 'req_fixed01',
        });

    const files = await writeTranscripts(dir, [
      mk(),
      { builder: mk(), fileName: `${SID}.resumed.jsonl` },
    ]);
    expect(files).toHaveLength(2);
    expect(new Set(files).size).toBe(2);

    const [a, b] = await Promise.all(files.map((f) => readFile(f, 'utf8')));
    expect(a).toBe(b); // the exact same call emitted twice
    for (const text of [a!, b!]) {
      expect(text).toContain('"id":"msg_fixed01"');
      expect(text).toContain('"requestId":"req_fixed01"');
    }
  });

  it('refuses two sessions targeting the same file path', async () => {
    const dir = await tmpDir('vibebill-transcripts-');
    const mk = (): SessionBuilder =>
      session({ sessionId: SID, defaultCwd: '/work/proj' })
        .at('2026-03-02T00:00:00Z')
        .call({ usage: { input: 1, output: 1 } });
    await expect(writeTranscripts(dir, [mk(), mk()])).rejects.toThrow(/same|disambiguate|target/i);
  });
});

// ---------------------------------------------------------------------------
// repo.ts
// ---------------------------------------------------------------------------

describe('makeRepo', () => {
  it('produces commits with exactly the controlled author dates', async () => {
    const base = await tmpDir('vibebill-repo-base-');
    const repo = await makeRepo(base);

    const h1 = await repo.commitFile('a.txt', 'one\n', {
      message: 'c1',
      authorDate: '2026-01-02T03:04:05+00:00',
    });
    const h2 = await repo.commitFile('b.txt', 'two\n', {
      message: 'c2',
      authorDate: Date.UTC(2026, 0, 3, 4, 5, 6), // ms number input
    });
    const h3 = await repo.commitFiles(
      [
        ['c.txt', 'three\n'],
        ['d/e.txt', 'four\n'],
      ],
      { message: 'c3', authorDate: '2026-01-04T00:00:00+00:00' },
    );

    expect(toGitIsoDate(Date.UTC(2026, 0, 3, 4, 5, 6))).toBe('2026-01-03T04:05:06+00:00');

    // git ≥ 2.45 prints strict-ISO UTC as "…Z", older git as "…+00:00" —
    // compare parsed instants, not strings, so the test is git-version agnostic.
    const log = await repo.git(['log', '--pretty=format:%H %aI %cI %s']);
    const rows = log.split('\n').map((line) => {
      const [hash, aI, cI, ...subject] = line.split(' ');
      return {
        hash,
        authorMs: Date.parse(aI as string),
        committerMs: Date.parse(cI as string),
        subject: subject.join(' '),
      };
    });
    expect(rows).toEqual([
      {
        hash: h3,
        authorMs: Date.UTC(2026, 0, 4),
        committerMs: Date.UTC(2026, 0, 4),
        subject: 'c3',
      },
      {
        hash: h2,
        authorMs: Date.UTC(2026, 0, 3, 4, 5, 6),
        committerMs: Date.UTC(2026, 0, 3, 4, 5, 6),
        subject: 'c2',
      },
      {
        hash: h1,
        authorMs: Date.UTC(2026, 0, 2, 3, 4, 5),
        committerMs: Date.UTC(2026, 0, 2, 3, 4, 5),
        subject: 'c1',
      },
    ]);

    // real 40-hex hashes, current branch is main
    for (const h of [h1, h2, h3]) expect(h).toMatch(/^[0-9a-f]{40}$/);
    expect(await repo.git(['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('main');
    expect(await repo.head()).toBe(h3);
  });

  it('merge creates a 2-parent commit; squashMerge a 1-parent commit with the branch files', async () => {
    const base = await tmpDir('vibebill-repo-base-');
    const repo = await makeRepo(base);
    await repo.commitFile('base.txt', 'base\n', {
      message: 'base',
      authorDate: '2026-02-01T00:00:00+00:00',
    });

    // true merge
    await repo.branch('feat');
    await repo.checkout('feat');
    await repo.commitFile('feat.txt', 'feat\n', {
      message: 'feat work',
      authorDate: '2026-02-02T00:00:00+00:00',
    });
    await repo.checkout('main');
    const mergeHash = await repo.merge('feat', { authorDate: '2026-02-03T00:00:00+00:00' });
    const mergeParents = (await repo.git(['rev-list', '--parents', '-n', '1', mergeHash])).split(' ');
    expect(mergeParents).toHaveLength(3); // self + 2 parents

    // squash merge
    await repo.branch('feat2');
    await repo.checkout('feat2');
    await repo.commitFiles(
      [
        ['sq/x.txt', 'x\n'],
        ['sq/y.txt', 'y\n'],
      ],
      { message: 'feat2 work', authorDate: '2026-02-04T00:00:00+00:00' },
    );
    await repo.checkout('main');
    const squashHash = await repo.squashMerge(
      'feat2',
      'squash feat2',
      '2026-02-05T00:00:00+00:00',
    );
    const squashParents = (await repo.git(['rev-list', '--parents', '-n', '1', squashHash])).split(
      ' ',
    );
    expect(squashParents).toHaveLength(2); // self + 1 parent: a normal commit

    const squashFiles = (
      await repo.git(['show', '--name-only', '--pretty=format:', squashHash])
    )
      .split('\n')
      .filter((line) => line !== '');
    expect(squashFiles.sort()).toEqual(['sq/x.txt', 'sq/y.txt']);
    // Parsed-instant comparison: git version differences in UTC suffix ("Z"
    // vs "+00:00") must not matter.
    expect(Date.parse(await repo.git(['log', '-1', '--pretty=%aI', squashHash]))).toBe(
      Date.UTC(2026, 1, 5),
    );
  });

  it('is deterministic: the same script yields identical hashes in two fresh repos', async () => {
    const script = async (): Promise<string[]> => {
      const base = await tmpDir('vibebill-repo-det-');
      const repo = await makeRepo(base);
      const hashes: string[] = [];
      hashes.push(
        await repo.commitFile('a.txt', 'alpha\n', {
          message: 'c1',
          authorDate: '2026-03-01T00:00:00+00:00',
        }),
      );
      await repo.branch('side');
      await repo.checkout('side');
      hashes.push(
        await repo.commitFile('s.txt', 'side\n', {
          message: 'side work',
          authorDate: '2026-03-02T00:00:00+00:00',
        }),
      );
      await repo.checkout('main');
      hashes.push(await repo.merge('side', { authorDate: '2026-03-03T00:00:00+00:00' }));
      return hashes;
    };

    const [first, second] = await Promise.all([script(), script()]);
    expect(first).toEqual(second);
  });
});
