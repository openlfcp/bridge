# lfcp-bridge

Bridge between LFCP shared sections and Apple apps, running as one more device of the
person (MVP 0.5: Apple Reminders). Design: D-010 (`design-b-010.md`, MVP 0.5 workbook);
the map of this repository: [docs/NAVIGATOR.md](docs/NAVIGATOR.md).

> **Tech preview — experimental.** MVP 0.5 runs from the Terminal on a Mac: you build it from
> source and start it with `lfcp-bridge run`. There is no installer and no app bundle for the
> bridge itself; only its helper, `LFCP Reminders Helper.app`, is an app, signed with the
> development certificate. Expect changes to commands and to the database between versions (each
> with a way back: [the runbook](docs/guides/running-the-bridge.md#roll-back)).

## What works in 0.5

- **One shared section ↔ one Reminders list per binding**, in both directions: title, due date,
  priority and completion.
- **Guards:** holds that stop a binding until a person accepts them; hourly limits on unlinks,
  imports and status changes (strict for the first 24 hours after `approve`); STOP
  (`lfcp-bridge stop`, `lfcp-bridge resume`); Safe Mode after two crashed runs within 10 minutes.
- **The owner's verification run before normal writes:** until it has passed on your Mac for this
  helper build and macOS, normal bindings only dry-run.
- **Quarantine for unknown outcomes:** a write whose answer was lost is never repeated by itself;
  the `quarantine` command (PR #28) lists it and resolves it as a person decides.

## How to set up

1. [docs/devel/testing/verification-run.md](docs/devel/testing/verification-run.md): build, pair,
   bind a test list and run the owner's checklist on your Mac — the first thing to do.
2. [docs/guides/running-the-bridge.md](docs/guides/running-the-bridge.md): install, run as a
   service, update, recover and disconnect.

## Known limits of 0.5

- **Fields.** Only the title, the due date (the date only: a time, a time zone and alarms stay in
  Reminders), the priority and the completion are synchronized. Notes, tags, scheduled dates,
  assignment from Reminders and a reminder's repeat rule are not (a repeating reminder locks the
  Task's status and dates).
- **Commands not in 0.5:** `conflicts`, `refused` and `links`. Field conflicts, refused intents and
  links are in the database, but `status` and `log` do not show them all: a cleared due date that
  meets a personal time or alarm (`due_cleared_in_lfcp`) shows only in
  `lfcp-bridge dry-run <binding>` (stop `run` first).
- **A helper stall on a request without a list** (an update by reference, the global marker search)
  counts toward the shared helper restart budget: more than 3 restarts in 5 minutes stop every
  binding (`helper_unavailable`) until a person resumes. Repeated stalls on one list's requests
  hold only that binding (`helper_stall`).
- **Creating a list keeps its own unknown-outcome flow:** if the answer is lost while `bind` creates
  the list, `bind` lists the candidates and you choose with
  `lfcp-bridge bind --binding <id> --resolve-list <id>|none`.

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
- **Adding a section (N8) is not available in 0.5:** `sections add` and `migrate resume` answer
  "not available in this build" (the run process does not give them the pairing and the new
  connection yet); only `lfcp-bridge migrate status` and `lfcp-bridge migrate abort` work. When it
  comes, it starts only from quiescence: no open work, nothing waiting for a person.
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

The LFCP SDK comes from npm at exact versions (`@openlfcp/*` 0.6.0, pinned for transitive
dependencies too by `pnpm.overrides`).

## License

Apache-2.0. See [LICENSE](LICENSE).
