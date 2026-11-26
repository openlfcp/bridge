# The synthetic year of `C`

T§3 "synthetic year of C" (A§3.5, E26 №8; E-030): a year of the history of `C` (SERVICE-CONTROL-PROFILE-01)
written through the host's `ControlClient` and sdk-ts against the reference server, then held to the
budget of A§3.5.

## What it writes

`packages/host/test/support/c-year.ts`, seeded, on a simulated clock:

- the bridge (a service device with the base approval): the host's own `ControlClient` — `service`,
  `status` with the 30-minute heartbeat, `bindings/<X>`, `events`, `questions.resolved`, the 7-day
  cleanup; a preview at each turn-on (a section is turned on at the start and again once a month, a new
  generation) and the questions, through the same port;
- the root (the plugin): an answer to each question, a Snapshot of `C` once a week.

8 sections, 20 transitions a day per binding (a complete check: `lastCompleteCheckAt` moves), 2
questions a week per binding.

## What it measures

| Measure | How | Budget (A§3.5) |
|---|---|---|
| History of `C` on the server | the stored bytes of `C`'s Data Units and Snapshots: `SUM(length(bytes))` over `data_units` and `snapshots` of `C` in the server's `server.sqlite3`, the server stopped | ≤ 20 MiB |
| Cold connection | `c-year-cold.mjs`, its own process: a new personal device of the root, nothing stored, until it reads the last status | ≤ 10 s |
| Peak memory | that process's `maxRSS` | ≤ 640 MiB (0.6) |
| Admission of the whole history | `replayStored` of every unit the bridge holds through a fresh profile | ≤ 5 s |
| Dedup evidence | every answer the cleanup removed from `C` keeps its `applied` `control_exec` row (A§3.4 step 5) | all |

"History of `C` ≤ 20 MiB" counts the objects the server keeps for `C`, not the size of its database
file (the owner's decision for A§3.5). The figures also give the size of the server's `state_dir`, for
reference only.

The peak memory budget for 0.6 is 640 MiB for a one-year history: the owner's decision of 2026-11-25
(A§3.5, answer C). The 200 MiB whole-process figure of A§3.5 is the goal for later phases.

Over budget fails the run: a release blocker (A§3.5, T§3). Every measure above fails it, the nightly
job included; there is no report-only mode. Admission, the cold connection and its memory depend on
sdk-ts (validating `ServiceControl` at admission), so until the bridge pins an sdk-ts that meets them
on a one-year history, the nightly year fails.

The answer to the history budget is less writing, never fewer
`control_exec` rows: the `ControlClient` writes only the fields that changed, and the heartbeat and a
binding's progress fields (`lastCompleteCheckAt`, `pending`) ride on the next unit it writes anyway, or on
the heartbeat 30 minutes after the last unit.

The cold client runs in its own process with a 30-minute timeout (`COLD_TIMEOUT_MS`), far above the
10 s budget: a slow cold connection still gives its figures before the budget check fails the run, and
the error says how the process ended (killed at the timeout, killed by a signal, or its exit code and stderr).
The client itself stops waiting one minute before the kill and reports how far it got: the time of each
phase (chain, DEKs, start), the units admitted and the time spent admitting them, the state of `C`, the
last heartbeat it read, and its peak memory.
The year prints its progress once a simulated week with the elapsed time, and the cold client's time.

## Running it

`pnpm c-year` (`LFCP_C_YEAR=1`, `LFCP_REQUIRE_LIVE=1`) with `LFCP_SERVER_BIN` set (see Live tests in
`docs/NAVIGATOR.md`). `LFCP_C_DAYS` and `LFCP_C_TRANSITIONS` change the year; `LFCP_C_REPORT` names a
JSON file for the figures. A whole year takes hours: run it in CI, not locally.

Every `pnpm test` with a server runs eight sparse days (past the cleanup) through the same checks.

`.github/workflows/c-year.yml` runs the year nightly on `macos-15`, `macos-15-intel` and `macos-26`
(the server built at `server.lock`, the SDK packed at `sdk-ts.lock`), 30 days when its own files change,
any length by `workflow_dispatch`. The figures are the job summary and the `c-year-<runner>` artifact.
