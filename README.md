# lfcp-bridge

Bridge between LFCP shared sections and Apple apps, running as one more device of the
person (MVP 0.5: Apple Reminders). Design: D-010 (`design-b-010.md`, MVP 0.5 workbook);
the map of this repository: [docs/NAVIGATOR.md](docs/NAVIGATOR.md).

> **Experimental.** MVP 0.5 is for people who build it from source and read the runbook first.
> It writes to your Reminders only after a verification run on your Mac, and a person decides
> every unknown outcome. Expect changes to commands and to the database between versions (each
> with a way back: [the runbook](docs/guides/running-the-bridge.md#roll-back)).

**Status: under construction.** The long-running process (`run`), pairing and `approve` come with
PR 9b. Until then those commands answer "not available in this build", and `lfcp-bridge status`
lists them.

How to install, update, recover and disconnect:
[docs/guides/running-the-bridge.md](docs/guides/running-the-bridge.md).

## Limits of the MVP

- **One bridge per Apple ID.** Each bound list carries an ownership marker that *detects* a second
  bridge (it then stops, hold `foreign_bridge`); nothing locks. Moving to another Mac is a
  procedure: [replacing the Mac](docs/guides/replacing-the-mac.md).
- **It never deletes reminders** and never moves or deletes alarms. Tasks that leave the filter stay
  in the list; an alarm left on an old date is a warning.
- **Writes to Reminders only after the verification run**, per helper version and macOS. Until then
  bindings only dry-run.
- **No guessing.** A write whose outcome is unknown is never repeated by itself: it goes to
  quarantine for a person. Neither is a list taken over by its title (no `--adopt-list`): the
  bridge binds only lists it creates.
- **A personal time or alarm wins** over clearing the due date: that becomes a conflict, not a
  write. A reminder you made recurring locks the Task's status and dates.
- **Adding a section (N8) only from quiescence:** no open work, nothing waiting for a person. Work
  that appears during the pairing aborts it.
- **Not in the MVP:** relinking unlinked Tasks, automatic deletion, tags, scheduled dates,
  assignment from Reminders.

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
