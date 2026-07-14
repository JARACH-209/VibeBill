# vibebill — Build Specification v0.1.0

> **You (the coding agent) are building `vibebill`**: a local, zero-config, git-native cost
> accountant for AI-assisted ("vibe-coded") repositories. It parses the *actual* session logs
> that coding agents write to disk, joins token usage to git history, and answers:
> **what did this commit / PR / feature / release cost — and where did the money go?**
>
> Read this entire document before writing any code. Build in the milestone order defined in
> §12. Every milestone has acceptance criteria; do not proceed to the next milestone until the
> current one's tests pass.

---

## 1. Product principles (these override convenience)

1. **Measured, never guessed.** All dollar figures derive from real per-call token usage found
   in local agent transcripts. vibebill never estimates cost from diff size. If a number cannot
   be measured, it is either omitted or explicitly labeled.
2. **Three-tier provenance.** Every number displayed carries one of three labels:
   - `measured` — priced from actual token records with a known model price.
   - `repriced` — actual token traffic re-priced on a different model's price card
     (counterfactual; same traffic, different meter).
   - `advisory` — attribution was low-confidence or tokens could not be tied to a commit.
3. **Token conservation invariant.** For any report scope:
   `total_tokens == attributed + waste + overhead + out_of_scope`. This is asserted at runtime
   and in tests. If the books don't balance, vibebill says so loudly rather than hiding it.
4. **Privacy by construction.** vibebill reads transcripts **read-only**, extracts **only**
   metadata (timestamps, token counts, model names, session ids, cwd, branch, and file paths
   from edit tool calls). It never stores, caches, or prints prompt/response text. It never
   makes a network request except the explicit, opt-in `--refresh-pricing` flag.
5. **Deterministic.** Same logs + same repo state + same pricing table ⇒ byte-identical output
   (modulo terminal width). No randomness, no wall-clock-dependent output except explicitly
   dated report headers.
6. **Degrade honestly.** Unknown model → unpriced (tokens shown, `$—`, warning), never a
   silent guess. Unparseable log line → skipped and counted, never a crash. Missing data →
   smaller honest report, never a fabricated one.

## 2. Scope

### 2.1 In scope for v0.1.0

- **One source adapter: Claude Code** (local JSONL transcripts). The adapter layer is a clean
  interface so Codex CLI / Gemini CLI / aider / OpenCode adapters can be added in v0.2 without
  touching the engine.
- Ingestion with incremental caching (logs can be hundreds of MB; cold parse must stream).
- Git layer + **attribution engine** (session/message → commit), the core IP of this tool.
- Pricing engine with bundled pinned price table + opt-in refresh from a community source.
- Subscription-plan mode (Pro/Max users): identical math, "API-equivalent value" wording.
- CLI commands: `doctor`, `summary`, `log`, `show`, `range`, `reprice`, `report`, `notes`,
  with `--json` on every command.
- Markdown ledger report (`LEDGER.md`) and cost annotations via `git notes`.

### 2.2 Explicit non-goals for v0.1.0 (do NOT build these)

- No TUI dashboard, no watch/live mode, no GitHub Action, no `pr` command (forge APIs), no
  web UI, no team/multi-user features, no proxy/gateway mode.
- No Cursor support (its usage data is cloud-side and opaque — say so in README).
- No diff-based cost *estimation* fallback of any kind.
- No line-survival ("cost per surviving line") analysis — sketched in §13 roadmap; the data
  model must not preclude it, but do not implement it now.
- No telemetry, analytics, crash reporting, or auto-update.

## 3. Tech stack and hard constraints

- **Language:** TypeScript, strict mode (`"strict": true`, no `any` except at parse
  boundaries, where inputs must be validated by schema before use).
- **Runtime:** Node.js ≥ 20. Must run via `npx vibebill` with zero global installs.
- **Package:** single npm package `vibebill`, `"type": "module"`, compiled with `tsc` (no
  bundler needed; keep it boring). Binary entry via `bin` field.
- **Dependencies (keep to roughly this set; justify any addition in a code comment):**
  - `commander` (CLI parsing)
  - `zod` (runtime validation of untrusted inputs: JSONL lines, pricing JSON, config)
  - `picocolors` (terminal color; must degrade to plain when not a TTY or `NO_COLOR` set)
  - dev: `vitest`, `typescript`, `eslint` + `@typescript-eslint`, `prettier`
- **No dependency** for: git (shell out to the `git` binary via `execFile` — never `exec`
  with string interpolation), tables (write a small internal table renderer), money math
  (see §8 — integer arithmetic with `bigint`).
- **Filesystem discipline:** all vibebill state lives in `<repo>/.vibebill/` (add to the
  user's `.gitignore` only with explicit confirmation prompt on first run; if declined,
  print the line for them to add). Agent transcript directories are opened read-only.

## 4. Domain model

Define these in `src/core/types.ts`. All timestamps are UTC epoch milliseconds internally.
All token counts are `number` (safe: < 2^53). All money is `bigint` **nano-USD** (§8).

```ts
/** One priced API call record parsed from an agent transcript. The atomic unit. */
interface UsageEvent {
  id: string;              // stable dedupe key, adapter-defined (see §5.1.4)
  agent: 'claude-code';    // adapter id; union grows in v0.2
  sessionId: string;
  ts: number;              // UTC ms
  model: string;           // raw model string from the log, e.g. "claude-opus-4-8"
  tokens: {
    input: number;         // non-cached input tokens
    output: number;
    cacheWrite: number;    // cache_creation_input_tokens
    cacheRead: number;     // cache_read_input_tokens
  };
  cwd: string | null;          // absolute path if present in the record
  gitBranch: string | null;    // if present in the record
  editedFiles: string[];       // absolute paths from Edit/Write/MultiEdit/NotebookEdit
                               // tool_use blocks in this message; [] if none
  isSidechain: boolean;        // subagent traffic; attributed like normal traffic but
                               // reported in breakdowns as "subagents"
  sourceFile: string;          // transcript path (for doctor/debugging only)
}

/** A commit as vibebill sees it. */
interface CommitInfo {
  hash: string;
  parents: string[];
  authorTs: number;            // author date, UTC ms — preserved by rebase (committer date is not); see §7.6
  subject: string;
  branchHint: string | null;   // best-effort: from `git log --source` when walking refs
  files: string[];             // repo-root-relative paths changed (merge commits: [] — see §7.5)
  insertions: number;
  deletions: number;
  isMerge: boolean;
}

/** Result of attribution for one UsageEvent. */
type Attribution =
  | { kind: 'commit'; hash: string; confidence: 'high' | 'medium' | 'low' }
  | { kind: 'waste' }          // edits that never landed in any commit within horizon
  | { kind: 'overhead' }       // session had zero edit events; advisory bucket
  | { kind: 'out_of_scope' };  // event belongs to a different repo / filtered out

/** Priced, attributed event — the row everything else aggregates. */
interface LedgerEntry {
  event: UsageEvent;
  attribution: Attribution;
  cost: MoneyBreakdown | null; // null when model is unpriced
  provenance: 'measured' | 'repriced' | 'advisory';
}

interface MoneyBreakdown {    // all bigint nano-USD
  input: bigint; output: bigint; cacheWrite: bigint; cacheRead: bigint; total: bigint;
}
```

Aggregations (per commit, per range, per model, per session) are computed on demand from
`LedgerEntry[]` — no denormalized aggregate storage in v0.1.

---

## 5. Component specifications

### 5.1 Source adapter: Claude Code

**Location of truth:** Claude Code writes one JSONL transcript file per session under
`~/.claude/projects/<encoded-project-dir>/<session-uuid>.jsonl`. Each line is a JSON object
representing a message or event in that session. Assistant messages that correspond to API
calls carry a `message.usage` object with per-call token counts, and a `message.model` string.

**⚠️ MANDATORY FIRST STEP before writing the parser:** these files are an undocumented
internal format that shifts across Claude Code versions. Before implementing, inspect real
samples on this machine (`ls ~/.claude/projects/`, read 20–50 lines from 2–3 recent files)
and confirm/adjust the field mapping below against what you actually observe. Build your test
fixtures by copying real lines and **sanitizing them**: replace all `content` text with
placeholders, keep structure and metadata intact. If `~/.claude` does not exist in your build
environment, implement against the mapping below, mark the adapter with a
`SCHEMA_VERIFIED = false` constant, and make `vibebill doctor` report parse coverage so real
users surface mismatches immediately.

**5.1.1 Field mapping (verify against live logs, as of mid-2026):**

| UsageEvent field | JSONL source |
|---|---|
| `sessionId` | `sessionId` |
| `ts` | `timestamp` (ISO 8601 → UTC ms) |
| `model` | `message.model` |
| `tokens.input` | `message.usage.input_tokens` |
| `tokens.output` | `message.usage.output_tokens` |
| `tokens.cacheWrite` | `message.usage.cache_creation_input_tokens` (default 0) |
| `tokens.cacheRead` | `message.usage.cache_read_input_tokens` (default 0) |
| `cwd` | `cwd` (present on most records) |
| `gitBranch` | `gitBranch` (present in newer versions; else null) |
| `isSidechain` | `isSidechain` (default false) |
| `editedFiles` | from `message.content[]` blocks where `type === "tool_use"` and `name ∈ {Edit, Write, MultiEdit, NotebookEdit}` → `input.file_path` (MultiEdit: `input.file_path`; collect unique) |
| `id` | see 5.1.4 |

Records without a `message.usage` object (user messages, tool results, meta events) produce
**no** UsageEvent, but tool_use file paths appear on the *assistant* message itself, so no
cross-record joining is needed for `editedFiles`. Do not read, store, or log any `content`
text besides `tool_use.name` and `tool_use.input.file_path`.

**5.1.2 Project-dir mapping:** the `<encoded-project-dir>` directory name is a lossy encoding
of the cwd (slashes replaced with dashes). **Never reverse-engineer the path from the
directory name** — ambiguous. Always read the `cwd` field from inside the records. Scan *all*
project directories and filter events by `cwd` at query time (an agent may have been launched
from a subdirectory of the target repo).

**5.1.3 Tolerance rules:** parse line-by-line as a stream (never `JSON.parse` the whole
file). A line that fails `JSON.parse` or zod validation is skipped and counted in
`parseStats.skippedLines`. Unknown extra fields are ignored (zod `.passthrough()` where
appropriate). A file that cannot be opened is skipped and counted. `doctor` reports:
files found, lines read, events extracted, lines skipped, % coverage.

**5.1.4 Deduplication (required — real logs contain duplicates):** Claude Code can write the
same API call into multiple lines/files (retries, resumed sessions, streamed partials).
Dedupe key: `message.id + ":" + requestId` when both exist; else
`sessionId + ":" + timestamp + ":" + hash(usage-json)`. Keep the **last** occurrence.
Dedupe must happen at ingestion, before caching. A fixture must cover this.

**5.1.5 Adapter interface (for v0.2 extensibility):**

```ts
interface SourceAdapter {
  id: 'claude-code';
  discover(): Promise<string[]>;                    // transcript file paths
  parseFile(path: string, sink: (e: UsageEvent) => void): Promise<FileParseStats>;
}
```

### 5.2 Ingestion & cache

- Cache lives at `<repo>/.vibebill/cache/`:
  - `events.ndjson` — normalized, deduped UsageEvents relevant to this repo
    (i.e. `cwd` is inside the repo root after `fs.realpath` normalization).
  - `manifest.json` — `{ schemaVersion, adapterVersion, files: { [path]: { size, mtimeMs,
    bytesConsumed } }, dedupeIndexHash }`.
- **Incremental rule:** on each run, a transcript file is re-read only if `size` or `mtimeMs`
  changed; if it grew and `bytesConsumed` is a valid line boundary, resume from the offset,
  else re-parse that file from zero. Cache is invalidated wholesale when `schemaVersion` or
  `adapterVersion` bumps.
- Corrupt/missing cache ⇒ silent full rebuild (cache is always disposable).
- Events whose `cwd` is outside the repo are not cached but ARE counted into an
  `out_of_scope` tally in the manifest so the conservation invariant can be checked
  against raw parse totals in tests.

### 5.3 Git layer (`src/git/`)

All git access shells out to the `git` binary with `execFile` and explicit argument arrays.
Resolve repo root once via `git rev-parse --show-toplevel`; fail with a clear message if not
in a repo. Required capabilities:

1. **Commit enumeration:** default scope is `HEAD` history:
   `git log HEAD --date-order --no-color --pretty=format:<FIELDS with \x1f separators and \x1e record terminator> --numstat`
   parsed streaming. Extract: hash, parent hashes, author date (strict ISO), subject, and the
   numstat file list (rename lines `old => new`: record the **new** path; binary `-` counts
   as 0/0). `--all` mode behind `--all-refs` flag (off by default; documented: attribution
   against HEAD history is the primary use case).
2. **Merge commits:** detected via parents.length > 1; their own file list is treated as `[]`
   and they are never attribution targets (§7.5).
3. **Notes:** read/write under ref `refs/notes/vibebill` only
   (`git notes --ref=vibebill add -f -m <json> <hash>`). Never touch the default notes ref.
4. **Path normalization:** commit paths are repo-root-relative; UsageEvent.editedFiles are
   absolute. Normalize events to repo-relative at attribution time (realpath both sides;
   events pointing outside the repo root are dropped from edit matching but keep their
   tokens).

### 5.4 Attribution engine (`src/core/attribution.ts`) — the heart. Implement exactly.

**Inputs:** `events: UsageEvent[]` (this repo only, deduped, sorted by ts),
`commits: CommitInfo[]` (non-merge, sorted by authorTs), config
`{ horizonDays = 14, graceSeconds = 120, weights = { file: 0.6, time: 0.25, branch: 0.15 } }`.

**Definitions:**
- An event is an **edit event** iff `editedFiles.length > 0` (after normalization to
  repo-relative paths).
- **Candidate window:** commit `C` is a candidate for event `e` iff
  `authorTs(C) + grace >= e.ts >= authorTs(C) - horizon`.
  (Edits precede their commit; `grace` absorbs clock skew and commit-immediately-after-write
  ordering quirks.)

**Step A — score edit events against candidate commits:**

```
fileScore(e, C)   = |rel(e.editedFiles) ∩ C.files| / |rel(e.editedFiles)|      ∈ [0,1]
timeScore(e, C)   = max(0, 1 - (authorTs(C) - e.ts) / horizonMs)               ∈ [0,1]
branchScore(e, C) = 1 if e.gitBranch != null and C.branchHint != null
                      and e.gitBranch == C.branchHint
                    0.5 if either side is null (unknown ≠ mismatch)
                    0 otherwise
score(e, C) = w.file * fileScore + w.time * timeScore + w.branch * branchScore
```

Assign `e` to `argmax_C score(e, C)` subject to `fileScore(e, C) > 0` **or**
(`fileScore == 0` for all candidates and the top candidate is the *next commit in time on
the event's branch* — the pure-time fallback). Ties broken by smallest
`authorTs(C) - e.ts`, then lexicographic hash (determinism).

Confidence: `high` if `fileScore >= 0.8` and (branchScore == 1 or only one candidate had
fileScore > 0); `medium` if `fileScore >= 0.4`; else `low`. Pure-time fallback is always
`low` and its LedgerEntry provenance is `advisory`.

**Step B — waste:** an edit event with no candidate commit whose `fileScore > 0` within the
horizon **after** the event, where at least `horizonDays` have elapsed since `e.ts` (or the
repo's newest commit is > horizon past `e.ts`), is `{ kind: 'waste' }`. If the horizon has
not yet elapsed, classify as `{ kind: 'commit' }` pending? **No** — classify as `overhead`
with a `pending` note is over-complex; instead: events newer than
`newestCommit.authorTs - grace` with no match are reported in a distinct display bucket
**"in progress (uncommitted)"** derived at render time from `waste` entries with
`e.ts > newestCommit.authorTs`. Storage kind remains `waste`; rendering distinguishes.

**Step C — non-edit events (planning / reads / thinking / tool results):**
Within each session, sort all events by ts. Each non-edit event adopts the attribution of the
**next edit event in the same session** (forward-attach: exploration and planning lead to the
edit that follows). Trailing non-edit events after the session's last edit event adopt the
**previous** edit event's attribution. Sessions with **zero** edit events: every event is
`{ kind: 'overhead' }` (advisory; shown in summaries as "sessions with no file edits").

**Step D — invariant check (runtime, every command):**
`Σ tokens(all parsed events for repo) == Σ tokens(commit) + Σ tokens(waste) + Σ tokens(overhead)`.
On violation: print a red warning with the delta and `--json` field
`accountingMismatch: { tokens: n }`. Tests treat any mismatch as failure.

**Determinism requirement:** attribution of a fixed (events, commits, config) triple is a
pure function. No Date.now() inside the engine — "now" is passed in as a parameter.

### 5.5 Pricing engine (`src/pricing/`)

**Price schema** (`prices/prices.json`, bundled, pinned per release):

```json
{
  "schemaVersion": 1,
  "asOf": "<ISO date — set at release time>",
  "source": "manual, cross-checked against provider price pages",
  "models": {
    "<model-id-prefix>": {
      "displayName": "…",
      "inputPerMTok": "15.00",
      "outputPerMTok": "75.00",
      "cacheWritePerMTok": "18.75",
      "cacheReadPerMTok": "1.50"
    }
  }
}
```

- Prices are **decimal strings**, parsed with the exact-decimal routine in §8. Never floats.
- **Model matching:** longest-prefix match on the raw model string (handles dated suffixes
  like `-20260115`). No match ⇒ event is **unpriced**: tokens reported, cost `$—`, one
  aggregated warning per unknown model naming the model string and suggesting
  `--refresh-pricing` or a PR.
- **⚠️ You must populate the initial table at build time**: fetch the current LiteLLM
  community price file (`model_prices_and_context_window.json` from the BerriAI/litellm
  repository on GitHub — permitted network domains include raw.githubusercontent.com) and
  extract entries for: current Anthropic Claude models, OpenAI GPT/Codex models, Google
  Gemini models, DeepSeek models, and Qwen coder models. Convert per-token to per-MTok
  decimal strings. Record provenance in `asOf`/`source`. Do not invent numbers; if a model
  is absent from the source, omit it.
- **`--refresh-pricing`:** the ONLY network call in the program. Fetches the same LiteLLM
  JSON, converts, validates with zod, writes `~/.config/vibebill/prices.json` which then
  takes precedence over the bundled file. Offline or on any error: keep last known table,
  warn with its `asOf` date. Never auto-refresh.
- **Repricing (`vibebill reprice --model X`):** recompute MoneyBreakdown for the selected
  scope using model X's price card on the *measured* token traffic, with cache-token
  handling: if X's card lacks cache prices, price cacheRead and cacheWrite at
  `inputPerMTok` and flag it in output. Output MUST carry the label:
  `repriced — same traffic, different meter; a different model may need more or fewer turns`.
- **Plan mode:** `--plan pro|max5|max20` flag or `plan` key in config. Changes wording only:
  headers say "API-equivalent value", totals get the suffix
  `consumed on your <plan> subscription`, and `summary` adds a line comparing the period's
  API-equivalent total to nothing (no plan price math — plan prices change; do not hardcode
  them).


---

## 6. CLI specification (`src/cli/`)

Global behavior: every command supports `--json` (stable machine-readable output; document
each schema in `docs/json-schemas.md`), `--since <date>` / `--until <date>` (ISO or
`git log`-style relative), `--no-color`, `--quiet`. Exit codes: `0` ok, `1` user/environment
error (not a repo, no logs found), `2` internal error, `3` accounting-mismatch warning
present while `--strict` was set. Currency display: `$1,234.56` (round half-even to cents
at render time only). Confidence markers: `●` high, `◐` medium, `○` low/advisory.

### 6.1 `vibebill doctor`
Environment self-check, first thing users run. Reports (each with ✓/✗ and remedy text):
git found & repo detected; `~/.claude/projects` found; transcript files found for this repo
(count, size, date range); parse coverage (% lines parsed, skipped counts, duplicates
removed); pricing table `asOf` and unknown-model list from a dry ingest; cache status;
plan-mode config. `--json` supported.

### 6.2 `vibebill summary [--since --until]`
Repo-level rollup: total measured cost, tokens by class (input / output / cache write /
cache read), cost by model (table), cache-efficiency line
("cache reads were N% of input volume, saving ~$X vs. uncached input" — savings computed as
`cacheRead_tokens × (inputPrice − cacheReadPrice)`, labeled `measured`), waste line
("$X across N sessions never landed in a commit"), overhead line, sessions and commits
covered, and the accounting-invariant status line.

### 6.3 `vibebill log [-n N] [revision-range]`
`git log --oneline`-style listing, newest first, with columns:
`cost | conf | hash | date | subject | models | sessions`.
Uncosted commits (no attributed events — e.g. human-written) show `$0.00 ·human?`.
The "in progress (uncommitted)" bucket, if non-empty, renders as a pseudo-row at top.
Footer: scope totals + invariant status. This is the money screenshot — make the default
output beautiful, aligned, and complete at 100 columns.

### 6.4 `vibebill show <ref>`
Deep-dive on one commit: attributed cost with breakdown (input/output/cache write/cache
read), token totals, contributing sessions (id-prefix, time span, event counts, per-session
cost), per-model split, subagent share, files matched vs. files in commit (the evidence for
the attribution), confidence and *why* (fileScore/timeScore/branchScore values), and any
advisory notes.

### 6.5 `vibebill range <A>..<B>`
Everything `summary` shows, restricted to commits in `git rev-list A..B`, plus per-commit
mini-table and a "cost of this release" headline. Also accepts `--label <name>` to title the
output (used by `report`).

### 6.6 `vibebill reprice --model <model-id> [range] [--vs]`
Counterfactual repricing per §5.5. Default scope: whole repo. `--vs` prints a two-column
comparison against measured actuals with a delta line
(`Opus 4.8 measured $212.40 → DeepSeek V4 repriced $9.12 (−95.7%)`). The honesty label from
§5.5 is ALWAYS printed, including in `--json` (`"label"` field). Unknown target model ⇒
exit 1 with the list of known model ids.

### 6.7 `vibebill report --md [--out LEDGER.md] [range]`
Writes a self-contained markdown ledger: header (repo, generated date, vibebill version,
pricing `asOf`, provenance legend), summary section, per-commit table, waste section, model
mix, and a footnotes section stating methodology + caveats in two sentences. Writing into
the repo happens **only** via this explicit command; never auto-write. If the target file
exists, refuse unless `--force`.

### 6.8 `vibebill notes sync [range]`
Writes per-commit JSON (`{v:1, costNanoUsd, tokens:{…}, confidence, provenance,
generatedBy:"vibebill@<version>"}`) to `refs/notes/vibebill`, idempotently (`-f` overwrite
of vibebill's own notes only). Print the one-liner teaching users
`git log --notes=vibebill`. `--clear` removes vibebill notes in scope.

### 6.9 Config file (optional): `vibebill.config.json` at repo root
`{ plan?, horizonDays?, graceSeconds?, weights?, adapter?: 'claude-code' }` — validated by
zod; unknown keys warn. CLI flags override config.

---

## 7. Edge cases — required behaviors

| # | Case | Required behavior |
|---|---|---|
| 7.1 | Multiple repos on one machine | Filter by realpath-normalized `cwd` inside repo root. Never attribute cross-repo. |
| 7.2 | Agent launched in monorepo subdir | `cwd` inside repo root ⇒ in scope; file matching is path-based so sub-package commits match naturally. |
| 7.3 | One session spans many commits | Message-grain attribution (§5.4) splits it; test S2 asserts the split. |
| 7.4 | Many sessions feed one commit | All contribute; `show` lists each. |
| 7.5 | Merge commits | Never attribution targets; their cost is definitionally $0 (work belongs to the merged commits). Squash-merged branches: the squash commit is a normal commit whose files match the sessions' edits — handled by Step A naturally; test S5. |
| 7.6 | Rebase / amend | Author date survives rebase; hashes don't. Ledger cache is keyed by nothing (recomputed), notes are re-synced idempotently. Document in README: after history rewrites, rerun `notes sync`; stale notes on dead hashes are unreachable and harmless. |
| 7.7 | Cherry-pick | Author date may be far older than commit context; candidate windows use author date, so events match the *original* work — correct behavior; note in docs. |
| 7.8 | Uncommitted current work | "in progress (uncommitted)" pseudo-bucket (§5.4 Step B). |
| 7.9 | Clock skew / commit-during-write | `graceSeconds` (default 120) after authorTs. |
| 7.10 | Timezones | Everything UTC internally; display local time with offset in headers only. |
| 7.11 | File renames | numstat `old => new` recorded as new path; an edit to the pre-rename path in the same window will miss on fileScore and fall to time fallback — acceptable v0.1, documented. |
| 7.12 | Transcript mid-write (agent running now) | Stream parser tolerates a truncated final line (skip, count); incremental resume picks it up next run. |
| 7.13 | Huge pastes / images in transcripts | Irrelevant — we never read content; parser must still skip such lines cheaply (bounded line buffer, e.g. 10 MB cap per line, count as skipped beyond cap). |
| 7.14 | `NO_COLOR`, piped output | Plain ASCII tables, no ANSI. |
| 7.15 | Shallow clones | Detect via `git rev-parse --is-shallow-repository`; warn that history-based attribution is truncated. |
| 7.16 | Empty repo / zero commits | `doctor` fine; other commands: friendly message, exit 0, totals go to waste/overhead buckets. |

---

## 8. Money math (get this exactly right)

- Internal unit: **nano-USD** (`1 USD = 1_000_000_000n`), type `bigint` everywhere money
  exists. Rationale: per-token prices at $/MTok granularity are sub-micro-dollar; nano-USD
  keeps every intermediate exact for realistic magnitudes.
- Price string → nano-USD per token: parse the decimal string `"15.00"` ($/MTok) with a
  hand-written exact parser (integer + fraction digits; **no** `parseFloat` anywhere in the
  money path): `nanoPerTok = (dollarsPerMTok × 10^9) / 10^6` computed in scaled integer
  space; reject prices with more than 9 fractional digits.
- `cost = Σ (tokens_class × nanoPerTok_class)` in bigint.
- Display rounding: nano-USD → cents with **round-half-even**, thousands separators, at the
  rendering boundary only. `--json` emits both `nanoUsd` (string, since JSON can't hold
  bigint) and `usd` (pre-rounded string like `"12.34"`).
- Property test (§11): for random token vectors and price tables, bigint total equals a
  reference computed with arbitrary-precision decimal (implement the reference in-test with
  scaled bigints at higher precision); and Σ per-commit == scope total exactly.

## 9. Performance targets (enforced by a benchmark script, not vibes)

- Cold ingest of 500 MB of JSONL: < 30 s on a typical laptop; memory ceiling < 300 MB RSS
  (streaming, no whole-file buffering).
- Warm run (`log` on cached events, 5k commits, 200k events): < 2 s.
- `scripts/bench.ts` generates synthetic logs of parameterized size and prints timings;
  CI runs a small variant to catch >2× regressions.

## 10. Error handling & degradation policy

- Every user-facing failure states: what happened, why it likely happened, what to do next.
  (e.g. "No Claude Code transcripts found under ~/.claude/projects for this repo. If your
  logs live elsewhere set VIBEBILL_CLAUDE_DIR. Run `vibebill doctor` for a full check.")
- `VIBEBILL_CLAUDE_DIR` env var overrides the default transcript root (also enables testing).
- Never print a stack trace unless `--debug`. Internal errors: one line + invitation to file
  an issue, exit 2.
- Partial data is fine and normal: report what was measured, enumerate what was skipped.


---

## 11. Testing strategy & acceptance scenarios

Framework: vitest. Layout: unit tests colocated (`*.test.ts`), scenario tests in
`test/scenarios/`. Two fixture builders are required infrastructure — build them first:

- **`test/helpers/transcripts.ts`** — programmatic builder producing realistic Claude Code
  JSONL (sanitized-real structure per §5.1): `session().at(ts).call({model, usage,
  edits:[paths], cwd, branch})…write(dir)`.
- **`test/helpers/repo.ts`** — scripted git repo builder in a temp dir (init, config user,
  commit files at controlled `GIT_AUTHOR_DATE`/`GIT_COMMITTER_DATE`, branch, merge,
  squash-merge, rebase), returning hashes for assertions.

Scenario tests drive the real CLI entry (spawn or direct invocation with
`VIBEBILL_CLAUDE_DIR` pointed at fixtures) and assert on `--json` output. **Golden
scenarios (all must pass before release):**

| ID | Scenario | Must assert |
|---|---|---|
| S1 | One session → one commit | 100% of session cost on that commit, confidence `high`, invariant holds |
| S2 | One session spans 3 commits (edits interleaved in time, disjoint files) | per-commit split matches message-grain expectation; non-edit events forward-attach correctly |
| S3 | Two branches, interleaved sessions, same window | file+branch scores route events to the right commits; zero cross-contamination |
| S4 | Abandoned session (edits never committed, horizon elapsed) | full cost in `waste`; appears in summary waste line |
| S5 | Feature branch squash-merged | squash commit receives the branch sessions' cost |
| S6 | Duplicate JSONL entries (same message.id+requestId across two files) | counted once; dedupe stat reported |
| S7 | Unknown model | tokens reported, cost `$—`, single aggregated warning, exit 0 |
| S8 | Malformed lines (truncated tail, binary garbage line, >cap line) | skipped + counted, no crash, coverage % in doctor |
| S9 | Plan mode | wording switches to API-equivalent value; no plan-price math anywhere |
| S10 | Perf smoke | synthetic 50 MB log ingests within CI budget; memory bounded |
| S11 | Reprice | measured Opus traffic repriced on a cheap card matches hand-computed bigint expectation; honesty label present in text and JSON |
| S12 | Invariant tamper | artificially drop one attributed entry post-hoc → mismatch warning fires, `--strict` exits 3 |
| S13 | Uncommitted in-progress work | pseudo-bucket rendered; not counted as waste in summary wording |
| S14 | notes sync idempotence | run twice → identical notes, no duplicates; `--clear` removes only vibebill ref |

Property tests: money math (§8); token conservation over randomized event/commit
generators (1000 cases); determinism (same inputs twice → deep-equal JSON).

**Definition of done for v0.1.0:** all scenarios green; `doctor`, `summary`, `log`, `show`,
`range`, `reprice`, `report`, `notes` implemented per §6; README complete per §14.4;
`npm pack` produces a package that runs via `npx` from a clean directory;
`npm publish --dry-run` clean.

---

## 12. Build plan — execute in this order

**M0 — Scaffold (small):** repo layout (§14.1), tsconfig strict, eslint+prettier, vitest,
CI workflow (lint → typecheck → test), `bin` wiring, `--version`. Commit.

**M1 — Ingestion:** transcript fixture builder → Claude Code adapter (parse, tolerate,
dedupe) → cache with incremental resume → `doctor` + `summary` (totals only, no
attribution: totals must equal raw fixture sums exactly — this is the parser's ground-truth
test). Scenarios S6, S7, S8 pass. Commit per component.

**M2 — Git + attribution:** repo fixture builder → git layer → attribution engine as a pure
function with exhaustive unit tests → wire into `log` and `show` → invariant check
everywhere. Scenarios S1–S5, S12, S13 pass. This is the milestone where correctness lives;
do not rush it.

**M3 — Pricing:** populate real price table (per §5.5, with provenance), money math + property
tests, `--refresh-pricing`, `reprice`, `range`, plan mode. Scenarios S9, S11 pass.

**M4 — Reporting & polish:** `report --md`, `notes sync`, table renderer polish (the §6.3
screenshot standard), bench script + S10, README (§14.4), CHANGELOG, LICENSE (MIT),
package metadata, publish dry-run.

After each milestone: run the full suite, fix, commit with a conventional-commit message.
If you must deviate from this spec, record the deviation and reason in
`docs/decisions.md` — do not silently redesign.

## 13. Roadmap (documented in README as "planned", NOT built now)

v0.2: Codex CLI + Gemini CLI + aider adapters (interface already in place) · `pr` command
via `gh` when available · GitHub Action posting the PR cost comment.
v0.3: churn/survival analysis ("cost per surviving line" via blame sampling) ·
cache-strategy hints · TUI dashboard.
Explicitly never: telemetry, hosted service requirement, diff-based estimation.

---

## 14. Repository conventions

### 14.1 Layout

```
vibebill/
├─ src/
│  ├─ cli/            # commander wiring, one file per command, rendering
│  ├─ adapters/claude-code/
│  ├─ core/           # types.ts, attribution.ts, aggregate.ts, invariant.ts
│  ├─ git/
│  ├─ pricing/        # engine.ts, money.ts
│  └─ cache/
├─ prices/prices.json
├─ test/{helpers,scenarios}/
├─ scripts/bench.ts
├─ docs/{json-schemas.md,decisions.md,how-attribution-works.md}
└─ README.md · CHANGELOG.md · LICENSE (MIT)
```

### 14.2 Code standards
Strict TS; zod at every untrusted boundary; pure core (attribution/pricing/aggregation have
zero I/O — I/O lives in adapters/git/cache/cli); no float in any money path; `execFile`
only, never shell strings; every exported function documented with one honest sentence.

### 14.3 Hard DO-NOTs (repeat of principles as build rules)
1. No network calls except `--refresh-pricing` (and the one-time price-table population
   during YOUR build, which happens at build time, not runtime).
2. Never read/store/log transcript `content` text beyond tool names and file paths.
3. Never write to the repo except explicit `report --out` and `notes sync`.
4. Never guess a price, a model, or a path encoding. Unknown ⇒ labeled unknown.
5. Never let a malformed input crash the program.
6. No new runtime dependencies beyond §3 without a written justification comment.

### 14.4 README requirements (write it like a product, not a manual)
1. One-line pitch + a `vibebill log` output block as the hero (real-looking, honest).
2. `npx vibebill` quickstart (3 commands: `doctor`, `log`, `summary`).
3. "How it works" — 5 sentences: local logs, git join, message-grain attribution,
   provenance tiers, privacy guarantee.
4. **Honest limitations section** (this builds trust — do not soften it): Claude Code only
   in v0.1; attribution is probabilistic with confidence markers; rebases require
   `notes sync` re-run; Cursor unsupported (cloud-side data); subscription plans show
   API-equivalent value, not billed dollars; repriced numbers are same-traffic
   counterfactuals, not workload simulations.
5. Roadmap (§13), contributing note for price-table PRs, MIT badge.

---

*End of spec. Build M0 → M4 in order. When in doubt, choose the boring, measurable,
honest option — that is the product.*
