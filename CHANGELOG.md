# Changelog

All notable changes to vibebill are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver.

## [0.2.0] — 2026-07-16

First published release. It ships the complete v0.1.0 scope **and** the v0.2 additions as a
single release — 0.1.0 was never published on its own (decision D6 in
[docs/decisions.md](docs/decisions.md)). Both scopes are listed separately below so the
version history stays honest.

### Added — v0.2 scope

- **Codex CLI source adapter**, verified against real `~/.codex/sessions` rollout logs
  (Codex CLI 0.138): per-turn `token_count` usage with cached-input separation, edited files
  from `apply_patch` header paths only (patch bodies are never read), subagent session
  detection.
- **Gemini CLI source adapter**, built from gemini-cli v0.50 source research
  (`SCHEMA_VERIFIED = false` — not yet checked against local samples): JSONL chat recordings
  plus the legacy single-document JSON format, `$set` history-patch records, cached/thought
  token mapping, edited files from `replace`/`write_file` tool calls.
- **aider source adapter**, built from aider v0.86 source research
  (`SCHEMA_VERIFIED = false`): parses `<repo>/.aider.chat.history.md`. aider's history
  rounds token counts to roughly two significant figures and records no per-message
  timestamps, so aider figures are approximate; vibebill ignores aider's own `Cost:` lines
  and prices tokens from its own table. `doctor` surfaces the precision caveat.
- **`vibebill pr [number] [--comment]`** — cost a GitHub pull request via the `gh` CLI
  (`gh` makes the network requests, vibebill never does); `--comment` creates or
  idempotently updates a single marker comment on the PR.
- **PR-comment GitHub Action** (`.github/workflows/vibebill-pr-comment.yml`): consumes
  per-commit cost notes that developers measure locally and push to `refs/notes/vibebill`;
  it measures nothing in CI, sums with integer math, lists un-noted commits as unmeasured,
  and posts nothing when no notes exist.
- **Multi-adapter ingest**: all four adapters run by default; select a subset with the
  `adapter` key in `vibebill.config.json`.

### Added — v0.1 scope (previously unreleased, shipped here)

- **Claude Code source adapter**, verified against real `~/.claude/projects` transcripts
  (Claude Code v2.1.202), including retry/fallback `iterations` handling and recursive
  discovery of nested subagent transcripts.
- **Streaming, incremental ingestion** with an on-disk cache under `<repo>/.vibebill/`:
  changed files are re-read from the last consumed offset, malformed lines are skipped and
  counted (never a crash), duplicate records are deduplicated by stable event id.
- **Git layer and the attribution engine**: message-grain event→commit attribution with
  file/time/branch scoring, confidence tiers (high/medium/low), forward-attach for
  planning/non-edit events, waste / in-progress / overhead buckets, and the
  token-conservation invariant (`total = attributed + waste + overhead + out-of-scope`)
  checked on every command.
- **Pricing engine**: bundled, pinned price table derived from the LiteLLM community table
  with recorded provenance; longest-prefix model matching; unknown models shown unpriced
  (`$—`) with a warning, never guessed; opt-in `--refresh-pricing` (the program's only
  network call).
- **Exact money math**: `bigint` nano-USD end to end, no floats anywhere in the money path,
  round-half-even to cents at the rendering boundary only.
- **CLI**: `doctor`, `summary`, `log`, `show`, `range`, `reprice` (with the mandatory
  "same traffic, different meter" honesty label), `report --md`, and `notes sync` — every
  command with `--json` (documented schemas), `--since`/`--until`, `--strict`, and plan-mode
  wording (`--plan pro|max5|max20`, API-equivalent value, no plan-price math).
- **Benchmark script** (`scripts/bench.ts`) with a CI smoke variant guarding ingest
  performance regressions.

## [0.1.0] — 2026-07-15 (not published separately)

Feature-complete internal milestone covering everything under "Added — v0.1 scope" above.
Folded into the 0.2.0 release instead of being published on its own (decision D6).
