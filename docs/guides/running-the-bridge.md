# Running the bridge: install, update, recover, disconnect

A runbook for a person who builds `lfcp-bridge` from source and runs it on their own Mac (D-010 r4,
B-014). The bridge is **experimental** (MVP 0.5): read [the limits](#limits-of-the-mvp) first.

This text describes the bridge **with PR 9b** (the `run` process). Every command shown here is
checked against that CLI (`pr9b-2-cli`, `d260354`) by `node scripts/check-runbook.mjs --src <its
packages/host/src>`. A command that is not in a build answers
`<command>: not available in this build (D-010 PR …)` with exit code 2; `lfcp-bridge status` lists
them.

- **Before PR 9b is in `main`:** `run`, `pair`, `sections`, `dry-run` and `approve` are not
  available.
- **Not available yet, PR 9b included:**
  - a command to leave Safe Mode (see [Safe Mode](#safe-mode));
  - `conflicts`, `quarantine`, `refused` (the state is in the database, the commands are not);
  - N8's `sections add` and `migrate resume` (the `run` process does not give them the pairing and
    the new connection yet).

  They are marked **(not available yet)** below.

## Contents

- [Install from source](#install-from-source)
- [Bind a section](#bind-a-section)
- [Day to day: status, log, doctor](#day-to-day-status-log-doctor)
- [Update](#update)
- [Roll back](#roll-back)
- [Recover](#recover)
- [Replace the Mac](#replace-the-mac)
- [Add a section (N8)](#add-a-section-n8)
- [Disconnect the bridge](#disconnect-the-bridge)
- [Exit codes](#exit-codes)
- [Limits of the MVP](#limits-of-the-mvp)

## Install from source

You need:
- macOS 12 or later;
- the Xcode command line tools (`xcode-select --install`; `swiftc`, `codesign`);
- Node 24 (`.node-version`) and pnpm 10 (`corepack enable`).

```sh
git clone https://github.com/openlfcp/bridge.git && cd bridge
pnpm install --frozen-lockfile
pnpm build
alias lfcp-bridge="node $PWD/packages/host/dist/cli.js"
```

Build and sign the helper app, then put it where the bridge looks for it:

```sh
cd helper
scripts/sign-dev.sh --login-keychain   # first time: a stable self-signed certificate (asks before touching the login keychain)
# a release instead: scripts/sign-release.sh … (docs/guides/signing-the-helper.md)
cp -R "build/LFCP Reminders Helper.app" ~/Applications/
cd ..
```

Then check the machine and grant Reminders access. The access request is the only system dialog,
and it comes only from this command (or from `bind`):

```sh
lfcp-bridge doctor --request-access
```

`doctor` only reads. It checks:
- the schema, STOP and the installation directories;
- the helper and its signature, Reminders access (TCC);
- each binding's list and markers, its holds;
- bootstraps waiting for a person, old open intents, unfinished migrations.

`fail` exits 3.

Where things are:

| What | Where |
|---|---|
| data: `config.json`, `bridge.sqlite`, `installations/`, `STOP`, `helper.pid` | `~/Library/Application Support/org.openlfcp.bridge/` (`LFCP_BRIDGE_HOME` overrides) |
| logs | `~/Library/Logs/org.openlfcp.bridge/` (`LFCP_BRIDGE_LOGS` overrides) |
| LaunchAgent | `~/Library/LaunchAgents/org.openlfcp.bridge.plist` |
| helper app | `~/Applications/LFCP Reminders Helper.app` (`helperPath` in `config.json` overrides) |

`config.json` holds `bridgeInstanceId`. It is created once and never changes: it names this bridge's
ownership markers. Do not edit or copy it to another Mac.

### The LaunchAgent

```sh
lfcp-bridge service install     # writes the plist and loads it (launchctl bootstrap gui/<uid>)
lfcp-bridge service uninstall   # unloads and removes it
```

The agent runs `lfcp-bridge run` at login and restarts it after a crash, at most every 30 s
(`ThrottleInterval`). Exit 0 (STOP, Safe Mode) is not restarted. It records the absolute paths of
`node` and of the CLI at install: install it again after moving the checkout or changing Node.

Install the agent only with PR 9b: before it, `run` is not in the build, and launchd would restart a
command that exits 2 every 30 seconds.

One `run` at a time: it holds `run.lock` in the data directory, and a second one exits 3. To run it
in a terminal instead, use `lfcp-bridge run`; Ctrl-C (or SIGTERM) stops it cleanly.

## Bind a section

1. **Pair** the bridge as a device of your sections. In Obsidian: the LFCP plugin → devices → add a
   service device with access to the sections → copy the link. Then:

   ```sh
   pbpaste | lfcp-bridge pair --label "Mac bridge" --section Work --section Home
   lfcp-bridge sections
   ```

   The link is read from standard input. `pair` prints a fingerprint: compare it with Obsidian and
   approve there. It waits up to 10 minutes (`--wait <seconds>`).
   - `paired: installation …` — done.
   - `not approved yet` — approve, then run the command it prints. That command has
     `--installation <id>`; give it the link on standard input again.

   `sections` lists the paired sections of every installation, bound or not.
2. **Bind** a section to a new Reminders list:

   ```sh
   lfcp-bridge bind Work                # makes the list "LFCP · Work" and the ownership marker
   lfcp-bridge bind Work --filter mine  # only Tasks assigned to you (default | mine | all)
   ```

   The bridge only binds a list it creates. If a list "LFCP · Work" already exists, `bind` refuses
   (`list_exists`): rename that list first. The binding ends in `pending_dry_run`.
3. **Dry run, then approve:**

   ```sh
   lfcp-bridge dry-run <binding>   # a full pass without effects: what it would create, update, import, unlink
   lfcp-bridge approve <binding>   # pending_dry_run -> active
   ```

   `approve` needs a dry run of that binding less than an hour old, and ownership not lost. The
   binding then runs with strict limits for 24 hours.
4. **Verify writes once per helper version and macOS.** Until then normal bindings only dry-run
   (`writesVerified: no` in `status`).

   ```sh
   lfcp-bridge verify --section "Bridge test"   # a test section and its own list "LFCP Verify · …"
   ```

   The verification run writes only to that list and that section, with the `run` process. The
   owner's walk-through is `docs/devel/testing/verification-run.md` (PR 9b).

## Day to day: status, log, doctor

```sh
lfcp-bridge status                            # STOP, writesVerified, bindings with their state and holds
lfcp-bridge log [--binding <id>] [--limit N]  # the last N journal entries, oldest first (default 50)
lfcp-bridge doctor                            # what blocks, and what to do
```

## Update

1. Stop effects, unload the agent, and stop a `run` started by hand (Ctrl-C):

   ```sh
   lfcp-bridge stop --reason update
   lfcp-bridge service uninstall
   ```

2. Back up the database: `node scripts/bridge-db.mjs backup`. It is a consistent online copy next to
   `bridge.sqlite`, named with its version and the time. A backup is always a new file: the script
   never writes over a file, the database or its `-wal` / `-shm`.
3. Update and build:

   ```sh
   git pull && pnpm install --frozen-lockfile && pnpm build
   ```

4. If the helper changed (`helper/` in the diff), rebuild and sign it, then copy it to
   `~/Applications`. A new helper version resets `writesVerified`: verify again before normal
   bindings write.
5. Start again:

   ```sh
   lfcp-bridge doctor
   lfcp-bridge service install
   lfcp-bridge resume
   ```

   The first command that opens the database migrates it up to the new schema. Each step runs in
   one transaction, and a failed step leaves the last complete version.

`node scripts/bridge-db.mjs status` shows the database's version and the versions this build knows.

| Version | What it adds | Down removes |
|---|---|---|
| 1 | installations, bindings, holds, journal, runs, meta | everything |
| 2 | links, bases, personal Apple data, conflicts, intents, bootstrap steps, transport state, N8 migrations | the synchronisation state |
| 3 | runs and journal in the r2 form (data moved over) | moves them back to the v2 form |
| 4 | N8 migration details (`migration_details`) | that table |
| 5 | a person's decisions on refused or quarantined intents (`intent_resolutions`) | that table |

## Roll back

An older build refuses a database written by a newer one ("bridge.sqlite has schema version N;
this build knows up to M"). It does not guess. To go back to an older build:

1. Stop and unload, as for an update (a `run` started by hand too):

   ```sh
   lfcp-bridge stop --reason rollback
   lfcp-bridge service uninstall
   ```

2. With the **current** build, which knows the way down, move the schema to the older build's
   version:

   ```sh
   node scripts/bridge-db.mjs status
   node scripts/bridge-db.mjs migrate --to 3   # needs STOP and no run; backs up to a new file first
   ```

   Down drops what the later versions added (table above). The backup keeps it.
3. Check out and build the older version, then `doctor`, `service install`, `resume`.

To undo a rollback, update again: the newer build migrates up. If the data of the dropped versions
matters, restore the backup instead: with no `run` running, copy it over `bridge.sqlite` and delete
`bridge.sqlite-wal` and `bridge.sqlite-shm`.

## Recover

### STOP: the emergency switch

```sh
lfcp-bridge stop [--reason "<why>"]   # no effect runs: no write to Reminders, no commit to LFCP
lfcp-bridge resume                    # removes STOP
```

STOP is a file (`STOP` in the data directory), checked before every effect and every retry, in
every process. It works even when the database is locked or unreadable. `touch STOP` there does the
same. `unbind` refuses while STOP is set (exit 5).

### Safe Mode

Two crashed runs in a row, started less than 10 minutes apart, put the bridge into Safe Mode: no
effect runs, and the bootstrap and `unbind` refuse. Only `run` enters it. Look at the log and the
launchd output in the logs directory and fix the cause.

**Leaving Safe Mode has no command yet (not available yet).** `resume` only removes STOP, and it
ignores flags it does not know: a `--safe-mode-off` flag is planned but not in the CLI, and passing
it changes nothing. Until it exists, the state is the `safe_mode` row of the `meta` table. With the
agent unloaded and no `run` running, remove it with
`sqlite3 bridge.sqlite "DELETE FROM meta WHERE key = 'safe_mode'"` in the data directory. That is
what the planned command does, without its journal entry.

### Holds

A hold stops the effects of one binding. `status` shows them; `doctor` explains them. Lift one hold
of one binding:

```sh
lfcp-bridge resume --accept <hold> --binding <id>
```

For a guard hold this also accepts the anomaly once: the next pass goes through with it as the new
baseline.

Accept a hold only once its cause is understood:

| Hold | Why | What to do |
|---|---|---|
| `guard_mass_unlink`, `guard_mass_import`, `guard_mass_status`, `guard_count_drop`, `guard_backlog` | a pass would change more than the hourly limits allow (§7.2) | check the list and the section; if the change is meant, accept |
| `ownership_lost` | this bridge's marker "LFCP bridge · не удалять" is gone from the list | never lifted or re-created by itself. If you deleted it by mistake, unbind and bind again. If another Mac took over, this bridge is done here |
| `foreign_bridge` | another bridge's marker for this section exists | lifts itself when that marker is gone. See [replacing the Mac](replacing-the-mac.md). One bridge per Apple ID |
| `import_ambiguous` | a new reminder could match more than one pending Task | resolve the quarantine **(not available yet)**, then accept |
| `access_refused` | the server refused the section (revoked device or grant) | lifts on an "allowed" answer; a proven revocation is final |
| `helper_unavailable` | the helper restarted more than 3 times in 5 minutes | `doctor`; fix the helper (signature, Reminders access); accept |
| `helper_stall` | the helper got stuck twice in 5 minutes reading or writing **this binding's list** (`log`: `helper.stalled`, `helper.stall_hold`); only this binding pauses, and nothing reads its list until you accept | look at the list in Reminders — a repeating reminder is the known trigger — then accept; if it stalls again, the hold comes back |
| `migration` | set by an N8 migration on the old installation's bindings | **do not accept by hand**: `migrate resume` or `migrate abort` lift it |

### Unknown outcomes

**While binding.** If the connection to Reminders broke while the list or the marker was being
written, the bridge does not guess. `bind` exits 3 and prints the candidates:

```sh
lfcp-bridge bind --binding <id> --resolve-list <list id>          # this is the list the bridge created
lfcp-bridge bind --binding <id> --resolve-list none               # it created none: rename lists with that title, try again
lfcp-bridge bind --binding <id> --resolve-marker <reminder id>    # this is the marker the bridge wrote
lfcp-bridge bind --binding <id> --resolve-marker none             # it wrote none: delete the printed markers, try again
lfcp-bridge bind --binding <id> --retry-marker                    # the same as --resolve-marker none
lfcp-bridge bind --binding <id>                                   # continue a bootstrap that stopped
```

`doctor` lists bootstraps that wait for a person.

**While syncing.** A write whose outcome is unknown is never repeated by itself. The intent goes to
quarantine with field conflicts. A refused intent stays refused. Both wait for a person:

- `quarantine list|link|ignore|drop` **(not available yet)**;
- `conflicts list|resolve <id> --take lfcp|apple` **(not available yet)**;
- `refused list|retry|drop` **(not available yet)**.

The database records the person's decision (`intent_resolutions`, schema version 5). Until then an
unresolved refused or quarantined intent also keeps [N8](#add-a-section-n8) from starting.

## Replace the Mac

See [replacing-the-mac.md](replacing-the-mac.md): revoke the old bridge in the plugin, delete its
marker, rename the old list, then pair and bind on the new Mac. There is no "adopt the old list".

## Add a section (N8)

**Starting a migration is not available yet**, PR 9b included. `sections add` and `migrate resume`
are in the command table, but they need the pairing and the new connection of the `run` process,
which does not give them yet: they answer "not available in this build" (exit 2). What works now:

```sh
lfcp-bridge migrate status                # migrations, their phase, blocked or aborted reason
lfcp-bridge migrate abort [<migration>]   # before switching only
```

How it will run, once available. A paired installation cannot gain a section. `sections add <name>
[--from <installation>]` pairs a **new** installation whose scope
is the old sections plus the new one, moves every binding to it, and retires the old one. It runs
**only from quiescence**. Before it starts, there must be:

- no open intent, and no batch to LFCP that is not accepted;
- no refused or quarantined intent a person has not resolved;
- no open conflict and no link in quarantine;
- no other migration under way.

Otherwise it refuses with the reasons (exit 3): wait for the synchronisation, resolve what waits,
try again. `migrate resume [<migration>]` continues a migration from its stored phase.

What happens:

1. **pairing**: approve the new pairing in the plugin.
2. **freeze**, one transaction: quiescence is checked again, the old installation is frozen, its
   bindings get the hold `migration`, and no new intent can be prepared for them. If work appeared
   during the pairing, the migration is aborted instead (`not_quiescent`), and the old installation
   works on. Start it again later.
3. **catching_up**: the new installation must be LIVE on every section, on a connection opened after
   the freeze. After 24 hours `migrate status` shows it blocked; `migrate abort` is still possible.
4. **switching**: one transaction moves the bindings to the new installation and retires the old
   one. From here on only forward.
5. **closing**: the old connection closes, the hold `migration` is lifted, a full pass runs.
6. **awaiting_revocation**: revoke the old device in the plugin. The migration ends (`done`) when
   the revocation is proven.

`migrate abort` works only before switching. It retires the new installation, makes the old one
active again (unless it was revoked meanwhile) and lifts the holds. A late answer of the pairing or
of the new connection never moves an aborted migration.

## Disconnect the bridge

1. For each binding (`lfcp-bridge status`):

   ```sh
   lfcp-bridge unbind <binding>
   ```

   The binding is removed and this bridge's marker retired. The list and its reminders stay in
   Reminders as yours, no longer synced. If the marker could not be retired, the command says why;
   delete "LFCP bridge · не удалять" in that list by hand. `unbind` refuses under STOP or Safe Mode.
2. Unload the agent: `lfcp-bridge service uninstall`.
3. Revoke the bridge in the Obsidian plugin (the section's device list). This is what removes its
   access to your sections.
4. Optionally:
   - delete the data: `~/Library/Application Support/org.openlfcp.bridge/` and
     `~/Library/Logs/org.openlfcp.bridge/`;
   - delete the helper app;
   - remove "LFCP Reminders Helper" in System Settings → Privacy & Security → Reminders.

   Deleting the data forgets `bridgeInstanceId`: a later bridge on this Mac is a new bridge, with
   new markers and new lists.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | an internal error |
| 2 | bad arguments, or a command not in this build |
| 3 | a person has to decide or act (a conflict, a hold, an unknown outcome, a failed check) |
| 4 | not found (a section, a binding, a migration) |
| 5 | stopped by STOP or a guard |

## Limits of the MVP

| Limit | What you see |
|---|---|
| One bridge per Apple ID. The marker only detects a second bridge; nothing locks | a second bridge gets `foreign_bridge` |
| Takeover is a procedure (revoke, delete the marker, bind a new list), not a command | [replacing-the-mac.md](replacing-the-mac.md) |
| The bridge never deletes reminders | Tasks that leave the filter stay in the list |
| The bridge never moves or deletes alarms | a warning when an alarm stays on the old date |
| Clearing a due date that has a personal time or alarm is not written | a conflict |
| A write to Reminders with an unknown outcome is never repeated by itself | quarantine, a person decides |
| Writes to Reminders only after the verification run, per helper version and macOS | dry run until then |
| N8 only from complete quiescence; it aborts if work appears during the pairing | "wait for the synchronisation", "run sections add again later" |
| Import stops when a new reminder could match more than one pending Task | hold `import_ambiguous` |
| A reminder you made recurring locks the Task's status, completion date and due | journal entries |
| An existing list is never adopted (no `--adopt-list`); after a takeover the old reminders stay personal | rename the old list; Tasks appear in the new one |
| An unknown outcome while creating a list or a marker needs a choice by id | `bind --resolve-list` / `--resolve-marker` |
| Not in the MVP: relinking unlinked Tasks, deleting reminders automatically, tags, scheduled dates, assignment from Reminders | — |
