/**
 * Zod schemas for Codex CLI rollout JSONL lines, matching the VERIFIED
 * log-format facts in docs/contracts.md (recon against v0.138 rollouts).
 * All object schemas use `.passthrough()` so unknown fields added by future
 * Codex versions are ignored, never fatal (spec §5.1.3).
 */
import { z } from 'zod';

/** Loosest line envelope: `{ timestamp, type, payload }` with a string discriminator. */
export const envelopeSchema = z
  .object({
    type: z.string(),
    timestamp: z.string().optional(),
    payload: z.unknown(),
  })
  .passthrough();

/**
 * `session_meta.payload` — names the session and supplies the initial cwd.
 * `source` is a scalar ("cli"/"vscode") on user sessions and an object with a
 * `subagent` key on subagent sessions; `git` may be an object, false-y, or
 * absent — both stay `unknown` here and are narrowed defensively downstream.
 */
export const sessionMetaPayloadSchema = z
  .object({
    id: z.string(),
    cwd: z.string().optional().nullable(),
    thread_source: z.string().optional().nullable(),
    source: z.unknown().optional(),
    git: z.unknown().optional(),
  })
  .passthrough();

/** `turn_context.payload` — stateful: latest one supplies model + cwd for later events. */
export const turnContextPayloadSchema = z
  .object({
    cwd: z.string().optional().nullable(),
    model: z.string().optional().nullable(),
  })
  .passthrough();

/**
 * A token count must be a safe non-negative integer: fractional values would
 * throw at the BigInt pricing boundary and negatives would corrupt the
 * conservation sums, so a record carrying either is malformed (spec §14.3.5).
 */
const tokenCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

/** One raw usage object (`last_token_usage` / `total_token_usage`); counts default 0. */
export const rawTokenUsageSchema = z
  .object({
    input_tokens: tokenCount.default(0),
    cached_input_tokens: tokenCount.default(0),
    output_tokens: tokenCount.default(0),
    reasoning_output_tokens: tokenCount.optional().nullable(),
    total_tokens: tokenCount.optional().nullable(),
  })
  .passthrough();

/** Any `event_msg.payload`; only `type == "token_count"` is usage-bearing. */
export const eventMsgPayloadSchema = z.object({ type: z.string() }).passthrough();

/** `event_msg.payload` for token_count records; `info` may be null (emits nothing). */
export const tokenCountPayloadSchema = z
  .object({
    type: z.literal('token_count'),
    info: z
      .object({
        last_token_usage: rawTokenUsageSchema.optional().nullable(),
        total_token_usage: rawTokenUsageSchema.optional().nullable(),
      })
      .passthrough()
      .optional()
      .nullable(),
  })
  .passthrough();

/** Any `response_item.payload`; only `type == "function_call"` is inspected. */
export const responseItemPayloadSchema = z.object({ type: z.string() }).passthrough();

/** A `function_call` response item; `arguments` is an untrusted JSON string. */
export const functionCallPayloadSchema = z
  .object({
    type: z.literal('function_call'),
    name: z.string(),
    arguments: z.string(),
  })
  .passthrough();

/** Parsed `arguments` of an `apply_patch` call; only header paths are ever read from `input`. */
export const applyPatchArgumentsSchema = z.object({ input: z.string() }).passthrough();

/**
 * Parsed `arguments` of a `shell`/`exec_command` call. `command` is the argv
 * array form from the contract; real v0.138 `exec_command` carries a single
 * shell string under `cmd` (verified locally) — both stay `unknown` and are
 * narrowed downstream.
 */
export const execArgumentsSchema = z
  .object({
    command: z.unknown().optional(),
    cmd: z.unknown().optional(),
  })
  .passthrough();

export type RawTokenUsage = z.infer<typeof rawTokenUsageSchema>;
