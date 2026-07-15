/**
 * zod schema and validation for the vibebill price table (spec §5.5).
 * Pure: no I/O here. Prices are decimal strings validated by actually parsing
 * them with the exact money parser — a price that cannot become exact
 * nano-USD is rejected at this boundary, never later.
 */

import { z } from 'zod';
import type { PriceCard, PriceTable } from './engine.js';
import { parsePriceToNanoPerMTok } from './money.js';

/** Decimal-string price ("15.00", $/MTok) that parses exactly to nano-USD. */
const priceString = z.string().superRefine((s, ctx) => {
  try {
    parsePriceToNanoPerMTok(s);
  } catch (err) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: err instanceof Error ? err.message : `invalid price string: ${JSON.stringify(s)}`,
    });
  }
});

const priceCardSchema = z
  .object({
    displayName: z.string().min(1),
    inputPerMTok: priceString,
    outputPerMTok: priceString,
    cacheWritePerMTok: priceString.optional(),
    cacheReadPerMTok: priceString.optional(),
  })
  .passthrough();

const priceTableSchema = z
  .object({
    schemaVersion: z.literal(1),
    asOf: z.string().min(1),
    source: z.string().min(1),
    models: z.record(z.string().min(1), priceCardSchema),
  })
  .passthrough();

const KNOWN_TABLE_KEYS = new Set(['schemaVersion', 'asOf', 'source', 'models']);
const KNOWN_CARD_KEYS = new Set([
  'displayName',
  'inputPerMTok',
  'outputPerMTok',
  'cacheWritePerMTok',
  'cacheReadPerMTok',
]);

/** A validated table plus non-fatal warnings (unknown keys tolerated, surfaced). */
export interface ParsedPriceTable {
  table: PriceTable;
  warnings: string[];
}

/**
 * Validate untrusted JSON into a PriceTable; throws on structural/price errors,
 * tolerates unknown keys with a warning per key.
 */
export function parsePriceTable(data: unknown, sourceLabel: string): ParsedPriceTable {
  const result = priceTableSchema.safeParse(data);
  if (!result.success) {
    const first = result.error.issues[0];
    const where = first && first.path.length > 0 ? ` at ${first.path.join('.')}` : '';
    throw new Error(
      `invalid price table (${sourceLabel})${where}: ${first?.message ?? 'validation failed'}`,
    );
  }

  const warnings: string[] = [];
  const raw = result.data;
  for (const key of Object.keys(raw)) {
    if (!KNOWN_TABLE_KEYS.has(key)) {
      warnings.push(`price table (${sourceLabel}): unknown key "${key}" ignored`);
    }
  }

  const models: Record<string, PriceCard> = {};
  for (const [id, rawCard] of Object.entries(raw.models)) {
    for (const key of Object.keys(rawCard)) {
      if (!KNOWN_CARD_KEYS.has(key)) {
        warnings.push(`price table (${sourceLabel}): model "${id}" unknown key "${key}" ignored`);
      }
    }
    const card: PriceCard = {
      displayName: rawCard.displayName,
      inputPerMTok: rawCard.inputPerMTok,
      outputPerMTok: rawCard.outputPerMTok,
    };
    if (rawCard.cacheWritePerMTok !== undefined) card.cacheWritePerMTok = rawCard.cacheWritePerMTok;
    if (rawCard.cacheReadPerMTok !== undefined) card.cacheReadPerMTok = rawCard.cacheReadPerMTok;
    models[id] = card;
  }

  return {
    table: { schemaVersion: 1, asOf: raw.asOf, source: raw.source, models },
    warnings,
  };
}
