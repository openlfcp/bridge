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
  type WireEvent,
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
import { type HelperIdentity, writesVerified } from "../verification.js";
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
/**
 * The EventKit transport for this helper build and macOS (review PR 9b #29): its capability
 * writesVerified — what the executor's permissions read for a normal binding — is the config's
 * verification record for exactly this helper and macOS (§7.6). The transport is made once the
 * helper answered, when its version is known.
 */
export function eventKitTransportFor(
  config: BridgeConfig,
  helper: HelperIdentity,
  o: { readonly appPath: string; readonly link: () => Promise<HelperLink> },
): EventKitTransport {
  return new EventKitTransport({
    appPath: o.appPath,
    writes: "off",
    writesVerified: writesVerified(config, helper),
    link: o.link,
  });
}

/**
 * The helper came back — the supervisor restarted it, or a person's resume gave it a fresh
 * budget (review PR 9b #33): the transport is opened on the new helper (scope and write mode as
 * they were), then `after` (a full pass: ownership, the open intents settled, the effects). One
 * at a time; a failure is journaled and does not block the next one.
 */
export function helperReconnector(o: {
  readonly supervisor: { resume(): Promise<void> };
  readonly reopen: () => Promise<unknown>;
  readonly after?: () => Promise<unknown>;
  readonly journal?: Journal;
}): { restarted(): Promise<void>; resume(): Promise<void> } {
  let chain: Promise<void> = Promise.resolve();
  const step = (work: () => Promise<void>) => {
    chain = chain.then(work).catch((e) => {
      o.journal?.append("error", "helper.reconnect_failed", {
        params: { error: e instanceof Error ? e.message : String(e) },
      });
    });
    return chain;
  };
  const reconnect = async () => {
    await o.reopen();
    await o.after?.();
  };
  return {
    restarted: () => step(reconnect),
    resume: () =>
      step(async () => {
        await o.supervisor.resume();
        await reconnect();
      }),
  };
}

/**
 * The helper's "stalled" event (a store call passed the helper's deadline; it answered
 * eventkit_timeout and went on with a new store, R-001 live run 2): journal it and restart the
 * helper, so nothing of the stuck call stays around. Other events are not this handler's.
 */
export function helperStallHandler(o: {
  readonly journal: Journal;
  readonly restart: (reason: string) => Promise<void>;
}): (e: WireEvent) => void {
  return (e) => {
    if (e.event !== "stalled") return;
    const op = typeof e.op === "string" ? e.op : "a store call";
    const after = typeof e.timeoutS === "number" ? ` after ${e.timeoutS} s` : "";
    o.journal.append("error", "helper.stalled", {
      params: {
        op,
        text: `The Reminders helper gave up on ${op}${after}: its outcome is unknown. Restarting the helper.`,
      },
    });
    void o.restart(`the helper stalled on ${op}`).catch(() => {});
  };
}

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
  let transport: EventKitTransport | undefined;
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
  const macOS = macOSVersion();
  // The helper of the moment: a restart may bring another build (writesVerified follows it).
  let helper: HelperIdentity = { helperVersion: "", macOS };
  const supervisor = new HelperSupervisor({
    pidFile: paths.helperPid,
    start: async () => {
      // onUnmatched (transport-eventkit #18 on main): a helper line that answers nothing goes to
      // the journal. Passed as a variable: on a base without the option it is simply unused.
      const options = {
        appPath,
        onUnmatched: (line: string) =>
          journal.append("warn", "helper.unmatched", { params: { line: line.slice(0, 200) } }),
      };
      const link = await HelperProcess.start(options);
      current = link;
      helper = { helperVersion: link.ready.helperVersion, macOS };
      const supervised = {
        pid: link.ready.pid,
        ping: async () => {
          const r = await link.request("access.status", {}, { timeoutMs: 10_000 });
          if (r.ok !== true) throw new Error("no answer");
        },
        close: () => link.close(),
        onExit: (cb: (code: number | null) => void) => link.onExit(cb),
      };
      link.onEvent(
        helperStallHandler({
          journal,
          restart: (reason) => supervisor.restartNow(reason, supervised),
        }),
      );
      return supervised;
    },
    onRestart: () => {
      void reconnector.restarted();
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
  let opened: Awaited<ReturnType<typeof installationPorts>> | undefined;
  let process: BridgeProcess | undefined;
  const reconnector = helperReconnector({
    supervisor,
    reopen: async () => {
      if (transport === undefined) throw new Error("no transport yet");
      return transport.open(openCtx);
    },
    after: async () => process?.passAll(),
    journal,
  });
  const release = async () => {
    await transport?.close().catch(() => {});
    await supervisor.stop().catch(() => {});
    opened?.close();
  };
  try {
    await supervisor.start();
    transport = eventKitTransportFor(config, helper, {
      appPath,
      link: async () => {
        if (current === undefined) throw new Error("the helper is not running");
        return current;
      },
    });
    await transport.open(openCtx);
    opened = await installationPorts(db);
    const started = new BridgeProcess({
      db,
      transport,
      installations: opened.ports,
      instanceId: config.bridgeInstanceId,
      // The helper of the moment: another build after a restart is not verified by the old record.
      writesVerified: () => writesVerified(config, helper),
      stopped: () => stopState(paths.home) !== undefined,
      // resume --accept helper_unavailable: the supervisor gets a fresh budget (review PR 9b #28).
      onHoldsLifted: (reasons) => {
        if (reasons.has("helper_unavailable")) void reconnector.resume();
      },
    });
    process = started;
    await started.start();
  } catch (e) {
    await process?.stop("failed to start").catch(() => {});
    await release();
    throw e;
  }
  const running = process;
  return {
    process: running,
    // The helper and the storage are released whatever stop() says (review PR 9b #26).
    async stop(reason = "exit") {
      try {
        await running.stop(reason);
      } finally {
        await release();
      }
    },
  };
}
