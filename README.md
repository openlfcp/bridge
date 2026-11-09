# lfcp-bridge

Bridge between LFCP shared sections and Apple apps, running as one more device of the
person (MVP 0.5: Apple Reminders). Design: `docs/` (to be added) and the D-010 design note.

Layout (planned):

| Path | What |
|---|---|
| `packages/host` | `@openlfcp/bridge`: CLI, long-running process, bridge database, guards |
| `packages/reminders` | Apple Reminders adapter: mapping, reconciliation, transport contract, fake transport |
| `packages/transport-eventkit` | Node side of the Swift helper |
| `helper/` | Swift helper `LFCP Reminders Helper.app` (EventKit, stdio JSON-lines) |

License: Apache-2.0.
