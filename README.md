# lfcp-bridge

Bridge between LFCP shared sections and Apple apps, running as one more device of the
person (MVP 0.5: Apple Reminders). Design: D-010 (`design-b-010.md`, MVP 0.5 workbook);
the map of this repository: [docs/NAVIGATOR.md](docs/NAVIGATOR.md).

**Status: under construction (MVP 0.5, stage 1).** Every command of `lfcp-bridge` answers
"not available in this build" until the pull request that brings it.

## Layout

| Path | What |
|---|---|
| `packages/host` | `@openlfcp/bridge`, bin `lfcp-bridge`: CLI, long-running process, bridge database, intent executor, guards, LFCP side |
| `packages/reminders` | `@openlfcp/bridge-reminders`: the Apple Reminders adapter (projections, reconciliation, matching, filter), its transport contract and the fake transport |
| `packages/transport-eventkit` | `@openlfcp/bridge-transport-eventkit`: the Node side of the Swift helper |
| `helper/` | Swift helper `LFCP Reminders Helper.app` (EventKit, stdio JSON-lines) |
| `scripts/check-boundaries.mjs` | package boundaries (D-010 §1.1) |

Boundaries: `reminders` never imports `host`; a `transport-*` package imports only the
adapter's `transport` and `capabilities`.

## Development

Node 24 (`.node-version`) and pnpm 10.

```sh
pnpm install
pnpm build        # tsc -b
pnpm lint         # biome, package boundaries
pnpm typecheck    # tsc -b, and the tests' types
pnpm test         # vitest
```

The LFCP SDK comes from npm at exact versions (`@openlfcp/*` 0.5.2, pinned for transitive
dependencies too by `pnpm.overrides`).

## License

Apache-2.0. See [LICENSE](LICENSE).
