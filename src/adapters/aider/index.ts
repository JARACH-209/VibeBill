/**
 * aider chat-history adapter (v0.2, docs/contracts.md). aider logs live
 * INSIDE the repo (`<repoRoot>/.aider.chat.history.md`), so the factory takes
 * the repo root rather than a home-directory override. The format is
 * source-verified against aider v0.86 but not sample-verified on this
 * machine, so schemaVerified is false and `vibebill doctor` must surface
 * parse coverage prominently.
 */
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

import type { SourceAdapter } from '../../core/types.js';
import { parseAiderFile } from './parser.js';

/** Format implemented from aider source (v0.86), not verified against local samples. */
export const AIDER_SCHEMA_VERIFIED = false;

/** One-sentence precision caveat for `vibebill doctor` to print (contracts.md). */
export const AIDER_PRECISION_NOTE =
  'aider rounds token counts in its history file to roughly two significant figures ("4.2k" = 4200), so aider-sourced token and cost figures are approximations at that precision.';

/** Default history file name aider writes at the repo root. */
const HISTORY_BASENAME = '.aider.chat.history.md';

/**
 * Create the aider SourceAdapter for one repo; discovery returns the repo's
 * `.aider.chat.history.md` when present, plus an explicit history file named
 * by $VIBEBILL_AIDER_HISTORY (additive convenience for relocated logs).
 */
export function createAiderAdapter(opts: { repoRoot: string }): SourceAdapter {
  const repoRoot = resolve(opts.repoRoot);
  return {
    id: 'aider',
    schemaVerified: AIDER_SCHEMA_VERIFIED,
    async discover(): Promise<string[]> {
      const candidates: string[] = [];
      const envPath = process.env['VIBEBILL_AIDER_HISTORY'];
      if (envPath !== undefined && envPath.length > 0) {
        candidates.push(resolve(envPath));
      }
      candidates.push(resolve(repoRoot, HISTORY_BASENAME));
      const found: string[] = [];
      for (const candidate of candidates) {
        if (found.includes(candidate)) {
          continue; // env var pointing at the default file: list it once
        }
        try {
          const info = await stat(candidate);
          if (info.isFile()) {
            found.push(candidate);
          }
        } catch {
          // Missing/unreadable candidate is simply not discovered (spec §10).
        }
      }
      return found.sort();
    },
    parseFile(path, sink, parseOpts) {
      return parseAiderFile(path, repoRoot, sink, parseOpts);
    },
  };
}
