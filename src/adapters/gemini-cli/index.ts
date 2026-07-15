/**
 * Gemini CLI source adapter (v0.2, docs/contracts.md): discovers chat
 * recordings under `<root>/tmp/<slug>/chats/` — JSONL sessions plus the
 * legacy pre-2026-04 single-document .json format — and stream-parses them
 * into UsageEvents. Transcript directories are opened read-only.
 */
import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import type { SourceAdapter } from '../../core/types.js';
import { ProjectRootResolver, analyzeChatPath } from './cwd.js';
import { parseGeminiJsonlFile, parseGeminiLegacyJsonFile } from './parser.js';
import type { GeminiFileContext } from './parser.js';

/**
 * The format mapping is source-verified (gemini-cli v0.50 chatRecordingService.ts)
 * but was NOT verified against live samples on this machine, so doctor must
 * surface parse coverage prominently (spec §5.1).
 */
export const GEMINI_CLI_SCHEMA_VERIFIED = false;

/** Transcript root: explicit option, then $VIBEBILL_GEMINI_DIR, then ~/.gemini. */
function resolveRoot(explicit: string | undefined): string {
  if (explicit !== undefined && explicit.length > 0) {
    return explicit;
  }
  const env = process.env['VIBEBILL_GEMINI_DIR'];
  if (env !== undefined && env.length > 0) {
    return env;
  }
  return join(homedir(), '.gemini');
}

/** Session id fallback from the chat file name, used when the metadata line is unusable. */
function sessionIdFromFileName(filePath: string): string {
  return basename(filePath).replace(/\.jsonl?$/, '');
}

/** Recursively collect *.jsonl and *.json chat files; unreadable dirs yield nothing. */
async function collectChatFiles(dir: string, out: string[]): Promise<void> {
  let entries: Dirent[];
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // missing or unreadable directory: no files, never a crash
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectChatFiles(path, out);
    } else if (entry.isFile() && (entry.name.endsWith('.jsonl') || entry.name.endsWith('.json'))) {
      out.push(path);
    }
  }
}

/** All chat files under `<root>/tmp/<slug>/chats/` (recursive), sorted for deterministic order. */
async function discoverChatFiles(tmpDir: string): Promise<string[]> {
  let slugs: Dirent[];
  try {
    slugs = await readdir(tmpDir, { withFileTypes: true });
  } catch {
    return []; // missing root ⇒ no transcripts (spec §10: partial data is normal)
  }
  const out: string[] = [];
  for (const slug of slugs) {
    if (slug.isDirectory()) {
      await collectChatFiles(join(tmpDir, slug.name, 'chats'), out);
    }
  }
  return out.sort();
}

/** Gemini CLI chat-recording adapter (spec §5.1.5 interface, contracts.md format). */
export function createGeminiCliAdapter(opts?: { geminiDir?: string }): SourceAdapter {
  const root = resolveRoot(opts?.geminiDir);
  const tmpDir = join(root, 'tmp');
  const resolver = new ProjectRootResolver(root);
  return {
    id: 'gemini-cli',
    schemaVerified: GEMINI_CLI_SCHEMA_VERIFIED,
    discover: () => discoverChatFiles(tmpDir),
    async parseFile(filePath, sink, parseOpts) {
      const pathInfo = analyzeChatPath(filePath, tmpDir);
      const ctx: GeminiFileContext = {
        sourceFile: filePath,
        cwd: await resolver.resolveForChatFile(filePath),
        nestedSidechain: pathInfo.nested,
        fallbackSessionId: sessionIdFromFileName(filePath),
      };
      if (filePath.endsWith('.json')) {
        return parseGeminiLegacyJsonFile(filePath, sink, ctx);
      }
      return parseGeminiJsonlFile(filePath, sink, ctx, parseOpts);
    },
  };
}
