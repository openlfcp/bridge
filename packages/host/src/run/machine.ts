// The run process on the real machine (D-010 r4 §2, PR 9b): what `lfcp-bridge run` opens.
//
// - every active installation: its storage-node state (openNodeInstallation, G3), a SectionHost
//   on its coordinator (the URL of its paired sections, G1), an AccessTracker (§5.3, §5.9) whose
//   revocation check is the SDK's revocationStatus, the person's root (G4) and its Principal;
// - the EventKit transport over the helper, supervised (PR 9, §8.2): helper.pid, an orphan
//   stopped, a ping (access.status) every 30 s, a restart reopens the transport; more than 3
//   restarts within 5 min → hold helper_unavailable on every binding until a person resumes;
// - writesVerified for this helper build and macOS (sw_vers), §7.6.
//
// `installationPorts` is the testable part (a live server in run.live.test.ts); the rest needs
// the helper app and is the owner's verification run (docs/devel/testing/verification-run.md).

import { execFileSync } from "node:child_process";
import {
  EventKitTransport,
  type HelperLink,
  HelperProcess,
} from "@openlfcp/bridge-transport-eventkit";
import { receiptOf, revocationStatus } from "@openlfcp/client";
import { fromHex, type ResourceId, resourceId } from "@openlfcp/core";
import { principalRef } from "@openlfcp/shared-objects";
import { LIST_PREFIX, VERIFY_PREFIX } from "../bootstrap.js";
import type { BridgeConfig, BridgePaths } from "../config.js";
import type { BridgeDatabase } from "../db/database.js";
import { Holds } from "../db/holds.js";
import { Journal } from "../db/journal.js";
import { stopState } from "../db/stop.js";
import { AccessTracker, metaAccessStore } from "../lfcp/access.js";
import { deviceRoot } from "../lfcp/fallback/device-root.js";
import { openNodeInstallation } from "../lfcp/fallback/node-installation.js";
import { pairedSections } from "../lfcp/fallback/paired-sections.js";
import { SectionHost, type SectionHostOptions } from "../lfcp/section-host.js";
import { DatabaseKV } from "../runtime.js";
import { HelperSupervisor } from "../supervisor.js";
import { writesVerified } from "../verification.js";
import { BridgeProcess, type InstallationPorts } from "./process.js";

/** The ports of every active installation; close() closes their storage. */
export async function installationPorts(
  db: BridgeDatabase,
  o: { readonly sectionHost?: Partial<SectionHostOptions>; readonly now?: () => number } = {},
): Promise<{ readonly ports: readonly InstallationPorts[]; close(): void }> {
  const now = o.now ?? Date.now;
  const rows = db
    .prepare("SELECT id, dir FROM installations WHERE status = 'active' ORDER BY created_at")
    .all() as { id: string; dir: string }[];
  const ports: InstallationPorts[] = [];
  const closers: (() => void)[] = [];
  for (const r of rows) {
    const node = await openNodeInstallation(r.dir);
    closers.push(() => node.close());
    const url = (await pairedSections(node.storage))[0]?.url;
    if (url === undefined) continue;
    const host = new SectionHost({
      url,
      installation: node.installation,
      storage: node.storage,
      secrets: node.secrets,
      ...o.sectionHost,
    });
    const access = new AccessTracker({
      source: host,
      store: metaAccessStore(db, r.id),
      checkRevocation: async (resource: ResourceId) => {
        const s = await revocationStatus({ ...node.flow, resource, url });
        return s.kind;
      },
      now,
    });
    const me = node.installation.signer.descriptor.principalId;
    const root = await deviceRoot(node.storage, me);
    ports.push({
      id: r.id,
      host,
      receipt: (resource, op) => receiptOf(node.storage, resource, op),
      access,
      ...(root === undefined ? {} : { me: principalRef(root) }),
      createdBy: me,
      // §5.9: a blocked batch → the access tracker asks revocationStatus.
      onBlocked: (hex) => void access.refused(resourceId(fromHex(hex)), "blocked"),
    });
    closers.push(() => access.close());
  }
  return {
    ports,
    close: () => {
      for (const c of closers.reverse()) c();
    },
  };
}

/** macOS's version (sw_vers), for writesVerified (§7.6); "" elsewhere. */
export function macOSVersion(): string {
  try {
    return execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
}

/** The run process of this machine, started; stop() stops it all. */
export async function machineProcess(o: {
  readonly db: BridgeDatabase;
  readonly config: BridgeConfig;
  readonly paths: BridgePaths;
}): Promise<{ readonly process: BridgeProcess; stop(reason?: string): Promise<void> }> {
  const { db, config, paths } = o;
  const journal = new Journal(db);
  const holds = new Holds(db);
  const appPath = config.helperPath ?? paths.helperApp;
  let current: HelperLink | undefined;
  const transport = new EventKitTransport({
    appPath,
    writes: "off",
    writesVerified: false,
    link: async () => {
      if (current === undefined) throw new Error("the helper is not running");
      return current;
    },
  });
  const lists = (
    db
      .prepare(
        "SELECT target_ref FROM bindings WHERE state <> 'removed' AND target_ref IS NOT NULL",
      )
      .all() as { target_ref: string }[]
  ).map((r) => r.target_ref);
  const openCtx = {
    installationKey: config.bridgeInstanceId,
    state: new DatabaseKV(db, "eventkit", config.bridgeInstanceId),
    scope: { listTitlePrefixes: [LIST_PREFIX, VERIFY_PREFIX], listIds: lists as never[] },
  };
  const supervisor = new HelperSupervisor({
    pidFile: paths.helperPid,
    start: async () => {
      const link = await HelperProcess.start({ appPath });
      current = link;
      return {
        pid: link.ready.pid,
        ping: async () => {
          const r = await link.request("access.status", {}, { timeoutMs: 10_000 });
          if (r.ok !== true) throw new Error("no answer");
        },
        close: () => link.close(),
        onExit: (cb) => link.onExit(cb),
      };
    },
    onRestart: () => {
      void transport.open(openCtx);
    },
    onUnavailable: (reason) => {
      const bound = db
        .prepare("SELECT id FROM bindings WHERE state IN ('pending_dry_run','active')")
        .all() as { id: string }[];
      for (const b of bound)
        if (holds.set(b.id, "helper_unavailable", { reason }))
          journal.append("error", "helper.unavailable", { bindingId: b.id, params: { reason } });
    },
  });
  await supervisor.start();
  await transport.open(openCtx);
  const helper = { helperVersion: current?.ready.helperVersion ?? "", macOS: macOSVersion() };
  const opened = await installationPorts(db);
  const process = new BridgeProcess({
    db,
    transport,
    installations: opened.ports,
    instanceId: config.bridgeInstanceId,
    writesVerified: () => writesVerified(config, helper),
    stopped: () => stopState(paths.home) !== undefined,
  });
  await process.start();
  return {
    process,
    async stop(reason = "exit") {
      await process.stop(reason);
      await transport.close().catch(() => {});
      await supervisor.stop();
      opened.close();
    },
  };
}
