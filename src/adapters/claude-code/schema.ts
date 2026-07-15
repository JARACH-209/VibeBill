/**
 * Zod schemas for Claude Code JSONL transcript lines, matching the VERIFIED
 * log-format facts in docs/contracts.md (recon against v2.1.202 logs).
 * All object schemas use `.passthrough()` so unknown fields added by future
 * Claude Code versions are ignored, never fatal (spec §5.1.3).
 */
import { z } from 'zod';

/** Loosest line envelope: any JSON object carrying a string `type` discriminator. */
export const envelopeSchema = z.object({ type: z.string() }).passthrough();

/** One retry/fallback attempt inside `message.usage.iterations`. */
export const iterationSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    type: z.string().optional(),
  })
  .passthrough();

/** Per-call `message.usage` object; all counts optional and defaulted to 0 downstream. */
export const usageSchema = z
  .object({
    input_tokens: z.number().optional(),
    output_tokens: z.number().optional(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
    iterations: z.array(iterationSchema).optional().nullable(),
  })
  .passthrough();

/** The `message` payload of an assistant record; `content` stays opaque until extraction. */
export const messageSchema = z
  .object({
    id: z.string().optional(),
    model: z.string().optional(),
    usage: usageSchema.optional().nullable(),
    content: z.unknown(),
  })
  .passthrough();

/** A full `type: "assistant"` transcript record (the only usage-bearing record type). */
export const assistantRecordSchema = z
  .object({
    type: z.literal('assistant'),
    sessionId: z.string(),
    timestamp: z.string(),
    cwd: z.string().optional().nullable(),
    gitBranch: z.string().optional().nullable(),
    isSidechain: z.boolean().optional(),
    requestId: z.string().optional(),
    message: messageSchema.optional().nullable(),
  })
  .passthrough();

/**
 * A content block that names a file-editing tool; only `name` and the file
 * path fields are ever read from content blocks (privacy, spec §14.3.2).
 */
export const toolUseBlockSchema = z
  .object({
    type: z.literal('tool_use'),
    name: z.string(),
    input: z
      .object({
        file_path: z.string().optional(),
        notebook_path: z.string().optional(),
      })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

export type RawUsage = z.infer<typeof usageSchema>;
export type AssistantRecord = z.infer<typeof assistantRecordSchema>;
