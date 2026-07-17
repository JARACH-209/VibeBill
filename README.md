# vibebill

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node ≥ 20](https://img.shields.io/badge/node-%E2%89%A5%2020-brightgreen.svg)](package.json)

**Git-native cost accounting for AI-assisted repositories — measured, never guessed.**

Your coding agents already write their token usage to disk, one API call at a time. vibebill
reads those local session logs, joins them to your git history, and answers the question
nobody's dashboard answers: **what did this commit cost, and where did the money go?**

This is real output — `vibebill log` run on vibebill's own repository, the tool costing its
own AI-assisted build:

```text
  cost  conf  hash     date        subject                                  models          sessions
------  ----  -------  ----------  ---------------------------------------  --------------  --------
$33.24  .     (wip)    2026-07-16  in progress (uncommitted)                claude-fable-5         1
 $5.77  *     87dd80e  2026-07-15  feat(v0.2): gemini-cli source adapter    claude-fable-5         1
$11.03  *     2100e23  2026-07-15  feat(core): on-demand aggregation ro...  claude-fable-5         1
 $7.35  *     cdf2640  2026-07-15  docs: pin gemini/aider adapter contr...  claude-fable-5         1
 $6.32  *     e0dcdf0  2026-07-15  feat(v0.2): codex and aider source a...  claude-fable-5         1
 $6.20  *     9c0af05  2026-07-15  feat(m4): terminal table renderer an...  claude-fable-5         1
 $9.37  *     d847031  2026-07-15  feat(m3): pricing engine — exact big...  claude-fable-5         1
$14.26  *     77442ae  2026-07-15  feat(m2): git layer and attribution ...  claude-fable-5         1
$26.40  *     e1d19ce  2026-07-15  feat(m1): claude-code adapter, incre...  claude-fable-5         1
$10.93  *     fd09c32  2026-07-14  chore: scaffold vibebill — strict TS...  claude-fable-5         1

totals: $97.63 across 9 commits | waste $2.27 | overhead $0.88 | in progress $33.24
accounting: 6.8B tokens = attributed 29.9M + waste 15.3M + overhead 311.5k + out-of-scope 6.7B OK
```

(Captured with `NO_COLOR`, so confidence renders as ASCII: `*` high, `~` medium, `.` low.
In a color terminal the markers are ● high, ◐ medium, ○ low. The `accounting:` line is the
token-conservation invariant — every parsed token must land in exactly one bucket, and
vibebill checks it on every run.)

## Quickstart

You need Node ≥ 20, a git repository, and local logs from at least one supported agent.
No install, no configuration, no account:

```sh
npx vibebill doctor    # 1. environment check: transcripts found, parse coverage, pricing table
npx vibebill log       # 2. git log with cost columns
npx vibebill summary   # 3. repo rollup: totals, cost by model, cache efficiency, waste
```

vibebill keeps its cache in `<repo>/.vibebill/` (it offers to gitignore it on first run) and
opens your agents' log directories strictly read-only.

## How it works

Coding agents like Claude Code, Codex CLI, Gemini CLI, and aider record per-call token usage
in local session logs, and vibebill parses exactly those records — it never estimates cost
from diff size or anything else. It then enumerates your repo's git history and matches each
usage event to the commit it most plausibly produced, scoring candidates by the files the
agent edited, the timing, and the branch. Attribution happens at message grain, so one
session can split its cost across several commits, and planning or exploration turns are
charged to the edit they led to (full method with a worked example in
[docs/how-attribution-works.md](docs/how-attribution-works.md)). Every number carries a
provenance tier — `measured` (real tokens at a known price), `repriced` (the same traffic on
a different model's price card), or `advisory` (low-confidence attribution) — and the books
must balance: total tokens = attributed + waste + overhead + out-of-scope, asserted on every
run. Privacy is by construction: vibebill reads transcripts read-only, extracts only metadata
(timestamps, token counts, model names, session ids, working directory, branch, and
edited-file paths), never stores or prints prompt or response text, and never touches the
network except the explicit, opt-in `--refresh-pricing` flag.

## Supported agents

| agent | logs read from | status |
|---|---|---|
| Claude Code | `~/.claude/projects/` (root override: `VIBEBILL_CLAUDE_DIR`) | verified against real transcripts |
| Codex CLI | `~/.codex/sessions/` (root override: `VIBEBILL_CODEX_DIR`) | verified against real transcripts |
| Gemini CLI | `~/.gemini/tmp/<project>/chats/` (root override: `VIBEBILL_GEMINI_DIR`) | built from source research — see limitations |
| aider | `<repo>/.aider.chat.history.md` | built from source research — see limitations |

All four adapters are on by default; pick a subset with the `adapter` key in
`vibebill.config.json`. **Cursor is not supported** — its usage data lives on Cursor's cloud
side, so there is nothing on disk to measure, and vibebill will not fall back to estimating
(see limitations).

## Commands

| command | what it answers |
|---|---|
| `vibebill doctor` | is my environment set up, what was found, how much of it parsed |
| `vibebill summary` | what has AI assistance on this repo cost overall |
| `vibebill log [-n N] [range]` | what did each commit cost — `git log --oneline` with money |
| `vibebill show <ref>` | where did this commit's cost come from: sessions, models, score evidence |
| `vibebill range A..B` | what did this release cost |
| `vibebill reprice --model <id> [--vs] [range]` | what would the same traffic cost on another model |
| `vibebill report --md [--out LEDGER.md] [--force] [range]` | write a self-contained markdown ledger |
| `vibebill notes sync [range] [--clear]` | annotate commits with cost JSON under `refs/notes/vibebill` (view with `git log --notes=vibebill`) |
| `vibebill pr [number] [--comment]` | what does this GitHub PR cost (via the `gh` CLI) |

Every command supports `--json` (stable schemas in
[docs/json-schemas.md](docs/json-schemas.md)), `--since <date>` / `--until <date>`,
`--plan pro|max5|max20`, `--all-refs`, `--no-color`, `--quiet`, `--debug`, `--strict` (exit 3
when the accounting invariant does not balance), and `--refresh-pricing` — the program's only
network call, and only when you ask for it.

An optional `vibebill.config.json` at the repo root accepts `plan`, `horizonDays`,
`graceSeconds`, `weights`, and `adapter`; CLI flags override it.

## PR cost comments in CI

CI runners do not have your agent transcripts — the session logs live on developers'
machines — so nothing running in CI can measure cost, and vibebill refuses to pretend
otherwise. The flow keeps measurement local and lets CI only relay:

1. **Measure locally.** `vibebill notes sync` writes per-commit cost JSON to
   `refs/notes/vibebill`.
2. **Publish the notes.** `git push origin refs/notes/vibebill`.
3. **CI posts the comment.** The bundled workflow
   ([.github/workflows/vibebill-pr-comment.yml](.github/workflows/vibebill-pr-comment.yml) —
   copy it into your repo) reads those notes for the PR's commits, sums them with integer
   math, and creates or updates a single marker comment on the PR.

Commits without notes appear as unmeasured; if no commit in the PR has a note, the workflow
succeeds without posting anything. You can also post the comment straight from your machine
with `vibebill pr --comment`. After a rebase, rerun `vibebill notes sync` and push the notes
ref again (see limitations).

## Honest limitations

- **Attribution is probabilistic.** Joining log events to commits is a scoring heuristic
  (files, time, branch), not ground truth. Every costed commit carries a confidence marker —
  ● high, ◐ medium, ○ low — and `vibebill show <ref>` prints the evidence behind it.
  Low-confidence figures are labeled `advisory`.
- **Rebases orphan notes.** Attribution itself survives history rewrites (it keys on author
  dates, which rebase preserves), but `git notes` annotations key on commit hashes, which
  don't. After a rebase or amend, rerun `vibebill notes sync`; stale notes on dead hashes are
  unreachable and harmless.
- **Cursor is unsupported, and honestly can't be.** Cursor's usage data is cloud-side and
  opaque — there are no local logs to measure. vibebill will not substitute a diff-size
  estimate, so there is no Cursor adapter.
- **Subscription plans show API-equivalent value, not billed dollars.** With
  `--plan pro|max5|max20` the math is identical and the wording changes: you see what the
  traffic would have cost at API prices, not what your subscription charged you.
- **Repriced figures are counterfactuals, not simulations.** `vibebill reprice` re-prices the
  *same measured traffic* on a different meter; a different model may have needed more or
  fewer turns to do the same work. The output always says so.
- **The gemini-cli and aider adapters are built from source research** (gemini-cli v0.50 and
  aider v0.86 source code), not yet verified against local log samples. `vibebill doctor`
  reports parse coverage per adapter — if yours is low, please file an issue with a sanitized
  sample so we can verify the format.
- **aider figures are approximate.** aider's chat history rounds token counts to roughly two
  significant figures ("12k sent"), so aider-derived costs inherit that precision. `doctor`
  surfaces the caveat.
- **The 1-hour cache-write premium is not modeled.** vibebill prices all cache writes at the
  standard (5-minute) rate — a single `cacheWrite` price class — which can understate cost on
  sessions using 1-hour caching (decision D2 in [docs/decisions.md](docs/decisions.md)).
- **Unknown models are never guessed.** Tokens are shown, cost is `$—`, and you get one
  aggregated warning per model naming it — try `--refresh-pricing` or send a price-table PR.

## Roadmap

Shipped in v0.2: Codex CLI, Gemini CLI, and aider adapters · the `pr` command via `gh` · the
PR-comment GitHub Action.

Planned for v0.3:

- churn/survival analysis — "cost per surviving line" via blame sampling
- cache-strategy hints
- TUI dashboard

Explicitly never: telemetry, a hosted-service requirement, or diff-based cost estimation.

## Contributing

Price-table PRs are the most useful contribution: edit
[prices/prices.json](prices/prices.json). Prices are decimal strings in $/MTok, and
**provenance is required** — name your source and its date in the PR so `asOf`/`source` stay
honest. Never invent a number: if a source doesn't list a model, the model stays out of the
table (unknown models render as `$—` by design).

Also welcome: sanitized Gemini CLI and aider log samples (structure and metadata intact,
content replaced) to verify those adapters against reality.

## License

[MIT](LICENSE) © 2026 vibebill contributors.
