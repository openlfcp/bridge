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
| `src/lfcp/` | SectionHost, `commitGuarded`, readiness, delivery; SDK gap fallbacks (G1: the pairing journal) until sdk-ts ships them | 3a, 3b |
| `src/executor/` | intents, recovery, guards, limits, Safe Mode | 7 |

## The SDK

`@openlfcp/*` from npm at 0.5.2, exact versions. The bridge API of sdk-ts (pairedResources,
deviceIdentity, openNodeInstallation, sectionEnd, connection reuse) comes in a separate chore
once sdk-ts releases it; until then the host keeps its own fallbacks in `src/lfcp/`.

## CI (§1.3)

| Job | Now |
|---|---|
| `lint` | biome, boundaries, `tsc -b` and the tests' types |
| `unit` | vitest |
| `crash`, `e2e`, `helper`, `helper-protocol` | with PRs 7, 9, 5a, 6 |

## Runtime files (§2.2)

`~/Library/Application Support/org.openlfcp.bridge/`: `config.json`, `bridge.sqlite`,
`installations/<iid>/` (a `storage-node` state directory each), `run.lock`, `STOP`,
`helper.pid`. Logs: `~/Library/Logs/org.openlfcp.bridge/`.
