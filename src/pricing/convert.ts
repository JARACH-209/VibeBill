/**
 * Pure conversion of the LiteLLM community price file into vibebill price cards
 * (spec §5.5). Mirrors the build-time table population exactly: per-token float
 * costs -> $/MTok decimal strings, float artifacts snapped with toPrecision(12),
 * every produced string round-trip-validated against the exact money parser.
 * Zero I/O in this file.
 */

import { z } from 'zod';
import type { PriceCard } from './engine.js';
import { NANO_PER_USD, parsePriceToNanoPerMTok } from './money.js';

/** Canonical decimal string ("15", "0.25") for exact nano-USD-per-MTok. */
export function nanoPerMTokToPriceString(nano: bigint): string {
  if (nano < 0n) {
    throw new Error(`price cannot be negative: ${nano} nano-USD/MTok`);
  }
  const whole = nano / NANO_PER_USD;
  const frac = (nano % NANO_PER_USD).toString().padStart(9, '0').replace(/0+$/u, '');
  return frac === '' ? whole.toString() : `${whole}.${frac}`;
}

/** Expand a Number.toPrecision result (possibly exponent-notated) to a plain non-negative decimal. */
function expandToPlainDecimal(s: string): { intDigits: string; fracDigits: string } {
  const m = /^(\d+)(?:\.(\d+))?(?:[eE]([+-]?\d+))?$/u.exec(s);
  if (!m) throw new Error(`unexpected numeric literal: ${JSON.stringify(s)}`);
  const int = m[1] ?? '0';
  const frac = m[2] ?? '';
  const exp = m[3] === undefined ? 0 : Number(m[3]);
  let digits = int + frac;
  // Decimal point sits after `int.length + exp` digits.
  let point = int.length + exp;
  if (point <= 0) {
    digits = '0'.repeat(1 - point) + digits;
    point = 1;
  } else if (point > digits.length) {
    digits = digits + '0'.repeat(point - digits.length);
  }
  return { intDigits: digits.slice(0, point), fracDigits: digits.slice(point) };
}

/**
 * Convert a LiteLLM per-token USD float into a $/MTok decimal string, snapping
 * float artifacts with toPrecision(12) and rounding anything beyond 9
 * fractional digits half-up; throws when the result does not round-trip.
 */
export function perTokenCostToPerMTokString(costPerToken: number): string {
  if (typeof costPerToken !== 'number' || !Number.isFinite(costPerToken) || costPerToken < 0) {
    throw new Error(`invalid per-token cost: ${String(costPerToken)}`);
  }
  const scaled = costPerToken * 1e6; // $/MTok, may carry float artifacts
  const { intDigits, fracDigits } = expandToPlainDecimal(scaled.toPrecision(12));

  const frac9 = fracDigits.slice(0, 9).padEnd(9, '0');
  let nano = BigInt(intDigits) * NANO_PER_USD + BigInt(frac9);
  const dropped = fracDigits.slice(9);
  if (dropped !== '' && dropped.charCodeAt(0) >= 0x35 /* '5' */) nano += 1n;

  const out = nanoPerMTokToPriceString(nano);
  if (parsePriceToNanoPerMTok(out) !== nano) {
    throw new Error(`price conversion round-trip failed for ${costPerToken}: ${out}`);
  }
  return out;
}

const litellmEntrySchema = z
  .object({
    litellm_provider: z.string().optional(),
    mode: z.string().optional(),
    input_cost_per_token: z.number().optional(),
    output_cost_per_token: z.number().optional(),
    cache_creation_input_token_cost: z.number().optional(),
    cache_read_input_token_cost: z.number().optional(),
  })
  .passthrough();

const INCLUDED_MODES = new Set(['chat', 'responses']);

/** Map a raw LiteLLM key + provider to a vibebill model id, or null when out of scope. */
export function selectModelId(rawKey: string, provider: string | undefined): string | null {
  if (provider === 'anthropic' && rawKey.startsWith('claude-')) return rawKey;
  if (
    provider === 'openai' &&
    /^(?:gpt-|o[0-9]|codex-|chatgpt-)/u.test(rawKey) &&
    !rawKey.includes('/')
  ) {
    return rawKey;
  }
  if (provider === 'gemini' && rawKey.startsWith('gemini/gemini-')) {
    return rawKey.slice('gemini/'.length);
  }
  if (provider === 'deepseek' && rawKey.startsWith('deepseek/')) {
    return rawKey.slice('deepseek/'.length);
  }
  if (provider === 'dashscope' || provider === 'alibaba') {
    const slash = rawKey.indexOf('/');
    const stripped = slash === -1 ? rawKey : rawKey.slice(slash + 1);
    if (stripped.includes('qwen') && stripped.includes('coder')) return stripped;
  }
  return null;
}

/**
 * Convert a fetched LiteLLM table (untrusted JSON) into vibebill price cards;
 * models outside the provider allowlist, with non-chat/responses mode, or
 * missing input/output cost are omitted, never invented.
 */
export function convertLiteLLMTable(data: unknown): Record<string, PriceCard> {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new Error('LiteLLM payload is not a JSON object of model entries');
  }
  const models: Record<string, PriceCard> = {};
  const rawKeys = Object.keys(data as Record<string, unknown>).sort();
  for (const rawKey of rawKeys) {
    if (rawKey === 'sample_spec') continue;
    const parsed = litellmEntrySchema.safeParse((data as Record<string, unknown>)[rawKey]);
    if (!parsed.success) continue;
    const entry = parsed.data;

    const id = selectModelId(rawKey, entry.litellm_provider);
    if (id === null || id in models) continue;
    if (entry.mode === undefined || !INCLUDED_MODES.has(entry.mode)) continue;
    if (entry.input_cost_per_token === undefined || entry.output_cost_per_token === undefined) {
      continue;
    }

    let card: PriceCard;
    try {
      card = {
        displayName: id,
        inputPerMTok: perTokenCostToPerMTokString(entry.input_cost_per_token),
        outputPerMTok: perTokenCostToPerMTokString(entry.output_cost_per_token),
      };
    } catch {
      continue; // unconvertible required price -> omit the model, never guess
    }
    if (entry.cache_creation_input_token_cost !== undefined) {
      try {
        card.cacheWritePerMTok = perTokenCostToPerMTokString(entry.cache_creation_input_token_cost);
      } catch {
        /* omit just the optional field */
      }
    }
    if (entry.cache_read_input_token_cost !== undefined) {
      try {
        card.cacheReadPerMTok = perTokenCostToPerMTokString(entry.cache_read_input_token_cost);
      } catch {
        /* omit just the optional field */
      }
    }
    models[id] = card;
  }
  return models;
}
