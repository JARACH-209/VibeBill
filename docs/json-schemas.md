# `--json` output schemas

Every command accepts `--json` and prints exactly one JSON document on stdout
(warnings and notes go to stderr, so stdout is always parseable). All schemas
share `schemaVersion: 1`; breaking changes bump it.

## Common types

- **Money** — `{ "nanoUsd": string, "usd": string }`. `nanoUsd` is the exact
  bigint nano-USD value as a decimal string (JSON cannot hold bigint); `usd`
  is pre-rounded to cents with round-half-even (e.g. `"12.34"`).
- **Tokens** — `{ "input": number, "output": number, "cacheWrite": number,
  "cacheRead": number, "total": number }`.
- **MoneyBreakdown** — `{ input, output, cacheWrite, cacheRead, total }`,
  each a Money.
- **Confidence** — `"high" | "medium" | "low"`.
- **Provenance** — `"measured" | "repriced" | "advisory"` (spec §1.2).

## Common envelope (all commands except `doctor`)

```jsonc
{
  "schemaVersion": 1,
  "command": "summary",              // the command name
  "vibebill": "0.2.0",
  "repoRoot": "/abs/path",
  "plan": null,                      // "pro" | "max5" | "max20" | null
  "pricing": { "asOf": "2026-07-14", "origin": "bundled" }, // origin: bundled | refreshed
  "invariant": {                     // token-conservation check (spec §1.3)
    "ok": true,
    "totalTokens": 123,              // raw ingest ground truth
    "attributed": 100, "waste": 20, "overhead": 3, "outOfScope": 0,
    "deltaTokens": 0
  },
  "warnings": ["..."],
  // present ONLY when invariant.ok is false:
  "accountingMismatch": { "tokens": 42 }
}
```

Exit codes everywhere: `0` ok · `1` user/environment error · `2` internal
error · `3` invariant mismatch while `--strict`.

## `doctor`

No repo context is required, so doctor has its own envelope:

```jsonc
{
  "schemaVersion": 1, "command": "doctor", "vibebill": "0.2.0",
  "ok": true,                        // false when any check failed hard
  "checks": [ { "name": "git", "status": "ok" /* ok|warn|fail */,
                "detail": "...", "remedy": null } ],
  "adapters": [ { "id": "claude-code", "root": "/Users/x/.claude",
                  "files": 43, "bytes": 175000000, "schemaVerified": true } ],
  "parse": {                         // null when there is no repo
    "filesFound": 45, "filesRead": 45, "filesSkipped": 0,
    "linesRead": 42870, "eventsExtracted": 19931, "linesSkipped": 0,
    "duplicatesRemoved": 182,
    "outOfScope": { "events": 19647, "tokens": 6466745691 }
  },
  "unknownModels": ["some-model"]    // sorted; absent when there is no repo
}
```

`doctor` exits 0 whenever the diagnosis itself completed, even with ✗ marks.

## `summary`

Envelope plus:

```jsonc
{
  "scope": { "since": null, "until": null },       // ISO strings when set
  "totals": { "cost": Money, "costBreakdown": MoneyBreakdown,
              "tokens": Tokens, "events": 494,
              "unpricedEvents": 0, "unpricedTokens": Tokens },
  "byModel": [ { "model": "claude-fable-5", "displayName": "…"|null,
                 "priced": true, "events": 1, "tokens": Tokens,
                 "cost": Money|null } ],            // cost null when fully unpriced
  "cacheEfficiency": { "cacheReadTokens": n, "inputTokens": n,
                       "pctOfInputVolume": 97.3|null,
                       "savings": Money, "label": "measured" },
  "waste":      { "cost": Money, "tokens": Tokens, "sessions": n },
  "inProgress": { "cost": Money, "tokens": Tokens, "sessions": n },
  "overhead":   { "cost": Money, "tokens": Tokens, "sessions": n },
  "covered": { "sessions": n, "commits": n }
}
```

## `log`

Envelope plus:

```jsonc
{
  "inProgress": { "cost": Money, "tokens": Tokens, "sessions": n } | null,
  "commits": [ { "hash": "…", "date": "2026-07-15", "subject": "…",
                 "cost": Money|null,                // null = uncosted (human?)
                 "confidence": Confidence|null,     // token-weighted dominant
                 "models": ["claude-fable-5"], "sessions": n,
                 "events": n, "tokens": Tokens } ],
  "totals": { "cost": Money, "commitsCosted": n, "waste": Money,
              "overhead": Money, "inProgress": Money }
}
```

## `show`

Envelope plus commit identity (`hash`, `subject`, `authorTs`, `files`,
`insertions`, `deletions`), `cost` (MoneyBreakdown), `tokens`,
`unpricedTokens`, `events`, `confidence`, `provenance`
(`{measured, advisory, repriced}` event counts), `sessions[]`
(id, span, events, cost), `byModel[]`, `subagent`
(`{ events, tokens, cost }`), `evidence[]`
(per scoring event: `fileScore`, `timeScore`, `branchScore`, `score`,
`confidence`, matched files), `filesMatched` / `filesInCommit`, and
`advisoryNotes[]`.

## `range`

Everything `summary` emits, plus `range`, `label`, `headline`
(`{ cost: Money, commits: n }`) and `byCommit[]` (same row shape as `log`).

## `reprice`

Envelope plus:

```jsonc
{
  "target": { "id": "deepseek-chat", "displayName": "…" },
  "scope": { "kind": "repo" | "range", "range": null | "A..B",
             "events": n, "tokens": Tokens },
  "repriced": { "cost": MoneyBreakdown, "provenance": "repriced" },
  "measured": { "cost": Money,                       // measured actuals in scope
                "unpricedEvents": n, "unpricedTokens": Tokens },
  "deltaPct": -98.8 | null,        // null when nothing in scope was priced
  "cacheFallback": false,          // true = target card lacks cache prices; cache
                                   //        classes were priced at inputPerMTok
  "label": "repriced — same traffic, different meter; a different model may need more or fewer turns"
}
```

The `label` field is ALWAYS present (spec §6.6). Unknown target model exits 1.

## `report`

Envelope plus `{ "out": "/abs/path/LEDGER.md", "commits": n }`.

## `notes sync`

Envelope plus `synced: [{ hash, costNanoUsd, tokens }]`, or with `--clear`
`cleared: [hash, …]`. The note blob written to `refs/notes/vibebill` is itself
JSON: `{ v: 1, costNanoUsd, tokens: Tokens, confidence, provenance,
generatedBy: "vibebill@<version>" }`.

## `pr`

Envelope plus:

```jsonc
{
  "pr": { "number": 12, "title": "…", "base": "main", "head": "feat",
          "commits": 5, "commitsInScope": 5 },
  "cost": MoneyBreakdown, "tokens": Tokens, "events": n, "sessions": n,
  "byCommit": [ { "hash", "inScope": true, "cost": {"nanoUsd": string}|null,
                  "tokens": n } ],
  "comment": null | "created" | "updated"
}
```
