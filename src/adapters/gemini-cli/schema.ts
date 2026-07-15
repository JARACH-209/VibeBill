/**
 * Zod schemas for Gemini CLI chat recordings (docs/contracts.md): the JSONL
 * format written by chatRecordingService.ts (gemini-cli v0.50) and the legacy
 * pre-2026-04 single-document .json format. The format is source-verified
 * only — no local samples were available (GEMINI_CLI_SCHEMA_VERIFIED = false),
 * so every object schema uses `.passthrough()` and unknown fields are ignored,
 * never fatal (spec §5.1.3).
 */
import { z } from 'zod';

/** First JSONL line: session metadata. `kind !== "main"`, when present, marks subagent sessions. */
export const metadataSchema = z
  .object({
    sessionId: z.string(),
    projectHash: z.string().optional(),
    startTime: z.string().optional(),
    kind: z.string().optional(),
  })
  .passthrough();

/** Per-call token counts; `input` INCLUDES `cached` and `thoughts` are separate from `output`. */
export const geminiTokensSchema = z
  .object({
    input: z.number().optional(),
    output: z.number().optional(),
    cached: z.number().optional(),
    thoughts: z.number().optional(),
    tool: z.number().optional(),
    total: z.number().optional(),
  })
  .passthrough();

/**
 * One tool call on a gemini message. Only `name` and `args.file_path` are ever
 * read from tool calls (privacy, spec §14.3.2): `args` also carries
 * old_string/new_string/content which must never be stored or logged.
 */
export const toolCallSchema = z
  .object({
    name: z.string().optional(),
    args: z
      .object({ file_path: z.string().optional() })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

/** A chat message record (direct JSONL append, `$set.messages` member, or legacy doc member). */
export const messageRecordSchema = z
  .object({
    id: z.union([z.string(), z.number()]).optional(),
    timestamp: z.string().optional(),
    type: z.string(),
    model: z.string().optional(),
    tokens: geminiTokensSchema.optional().nullable(),
    toolCalls: z.array(z.unknown()).optional().nullable(),
  })
  .passthrough();

/** A `{"$set": {...}}` patch record; a `$set.messages` array REPLACES the recorded history. */
export const setPatchSchema = z
  .object({
    $set: z.object({ messages: z.array(z.unknown()).optional().nullable() }).passthrough(),
  })
  .passthrough();

/** Legacy single-document chat file (pre-2026-04): same message schema inside `messages`. */
export const legacyDocSchema = z
  .object({
    sessionId: z.string().optional(),
    projectHash: z.string().optional(),
    startTime: z.string().optional(),
    kind: z.string().optional(),
    messages: z.array(z.unknown()).optional().nullable(),
  })
  .passthrough();

/** `<root>/projects.json`: maps absolute project path → tmp slug. */
export const projectsFileSchema = z.object({ projects: z.record(z.string()) }).passthrough();

export type GeminiTokens = z.infer<typeof geminiTokensSchema>;
export type GeminiMessageRecord = z.infer<typeof messageRecordSchema>;
