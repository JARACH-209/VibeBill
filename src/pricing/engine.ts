/**
 * Pricing engine (spec §5.5, §8). Loads the bundled/refreshed price table,
 * matches raw model strings by longest prefix, and prices token counts in
 * exact bigint nano-USD. `refreshPricing` is the ONLY function in the entire
 * program that performs a network call (spec §14.3 rule 1), and only when the
 * user explicitly asks for it.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { MoneyBreakdown, TokenCounts } from '../core/types.js';
import { CliUserError, InternalError } from '../core/errors.js';
import { convertLiteLLMTable } from './convert.js';
import {
  costBreakdown,
  parsePriceToNanoPerMTok,
  type PriceCardNano,
} from './money.js';
import { parsePriceTable } from './schema.js';

/** One model's prices as decimal strings in $/MTok (spec §5.5). */
export interface PriceCard {
  displayName: string;
  inputPerMTok: string;
  outputPerMTok: string;
  cacheWritePerMTok?: string;
  cacheReadPerMTok?: string;
}

/** The bundled/refreshed price table document. */
export interface PriceTable {
  schemaVersion: 1;
  asOf: string;
  source: string;
  models: Record<string, PriceCard>;
}

/** The one URL vibebill is ever allowed to fetch (spec §14.3 rule 1). */
export const LITELLM_PRICES_URL =
  'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/**
 * Resolve the bundled prices/prices.json relative to THIS module file so it
 * works both from dist/src/pricing (../../.. -> package root, matching the
 * published `files` layout) and from the source tree under a TS runner
 * (../.. -> repo root). Exported for tests only.
 */
export function resolveBundledPricesPath(fromModuleUrl: string = import.meta.url): string {
  const moduleDir = path.dirname(fileURLToPath(fromModuleUrl));
  const candidates = [
    path.resolve(moduleDir, '../../../prices/prices.json'), // dist/src/pricing -> <root>/prices
    path.resolve(moduleDir, '../../prices/prices.json'), // src/pricing -> <root>/prices
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new InternalError(
    `bundled price table not found (looked at ${candidates.join(' and ')}); ` +
      'the vibebill package is corrupt — reinstall it',
  );
}

/** zod-validate and load the bundled prices/prices.json (resolved relative to this module). */
export function loadBundledPrices(): PriceTable {
  const bundledPath = resolveBundledPricesPath();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(bundledPath, 'utf8')) as unknown;
  } catch (err) {
    throw new InternalError(`could not read bundled price table at ${bundledPath}`, err);
  }
  try {
    return parsePriceTable(raw, 'bundled').table;
  } catch (err) {
    throw new InternalError(
      err instanceof Error ? err.message : `invalid bundled price table at ${bundledPath}`,
      err,
    );
  }
}

/** Path of the user-refreshed table: (configDir ?? ~/.config)/vibebill/prices.json. */
function userPricesPath(configDir?: string): string {
  return path.join(configDir ?? path.join(homedir(), '.config'), 'vibebill', 'prices.json');
}

/**
 * User-refreshed table wins over bundled when present AND valid; an invalid
 * user table falls back to bundled with a warning (never a crash). Warnings
 * also carry tolerated-unknown-key notices from whichever table loaded.
 */
export function loadEffectivePrices(opts?: { configDir?: string }): {
  table: PriceTable;
  origin: 'bundled' | 'refreshed';
  path: string;
  warnings: string[];
} {
  const userPath = userPricesPath(opts?.configDir);
  const warnings: string[] = [];
  if (existsSync(userPath)) {
    try {
      const raw = JSON.parse(readFileSync(userPath, 'utf8')) as unknown;
      const parsed = parsePriceTable(raw, `refreshed ${userPath}`);
      return { table: parsed.table, origin: 'refreshed', path: userPath, warnings: parsed.warnings };
    } catch (err) {
      warnings.push(
        `refreshed price table at ${userPath} is invalid (${err instanceof Error ? err.message : String(err)}); ` +
          'falling back to the bundled table — re-run --refresh-pricing to replace it',
      );
    }
  }
  const table = loadBundledPrices();
  return { table, origin: 'bundled', path: resolveBundledPricesPath(), warnings };
}

/**
 * Longest-prefix match of the raw model string against table keys (handles
 * dated suffixes like "-20260115"); exact match wins naturally; null when unknown.
 */
export function matchModel(
  table: PriceTable,
  rawModel: string,
): { id: string; card: PriceCard } | null {
  let bestId: string | null = null;
  for (const id of Object.keys(table.models)) {
    if (rawModel.startsWith(id) && (bestId === null || id.length > bestId.length)) {
      bestId = id;
    }
  }
  if (bestId === null) return null;
  const card = table.models[bestId];
  if (card === undefined) return null; // unreachable; satisfies noUncheckedIndexedAccess
  return { id: bestId, card };
}

/** Resolve a card to exact nano-USD units; missing cache prices fall back to inputPerMTok with a flag. */
export function resolveCard(card: PriceCard): { nano: PriceCardNano; cacheFallback: boolean } {
  const inputPerMTok = parsePriceToNanoPerMTok(card.inputPerMTok);
  const outputPerMTok = parsePriceToNanoPerMTok(card.outputPerMTok);
  const cacheFallback = card.cacheWritePerMTok === undefined || card.cacheReadPerMTok === undefined;
  const cacheWritePerMTok =
    card.cacheWritePerMTok === undefined
      ? inputPerMTok
      : parsePriceToNanoPerMTok(card.cacheWritePerMTok);
  const cacheReadPerMTok =
    card.cacheReadPerMTok === undefined
      ? inputPerMTok
      : parsePriceToNanoPerMTok(card.cacheReadPerMTok);
  return {
    nano: { inputPerMTok, outputPerMTok, cacheWritePerMTok, cacheReadPerMTok },
    cacheFallback,
  };
}

/** Price one event's tokens; null when the model is unknown (caller records the unknown model). */
export function priceTokens(
  table: PriceTable,
  rawModel: string,
  tokens: TokenCounts,
): MoneyBreakdown | null {
  const match = matchModel(table, rawModel);
  if (match === null) return null;
  return costBreakdown(tokens, resolveCard(match.card).nano);
}

/**
 * Reprice measured token traffic on a counterfactual card (spec §5.5); the
 * cacheFallback flag feeds the CLI's honesty label when the card lacks cache prices.
 */
export function repriceTokens(
  tokens: TokenCounts,
  card: PriceCard,
): { cost: MoneyBreakdown; cacheFallback: boolean } {
  const { nano, cacheFallback } = resolveCard(card);
  return { cost: costBreakdown(tokens, nano), cacheFallback };
}

/**
 * THE ONLY NETWORK CALL in vibebill: fetch the LiteLLM community table,
 * convert it exactly like the build-time script, validate with zod, and write
 * the user table atomically; any failure throws CliUserError and leaves no
 * partial file (the CLI adds the "kept last known table" wording).
 */
export async function refreshPricing(opts?: {
  configDir?: string;
  fetchImpl?: typeof fetch;
}): Promise<{ path: string; asOf: string; modelCount: number }> {
  const fetchImpl = opts?.fetchImpl ?? fetch;
  let payload: unknown;
  try {
    const res = await fetchImpl(LITELLM_PRICES_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    payload = (await res.json()) as unknown;
  } catch (err) {
    throw new CliUserError(
      `pricing refresh failed: could not fetch ${LITELLM_PRICES_URL} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      'Check your network connection and retry; vibebill keeps working on its last known table.',
    );
  }

  let models: Record<string, PriceCard>;
  try {
    models = convertLiteLLMTable(payload);
  } catch (err) {
    throw new CliUserError(
      `pricing refresh failed: unexpected LiteLLM payload shape ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      'The upstream file format may have changed; please file a vibebill issue.',
    );
  }
  const modelCount = Object.keys(models).length;
  if (modelCount === 0) {
    throw new CliUserError(
      'pricing refresh failed: the fetched LiteLLM table yielded zero usable models',
      'The upstream file format may have changed; please file a vibebill issue.',
    );
  }

  // Explicit, user-initiated action — wall clock is allowed here (spec §1.5 exception).
  const asOf = new Date().toISOString().slice(0, 10);
  const table: PriceTable = {
    schemaVersion: 1,
    asOf,
    source:
      `LiteLLM community price table (${LITELLM_PRICES_URL}), fetched ${asOf} via ` +
      'vibebill --refresh-pricing; per-token costs converted to $/MTok decimal strings. ' +
      'Models absent from the source are omitted, never invented.',
    models,
  };
  try {
    parsePriceTable(table, 'refresh output'); // self-check: our own output must validate
  } catch (err) {
    throw new InternalError('pricing refresh produced an invalid table', err);
  }

  const outPath = userPricesPath(opts?.configDir);
  const tmpPath = `${outPath}.tmp-${process.pid}`;
  try {
    mkdirSync(path.dirname(outPath), { recursive: true });
    writeFileSync(tmpPath, `${JSON.stringify(table, null, 2)}\n`, 'utf8');
    renameSync(tmpPath, outPath); // atomic on POSIX: never a partial prices.json
  } catch (err) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // Cleanup is best-effort; `force` only silences ENOENT, and e.g. ENOTDIR
      // here must not mask the real write failure reported below.
    }
    throw new CliUserError(
      `pricing refresh failed: could not write ${outPath} ` +
        `(${err instanceof Error ? err.message : String(err)})`,
      'Check directory permissions; vibebill keeps working on its last known table.',
    );
  }
  return { path: outPath, asOf, modelCount };
}
