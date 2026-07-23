#!/usr/bin/env node
/**
 * vibebill CLI entry (spec §6): commander wiring, global flags, error→exit-code
 * mapping (0 ok, 1 user/environment, 2 internal, 3 strict accounting mismatch),
 * the opt-in --refresh-pricing preaction, and the one-time .gitignore nudge.
 */

import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as readline from 'node:readline/promises';

import { Command } from 'commander';

import { CliUserError, InternalError } from '../core/errors.js';
import type { PlanId } from '../core/types.js';
import { GitError } from '../git/index.js';
import { refreshPricing } from '../pricing/engine.js';
import { c, setColorEnabled } from '../render/table.js';
import { buildContext, type CliContext, type GlobalFlags } from './context.js';
import { runDoctor } from './commands/doctor.js';
import { runLog } from './commands/log.js';
import { runNotes } from './commands/notes.js';
import { runPr } from './commands/pr.js';
import { runRange } from './commands/range.js';
import { runReprice } from './commands/reprice.js';
import { runReport } from './commands/report.js';
import { runShow } from './commands/show.js';
import { runSummary } from './commands/summary.js';
import { parseDateFlag } from './dates.js';
import { processIO, type CliIO } from './io.js';
import { vibebillVersion } from './version.js';

const PLAN_IDS: ReadonlySet<string> = new Set(['pro', 'max5', 'max20']);

/** The injected clock: VIBEBILL_NOW (ISO or epoch-ms) for tests, else wall clock. */
function resolveNowMs(): number {
  const env = process.env['VIBEBILL_NOW'];
  if (env !== undefined && env !== '') {
    const asInt = Number(env);
    if (Number.isFinite(asInt)) return asInt;
    const asDate = Date.parse(env);
    if (!Number.isNaN(asDate)) return asDate;
    throw new CliUserError(
      `VIBEBILL_NOW is set but unparseable: ${JSON.stringify(env)}.`,
      'Use an ISO 8601 date or epoch milliseconds.',
    );
  }
  return Date.now();
}

/** Assemble GlobalFlags from commander's parsed options. */
function globalFlags(cmd: Command): GlobalFlags {
  const o = cmd.optsWithGlobals<{
    json?: boolean;
    since?: string;
    until?: string;
    color?: boolean;
    quiet?: boolean;
    strict?: boolean;
    debug?: boolean;
    plan?: string;
    allRefs?: boolean;
    refreshPricing?: boolean;
  }>();
  const nowMs = resolveNowMs();
  if (o.plan !== undefined && !PLAN_IDS.has(o.plan)) {
    throw new CliUserError(
      `unknown --plan ${JSON.stringify(o.plan)}.`,
      'Valid plans: pro, max5, max20.',
    );
  }
  return {
    json: o.json ?? false,
    since: o.since === undefined ? null : parseDateFlag(o.since, nowMs, '--since'),
    until: o.until === undefined ? null : parseDateFlag(o.until, nowMs, '--until'),
    color: o.color ?? true,
    quiet: o.quiet ?? false,
    strict: o.strict ?? false,
    debug: o.debug ?? false,
    plan: (o.plan as PlanId | undefined) ?? null,
    allRefs: o.allRefs ?? false,
    refreshPricing: o.refreshPricing ?? false,
    nowMs,
  };
}

/**
 * One-time .gitignore nudge (spec §3): ask (TTY only) whether to append
 * `.vibebill/`; if declined or non-interactive, print the line to add. The
 * answer is recorded in .vibebill/state.json so users are asked exactly once.
 */
async function gitignoreNudge(ctx: CliContext, io: CliIO): Promise<void> {
  const statePath = path.join(ctx.repoRoot, '.vibebill', 'state.json');
  try {
    const state = JSON.parse(await fs.readFile(statePath, 'utf8')) as Record<string, unknown>;
    if (state['gitignoreHandled'] === true) return;
  } catch {
    // no state yet — first run
  }
  const gitignorePath = path.join(ctx.repoRoot, '.gitignore');
  let alreadyIgnored = false;
  try {
    const lines = (await fs.readFile(gitignorePath, 'utf8')).split('\n');
    alreadyIgnored = lines.some((l) => {
      const t = l.trim();
      return t === '.vibebill' || t === '.vibebill/' || t === '/.vibebill' || t === '/.vibebill/';
    });
  } catch {
    // no .gitignore — the nudge below covers it
  }

  if (!alreadyIgnored) {
    const interactive =
      process.stdin.isTTY === true && process.stdout.isTTY === true && !ctx.flags.json && !ctx.flags.quiet;
    if (interactive) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
      const answer = (
        await rl.question('vibebill keeps its cache in .vibebill/ — add it to .gitignore? [y/N] ')
      )
        .trim()
        .toLowerCase();
      rl.close();
      if (answer === 'y' || answer === 'yes') {
        await fs.appendFile(gitignorePath, '.vibebill/\n', 'utf8');
        io.err('added `.vibebill/` to .gitignore');
      } else {
        io.err('ok — add this line to .gitignore yourself when ready: .vibebill/');
      }
    } else {
      io.err('note: add `.vibebill/` to .gitignore (vibebill keeps its local cache there)');
    }
  }

  try {
    await fs.mkdir(path.dirname(statePath), { recursive: true });
    await fs.writeFile(statePath, JSON.stringify({ gitignoreHandled: true }) + '\n', 'utf8');
  } catch {
    // read-only checkout: the nudge just repeats next run — harmless
  }
}

/** Shared pre-command work + error mapping around each command body. */
async function execute(
  cmd: Command,
  io: CliIO,
  body: (flags: GlobalFlags) => Promise<number>,
): Promise<void> {
  let debug = false;
  try {
    const flags = globalFlags(cmd);
    debug = flags.debug;
    if (!flags.color) setColorEnabled(false);
    if (flags.refreshPricing) {
      // The ONLY network call in the program, and only because the user asked.
      try {
        const r = await refreshPricing();
        if (!flags.quiet) io.err(`refreshed pricing: ${r.modelCount} models, asOf ${r.asOf}`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        io.err(c.yellow(`--refresh-pricing failed (${msg}); kept the last known table`));
      }
    }
    process.exitCode = await body(flags);
  } catch (err) {
    if (err instanceof CliUserError) {
      io.err(c.red(err.message));
      if (err.remedy !== undefined) io.err(err.remedy);
      process.exitCode = 1;
    } else if (err instanceof GitError) {
      io.err(c.red(err.message));
      process.exitCode = 1;
    } else {
      const msg = err instanceof InternalError || err instanceof Error ? err.message : String(err);
      io.err(c.red(`vibebill internal error: ${msg}`));
      io.err('this is a bug — please file an issue: https://github.com/JARACH-209/VibeBill/issues');
      if (debug && err instanceof Error && err.stack !== undefined) io.err(err.stack);
      process.exitCode = 2;
    }
  }
}

/** Build a context, print its collected warnings, run the .gitignore nudge. */
async function contextFor(flags: GlobalFlags, io: CliIO): Promise<CliContext> {
  const ctx = await buildContext(flags);
  if (!flags.quiet) {
    for (const w of ctx.warnings) io.err(c.yellow(`vibebill: ${w}`));
  }
  await gitignoreNudge(ctx, io);
  return ctx;
}

/** Attach the global options every command shares (spec §6). */
function withGlobals(cmd: Command): Command {
  return cmd
    .option('--json', 'machine-readable output (documented in docs/json-schemas.md)')
    .option('--since <date>', 'lower time bound (ISO or git-style relative like "2 weeks ago")')
    .option('--until <date>', 'upper time bound')
    .option('--no-color', 'plain ASCII output')
    .option('--quiet', 'suppress warnings and notes on stderr')
    .option('--strict', 'exit 3 when the accounting invariant does not balance')
    .option('--debug', 'print stack traces for internal errors')
    .option('--plan <plan>', 'subscription plan wording: pro, max5 or max20')
    .option('--all-refs', 'attribute against all refs, not just HEAD history')
    .option('--refresh-pricing', 'fetch the newest community price table first (network!)');
}

export function buildProgram(io: CliIO = processIO): Command {
  const program = new Command();
  program
    .name('vibebill')
    .description('git-native cost accounting for AI-assisted repositories — measured, never guessed')
    .version(vibebillVersion(), '-V, --version')
    .enablePositionalOptions();

  withGlobals(
    program.command('doctor').description('check the environment and report parse coverage'),
  ).action(async function (this: Command) {
    await execute(this, io, (flags) => runDoctor(flags, io));
  });

  withGlobals(
    program.command('summary').description('repo-level cost rollup'),
  ).action(async function (this: Command) {
    await execute(this, io, async (flags) => runSummary(await contextFor(flags, io), io));
  });

  withGlobals(
    program
      .command('log')
      .description('git log with cost columns (newest first)')
      .argument('[range]', 'revision range (anything git rev-list accepts)')
      .option('-n, --max-count <n>', 'limit the number of commits shown'),
  ).action(async function (this: Command, range: string | undefined) {
    const opts = this.opts<{ maxCount?: string }>();
    await execute(this, io, async (flags) => {
      const maxCount = opts.maxCount === undefined ? null : Number.parseInt(opts.maxCount, 10);
      if (maxCount !== null && (!Number.isFinite(maxCount) || maxCount <= 0)) {
        throw new CliUserError('-n expects a positive integer.');
      }
      return runLog(await contextFor(flags, io), { maxCount, range: range ?? null }, io);
    });
  });

  withGlobals(
    program
      .command('show')
      .description('deep-dive on one commit: cost, sessions, evidence, confidence')
      .argument('<ref>', 'commit hash or any ref git can resolve'),
  ).action(async function (this: Command, ref: string) {
    await execute(this, io, async (flags) => runShow(await contextFor(flags, io), { ref }, io));
  });

  withGlobals(
    program
      .command('range')
      .description('cost of a release: summary restricted to A..B')
      .argument('<range>', 'revision range like v1.0.0..v1.1.0')
      .option('--label <name>', 'title for the output (used by report)'),
  ).action(async function (this: Command, range: string) {
    const opts = this.opts<{ label?: string }>();
    await execute(this, io, async (flags) =>
      runRange(await contextFor(flags, io), { range, label: opts.label ?? null }, io),
    );
  });

  withGlobals(
    program
      .command('reprice')
      .description('counterfactual: the same measured traffic on a different price card')
      .requiredOption('--model <model-id>', 'target model id (price-table key or prefix)')
      .option('--vs', 'two-column comparison against measured actuals')
      .argument('[range]', 'optional revision range restricting scope'),
  ).action(async function (this: Command, range: string | undefined) {
    const opts = this.opts<{ model: string; vs?: boolean }>();
    await execute(this, io, async (flags) =>
      runReprice(
        await contextFor(flags, io),
        { model: opts.model, range: range ?? null, vs: opts.vs ?? false },
        io,
      ),
    );
  });

  withGlobals(
    program
      .command('report')
      .description('write a self-contained markdown ledger (only explicit write)')
      .option('--md', 'markdown format (required; the only format today)')
      .option('--out <file>', 'output path', 'LEDGER.md')
      .option('--force', 'overwrite an existing file')
      .argument('[range]', 'optional revision range'),
  ).action(async function (this: Command, range: string | undefined) {
    const opts = this.opts<{ md?: boolean; out: string; force?: boolean }>();
    await execute(this, io, async (flags) =>
      runReport(
        await contextFor(flags, io),
        { md: opts.md ?? false, out: opts.out, force: opts.force ?? false, range: range ?? null },
        io,
      ),
    );
  });

  const notes = program
    .command('notes')
    .description('per-commit cost annotations under refs/notes/vibebill');
  withGlobals(
    notes
      .command('sync')
      .description('write (or with --clear, remove) vibebill notes, idempotently')
      .argument('[range]', 'optional revision range')
      .option('--clear', 'remove vibebill notes in scope instead of writing'),
  ).action(async function (this: Command, range: string | undefined) {
    const opts = this.opts<{ clear?: boolean }>();
    await execute(this, io, async (flags) =>
      runNotes(await contextFor(flags, io), { range: range ?? null, clear: opts.clear ?? false }, io),
    );
  });

  withGlobals(
    program
      .command('pr')
      .description('cost a GitHub pull request via the gh CLI (v0.2)')
      .argument('[number]', 'PR number; defaults to the current branch’s PR')
      .option('--comment', 'post or update the cost comment on the PR'),
  ).action(async function (this: Command, number: string | undefined) {
    const opts = this.opts<{ comment?: boolean }>();
    await execute(this, io, async (flags) =>
      runPr(await contextFor(flags, io), { number: number ?? null, comment: opts.comment ?? false }, io),
    );
  });

  return program;
}

/** True when this module is the process entry point (bin), not an import. */
function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return fsSync.realpathSync(entry) === fsSync.realpathSync(new URL(import.meta.url).pathname);
  } catch {
    return false;
  }
}

/** True inside a Node single-executable binary (node:sea absent on old Nodes). */
async function isSeaBinary(): Promise<boolean> {
  try {
    const sea = (await import('node:sea')) as { isSea?: () => boolean };
    return sea.isSea?.() === true;
  } catch {
    return false;
  }
}

/** Entry gate, kept awaitless at top level so the SEA bundle can be CJS (D15). */
async function runCli(): Promise<void> {
  // SEA sets argv[1] to the executable path (mimicking a script arg), so the
  // standard argv shape applies in both modes; the explicit SEA check exists
  // because isMain()'s realpath comparison is not guaranteed there.
  if ((await isSeaBinary()) || isMain()) {
    await buildProgram().parseAsync(process.argv);
  }
}

void runCli();
