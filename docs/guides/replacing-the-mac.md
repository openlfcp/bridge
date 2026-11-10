# Replacing the Mac that runs the bridge

One bridge per Apple ID (D-010 r4 §6.5, B16). Each bound Reminders list carries a completed reminder
**"LFCP bridge · не удалять"**: the ownership marker of the bridge that created it. The marker only
**detects** a second bridge. When a bridge sees another bridge's marker for the same section, it stops
writing (hold `foreign_bridge`). It does not lock anything, so do not run two bridges on one Apple ID.

There is no "take over the old list" (`--adopt-list` does not exist, B17). The new Mac binds the
section to a **new** list. The reminders of the old list stay yours, as personal reminders, without
synchronisation.

## Steps

1. **Revoke the old bridge** in the Obsidian plugin, in the device list of the section: "Reminders bridge
   (…)". If the old Mac still runs, its bridge goes read-only (`revoked`).
2. **Delete the old marker** in Reminders. Show completed reminders in the old list
   "LFCP · <section>", delete "LFCP bridge · не удалять". If the old bridge is still running, it sees its
   marker gone and stops (`ownership_lost`); it never re-creates the marker by itself.
3. **Rename the old list**, for example to "<section> (old)". The new bridge never adopts a list by its
   title. While a list "LFCP · <section>" exists, `bind` refuses with `list_exists`.
4. On the new Mac: `lfcp-bridge pair` (the link from the plugin), then `lfcp-bridge bind <section>`,
   `lfcp-bridge dry-run`, `lfcp-bridge approve`.

`lfcp-bridge doctor` names whatever still blocks: a foreign marker, a missing list, a bootstrap waiting
for a decision.

## When `bind` says the outcome is unknown

If the connection to Reminders broke while the list was being created, the bridge cannot know whether
the list exists. It does not guess by the title. It prints the lists with that title and waits:

    lfcp-bridge bind --binding <id> --resolve-list <list id>   # this is the list the bridge created
    lfcp-bridge bind --binding <id> --resolve-list none        # none of them: create it again

For `none`, rename the lists with that title first. For an unknown ownership marker, check Reminders,
then run `lfcp-bridge bind --binding <id> --retry-marker`.
