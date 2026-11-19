# Export diagnostics: `diag-schema v1`

Export diagnostics (A§11, E20) writes a zip a person sends to support themselves:
`lfcp-bridge export [--out </absolute/path.zip>]` (default `<data directory>/diagnostics/`), or
the menu's **Export diagnostics…** through the app channel's `export{path}`
([app-ipc-v1.md](app-ipc-v1.md)). The zip holds one file, `diagnostics.json`. Code:
`packages/host/src/diag/`.

## What is collected (allow-list)

| Field | What |
|---|---|
| `schema`, `version` | `"diag-schema"`, `1` |
| `createdAt` | the time of the export |
| `versions` | bridge, Node, OS, arch, the verified helper and macOS, the database's schema version |
| `artifactSliceId`, `certTestMode` | A§9.1 and A§9.4; `null` and `false` until E-051 and E-050 |
| `stop`, `safeMode` | STOP present; Safe Mode's start |
| `paths.home` | the data directory (sealed) |
| `counters` | bindings, links and intents by state; holds by reason; journal entries by level |
| `needsAttention` | `{bindingId, code}` of A§7.3 (filled from E-043) |
| `bindings` | `{id, state, title, verification, holds}` — the title sealed |
| `intents` | the newest 200: `{id, bindingId, taskId, direction, kind, state, stateReason, attempts, code}`, never fields, payload or evidence (E19) |
| `runs` | the newest 20 process runs: `{startedAt, endedAt, outcome}` |
| `journal` | the newest 500 entries as `{ts, level, key, code, ids}`; `code` is the entry's machine code, never its text or other parameters |
| `crashes` | the newest 10 signatures: `{process, exception, frames}` — the host's, and macOS's `.ips` reports of `LFCP Bridge` and `lfcp-reminders-helper` only; frames of our own code only |

## Sealing

Every string of the tree becomes `h:` + the first 8 bytes (hex) of HMAC-SHA-256(k, value), unless
its key is allow-listed as plain **and** the value has that key's form: a machine code
(`store_conflict`, `effect.lost`, `EPIPE`, `OutcomeUnknownError`), an enumerated state, an id, a
time, a version, a frame. Titles, URLs, paths and error texts are never plain. Equal strings within
one export have equal HMACs; `k` is random per export, zeroed after it and never written, so two
exports share no HMAC value.

## Never read

Pairing links, keys and DEKs, the `meta` table beyond Safe Mode, intent payloads and evidence,
link URLs and snapshots, hold details, journal parameters other than the code, raw crash reports.

Errors are journaled as structured codes (`src/diag/errors.ts`), never as `String(error)`.
