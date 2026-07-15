/**
 * Optional repo config: vibebill.config.json at repo root (spec §6.9).
 * zod-validated; unknown keys warn; CLI flags override everything here.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CliUserError } from './errors.js';
import type { AttributionConfig, PlanId } from './types.js';
import { ALL_AGENT_IDS, DEFAULT_ATTRIBUTION_CONFIG } from './types.js';
import type { AgentId } from './types.js';

const weightsSchema = z
  .object({
    file: z.number().min(0),
    time: z.number().min(0),
    branch: z.number().min(0),
  })
  .strict();

const configSchema = z
  .object({
    plan: z.enum(['pro', 'max5', 'max20']).optional(),
    horizonDays: z.number().positive().optional(),
    graceSeconds: z.number().min(0).optional(),
    weights: weightsSchema.optional(),
    adapter: z
      .union([z.enum(ALL_AGENT_IDS as [AgentId, ...AgentId[]]), z.array(z.enum(ALL_AGENT_IDS as [AgentId, ...AgentId[]]))])
      .optional(),
  })
  .passthrough();

export interface RepoConfig {
  plan: PlanId | null;
  attribution: AttributionConfig;
  /** Adapters to ingest; defaults to all bundled adapters. */
  adapters: AgentId[];
  warnings: string[];
}

export const CONFIG_FILENAME = 'vibebill.config.json';

/** Load and validate vibebill.config.json; absent file is normal and yields defaults. */
export async function loadRepoConfig(repoRoot: string): Promise<RepoConfig> {
  const warnings: string[] = [];
  const defaults: RepoConfig = {
    plan: null,
    attribution: { ...DEFAULT_ATTRIBUTION_CONFIG, weights: { ...DEFAULT_ATTRIBUTION_CONFIG.weights } },
    adapters: [...ALL_AGENT_IDS],
    warnings,
  };

  let text: string;
  try {
    text = await readFile(join(repoRoot, CONFIG_FILENAME), 'utf8');
  } catch {
    return defaults; // no config file — zero-config is the default path
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(text);
  } catch (err) {
    throw new CliUserError(
      `${CONFIG_FILENAME} is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
      `Fix or delete ${CONFIG_FILENAME} at the repo root.`,
    );
  }

  const result = configSchema.safeParse(parsedJson);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new CliUserError(
      `${CONFIG_FILENAME} is invalid: ${issue ? `${issue.path.join('.') || '(root)'}: ${issue.message}` : 'schema mismatch'}`,
      `See docs/json-schemas.md for the config schema.`,
    );
  }

  const known = new Set(['plan', 'horizonDays', 'graceSeconds', 'weights', 'adapter']);
  for (const key of Object.keys(result.data)) {
    if (!known.has(key)) warnings.push(`${CONFIG_FILENAME}: unknown key "${key}" ignored`);
  }

  const cfg = result.data;
  return {
    plan: cfg.plan ?? null,
    attribution: {
      horizonDays: cfg.horizonDays ?? defaults.attribution.horizonDays,
      graceSeconds: cfg.graceSeconds ?? defaults.attribution.graceSeconds,
      weights: cfg.weights ?? defaults.attribution.weights,
    },
    adapters: cfg.adapter === undefined ? defaults.adapters : Array.isArray(cfg.adapter) ? cfg.adapter : [cfg.adapter],
    warnings,
  };
}
