/**
 * Codex CLI source adapter (v0.2, spec §5.1.5). Discovers rollout JSONL files
 * under `<root>/sessions/**` and stream-parses them per the VERIFIED format
 * facts in docs/contracts.md. Transcript directories are opened READ-ONLY.
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SourceAdapter } from '../../core/types.js';
import { parseCodexFile } from './parser.js';

/** Field mapping verified against real Codex v0.138 rollout files (docs/contracts.md). */
export const CODEX_SCHEMA_VERIFIED = true;

/** Recursively collect *.jsonl files; missing/unreadable directories yield nothing. */
async function collectJsonlFiles(dir: string, out: string[]): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing root or unreadable subdir — tolerated, never fatal (spec §5.1.3)
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectJsonlFiles(full, out);
    } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      out.push(full);
    }
  }
}

/** Codex CLI rollout JSONL adapter (v0.2). */
export function createCodexAdapter(opts?: { codexDir?: string }): SourceAdapter {
  // Precedence: explicit option > VIBEBILL_CODEX_DIR > ~/.codex (contracts.md).
  const root = opts?.codexDir ?? process.env['VIBEBILL_CODEX_DIR'] ?? join(homedir(), '.codex');
  const sessionsDir = join(root, 'sessions');
  return {
    id: 'codex',
    schemaVerified: CODEX_SCHEMA_VERIFIED,
    async discover(): Promise<string[]> {
      const files: string[] = [];
      await collectJsonlFiles(sessionsDir, files);
      files.sort(); // deterministic order — ingest dedupe depends on it
      return files;
    },
    parseFile: (path, sink, parseOpts) => parseCodexFile(path, sink, parseOpts),
  };
}
