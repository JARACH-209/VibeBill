/**
 * Project-root (cwd) recovery for Gemini CLI chat files (docs/contracts.md):
 * prefer the plain-text `.project_root` marker inside the slug directory
 * (`<root>/tmp/<slug>/.project_root`), fall back to a reverse lookup in
 * `<root>/projects.json` ({ projects: { <absolute path>: <slug> } }), else
 * null. Lookups are cached per slug within a run (adapter instance).
 */
import { readFile } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import { projectsFileSchema } from './schema.js';

export interface ChatPathInfo {
  /** The `<root>/tmp/<slug>` directory owning the chat file; null when the layout is unrecognizable. */
  slugDir: string | null;
  /** True when the file sits below an extra directory under chats/ (nested subagent session). */
  nested: boolean;
}

/**
 * Locate the slug directory and nesting depth of a chat file, handling both
 * `chats/<session>.jsonl` and nested `chats/<parent>/<session>.jsonl` layouts.
 */
export function analyzeChatPath(filePath: string, tmpDir: string): ChatPathInfo {
  const rel = relative(tmpDir, filePath);
  if (rel.length > 0 && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) {
    const segments = rel.split(sep);
    const slug = segments[0];
    if (segments.length >= 3 && slug !== undefined && segments[1] === 'chats') {
      return { slugDir: join(tmpDir, slug), nested: segments.length > 3 };
    }
  }
  // Defensive fallback for paths outside <root>/tmp: anchor on the last chats/ segment.
  const parts = filePath.split(sep);
  const chatsIndex = parts.lastIndexOf('chats');
  if (chatsIndex > 0) {
    return {
      slugDir: parts.slice(0, chatsIndex).join(sep) || sep,
      nested: parts.length - chatsIndex - 1 > 1,
    };
  }
  return { slugDir: null, nested: false };
}

/** Recovers absolute project roots for chat files, caching per-slug results within a run. */
export class ProjectRootResolver {
  private readonly tmpDir: string;
  private readonly projectsJsonPath: string;
  private readonly bySlugDir = new Map<string, string | null>();
  private projectsBySlug: Promise<Map<string, string>> | undefined;

  constructor(geminiRoot: string) {
    this.tmpDir = join(geminiRoot, 'tmp');
    this.projectsJsonPath = join(geminiRoot, 'projects.json');
  }

  /** Absolute project root for a chat file: .project_root marker, else projects.json, else null. */
  async resolveForChatFile(chatFilePath: string): Promise<string | null> {
    const { slugDir } = analyzeChatPath(chatFilePath, this.tmpDir);
    if (slugDir === null) {
      return null;
    }
    if (this.bySlugDir.has(slugDir)) {
      return this.bySlugDir.get(slugDir) ?? null;
    }
    const found = await this.lookup(slugDir);
    this.bySlugDir.set(slugDir, found);
    return found;
  }

  /** One uncached lookup: marker file first (must hold an absolute path), then projects.json. */
  private async lookup(slugDir: string): Promise<string | null> {
    try {
      const marker = (await readFile(join(slugDir, '.project_root'), 'utf8')).trim();
      if (marker.length > 0 && isAbsolute(marker)) {
        return marker;
      }
    } catch {
      // Missing/unreadable marker: fall through to projects.json.
    }
    const projects = await this.loadProjects();
    return projects.get(basename(slugDir)) ?? null;
  }

  /** Lazily parse projects.json once per run; any failure yields an empty map, never an error. */
  private loadProjects(): Promise<Map<string, string>> {
    this.projectsBySlug ??= this.readProjects();
    return this.projectsBySlug;
  }

  /** Reverse map slug → absolute path; smallest path wins on duplicate slugs (determinism). */
  private async readProjects(): Promise<Map<string, string>> {
    const bySlug = new Map<string, string>();
    let raw: string;
    try {
      raw = await readFile(this.projectsJsonPath, 'utf8');
    } catch {
      return bySlug;
    }
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      return bySlug;
    }
    const parsed = projectsFileSchema.safeParse(json);
    if (!parsed.success) {
      return bySlug;
    }
    const entries = Object.entries(parsed.data.projects).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    for (const [absPath, slug] of entries) {
      if (isAbsolute(absPath) && !bySlug.has(slug)) {
        bySlug.set(slug, absPath);
      }
    }
    return bySlug;
  }
}
