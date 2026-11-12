# Changelog

## 0.5.0 — 2026-11-12 (tech preview)

First release of `lfcp-bridge`: an LFCP shared section ↔ an Apple Reminders list, run from the
Terminal on a Mac. Experimental: commands and the database may change between versions. What works
and the known limits: [README](README.md).

- Host `lfcp-bridge`: pairing as one more device of the person, bindings, `dry-run`/`approve`,
  the long-running `run` process, journal (`log`), `status`, STOP/`resume`, Safe Mode.
- Apple Reminders adapter, both directions: title, due date (date only), priority, completion.
  Reminders are never deleted; personal time, alarms and notes stay in Reminders.
- Guards: holds, hourly limits on unlinks, imports and status changes (strict for the first
  24 hours), ownership marker against a second bridge.
- Swift helper `LFCP Reminders Helper.app` 0.3.1 (EventKit, stdio JSON-lines): a deadline on every
  EventKit call; a stalled helper is restarted by the host with backoff.
- Unknown write outcomes go to quarantine, never repeated by themselves:
  `lfcp-bridge quarantine` lists them and resolves them (`accept`, `redo`, `link`, `ignore`).
- Writes to normal bindings need the owner's verification run on that Mac
  ([verification-run.md](docs/devel/testing/verification-run.md)), recorded with
  `lfcp-bridge verify --record`; until then bindings only dry-run.

Verified live on macOS 26.5 (checklist steps 1–20, helper 0.3.1). Steps 21–23 (both-side edit,
lost write answer, repeating reminder) are covered by automated tests on the fake transport;
their live run was not done
before this release.
