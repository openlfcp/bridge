# Navigator

Where things are in lfcp-bridge, and where they will be. The design is D-010
(`design-b-010.md`); section numbers below (§) are its sections, PR numbers its §11.

## Packages

| Package | Directory | Owns | Never |
|---|---|---|---|
| `@openlfcp/bridge` (bin `lfcp-bridge`) | `packages/host` | CLI (§2.1), the `run` process, `bridge.sqlite` (§3), intents and recovery (§5.6–5.9), guards and holds (§7), bootstrap and ownership (§6.5), the LFCP side (SectionHost, §5.8) | — |
| `@openlfcp/bridge-reminders` | `packages/reminders` | projections (§4.4–4.5), matching (§5.4), reconciliation, filter (§6.1); `transport.ts` (§4.2), `capabilities.ts` (§4.3); `fake/` | imports the host |
| `@openlfcp/bridge-transport-eventkit` | `packages/transport-eventkit` | the Node side of the helper: spawn, FIFO, protocol v2 (§8), stages in DurableKV | imports anything of the adapter but `transport` and `capabilities`; imports the host |
| Swift helper | `helper/` | `LFCP Reminders Helper.app`: HelperCore, HelperApp (EventKit) | — |

`scripts/check-boundaries.mjs` enforces the column "Never" (`pnpm lint`).

## Host (planned layout, by PR)

| Path | What | PR |
|---|---|---|
| `src/cli.ts`, `src/commands.ts`, `src/exit.ts` | the command table and exit codes; later commands answer "not available in this build" | 1 |
| `src/db/` | `bridge.sqlite` on better-sqlite3 (WAL, synchronous=FULL, foreign keys): `schema.ts` (migrations over `user_version`, each with its `down`), `database.ts` (open, `migrateTo`, newer schema refused), `holds.ts` (a set per binding), `journal.ts`, `stop.ts` (the STOP file) | 2 |
| `src/lfcp/section-host.ts` | SectionHost: one SyncClient per coordinator; restore/rebuild of checkpoints, applier, snapshot binding (load only, never publish), sync driver, outbound; `commitGuarded` is the only commit; `onNodesChanged`; `isLive` / `generation` | 3a |
| `src/lfcp/commit-guard.ts` | the atomic basis check (§5.8): a wrapper of `CommitBinding.stage` with a guard registry by array object; unguarded stage → `UnguardedCommitError`, failed check → `BasisChangedError` | 3a |
| `src/lfcp/live.ts` | `lfcp_live` (§5.3, R2-13): LIVE now, in the current generation of the connection; reset on disconnect, wake, rebuild | 3a |
| `src/lfcp/fallback/` | **SDK gap fallbacks**, one file each, marked `FALLBACK for sdk-ts G…`: `node-installation.ts` (G3), `paired-sections.ts` (G1). Removed by the chore that moves to the sdk-ts release with 504 | 3a |
| `src/lfcp/liveness.ts`, `reconnect.ts` | a PING after 15 s of silence, dead after 5 s more → drop and reconnect; backoff 1 s → 15 s ±20 %, restartable; `SectionHost.wake()` (drop, reconnect, new generation) and `networkBack()` | 3b |
| `src/lfcp/access.ts` | `access_checked_now` (an answer in the current generation: allowed or read-only), `offline_commit_allowed` (the last answer kept in `meta`); a refusal → `revocationStatus` (the §8.6 write barrier) → refused / revoked for good; hold `access_refused` | 3b |
| `src/lfcp/delivery.ts` | §5.9: batch status → intent; no-op receipt delivered at once; rejected and partial by the field's generation (`bases.intent_id`), conflicts `lfcp_rejected` / `lfcp_partial`; blocked → hold `access_refused` | 3b |
| `src/executor/permissions.ts` | **the one table** of what an effect needs, for normal / verification / bootstrap / unbind (§7.1, r3 P2-4): `permits(context)` | 7 |
| `src/executor/intents.ts` | intents in `bridge.sqlite` (§5.6): ULID ids, `brg1:<id>`, one open intent per Task and direction, the state steps | 7 |
| `src/executor/executor.ts` | prepare (after the limits) → §7.1 → `effecting` → one call → result → finalize; recovery §5.7 (`unknown_outcome` quarantine, which also holds the Task's fields in both directions until resolved; every unknown outcome is quarantined, nothing inferred from the item — B19; an opKey with an unknown outcome is never sent again — `OutcomeUnknownError` → quarantine, a new opKey only after a person; `OperationInFlightError` and a second runner in this process → `in_flight`, not repeated); an intent is checked against its binding and its payload against its kind before any call; **effects off** (Apple only through the fake transport, LFCP only through `offlineTestPort`) | 7 |
| `src/executor/limits.ts`, `safe-mode.ts`, `transport-state.ts` | sliding-window limits with prepared intents counted (§7.2); runs and Safe Mode (§7.3); the transport's DurableKV in `transport_state` | 7 |
| `src/reconcile/pass.ts`, `section-view.ts` | a pass of one binding (§5.5): the section's Tasks from the replica, the list's snapshot, links / bases / open intents / conflicts → the adapter's plan; guards §7.2 checked without setting them; **dry-run only**: the plan is stored in `runs` (kind `dry`), `apply` answers `dry_run_only` | 8 |
| `src/lfcp/fallback/device-root.ts` | **FALLBACK for sdk-ts G4**: the person's root (who "me" is for the filter) from the finished pairing request | 8 |
| `src/reconcile/handler.ts` | the adapter's part of the executor (§5.6, §5.8): finalize by direction (R2-1: to_apple — LFCP base from the basis, Apple base from `written`; create also links; to_lfcp — LFCP base from the stored intents applied, Apple base from the basis), B14 journal, the basis check inside stage; `currentLfcp` for delivery (§5.9) | 10 |
| `src/bootstrap.ts`, `src/ownership.ts` | bind: scan → list → marker (§6.5, B16/B17), unknown outcomes resolved by a person; the ownership check (foreign_bridge, ownership_lost) | 9 |
| `src/supervisor.ts` | the helper process: ping 30 s, restart, 3 in 5 min → helper_unavailable, orphan from helper.pid | 9 |
| `src/launchd.ts`, `src/doctor.ts`, `src/verification.ts`, `src/runtime.ts`, `src/config.ts` | LaunchAgent, preflight (§7.4), write modes and writesVerified (§7.6), the machine, paths and config.json | 9 |
| `src/migration.ts` | N8 from quiescence (§9 r4, B17 P1-1): precondition, the atomic freeze with quiescence checked again, fresh LIVE, switch, revocation, abort before switching; phase, `blocked_reason` and `aborted_reason` apart | 13 |
| `src/reconcile/links.ts` | a pass's application (§6.1–6.4, B4, B11): global finds first (complete only; several candidates → quarantine), then the whole pass — intents, real unlinks, the dry run's count drop — against the limits on the state before any change (r2 §7.2); then the transitions and the intents; task_gone / out_of_filter, a global find before unlinked (moved_out, deleted_in_apple) and before a new projection on a return (R2-9 (3)), relink as a first link, orphans, quarantine, recurring copies, status_locked; nothing deleted anywhere | 12 |

## Adapter (`packages/reminders/src/adapter/`, PR 8)

Pure: no I/O, no host; the host gives it a view and gets a plan.

| Path | What |
|---|---|
| `projection.ts` | projections of title, due, priority, status (§4.4), equivalence, the Apple write of one field with §4.5 (dates alone; clearing with a time or alarm → `due_cleared_in_lfcp`; an alarm left on the old day → warning) |
| `filter.ts` | `default` (QB10), `mine`, `all` (§6.1); what may get a new projection |
| `link.ts` | `lfcp://task/<T>?s=<R>&b=<instance8>` and the marker URL |
| `matching.ts` | §5.4: markers out, pass 1 (links: matched / tombstone / absent / ambiguous, recurring copies), pass 2 (orphans, foreign bridge, imports, `import_ambiguous`) |
| `plan.ts` | §5.5: per field dL / dA against the bases → write to Apple or to LFCP (one intent per direction and Task), record bases or shadow; the status group by its table; link transitions and imports shown (PR 11, 12); new projections |
| `status-table.ts` | the status group (r3 P2-2): rows with explicit dL / dA predicates, one row for every input (tested over the whole input space); cancelled is (true, —) |
| `lfcp-write.ts` | Apple → LFCP: set_title, set_due / clear_due (the date only, B12), set_priority with the shadow (B13), complete / reopen; `applyLfcpIntents` for the to_lfcp finalize |

## The SDK

`@openlfcp/*` from npm at 0.5.2, exact versions. The bridge API of sdk-ts (pairedResources,
deviceIdentity, openNodeInstallation, sectionEnd, connection reuse) comes in a separate chore
once sdk-ts releases it; until then the host keeps its own fallbacks in `src/lfcp/`.

## Live tests

`packages/host/test/*.live.test.ts` run against the Rust reference server named by
`LFCP_SERVER_BIN` (built at `server.lock`); without it they are skipped, and with
`LFCP_REQUIRE_LIVE=1` a skip fails the run. CI runs them with the `e2e` job (PR 9+).

## CI (§1.3)

| Job | Now |
|---|---|
| `lint` | biome, boundaries, `tsc -b` and the tests' types |
| `unit` | vitest |
| `helper` (`helper.yml`) | HelperCore tests, the app, smoke, sign-dev tests, SwiftPM |
| `helper-protocol` (`helper.yml`) | `transport-eventkit` against the helper (memory backend): unit tests, `transportContract`, open + FIFO |
| `crash`, `e2e` | with PRs 7, 9 |

## Testing

| Document | What |
|---|---|
| `docs/devel/testing/helper-live-checklist.md` | the owner's live EventKit check of the helper (TCC, `live-check.mjs`, `sign-dev.sh`), linked to the R-001 live run |

## Guides

| Document | What |
|---|---|
| `docs/guides/replacing-the-mac.md` | one bridge per Apple ID; replacing the Mac (revoke, delete the marker, rename the list, bind); unknown bootstrap outcomes |

## Runtime files (§2.2)

`~/Library/Application Support/org.openlfcp.bridge/`: `config.json`, `bridge.sqlite`,
`installations/<iid>/` (a `storage-node` state directory each), `run.lock`, `STOP`,
`helper.pid`. Logs: `~/Library/Logs/org.openlfcp.bridge/`.
