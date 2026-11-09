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
| `src/executor/` | intents, recovery, guards, limits, Safe Mode | 7 |

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
| `crash`, `e2e`, `helper`, `helper-protocol` | with PRs 7, 9, 5a, 6 |

## Testing

| Document | What |
|---|---|
| `docs/devel/testing/helper-live-checklist.md` | the owner's live EventKit check of the helper (TCC, `live-check.mjs`, `sign-dev.sh`), linked to the R-001 live run |

## Runtime files (§2.2)

`~/Library/Application Support/org.openlfcp.bridge/`: `config.json`, `bridge.sqlite`,
`installations/<iid>/` (a `storage-node` state directory each), `run.lock`, `STOP`,
`helper.pid`. Logs: `~/Library/Logs/org.openlfcp.bridge/`.
