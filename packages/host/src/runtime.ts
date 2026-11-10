// What the CLI commands of PR 9 use, assembled for the real machine: paths and config (§2.2),
// bridge.sqlite, the EventKit transport over the helper app with its durable stages in
// transport_state, and section names resolved through the pairing journal (G1 fallback).
// Tests pass their own Runtime.

import { execFileSync } from "node:child_process";
import type { DurableKV } from "@openlfcp/bridge-reminders/transport";
import { EventKitTransport } from "@openlfcp/bridge-transport-eventkit";
import { toHex } from "@openlfcp/core";
import { type BootstrapTransport, LIST_PREFIX, VERIFY_PREFIX } from "./bootstrap.js";
import { type BridgeConfig, type BridgePaths, bridgePaths, loadConfig } from "./config.js";
import { type BridgeDatabase, openBridgeDatabase } from "./db/database.js";
import { Holds } from "./db/holds.js";
import { Journal } from "./db/journal.js";
import { type Launchctl, launchctl } from "./launchd.js";
import { openNodeInstallation } from "./lfcp/fallback/node-installation.js";
import { pairedSections } from "./lfcp/fallback/paired-sections.js";
import type { MigrationPorts } from "./migration.js";

export interface ResolvedSection {
  readonly installationId: string;
  readonly resourceId: string;
  readonly title: string;
}

export interface Runtime {
  readonly paths: BridgePaths;
  readonly db: BridgeDatabase;
  readonly config: BridgeConfig;
  readonly journal: Journal;
  readonly holds: Holds;
  /** The started transport (helper write mode off; the bootstrap switches it). */
  openTransport(): Promise<BootstrapTransport>;
  resolveSection(name: string): Promise<ResolvedSection | undefined>;
  readonly launchctl: Launchctl;
  readonly node: string;
  readonly cli: string;
  readonly verifySignature?: (app: string) => boolean;
  /**
   * What N8 needs from the machine: pairing, the new installation's connection, the old one's
   * close and revocationStatus. Undefined until the run process exists (PR 9 after 8): then
   * `sections add` and `migrate resume` say so; `migrate status` and `abort` work without it.
   */
  readonly migrationPorts?: () => Promise<MigrationPorts>;
  close(): Promise<void>;
}

/** transport_state rows of one transport and installation key, as a DurableKV. */
export class DatabaseKV implements DurableKV {
  constructor(
    private readonly db: BridgeDatabase,
    private readonly transport: string,
    private readonly installationKey: string,
  ) {}
  get(key: string): unknown {
    const r = this.db
      .prepare(
        "SELECT value_json FROM transport_state WHERE transport = ? AND installation_key = ? AND key = ?",
      )
      .get(this.transport, this.installationKey, key) as { value_json: string } | undefined;
    return r === undefined ? undefined : JSON.parse(r.value_json);
  }
  put(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO transport_state (transport, installation_key, key, value_json) VALUES (?, ?, ?, ?)
         ON CONFLICT (transport, installation_key, key) DO UPDATE SET value_json = excluded.value_json`,
      )
      .run(this.transport, this.installationKey, key, JSON.stringify(value));
  }
  delete(key: string): void {
    this.db
      .prepare(
        "DELETE FROM transport_state WHERE transport = ? AND installation_key = ? AND key = ?",
      )
      .run(this.transport, this.installationKey, key);
  }
  keys(prefix = ""): readonly string[] {
    return (
      this.db
        .prepare(
          "SELECT key FROM transport_state WHERE transport = ? AND installation_key = ? AND key LIKE ? ORDER BY key",
        )
        .all(this.transport, this.installationKey, `${prefix.replaceAll("%", "\\%")}%`) as {
        key: string;
      }[]
    ).map((r) => r.key);
  }
}

export async function machineRuntime(env: NodeJS.ProcessEnv = process.env): Promise<Runtime> {
  const paths = bridgePaths(env);
  const db = openBridgeDatabase(paths.database);
  const config = loadConfig(paths.config);
  const journal = new Journal(db);
  const transports: EventKitTransport[] = [];
  return {
    paths,
    db,
    config,
    journal,
    holds: new Holds(db),
    launchctl,
    node: process.execPath,
    cli: process.argv[1] ?? "lfcp-bridge",
    async openTransport() {
      const appPath = config.helperPath ?? paths.helperApp;
      const t = new EventKitTransport({ appPath, writes: "off" });
      transports.push(t);
      const lists = (
        db
          .prepare(
            "SELECT target_ref FROM bindings WHERE state <> 'removed' AND target_ref IS NOT NULL",
          )
          .all() as {
          target_ref: string;
        }[]
      ).map((r) => r.target_ref);
      await t.open({
        installationKey: config.bridgeInstanceId,
        state: new DatabaseKV(db, "eventkit", config.bridgeInstanceId),
        scope: { listTitlePrefixes: [LIST_PREFIX, VERIFY_PREFIX], listIds: lists as never[] },
      });
      return t;
    },
    async resolveSection(name) {
      const installations = db
        .prepare("SELECT id, dir FROM installations WHERE status = 'active' ORDER BY created_at")
        .all() as { id: string; dir: string }[];
      for (const i of installations) {
        const node = await openNodeInstallation(i.dir);
        try {
          const found = (await pairedSections(node.storage)).find((s) => s.name === name);
          if (found !== undefined)
            return { installationId: i.id, resourceId: toHex(found.resource), title: name };
        } finally {
          node.close();
        }
      }
      return undefined;
    },
    verifySignature: (app) => {
      try {
        // codesign --verify exits non-zero on a broken signature.
        execFileSync("codesign", ["--verify", "--strict", app], { stdio: "ignore" });
        return true;
      } catch {
        return false;
      }
    },
    async close() {
      for (const t of transports) await t.close().catch(() => {});
      db.close();
    },
  };
}
