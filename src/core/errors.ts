/**
 * Error taxonomy mapped to exit codes by the CLI (spec §6, §10).
 * User-facing failures state: what happened, why it likely happened, what to do next.
 */

/** Expected user/environment problem (not a repo, no logs, bad flag) — exit code 1. */
export class CliUserError extends Error {
  /** Optional remedy line printed after the message. */
  readonly remedy: string | undefined;
  constructor(message: string, remedy?: string) {
    super(message);
    this.name = 'CliUserError';
    this.remedy = remedy;
  }
}

/** Unexpected internal failure — exit code 2; stack shown only with --debug. */
export class InternalError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'InternalError';
  }
}
