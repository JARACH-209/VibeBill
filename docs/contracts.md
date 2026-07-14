# vibebill internal module contracts

Internal build document. Every module implements EXACTLY these exported signatures so the
CLI can be wired against them without drift. Domain types live in `src/core/types.ts` and
are already final — import, never redefine. Money helpers live in `src/pricing/money.ts`
(final). If a contract here is impossible to satisfy, STOP and report back — do not
redesign silently (spec §12).

Shared rules (spec §14.2/§14.3):
- strict TS, no `any` except at parse boundaries where zod validates before use
- zod at every untrusted boundary (JSONL lines, pricing JSON, config)
- pure core: attribution/pricing-math/aggregation do zero I/O
- `execFile` with argument arrays only — never shell strings
- never read/store/log transcript `content` text beyond tool names and file paths
- adapters open transcript dirs READ-ONLY
- every exported function documented with one honest sentence
- no new runtime deps beyond commander/zod/picocolors

## Verified log-format facts (recon on this machine, 2026-07-14)

### Claude Code (`~/.claude/projects/<encoded-dir>/<session-uuid>.jsonl`) — VERIFIED against v2.1.202 logs
- Line envelope (assistant records): `{ type: "assistant", sessionId, timestamp (ISO 8601),
  cwd, gitBranch, isSidechain, requestId, uuid, parentUuid, version, message: {...} }`.
- Other observed `type` values (produce no UsageEvent): `user`, `attachment`, `ai-title`,
  `custom-title`, `queue-operation`, `last-prompt`, and more may appear — ignore unknown.
- `message`: `{ id: "msg_01...", model, usage, content: [...] }`.
- `message.usage`: `{ input_tokens, output_tokens, cache_creation_input_tokens,
  cache_read_input_tokens, iterations?: [{ input_tokens, output_tokens,
  cache_read_input_tokens, cache_creation_input_tokens, type: "message"|"fallback_message" }, ...], ... }`.
  **Token extraction rule (verified):** if top-level input+output+cacheWrite+cacheRead > 0,
  use top-level (on multi-iteration retry/fallback records the top-level equals the LAST
  iteration — the call that landed; earlier iterations are failed/fallback attempts, do NOT
  sum them). Else if `iterations` non-empty, sum the iterations (16 real records have
  zeroed top-level with truth only in iterations). Else the record carries zero usage.
- Records with `message.model == "<synthetic>"` (API-error records, `isApiErrorMessage`):
  produce NO UsageEvent.
- `editedFiles`: from `message.content[]` blocks where `type=="tool_use"` and
  `name in {Edit, Write, MultiEdit, NotebookEdit}` → `input.file_path` (verified: Edit and
  Write use `file_path`; also accept `input.notebook_path` for NotebookEdit — defensive).
  Read NOTHING else from content blocks (privacy).
- Dedupe id: `message.id + ":" + requestId` when both exist, else
  `sessionId + ":" + timestamp + ":" + sha256(canonical usage json).slice(0,16)`.
  Duplicates are REAL (observed: identical usage lines repeated 2–3×).
- `SCHEMA_VERIFIED = true` for this adapter.

### Codex CLI (`~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl`) — VERIFIED against v0.138 logs
- Line envelope: `{ timestamp: ISO, type: "session_meta"|"turn_context"|"event_msg"|"response_item", payload: {...} }`.
- `session_meta.payload`: `{ id, cwd, cli_version, originator, thread_source?, source?,
  git?: { branch?, ... } | false-y }`. `thread_source == "subagent"` (or `source.subagent`
  present) ⇒ all events in file get `isSidechain: true`.
- `turn_context.payload`: `{ cwd, model, ... }` — stateful: latest one supplies `model` and
  `cwd` for subsequent events in the file.
- Usage: `event_msg.payload.type == "token_count"`, `payload.info` may be null; when
  present: `info.last_token_usage = { input_tokens, cached_input_tokens, output_tokens,
  reasoning_output_tokens, total_tokens }` (per-turn) and `info.total_token_usage`
  (cumulative). **Semantics: `input_tokens` INCLUDES `cached_input_tokens`;
  `output_tokens` includes reasoning.** Map: input = input_tokens − cached_input_tokens,
  cacheRead = cached_input_tokens, cacheWrite = 0, output = output_tokens.
  Use `last_token_usage` when present; if only `total_token_usage`, emit the positive delta
  vs the previous token_count in the same file (clamp at 0).
- `editedFiles`: `response_item.payload.type == "function_call"` with
  `payload.name == "apply_patch"` → parse `payload.arguments` (JSON string with `input`
  field) and extract paths from `*** (Add|Update|Delete) File: <path>` header lines ONLY
  (never store patch bodies). Also `name == "shell"`/`"exec_command"` where the command
  argv[0] is `apply_patch`: extract the same header lines from argv[1]. Relative paths
  resolve against the current turn cwd. Accumulate since the last token_count and attach to
  the NEXT token_count event.
- No per-call message id ⇒ dedupe id fallback: `sessionId + ":" + timestamp + ":" + hash`.
- `SCHEMA_VERIFIED = true`.

### Gemini CLI / aider — research in flight; adapters ship `SCHEMA_VERIFIED = false`.

## Module contracts

### `src/core/errors.ts` (final, already written)
`CliUserError` (exit 1), `InternalError` (exit 2). Throw these; the CLI maps them.

### `src/adapters/claude-code/index.ts`
```ts
export const CLAUDE_CODE_SCHEMA_VERIFIED = true;
/** Claude Code JSONL transcript adapter (spec §5.1). */
export function createClaudeCodeAdapter(opts?: { claudeDir?: string }): SourceAdapter;
```
- Transcript root: `opts.claudeDir ?? $VIBEBILL_CLAUDE_DIR ?? ~/.claude`, files at
  `<root>/projects/*/*.jsonl`. `discover()` returns sorted paths; missing root ⇒ `[]`.
- Stream line-by-line (readline over createReadStream), 10 MB line cap (spec §7.13):
  longer lines are skipped and counted without buffering beyond the cap.
- zod `.passthrough()` validation per line; invalid JSON / failed validation ⇒
  `linesSkipped++`, never throw. Truncated final line (no trailing newline) ⇒ skipped +
  counted; `bytesConsumed` = offset after last complete line.
- Adapter does NOT dedupe (ingest layer does); it emits events with the dedupe `id`.

### `src/adapters/codex/index.ts`
```ts
export const CODEX_SCHEMA_VERIFIED = true;
/** Codex CLI rollout JSONL adapter (v0.2). */
export function createCodexAdapter(opts?: { codexDir?: string }): SourceAdapter;
```
Root: `opts.codexDir ?? $VIBEBILL_CODEX_DIR ?? ~/.codex`, files `sessions/**/*.jsonl`
(recursive, sorted). Same tolerance rules as claude-code.

### `src/adapters/gemini-cli/index.ts`, `src/adapters/aider/index.ts`
Same shape: `createGeminiCliAdapter(opts?: { geminiDir?: string })` (env
`VIBEBILL_GEMINI_DIR`, default `~/.gemini`), `createAiderAdapter(opts: { repoRoot: string })`
(aider logs live inside the repo). `SCHEMA_VERIFIED = false` constants exported.

### `src/git/index.ts`
```ts
export class GitError extends Error {}
/** Resolve repo root via `git rev-parse --show-toplevel`; CliUserError if not a repo. */
export async function resolveRepoRoot(cwd: string): Promise<string>;
export async function isShallowRepository(repoRoot: string): Promise<boolean>;
/** HEAD history by default; opts.allRefs adds --all + branchHint via --source; opts.range limits. */
export async function enumerateCommits(repoRoot: string, opts?: { allRefs?: boolean; range?: string }): Promise<CommitInfo[]>;
export async function revList(repoRoot: string, range: string): Promise<string[]>; // hashes
export async function resolveRef(repoRoot: string, ref: string): Promise<string>;  // full hash
/** vibebill notes ref only: refs/notes/vibebill. */
export async function readNote(repoRoot: string, hash: string): Promise<string | null>;
export async function writeNote(repoRoot: string, hash: string, message: string): Promise<void>; // add -f
export async function removeNote(repoRoot: string, hash: string): Promise<void>;
export async function listNotes(repoRoot: string): Promise<Array<{ hash: string }>>;
```
- `enumerateCommits`: `git log <scope> --date-order --no-color
  --pretty=format:<\x1e-terminated records, \x1f-separated fields: H, P, aI, s> --numstat`,
  parsed streaming from the child stdout. authorTs from strict ISO author date. numstat:
  rename `old => new` and `prefix/{old => new}/rest` brace forms record the NEW path; binary `-` = 0/0.
  Merge commits (parents>1): files = [], insertions/deletions = 0, isMerge = true.
  branchHint: only in allRefs mode via `git log --all --source`; else null.
- Empty repo (no HEAD): return []. Never crash.
- All git invocations: `execFile('git', [...], { cwd: repoRoot, maxBuffer: large or stream })`.

### `src/core/attribution.ts` — pure, zero I/O, deterministic
```ts
export interface AttributionExplain { fileScore: number; timeScore: number; branchScore: number; score: number; adoptedFromEventId?: string; }
export interface AttributedEvent { attribution: Attribution; explain: AttributionExplain | null; }
/** Message-grain attribution (spec §5.4). Returns array parallel to `events` input order. */
export function attributeEvents(
  events: UsageEvent[],            // this repo only, deduped, sorted by ts ascending
  commits: CommitInfo[],           // includes merges; engine ignores merge commits as targets
  config: AttributionConfig,
  opts: {
    nowMs: number;                                    // injected, no Date.now() inside
    toRepoRelative: (absPath: string) => string | null; // null => outside repo
  },
): AttributedEvent[];
```
Implement spec §5.4 Steps A–C EXACTLY (candidate window, score weights, tie-breaks
smallest `authorTs - e.ts` then lexicographic hash, confidence rules, pure-time fallback =
low + advisory, waste vs in-progress semantics, forward-attach then backward-attach for
non-edit events, zero-edit sessions = overhead). Edit events whose files ALL map to null
(outside repo) count as non-edit events (tokens keep, no file matching). The pure-time
fallback candidate is the next commit in time on the event's branch: same branch when both
sides known, else nearest next commit; it applies only when NO candidate anywhere has
fileScore > 0 and the fallback commit must be within the candidate window. `explain` is
non-null for kind:'commit' entries.
Also export:
```ts
/** Advisory display bucket derived at render time (spec §5.4 Step B). */
export function isInProgress(e: UsageEvent, attribution: Attribution, newestCommitAuthorTs: number | null): boolean;
```
(waste && (no commits || e.ts > newestCommitAuthorTs)).

### `src/core/invariant.ts` — pure
```ts
export interface ConservationReport { ok: boolean; totalTokens: number; attributed: number; waste: number; overhead: number; outOfScope: number; deltaTokens: number; }
/** Token conservation invariant (spec §1.3): total == attributed + waste + overhead + out_of_scope. */
export function checkConservation(entries: LedgerEntry[], outOfScopeTokens: number): ConservationReport;
```

### `src/pricing/engine.ts`
```ts
export interface PriceCard { displayName: string; inputPerMTok: string; outputPerMTok: string; cacheWritePerMTok?: string; cacheReadPerMTok?: string; }
export interface PriceTable { schemaVersion: 1; asOf: string; source: string; models: Record<string, PriceCard>; }
/** zod-validate and load the bundled prices/prices.json (resolved relative to this module). */
export function loadBundledPrices(): PriceTable;
/** User-refreshed table at ~/.config/vibebill/prices.json wins over bundled; report which. */
export function loadEffectivePrices(opts?: { configDir?: string }): { table: PriceTable; origin: 'bundled' | 'refreshed'; path: string };
/** Longest-prefix match of raw model string against table keys; null when unknown. */
export function matchModel(table: PriceTable, rawModel: string): { id: string; card: PriceCard } | null;
/** Resolve a card to exact nano-USD units; missing cache prices fall back to inputPerMTok with a flag. */
export function resolveCard(card: PriceCard): { nano: PriceCardNano; cacheFallback: boolean };
/** Price one event's tokens; null when model unknown (caller records the unknown model). */
export function priceTokens(table: PriceTable, rawModel: string, tokens: TokenCounts): MoneyBreakdown | null;
/** THE ONLY NETWORK CALL: fetch LiteLLM table, convert, validate, write user table. */
export async function refreshPricing(opts?: { configDir?: string; fetchImpl?: typeof fetch }): Promise<{ path: string; asOf: string; modelCount: number }>;
```
Conversion in refreshPricing mirrors the build-time conversion (per-token → $/MTok decimal
strings, models absent omitted); include Anthropic/OpenAI/Gemini/DeepSeek/Qwen-coder sets.
On any error: throw CliUserError with "kept last known table (asOf ...)" wording handled
by the CLI. Never auto-refresh.

### `src/cache/index.ts` + `src/core/ingest.ts` (one owner)
```ts
// src/core/ingest.ts
export interface IngestResult {
  events: UsageEvent[];       // deduped, cwd inside repo root (realpath), sorted by (ts, id)
  stats: ParseStats;
  outOfScope: { events: number; tokens: number };  // parsed but outside this repo
  unknownRecordTypes?: never; // (keep ParseStats the single stats surface)
}
/** Incremental, cached ingest across adapters (spec §5.2). */
export async function ingestEvents(opts: {
  repoRoot: string;
  adapters: SourceAdapter[];
  cacheDir: string;            // <repo>/.vibebill/cache
  noCache?: boolean;           // force full re-parse (doctor uses for dry runs if needed)
}): Promise<IngestResult>;
```
- manifest.json: `{ schemaVersion, adapterVersions: Record<AgentId, string>, files: { [path]: { size, mtimeMs, bytesConsumed } }, outOfScope: { events, tokens }, dedupeIndexHash }`.
- Re-read only changed files (size/mtime); grew + valid line boundary ⇒ resume from
  bytesConsumed (adapter parseFile handles a `start` offset? NO — keep the SourceAdapter
  interface; resume = re-parse that file but events before the offset are already in
  events.ndjson keyed by sourceFile+id... SIMPLEST CORRECT: store per-file events in the
  ndjson with their sourceFile; when a file changed, drop its cached events and re-parse the
  whole file. "Resume from offset" optimization: implement by reading the file from
  bytesConsumed via the adapter's parseFile(path, sink, { startOffset }) OPTIONAL third
  param — adapters accept `{ startOffset?: number }` and must start at a line boundary; if
  startOffset invalid (file shrank) re-parse from 0. Add the optional param to the
  SourceAdapter interface implementations (it's in types.ts as optional).
- Dedupe map across all files (last occurrence in deterministic file order wins);
  duplicatesRemoved counted. Cache stores post-dedupe events plus per-file raw stats needed
  to rebuild ParseStats without re-reading unchanged files.
- Corrupt/missing cache ⇒ silent full rebuild. schemaVersion/adapterVersion bump ⇒ wholesale invalidation.
- cwd scope test: `realpath(event.cwd)` starts with `realpath(repoRoot) + sep` (or equals).
  Events with null cwd: OUT of scope (cannot prove membership; count as out_of_scope).

NOTE: `parseFile(path, sink, opts?: { startOffset?: number })` — the optional third param
is part of the SourceAdapter interface in types.ts; adapter owners must honor it (start
parsing at that byte offset; assume caller verified it is a line boundary they reported).

### `src/render/table.ts`
```ts
export interface ColumnSpec { header: string; align?: 'left' | 'right'; minWidth?: number; }
/** Aligned plain-text table; ANSI-safe width math; no trailing whitespace. */
export function renderTable(cols: ColumnSpec[], rows: string[][]): string;
/** Strip-aware padding helpers + color enable switch honoring --no-color/NO_COLOR/TTY. */
export function setColorEnabled(enabled: boolean): void;
export function isColorEnabled(): boolean;
export const c: { red, green, yellow, dim, bold, cyan }: Record<string, (s: string) => string>; // no-op when disabled
```

### `test/helpers/transcripts.ts`
```ts
export interface CallSpec { model?: string; usage: { input: number; output: number; cacheWrite?: number; cacheRead?: number }; edits?: string[]; cwd?: string; branch?: string | null; sidechain?: boolean; messageId?: string; requestId?: string; iterationsShape?: 'top-level-only' | 'with-iterations' | 'zero-top-with-iterations'; }
export class SessionBuilder {
  constructor(opts?: { sessionId?: string; defaultCwd?: string; defaultBranch?: string | null; defaultModel?: string });
  at(tsIsoOrMs: string | number): this;       // sets clock for next call(s); auto-advances 1s per line otherwise
  call(spec: CallSpec): this;                  // one assistant record (+ preceding user record for realism)
  raw(line: string): this;                     // inject arbitrary/malformed line
  build(): string;                             // JSONL text
}
export function session(opts?: ...): SessionBuilder;
/** Write sessions into a fake VIBEBILL_CLAUDE_DIR layout: <dir>/projects/<encoded>/<sessionId>.jsonl */
export async function writeTranscripts(claudeDir: string, sessions: SessionBuilder[]): Promise<string[]>;
```
Emitted lines must match the VERIFIED Claude Code structure above (envelope fields incl.
uuid/parentUuid/version, message.id "msg_..." unique per call unless overridden, usage with
`iterations` per iterationsShape; content blocks for edits use tool_use Edit with file_path
and placeholder-free structure — put "[sanitized]" placeholders in any text field).

### `test/helpers/repo.ts`
```ts
export interface FixtureRepo {
  root: string;
  git(args: string[]): Promise<string>;
  commitFile(relPath: string, content: string, opts: { message?: string; authorDate: string | number; branch?: string }): Promise<string>; // returns hash
  commitFiles(files: Array<[string, string]>, opts: { message?: string; authorDate: string | number }): Promise<string>;
  branch(name: string, from?: string): Promise<void>;
  checkout(name: string): Promise<void>;
  merge(branch: string, opts?: { message?: string; authorDate?: string | number }): Promise<string>;
  squashMerge(branch: string, message: string, authorDate: string | number): Promise<string>;
  head(): Promise<string>;
}
export async function makeRepo(baseDir?: string): Promise<FixtureRepo>; // temp dir, isolated config (user.name/email set via -c or local config), main branch
```
GIT_AUTHOR_DATE and GIT_COMMITTER_DATE set from opts (ISO with offset). Deterministic.
`HOME`/`GIT_CONFIG_GLOBAL`/`GIT_CONFIG_SYSTEM` isolated so user gitconfig can't leak in.

## CLI JSON conventions (for reference)
Money in JSON: `{ nanoUsd: string, usd: string }` via `moneyToJson`. Every command's JSON
includes `schemaVersion: 1`, `provenance` labels, and `accountingMismatch` when the
invariant fails. Exit codes: 0 ok, 1 user/env error, 2 internal, 3 mismatch + --strict.
