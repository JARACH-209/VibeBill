/**
 * `vibebill doctor` (spec §6.1): environment self-check — the first thing
 * users run. Unlike every other command it never requires a working setup:
 * each check reports pass/fail with a remedy and doctor exits 0 whenever the
 * diagnosis itself completed. It performs a DRY ingest (never touches the
 * cache) so it can report parse coverage and unknown models honestly.
 */

import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';

import { AIDER_PRECISION_NOTE, AIDER_SCHEMA_VERIFIED } from '../../adapters/aider/index.js';
import { CLAUDE_CODE_SCHEMA_VERIFIED } from '../../adapters/claude-code/index.js';
import { CODEX_SCHEMA_VERIFIED } from '../../adapters/codex/index.js';
import { GEMINI_CLI_SCHEMA_VERIFIED } from '../../adapters/gemini-cli/index.js';
import { readCache } from '../../cache/index.js';
import { loadRepoConfig } from '../../core/config.js';
import { ingestEvents, type IngestResult } from '../../core/ingest.js';
import type { AgentId } from '../../core/types.js';
import { totalTokens } from '../../core/types.js';
import { isShallowRepository, resolveRepoRoot } from '../../git/index.js';
import { loadEffectivePrices, matchModel } from '../../pricing/engine.js';
import { c } from '../../render/table.js';
import { cacheDirFor, makeAdapters, type GlobalFlags } from '../context.js';
import type { CliIO } from '../io.js';
import { formatBytes, glyphs, pct1, printJson } from '../render.js';
import { vibebillVersion } from '../version.js';

const execFileP = promisify(execFile);

/** One doctor check result. */
export interface DoctorCheck {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
  remedy?: string;
}

const SCHEMA_VERIFIED: Record<AgentId, boolean> = {
  'claude-code': CLAUDE_CODE_SCHEMA_VERIFIED,
  codex: CODEX_SCHEMA_VERIFIED,
  'gemini-cli': GEMINI_CLI_SCHEMA_VERIFIED,
  aider: AIDER_SCHEMA_VERIFIED,
};

/** Default transcript root shown to the user for each adapter. */
function adapterRoot(id: AgentId, repoRoot: string | null): string {
  switch (id) {
    case 'claude-code':
      return process.env['VIBEBILL_CLAUDE_DIR'] ?? path.join(os.homedir(), '.claude');
    case 'codex':
      return process.env['VIBEBILL_CODEX_DIR'] ?? path.join(os.homedir(), '.codex');
    case 'gemini-cli':
      return process.env['VIBEBILL_GEMINI_DIR'] ?? path.join(os.homedir(), '.gemini');
    case 'aider':
      return repoRoot === null ? '(needs a git repo)' : path.join(repoRoot, '.aider.chat.history.md');
  }
}

/** Run `vibebill doctor`; returns the process exit code (0 when diagnosis ran). */
export async function runDoctor(flags: GlobalFlags, io: CliIO): Promise<number> {
  const checks: DoctorCheck[] = [];
  const jsonExtras: Record<string, unknown> = {};

  // --- git + repo -----------------------------------------------------------
  let gitVersion: string | null = null;
  try {
    gitVersion = (await execFileP('git', ['--version'])).stdout.trim();
    checks.push({ name: 'git', status: 'ok', detail: gitVersion });
  } catch {
    checks.push({
      name: 'git',
      status: 'fail',
      detail: 'git binary not found on PATH',
      remedy: 'Install git — vibebill shells out to it for all repository access.',
    });
  }

  let repoRoot: string | null = null;
  if (gitVersion !== null) {
    try {
      repoRoot = await resolveRepoRoot(process.cwd());
      checks.push({ name: 'repository', status: 'ok', detail: repoRoot });
      if (await isShallowRepository(repoRoot)) {
        checks.push({
          name: 'history depth',
          status: 'warn',
          detail: 'shallow clone — history-based attribution is truncated (spec §7.15)',
          remedy: 'Run `git fetch --unshallow` for full attribution.',
        });
      }
    } catch {
      checks.push({
        name: 'repository',
        status: 'fail',
        detail: `not inside a git repository (cwd: ${process.cwd()})`,
        remedy: 'Run vibebill from inside the repo you want to account for.',
      });
    }
  }

  // --- config + plan --------------------------------------------------------
  const config = repoRoot === null ? null : await loadRepoConfig(repoRoot);
  if (config !== null) {
    for (const w of config.warnings) {
      checks.push({ name: 'config', status: 'warn', detail: w });
    }
    const plan = flags.plan ?? config.plan;
    checks.push({
      name: 'plan mode',
      status: 'ok',
      detail:
        plan === null
          ? 'off — costs shown as measured API dollars'
          : `${plan} — costs shown as API-equivalent value (wording only, no plan-price math)`,
    });
  }

  // --- pricing --------------------------------------------------------------
  const prices = loadEffectivePrices();
  checks.push({
    name: 'pricing table',
    status: 'ok',
    detail: `asOf ${prices.table.asOf} (${prices.origin}), ${Object.keys(prices.table.models).length} model prefixes`,
    ...(prices.origin === 'bundled'
      ? { remedy: 'Optionally run any command with --refresh-pricing for the newest community table.' }
      : {}),
  });
  for (const w of prices.warnings) checks.push({ name: 'pricing', status: 'warn', detail: w });

  // --- adapters: discovery + dry ingest --------------------------------------
  const adapterIds = config?.adapters ?? (['claude-code', 'codex', 'gemini-cli', 'aider'] as AgentId[]);
  const adapterReports: Array<Record<string, unknown>> = [];
  let ingest: IngestResult | null = null;

  if (repoRoot !== null) {
    const adapters = makeAdapters(adapterIds, repoRoot);
    for (const adapter of adapters) {
      const root = adapterRoot(adapter.id, repoRoot);
      const files = await adapter.discover();
      let bytes = 0;
      let oldest = Number.POSITIVE_INFINITY;
      let newest = Number.NEGATIVE_INFINITY;
      for (const f of files) {
        try {
          const st = await fs.stat(f);
          bytes += st.size;
          oldest = Math.min(oldest, st.mtimeMs);
          newest = Math.max(newest, st.mtimeMs);
        } catch {
          // unreadable file: the dry ingest below counts it as skipped
        }
      }
      const dateRange =
        files.length === 0
          ? ''
          : `, ${new Date(oldest).toISOString().slice(0, 10)} … ${new Date(newest).toISOString().slice(0, 10)}`;
      const verified = SCHEMA_VERIFIED[adapter.id];
      checks.push({
        name: `adapter ${adapter.id}`,
        status: files.length > 0 ? 'ok' : 'warn',
        detail:
          files.length > 0
            ? `${files.length} transcript file${files.length === 1 ? '' : 's'} (${formatBytes(bytes)}${dateRange}) under ${root}` +
              (verified ? '' : ' — format implemented from source research, not yet verified on this machine')
            : `no transcripts found under ${root}`,
        ...(files.length === 0
          ? { remedy: `Fine if you don't use ${adapter.id}; otherwise check the path or its VIBEBILL_*_DIR override.` }
          : {}),
      });
      adapterReports.push({
        id: adapter.id,
        root,
        files: files.length,
        bytes,
        schemaVerified: verified,
      });
    }
    if (adapterIds.includes('aider')) {
      checks.push({ name: 'aider precision', status: 'warn', detail: AIDER_PRECISION_NOTE });
    }

    // Dry ingest: parse coverage + unknown models, never touching the cache.
    ingest = await ingestEvents({
      repoRoot,
      adapters,
      cacheDir: cacheDirFor(repoRoot),
      noCache: true,
    });
    const s = ingest.stats;
    const coverage = pct1(s.linesRead - s.linesSkipped, s.linesRead);
    checks.push({
      name: 'parse coverage',
      status: s.linesSkipped === 0 ? 'ok' : 'warn',
      detail:
        `${s.filesRead}/${s.filesFound} files read, ${s.linesRead} lines, ` +
        `${s.eventsExtracted} events, ${s.linesSkipped} skipped` +
        (coverage === null ? '' : ` (${coverage}% coverage)`) +
        `, ${s.duplicatesRemoved} duplicates removed`,
      ...(s.linesSkipped > 0
        ? { remedy: 'Some lines did not match the known format — please report a sample via a GitHub issue.' }
        : {}),
    });
    checks.push({
      name: 'repo scope',
      status: 'ok',
      detail:
        `${ingest.events.length} events belong to this repo; ` +
        `${ingest.outOfScope.events} events (${ingest.outOfScope.tokens} tokens) belong to other directories`,
    });

    const unknown = new Map<string, number>();
    for (const e of ingest.events) {
      if (matchModel(prices.table, e.model) === null) {
        unknown.set(e.model, (unknown.get(e.model) ?? 0) + totalTokens(e.tokens));
      }
    }
    if (unknown.size > 0) {
      const list = [...unknown.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([m, t]) => `${JSON.stringify(m)} (${t} tokens)`)
        .join(', ');
      checks.push({
        name: 'unknown models',
        status: 'warn',
        detail: `no price for: ${list} — their costs will show $—`,
        remedy: 'Try --refresh-pricing, or contribute a price-table PR.',
      });
    } else {
      checks.push({ name: 'unknown models', status: 'ok', detail: 'every model in scope has a price' });
    }
    jsonExtras['unknownModels'] = [...unknown.keys()].sort();

    // Cache status (read-only peek).
    const cache = await readCache(cacheDirFor(repoRoot));
    checks.push({
      name: 'cache',
      status: 'ok',
      detail:
        cache === null
          ? 'cold — will be built by the first report command'
          : `warm: ${Object.keys(cache.manifest.files).length} transcript files indexed`,
    });
  }

  // --- output ----------------------------------------------------------------
  const failed = checks.filter((ch) => ch.status === 'fail').length;
  if (flags.json) {
    printJson(
      {
        schemaVersion: 1,
        command: 'doctor',
        vibebill: vibebillVersion(),
        ok: failed === 0,
        checks: checks.map((ch) => ({
          name: ch.name,
          status: ch.status,
          detail: ch.detail,
          remedy: ch.remedy ?? null,
        })),
        adapters: adapterReports,
        parse: ingest === null ? null : { ...ingest.stats, outOfScope: ingest.outOfScope },
        ...jsonExtras,
      },
      (l) => io.out(l),
    );
    return 0;
  }

  const g = glyphs();
  io.out(c.bold(`vibebill doctor ${g.dot} v${vibebillVersion()}`));
  io.out('');
  for (const ch of checks) {
    const mark =
      ch.status === 'ok' ? c.green(g.check) : ch.status === 'warn' ? c.yellow('!') : c.red(g.cross);
    io.out(`${mark} ${ch.name}: ${ch.detail}`);
    if (ch.remedy !== undefined) io.out(c.dim(`    ${g.arrow} ${ch.remedy}`));
  }
  io.out('');
  io.out(
    failed === 0
      ? c.green('diagnosis complete — vibebill is ready; try `vibebill log`')
      : c.red(`diagnosis complete — ${failed} blocking problem${failed === 1 ? '' : 's'} above`),
  );
  return 0;
}
