/**
 * --since/--until parsing (spec §6): ISO dates or git-log-style relative expressions.
 * Relative expressions resolve against an injected `nowMs` so command output stays
 * deterministic for a fixed clock.
 */

import { CliUserError } from '../core/errors.js';

const RELATIVE_RE =
  /^(\d+)\s+(second|minute|hour|day|week|month|year)s?\s+ago$/i;

const UNIT_MS: Record<string, number> = {
  second: 1_000,
  minute: 60_000,
  hour: 3_600_000,
  day: 86_400_000,
  week: 7 * 86_400_000,
  // Calendar-approximate like git's approxidate; documented in json-schemas.md.
  month: 30 * 86_400_000,
  year: 365 * 86_400_000,
};

/** Parse a --since/--until value into UTC ms; throws CliUserError on nonsense. */
export function parseDateFlag(value: string, nowMs: number, flagName: string): number {
  const trimmed = value.trim();
  if (/^yesterday$/i.test(trimmed)) return nowMs - UNIT_MS['day']!;
  if (/^today$/i.test(trimmed)) return nowMs;
  const rel = RELATIVE_RE.exec(trimmed);
  if (rel) {
    const n = Number(rel[1]);
    const unit = rel[2]!.toLowerCase();
    return nowMs - n * UNIT_MS[unit]!;
  }
  const abs = Date.parse(trimmed);
  if (!Number.isNaN(abs)) return abs;
  throw new CliUserError(
    `Could not parse ${flagName} value ${JSON.stringify(value)}.`,
    `Use an ISO date ("2026-07-01", "2026-07-01T12:00:00Z") or a relative expression ("2 weeks ago", "yesterday").`,
  );
}
