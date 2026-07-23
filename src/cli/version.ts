/**
 * Resolve vibebill's own package version for --version, report headers, and
 * the `generatedBy` field of git notes. Reads the package.json that ships with
 * the package; works both from dist/src/cli and from the source tree.
 */

import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

let cached: string | null = null;

/** The version string from vibebill's own package.json ("0.0.0" if unreadable). */
export function vibebillVersion(): string {
  if (cached !== null) return cached;
  // The single-executable build injects the version (no package.json on disk there).
  const embedded = (globalThis as { __vibebillVersion?: string }).__vibebillVersion;
  if (typeof embedded === 'string' && embedded.length > 0) {
    cached = embedded;
    return cached;
  }
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(moduleDir, '../../../package.json'), // dist/src/cli -> package root
    path.resolve(moduleDir, '../../package.json'), // src/cli -> repo root
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = JSON.parse(readFileSync(candidate, 'utf8')) as { version?: unknown };
      if (typeof parsed.version === 'string' && parsed.version.length > 0) {
        cached = parsed.version;
        return cached;
      }
    } catch {
      // fall through to the next candidate; a broken package.json must not crash the CLI
    }
  }
  cached = '0.0.0';
  return cached;
}
