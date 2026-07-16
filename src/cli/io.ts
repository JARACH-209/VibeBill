/**
 * Output plumbing for the CLI: commands write lines through a CliIO so tests
 * can capture output without spawning a process. stdout carries the primary
 * (human or --json) output; stderr carries warnings and progress notes so
 * `--json` stdout always stays machine-parseable.
 */

export interface CliIO {
  /** Write one line to stdout. */
  out(line: string): void;
  /** Write one line to stderr. */
  err(line: string): void;
}

/** The real process stdout/stderr as a CliIO. */
export const processIO: CliIO = {
  out: (line: string) => process.stdout.write(`${line}\n`),
  err: (line: string) => process.stderr.write(`${line}\n`),
};

/** An in-memory CliIO that records lines for assertions in tests. */
export function captureIO(): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout,
    stderr,
    out: (line: string) => {
      stdout.push(line);
    },
    err: (line: string) => {
      stderr.push(line);
    },
  };
}
