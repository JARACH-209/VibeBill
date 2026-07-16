# Decisions & deviations log

Per spec §12: deviations from the spec are recorded here with reasons, not silently
redesigned. Entries are dated and numbered; newest last.

## D1 (2026-07-14) — Claude Code usage extraction handles `iterations`

The spec's §5.1.1 field mapping predates a format change. Recon against real transcripts
(Claude Code v2.1.202, 22k+ assistant records on the build machine) found
`message.usage.iterations[]`:

- Most records: one iteration, top-level fields populated and equal to it.
- Retry/fallback records (`iterations[].type == "fallback_message"`): top-level equals the
  **last** iteration — the call that actually landed. Earlier iterations are failed
  attempts; we do **not** sum them (that would overstate billed traffic).
- 16 records: top-level all zeros, truth only inside `iterations`.

Rule implemented: use top-level when any top-level token field is non-zero; else sum
`iterations`; records with `message.model == "<synthetic>"` (API-error records) produce no
UsageEvent. This is measurement, not estimation; the rule is covered by fixtures.

## D2 (2026-07-14) — 1-hour cache-write premium not modeled

Anthropic bills 5-minute and 1-hour cache writes at different rates, and real logs carry
the split (`usage.cache_creation.ephemeral_1h_input_tokens`). The spec's §4 domain model
and §5.5 price schema define exactly one `cacheWrite` class, and the conservation
invariant, JSON schemas and tests are all built on the 4-class model. We follow the spec:
all cache-write tokens are priced at the card's single `cacheWritePerMTok` (the standard
5-minute rate), which can understate cost on sessions using 1h caching. Documented in the
README limitations section. Revisit in v0.3 if the class model is extended.

## D3 (2026-07-14) — cache prices are optional in the price schema

The spec's schema example shows four price fields per model, but the mandated source
(LiteLLM) has no cache prices for several providers, and some providers don't bill cache
writes at all. `cacheWritePerMTok`/`cacheReadPerMTok` are optional; when missing, that
class is priced at `inputPerMTok` and the output is flagged (this generalizes the spec's
own §5.5 reprice rule to measured pricing). Models absent from the source are omitted,
never invented (spec §5.5).

## D4 (2026-07-14) — events with null `cwd` are out_of_scope

Membership of an event in this repo is proven only by its `cwd` (spec §5.1.2 forbids
decoding project-dir names). Records with no `cwd` cannot be attributed to any repo, so
they count into the `out_of_scope` bucket of the conservation invariant rather than being
guessed into scope.

## D5 (2026-07-14) — Codex adapter specifics (v0.2)

Verified against real `~/.codex/sessions` rollout files (Codex CLI 0.138):

- Usage comes from `event_msg` `token_count` events; `input_tokens` **includes**
  `cached_input_tokens`, so `input = input_tokens − cached_input_tokens`,
  `cacheRead = cached_input_tokens`, `cacheWrite = 0` (OpenAI doesn't bill cache writes).
- Model comes from the latest `turn_context`; an event before any `turn_context` keeps
  model `""` and is therefore reported unpriced/unknown rather than guessed.
- Edited files come from `apply_patch` call arguments — only the
  `*** Add/Update/Delete File:` header paths are read, never patch bodies (privacy rule).
- Subagent sessions (`thread_source == "subagent"`) map to `isSidechain: true`.

## D6 (2026-07-14) — single 0.2.0 release covering v0.1 + v0.2 scope

Built at the owner's request as one release: the four adapters (claude-code verified,
codex verified, gemini-cli and aider against researched formats with
`SCHEMA_VERIFIED = false`), the `pr` command via `gh`, and the GitHub Action, on top of the
complete v0.1.0 feature set. CHANGELOG records both versions' scopes.

## D7 (2026-07-14) — money representation: nano-USD per MTok, one floor division

Prices are stored internally as bigint nano-USD **per MTok** (exact for ≤ 9 fractional
digits — the spec's own per-token form is not integral for prices like $0.0195/MTok).
`cost = (tokens × nanoPerMTok) div 10^6` — one floor division per token class per event,
error strictly < 1 nano-USD, far below cent-level display rounding. All aggregation sums
per-event bigints, so per-commit sums equal scope totals exactly (spec §8 property).

## D8 (2026-07-15) — events cache stores pre-dedupe events; dedupe re-runs per ingest

Spec §5.2 says the cache holds "deduped" events, but last-occurrence-wins dedupe is
cross-file: a change to one transcript can flip which duplicate wins in another, which an
incrementally-updated post-dedupe cache cannot express. `events.ndjson` therefore stores
in-scope events pre-dedupe per file; dedupe runs in memory on every ingest (cheap — a Map
over event ids). Cold and warm runs produce byte-identical results, which is the property
the spec actually needs.

## D9 (2026-07-15) — `--all-refs` excludes vibebill's own notes refs

`git log --all` would enumerate commits under `refs/notes/vibebill` after a `notes sync`,
making vibebill's own bookkeeping look like repo history. The git layer adds
`--exclude=refs/notes/* --exclude=refs/stash` before `--all`, and passes no positional
`HEAD` (an explicit positional wins the `--source` race and destroys branch hints).

## D10 (2026-07-15) — attribution: timeScore clamped; "in progress" is render-time

The spec's timeScore formula exceeds 1 for commits authored before the event but within
grace, while declaring the range ∈ [0,1]; we clamp. Per §5.4 Step B all unmatched edit
events are stored as `waste`; the "in progress (uncommitted)" bucket is derived at render
time via `isInProgress(event, attribution, newestCommitAuthorTs)`. Provenance rule
(`provenanceFor`): `advisory` for overhead, pure-time fallback (`fileScore === 0` on a
commit attribution), and events adopting an advisory attribution; `measured` otherwise —
waste tokens are measured facts even though unattributed.

## D11 (2026-07-15) — aider adapter: lossy source, honest precision

`.aider.chat.history.md` records token counts rounded to ~2 significant figures ("12k
sent"), per-message not per-call, in local time with no timezone, and sometimes locally
estimated when the provider returns no usage. The adapter parses them as-is, stamps every
event with its session-start timestamp, ignores aider's own `Cost:` figures (vibebill
prices tokens from its own table), and exports `AIDER_PRECISION_NOTE` which `doctor`
prints. The file is stateful markdown, so `parseFile` always re-parses from byte 0;
stable event ids make ingest's last-wins dedupe absorb the re-emission.

## D12 (2026-07-16) — claude-code discovery is recursive under project dirs

The spec's §5.1 layout (`projects/<encoded-dir>/<session-uuid>.jsonl`, flat) predates
Claude Code's workflow/subagent features: on this machine, 28 transcript files (7.7 MB of
real usage, same record format, proper `cwd` and `isSidechain: true`) live nested under
`<project>/<session>/subagents/**`. Flat discovery silently dropped that spend — the
commits it produced showed as `$0.00 ·human?`, violating "measured, never guessed" in the
other direction. `discover()` now walks each project directory recursively for `*.jsonl`;
dedupe-by-id makes any overlap with flat files harmless.
