/**
 * Attribution engine (spec §5.4) — the heart of vibebill. Joins usage events to commits
 * at message grain. Pure, zero I/O, deterministic: "now" is injected, never read from
 * the clock, and identical inputs produce deep-equal outputs.
 */

import type {
  Attribution,
  AttributionConfidence,
  AttributionConfig,
  CommitInfo,
  Provenance,
  UsageEvent,
} from './types.js';

/** Score breakdown for a commit attribution — the "why" shown by `vibebill show`. */
export interface AttributionExplain {
  fileScore: number;
  timeScore: number;
  branchScore: number;
  score: number;
  /** Set on non-edit events that adopted an edit event's attribution (Step C). */
  adoptedFromEventId?: string;
}

/** One event's attribution result; `explain` is non-null for kind:'commit' entries. */
export interface AttributedEvent {
  attribution: Attribution;
  explain: AttributionExplain | null;
}

const MS_PER_DAY = 86_400_000;

/** Deterministic lexicographic comparison (never locale-dependent). */
function compareLex(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** A non-merge commit prepared for scoring: file list as a set for O(1) intersection. */
interface Target {
  commit: CommitInfo;
  files: ReadonlySet<string>;
}

/** First index in `targets` (sorted by authorTs) with authorTs >= minAuthorTs. */
function lowerBound(targets: Target[], minAuthorTs: number): number {
  let lo = 0;
  let hi = targets.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((targets[mid] as Target).commit.authorTs < minAuthorTs) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

interface Scored {
  commit: CommitInfo;
  explain: AttributionExplain;
}

/**
 * Steps A & B for one edit event: score candidate commits, pick the best fileScore>0
 * match, else the pure-time fallback, else waste (spec §5.4).
 */
function attributeEditEvent(
  e: UsageEvent,
  rel: ReadonlySet<string>,
  targets: Target[],
  horizonMs: number,
  graceMs: number,
  weights: AttributionConfig['weights'],
): AttributedEvent {
  // Candidate window (spec §5.4): authorTs(C) + grace >= e.ts >= authorTs(C) - horizon,
  // i.e. authorTs(C) ∈ [e.ts - grace, e.ts + horizon] (both ends inclusive).
  const minTs = e.ts - graceMs;
  const maxTs = e.ts + horizonMs;
  // Guard against a degenerate horizon (config schema requires it positive anyway).
  const horizonDen = Math.max(1, horizonMs);

  let best: Scored | null = null;
  let positiveFileScoreCount = 0;
  /** Earliest candidate at-or-after the event (pure-time fallback, any branch). */
  let fallbackAny: Scored | null = null;
  /** Earliest candidate at-or-after the event on the event's own branch. */
  let fallbackSameBranch: Scored | null = null;

  // Targets are sorted by (authorTs, hash), so iteration order already realizes the
  // tie-break rule: on equal score keep the first seen — the candidate with the
  // smallest authorTs(C) - e.ts, then the lexicographically smallest hash.
  for (let k = lowerBound(targets, minTs); k < targets.length; k++) {
    const t = targets[k] as Target;
    const authorTs = t.commit.authorTs;
    if (authorTs > maxTs) break;

    let intersection = 0;
    for (const f of rel) if (t.files.has(f)) intersection++;
    const fileScore = intersection / rel.size;
    // Spec declares timeScore ∈ [0,1]; commits before the event (within grace) would
    // make the raw value exceed 1, so it is clamped to the declared range.
    const rawTime = 1 - (authorTs - e.ts) / horizonDen;
    const timeScore = Math.min(1, Math.max(0, rawTime));
    const branchScore =
      e.gitBranch !== null && t.commit.branchHint !== null
        ? e.gitBranch === t.commit.branchHint
          ? 1
          : 0
        : 0.5; // unknown ≠ mismatch
    const score =
      weights.file * fileScore + weights.time * timeScore + weights.branch * branchScore;
    const explain: AttributionExplain = { fileScore, timeScore, branchScore, score };

    if (fileScore > 0) {
      positiveFileScoreCount++;
      if (best === null || score > best.explain.score) best = { commit: t.commit, explain };
    }
    if (authorTs >= e.ts) {
      if (fallbackAny === null) fallbackAny = { commit: t.commit, explain };
      if (
        fallbackSameBranch === null &&
        e.gitBranch !== null &&
        t.commit.branchHint === e.gitBranch
      ) {
        fallbackSameBranch = { commit: t.commit, explain };
      }
    }
  }

  if (best !== null) {
    const fs = best.explain.fileScore;
    const confidence: AttributionConfidence =
      fs >= 0.8 && (best.explain.branchScore === 1 || positiveFileScoreCount === 1)
        ? 'high'
        : fs >= 0.4
          ? 'medium'
          : 'low';
    return {
      attribution: { kind: 'commit', hash: best.commit.hash, confidence },
      explain: best.explain,
    };
  }

  // Pure-time fallback: no candidate anywhere had fileScore > 0 — take the next commit
  // in time at-or-after the event, preferring the event's branch when both sides are
  // known. Always confidence 'low'; provenance 'advisory' (see provenanceFor).
  const fallback = fallbackSameBranch ?? fallbackAny;
  if (fallback !== null) {
    return {
      attribution: { kind: 'commit', hash: fallback.commit.hash, confidence: 'low' },
      explain: fallback.explain,
    };
  }

  // Step B: no matching commit after the event within the horizon => waste. Whether the
  // horizon has elapsed changes only the render-time bucket (isInProgress), never the
  // stored kind (spec §5.4 Step B: "Storage kind remains waste; rendering distinguishes").
  return { attribution: { kind: 'waste' }, explain: null };
}

/**
 * Message-grain attribution (spec §5.4 Steps A–C). Returns an array parallel to the
 * `events` input order; merge commits are never attribution targets.
 */
export function attributeEvents(
  events: UsageEvent[],
  commits: CommitInfo[],
  config: AttributionConfig,
  opts: {
    /** Injected clock (determinism; no Date.now() inside the engine). */
    nowMs: number;
    /** Maps an absolute edited path to repo-relative, or null when outside the repo. */
    toRepoRelative: (absPath: string) => string | null;
  },
): AttributedEvent[] {
  const horizonMs = config.horizonDays * MS_PER_DAY;
  const graceMs = config.graceSeconds * 1000;

  const targets: Target[] = commits
    .filter((c) => !c.isMerge && c.parents.length <= 1)
    .map((c) => ({ commit: c, files: new Set(c.files) }))
    .sort(
      (a, b) =>
        a.commit.authorTs - b.commit.authorTs || compareLex(a.commit.hash, b.commit.hash),
    );

  // Repo-relative edited-file set per event (set semantics; nulls dropped). An event is
  // an EDIT event iff this set is non-empty — events whose edits all map outside the
  // repo keep their tokens but participate as non-edit events.
  const relFiles: ReadonlySet<string>[] = events.map((e) => {
    const s = new Set<string>();
    for (const p of e.editedFiles) {
      const rel = opts.toRepoRelative(p);
      if (rel !== null) s.add(rel);
    }
    return s;
  });

  const results: (AttributedEvent | null)[] = events.map(() => null);

  // ---- Steps A & B: edit events ----
  for (let i = 0; i < events.length; i++) {
    const rel = relFiles[i] as ReadonlySet<string>;
    if (rel.size === 0) continue;
    results[i] = attributeEditEvent(
      events[i] as UsageEvent,
      rel,
      targets,
      horizonMs,
      graceMs,
      config.weights,
    );
  }

  // ---- Step C: non-edit events adopt within their session ----
  const sessions = new Map<string, number[]>();
  for (let i = 0; i < events.length; i++) {
    const sid = (events[i] as UsageEvent).sessionId;
    const arr = sessions.get(sid);
    if (arr) arr.push(i);
    else sessions.set(sid, [i]);
  }

  for (const indices of sessions.values()) {
    // Deterministic session order: ts ascending, ties by event id (then input index,
    // unreachable for deduped inputs but keeps the sort total).
    indices.sort((a, b) => {
      const ea = events[a] as UsageEvent;
      const eb = events[b] as UsageEvent;
      return ea.ts - eb.ts || compareLex(ea.id, eb.id) || a - b;
    });

    const editPositions: number[] = [];
    for (let p = 0; p < indices.length; p++) {
      if ((relFiles[indices[p] as number] as ReadonlySet<string>).size > 0) editPositions.push(p);
    }

    if (editPositions.length === 0) {
      // Session with zero edit events: everything is overhead (advisory).
      for (const idx of indices) results[idx] = { attribution: { kind: 'overhead' }, explain: null };
      continue;
    }

    // Forward-attach to the next edit event; trailing non-edit events attach backward
    // to the session's last edit event.
    let nextEditPtr = 0;
    const lastEditPos = editPositions[editPositions.length - 1] as number;
    for (let p = 0; p < indices.length; p++) {
      const idx = indices[p] as number;
      if ((relFiles[idx] as ReadonlySet<string>).size > 0) continue; // edit event: already done
      while (nextEditPtr < editPositions.length && (editPositions[nextEditPtr] as number) < p) {
        nextEditPtr++;
      }
      const srcPos =
        nextEditPtr < editPositions.length ? (editPositions[nextEditPtr] as number) : lastEditPos;
      const srcIdx = indices[srcPos] as number;
      const src = results[srcIdx] as AttributedEvent;
      results[idx] = {
        attribution: src.attribution,
        explain:
          src.explain === null
            ? null
            : { ...src.explain, adoptedFromEventId: (events[srcIdx] as UsageEvent).id },
      };
    }
  }

  return results.map((r) => r as AttributedEvent);
}

/**
 * Render-time "in progress (uncommitted)" bucket (spec §5.4 Step B, §7.8): waste whose
 * event is newer than the repo's newest commit (or the repo has no commits at all).
 */
export function isInProgress(
  e: UsageEvent,
  attribution: Attribution,
  newestCommitAuthorTs: number | null,
): boolean {
  return (
    attribution.kind === 'waste' &&
    (newestCommitAuthorTs === null || e.ts > newestCommitAuthorTs)
  );
}

/**
 * Single source of truth for an attributed event's provenance label (spec §1.2, §5.4):
 * advisory for overhead, for the pure-time fallback (kind 'commit' with fileScore 0),
 * and for events that adopted an advisory attribution; measured otherwise.
 */
export function provenanceFor(attributed: AttributedEvent): Provenance {
  const a = attributed.attribution;
  if (a.kind === 'overhead') return 'advisory';
  if (a.kind === 'commit' && attributed.explain !== null && attributed.explain.fileScore === 0) {
    // Only the pure-time fallback (or an adoption of one) can win with fileScore 0.
    return 'advisory';
  }
  return 'measured';
}
