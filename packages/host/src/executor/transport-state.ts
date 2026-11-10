// The DurableKV a transport writes its stages to (D-010 §4.2: `sent` /
// `done` around each external step), as rows of bridge.sqlite's
// transport_state, so that recover(opKey) answers after a restart.

import type { DurableKV } from "@openlfcp/bridge-reminders";
import type { BridgeDatabase } from "../db/database.js";

export function transportStateKV(
  db: BridgeDatabase,
  transport: string,
  installationKey: string,
): DurableKV {
  return {
    get(key) {
      const r = db
        .prepare(
          "SELECT value_json FROM transport_state WHERE transport = ? AND installation_key = ? AND key = ?",
        )
        .get(transport, installationKey, key) as { value_json: string } | undefined;
      return r === undefined ? undefined : (JSON.parse(r.value_json) as unknown);
    },
    put(key, value) {
      db.prepare(
        `INSERT INTO transport_state (transport, installation_key, key, value_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (transport, installation_key, key) DO UPDATE SET value_json = excluded.value_json`,
      ).run(transport, installationKey, key, JSON.stringify(value));
    },
    delete(key) {
      db.prepare(
        "DELETE FROM transport_state WHERE transport = ? AND installation_key = ? AND key = ?",
      ).run(transport, installationKey, key);
    },
    keys(prefix = "") {
      return (
        db
          .prepare(
            "SELECT key FROM transport_state WHERE transport = ? AND installation_key = ? AND substr(key, 1, ?) = ? ORDER BY key",
          )
          .all(transport, installationKey, prefix.length, prefix) as { key: string }[]
      ).map((r) => r.key);
    },
  };
}
