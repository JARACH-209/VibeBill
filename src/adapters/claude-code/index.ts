/**
 * Claude Code source adapter (spec §5.1): discovers JSONL session transcripts
 * under `<claudeDir>/projects/<encoded-dir>/<session-uuid>.jsonl` and
 * stream-parses them into UsageEvents. Transcript directories are opened
 * READ-ONLY; nothing from message content is read besides tool_use names and
 * file paths (spec §14.3.2).
 */
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { SourceAdapter } from '../../core/types.js';
import { parseClaudeCodeFile } from './parser.js';

/** Field mapping verified against real v2.1.202 logs on a developer machine (contracts.md). */
export const CLAUDE_CODE_SCHEMA_VERIFIED = true;

/** Transcript root precedence: explicit option, $VIBEBILL_CLAUDE_DIR, ~/.claude (spec §10). */
function resolveClaudeDir(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const envDir = process.env['VIBEBILL_CLAUDE_DIR'];
  if (envDir !== undefined && envDir.length > 0) {
    return envDir;
  }
  return join(homedir(), '.claude');
}

/** Claude Code JSONL transcript adapter (spec §5.1). */
export function createClaudeCodeAdapter(opts?: { claudeDir?: string }): SourceAdapter {
  const root = resolveClaudeDir(opts?.claudeDir);
  const projectsDir = join(root, 'projects');
  return {
    id: 'claude-code',
    schemaVerified: CLAUDE_CODE_SCHEMA_VERIFIED,

    // Sorted `projects/*/*.jsonl` paths; a missing or unreadable root is not an
    // error — it simply means no transcripts (degrade honestly, spec §1.6).
    async discover(): Promise<string[]> {
      let projectEntries;
      try {
        projectEntries = await readdir(projectsDir, { withFileTypes: true });
      } catch {
        return [];
      }
      const files: string[] = [];
      for (const project of projectEntries) {
        if (!project.isDirectory()) {
          continue;
        }
        const projectPath = join(projectsDir, project.name);
        let sessionEntries;
        try {
          sessionEntries = await readdir(projectPath, { withFileTypes: true });
        } catch {
          continue; // project dir vanished or unreadable: skip it, never throw
        }
        for (const session of sessionEntries) {
          if (session.isFile() && session.name.endsWith('.jsonl')) {
            files.push(join(projectPath, session.name));
          }
        }
      }
      return files.sort();
    },

    parseFile: parseClaudeCodeFile,
  };
}
