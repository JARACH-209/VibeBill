# How attribution works

Every dollar vibebill reports starts as one API call recorded in an agent's local session
log: a timestamp, a model, and exact token counts. Pricing those tokens is arithmetic.
The interesting problem is **attribution** — deciding which commit each call belongs to —
and this page explains exactly how vibebill does it, ending with a worked example.

One thing to hold onto throughout: attribution never changes *how much* was spent. Token
counts are measured facts. Attribution only decides *where* each token lands, and the books
must balance at the end (see [the invariant](#the-books-must-balance)).

## The raw material: usage events

Each API call parsed from a transcript becomes a **usage event** carrying its timestamp,
model, token counts, session id, working directory, git branch (when the agent recorded
one), and the list of files the agent edited in that turn (from Edit/Write-style tool
calls — file *paths* only, never content).

Events split into two kinds:

- **Edit events** — the agent edited at least one file inside your repo in that turn.
  These carry direct evidence and are attributed first.
- **Non-edit events** — planning, reading files, searching, thinking, tool results. No
  direct evidence, but they ride along with the edits they led to (see
  [forward-attach](#non-edit-events-forward-attach)).

## Candidate commits

For an edit event `e`, a commit `C` is a **candidate** when its author time falls inside
the event's window:

```
e.ts − 120 s  ≤  authorTs(C)  ≤  e.ts + 14 days
```

In words: edits precede the commit that lands them, so vibebill looks up to 14 days
*forward* from the event (the **horizon**), plus a 120-second **grace** period backward to
absorb clock skew and the "agent writes the file an instant after you commit" ordering
quirk. Both knobs are configurable (`horizonDays`, `graceSeconds` in
`vibebill.config.json`).

Two deliberate choices here:

- **Author dates, not committer dates.** Author dates survive rebases, so attribution
  recovers automatically after history rewrites. It also means a cherry-picked commit
  matches the *original* work — which is the correct answer.
- **Merge commits are never candidates.** Their cost is definitionally $0; the work
  belongs to the commits being merged. (A squash-merge commit is a normal commit whose
  file list matches the branch's edits, so it attracts the branch sessions' cost
  naturally.)

## Scoring

Each candidate gets three sub-scores, combined with fixed weights:

```
fileScore(e, C)   = |edited(e) ∩ files(C)| / |edited(e)|              ∈ [0, 1]
timeScore(e, C)   = clamp to [0,1] of  1 − (authorTs(C) − e.ts) / horizon
branchScore(e, C) = 1    both sides known and equal
                    0.5  either side unknown (unknown ≠ mismatch)
                    0    both known and different

score(e, C) = 0.6 · fileScore + 0.25 · timeScore + 0.15 · branchScore
```

- **fileScore** is the workhorse: what fraction of the files this event edited ended up
  changed in commit `C`?
- **timeScore** prefers the sooner commit: 1.0 for a commit landing immediately, falling
  linearly to 0 at the horizon.
- **branchScore** uses the branch name the agent recorded. Note that in the default mode
  (attributing against `HEAD` history) git does not remember which branch a commit was
  made on, so the commit side is unknown and branchScore is usually 0.5; `--all-refs`
  derives branch hints and makes this score bite.

The weights are configurable (`weights.file/time/branch`); the defaults above are what
shipped.

**The winner** is the candidate with the highest score, **required to share at least one
file** (`fileScore > 0`). Ties break deterministically: nearest commit in time first, then
lexicographically smallest hash. No randomness, ever.

## Confidence

Every commit attribution carries a confidence tier, shown as a marker in `log` and `show`
(● high · ◐ medium · ○ low; ASCII `*` `~` `.` when color is off):

- **high** — `fileScore ≥ 0.8` *and* (the branch matched, or this was the only candidate
  that shared any files). The edits map almost entirely onto the commit and nothing else
  claims them.
- **medium** — `fileScore ≥ 0.4`.
- **low** — everything else, including the pure-time fallback below.

`vibebill show <ref>` prints the raw fileScore/timeScore/branchScore per contributing
event — the evidence, not just the verdict.

## The pure-time fallback

Sometimes *no* candidate shares a single file with an event — for example the file was
renamed before committing, or the work landed under a different path. If any commit exists
at-or-after the event within its window, vibebill falls back to the **next commit in
time**, preferring the event's own branch when both branch names are known. Fallback
attributions are always **low** confidence and labeled **advisory** — they are a guess by
proximity and are marked as such.

## Non-edit events: forward-attach

Exploration, planning, and reading are the run-up to an edit: they lead to the edit that
follows. So within each session (events sorted by time), every non-edit event **adopts the
attribution of the next edit event in the same session**. Non-edit events *after* the
session's last edit (wrap-up, summaries) adopt the *previous* edit's attribution.

A session with **zero** edit events has nowhere to attach — every one of its events becomes
**overhead** (advisory), reported in summaries as "sessions with no file edits". Those are
real, measured tokens; vibebill just won't pretend to know which commit they served.

## Waste, in progress, overhead

Three buckets hold tokens that didn't attach to a commit:

- **Waste** — an edit event whose files never matched any commit, with no commit landing
  in its window at all: the work never landed. Waste is still `measured` — the spend is a
  fact, only the destination is "nowhere".
- **In progress (uncommitted)** — a display refinement of waste: waste *newer than the
  newest commit* is your current uncommitted work, not abandonment, and is rendered as its
  own pseudo-row at the top of `vibebill log` rather than scolded as waste.
- **Overhead** — whole sessions that never edited a file (see above). Advisory.

## The books must balance

The token-conservation invariant, checked on **every** command:

```
total parsed tokens = attributed + waste + overhead + out-of-scope
```

**Out-of-scope** covers events proven to belong elsewhere: their working directory is
another repo, or no working directory was recorded at all (membership can't be proven, so
vibebill refuses to guess it into scope). If the sum ever fails to balance, vibebill prints
a loud warning with the delta — and `--strict` exits with code 3 — rather than hiding the
discrepancy. This line at the bottom of every report is that check:

```
accounting: 6.8B tokens = attributed 29.9M + waste 15.3M + overhead 311.5k + out-of-scope 6.7B OK
```

## Determinism

Attribution is a pure function of (events, commits, config). "Now" is injected, never read
from the clock inside the engine, and all ties break by explicit rules. Same logs + same
repo state + same pricing table ⇒ byte-identical output.

## A worked example

One session on branch `main`, four events, defaults everywhere (horizon 14 days, grace
120 s, weights 0.6/0.25/0.15). The repo gains one commit:

> **C1** `a1b2c3d` — "feat: token refresh", authored **14:30**,
> files: `src/auth.ts`, `src/auth.test.ts`, `README.md`

| event | time | edited files | tokens |
|---|---|---|---:|
| e1 | 14:02 | *(none — planning, reading)* | 12,000 |
| e2 | 14:10 | `src/auth.ts`, `src/auth.test.ts` | 31,000 |
| e3 | 14:26 | `src/auth.ts` | 8,000 |
| e4 | 18:00 | `src/experiment.ts` *(never committed)* | 20,000 |

**e2 vs C1.** Both edited files appear in C1: fileScore = 2/2 = **1.0**. The commit lands
20 minutes later; 20 min ÷ 14 days ≈ 0.001, so timeScore ≈ **0.999**. We're in default
HEAD mode, so C1's branch is unknown: branchScore = **0.5**. Total:
0.6·1.0 + 0.25·0.999 + 0.15·0.5 ≈ **0.925**. C1 is the only candidate sharing any files
and fileScore ≥ 0.8 ⇒ **high** confidence.

**e3 vs C1.** fileScore = 1/1 = 1.0, timeScore ≈ 1.0 (4 minutes out), same branchScore
⇒ score ≈ 0.925, **high**. C1 now carries e2 + e3.

**e1** edited nothing, so it forward-attaches to the next edit event in its session — e2 —
and inherits e2's attribution: C1, high. The 12,000 planning tokens are charged to the
commit that planning produced.

**e4** shares no file with C1 (`src/experiment.ts` was never committed), and in this repo
no commit at all lands in the 14 days after 18:00 — so e4 is **waste**. Because e4 is newer
than the newest commit (C1, 14:30), `vibebill log` renders it as
**in progress (uncommitted)** rather than waste. If the experiment is later abandoned and
history moves past it, it settles into the waste line. And had some *unrelated* commit
landed at, say, 19:00, e4 would instead have gone to it via the pure-time fallback — low
confidence, advisory, visibly marked ○.

Final ledger for the example:

| destination | tokens |
|---|---:|
| C1 `a1b2c3d` (● high) | 51,000 |
| in progress (uncommitted) | 20,000 |
| overhead | 0 |

Invariant: 71,000 = 51,000 + 20,000 + 0 + 0 ✓ — the books balance, so the report prints.
