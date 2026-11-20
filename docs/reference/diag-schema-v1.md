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
| `versions` | bridge, Node, OS, arch, macOS as the write gate saw it, the database's schema version; `helper` is `null` (nested code of the app, checked by cdhash) |
| `artifactSliceId`, `cert` | A§9.1, the write gate's last decision: the running shell's cdhash; `{state, reason, at}` (`cert.state` and its reason code), `null` before the first check. Its text is not exported |
| `certTestMode` | A§9.4; `false` until E-050 |
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

The tree is built field by field by its path in the schema; no object read from the database or
a file is copied. Each string leaf is kept plain only when it belongs to its field's vocabulary —
a **known** code (`src/diag/codes.ts`: helper, transport, SDK, SQLite and errno codes, the
bridge's reasons and enumerated states), a journal key of `JOURNAL_TEXT` — or form (an id, a time,
a version, a frame); otherwise it becomes `h:` + the first 8 bytes (hex) of HMAC-SHA-256(k, value).
A value that only looks like a code (`PRIVATE_NOTE`, `private.example.com`) is sealed. A non-string
where a string belongs (a nested object) is dropped. Crash signatures are rebuilt from `process`,
`exception` and `frames` only, each checked. Titles, URLs, paths and error texts are always sealed.
Equal strings within one export have equal HMACs; `k` is random per export, zeroed after it and
never written, so two exports share no HMAC value.

## Writing the zip

The zip is written as a new file (0600, `O_EXCL | O_NOFOLLOW`) in the folder the path names, then
renamed over the path: an existing regular file is replaced as a whole, never written into; a
symlink, a directory or anything else at the path is refused (`EEXIST`); the folder must exist
(the default `<data directory>/diagnostics/` is made, 0700). Crash reports are chosen by name, type
(regular files only) and size before any is opened, and only the newest 10 are read.

## Never read

Pairing links, keys and DEKs, the `meta` table beyond Safe Mode, intent payloads and evidence,
link URLs and snapshots, hold details, journal parameters other than the code, raw crash reports.

Errors are journaled as structured codes (`src/diag/errors.ts`), never as `String(error)`: a
known code, else a known class name, else `error`.
