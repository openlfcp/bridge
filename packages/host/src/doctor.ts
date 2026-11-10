// `lfcp-bridge doctor`: the preflight checks of D-010 r4 §7.4, read-only (it changes nothing; the
// TCC request is a separate, explicit `doctor --request-access`).

import { existsSync } from "node:fs";
import type { RemindersTransport } from "@openlfcp/bridge-reminders/transport";
import type { BridgeDatabase } from "./db/database.js";
import { SCHEMA_VERSION, schemaVersion } from "./db/database.js";
import { stopState } from "./db/stop.js";
import { inspectMarkers } from "./ownership.js";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  readonly name: string;
  readonly status: CheckStatus;
  readonly detail: string;
}

export interface DoctorDeps {
  readonly db: BridgeDatabase;
  /** The bridge home (STOP lives there). */
  readonly home: string;
  readonly helperApp: string;
  readonly instanceId: string;
  /** Opened transport, when the helper could be started. */
  readonly transport?: RemindersTransport;
  /** codesign --verify of the helper app (injected; false when it fails). */
  readonly verifySignature?: (app: string) => boolean;
  readonly now?: () => number;
}

interface BindingRow {
  id: string;
  resource_id: string;
  target_ref: string | null;
  target_title: string | null;
  state: string;
}

const DAY = 86_400_000;

export async function doctor(d: DoctorDeps): Promise<readonly Check[]> {
  const out: Check[] = [];
  const add = (name: string, status: CheckStatus, detail: string) =>
    out.push({ name, status, detail });
  const now = (d.now ?? Date.now)();

  const v = schemaVersion(d.db);
  add(
    "database",
    v === SCHEMA_VERSION ? "ok" : "fail",
    `bridge.sqlite schema ${v} (this build: ${SCHEMA_VERSION})`,
  );

  add(
    "stop",
    stopState(d.home) === undefined ? "ok" : "warn",
    stopState(d.home) === undefined
      ? "no STOP"
      : "STOP is set: no effect runs until `lfcp-bridge resume`",
  );

  const installations = d.db.prepare("SELECT id, dir, status FROM installations").all() as {
    id: string;
    dir: string;
    status: string;
  }[];
  for (const i of installations.filter((x) => x.status === "active" || x.status === "frozen"))
    add(
      `installation ${i.id}`,
      existsSync(i.dir) ? "ok" : "fail",
      existsSync(i.dir) ? i.dir : `state directory missing: ${i.dir}`,
    );
  if (installations.length === 0)
    add("installations", "warn", "no installation yet: run `lfcp-bridge pair`");

  if (!existsSync(d.helperApp))
    add("helper", "fail", `LFCP Reminders Helper.app not found at ${d.helperApp}`);
  else if (d.verifySignature !== undefined && !d.verifySignature(d.helperApp))
    add("helper", "fail", `the signature of ${d.helperApp} does not verify`);
  else add("helper", "ok", d.helperApp);

  const t = d.transport;
  if (t === undefined) add("reminders access", "fail", "the helper could not be started");
  else {
    const s = t.status();
    add(
      "reminders access",
      s.state === "ok" ? "ok" : "fail",
      s.state === "ok"
        ? "full access"
        : `${s.reason}: System Settings → Privacy & Security → Reminders (doctor --request-access asks)`,
    );
  }

  const bindings = d.db
    .prepare(
      "SELECT id, resource_id, target_ref, target_title, state FROM bindings WHERE state <> 'removed' ORDER BY id",
    )
    .all() as BindingRow[];
  let lists: ReadonlySet<string> | undefined;
  if (t !== undefined && t.status().state === "ok") {
    const l = await t.lists().catch(() => undefined);
    if (l?.complete) lists = new Set(l.lists.map((x) => x.id));
  }
  for (const b of bindings) {
    const name = `binding ${b.id}`;
    if (b.state === "bootstrapping") {
      const unknown = d.db
        .prepare(
          "SELECT step FROM bootstrap_ops WHERE binding_id = ? AND state = 'unknown_outcome'",
        )
        .all(b.id) as { step: string }[];
      add(
        name,
        "warn",
        unknown.length > 0
          ? `bootstrap waits for a person: unknown ${unknown.map((u) => u.step).join(", ")} (bind --resolve-list / --retry-marker)`
          : "bootstrap not finished: `lfcp-bridge bind` continues it",
      );
      continue;
    }
    if (lists !== undefined && b.target_ref !== null && !lists.has(b.target_ref)) {
      add(name, "fail", `its list "${b.target_title}" (${b.target_ref}) is gone`);
      continue;
    }
    if (t !== undefined && lists !== undefined) {
      const m = await inspectMarkers(t, d.instanceId, b.resource_id, true);
      if (m.state === "foreign") {
        add(name, "fail", `another bridge marks this section (${m.instances.join(", ")})`);
        continue;
      }
      if (m.state === "lost") {
        add(name, "fail", "this bridge's marker is gone (ownership_lost)");
        continue;
      }
    }
    const holds = d.db
      .prepare("SELECT reason FROM binding_holds WHERE binding_id = ? ORDER BY reason")
      .all(b.id) as { reason: string }[];
    add(
      name,
      holds.length > 0 ? "warn" : "ok",
      holds.length > 0
        ? `holds: ${holds.map((h) => h.reason).join(", ")}`
        : `${b.state}, "${b.target_title}"`,
    );
  }

  const stale = d.db
    .prepare(
      "SELECT id, state, created_at FROM intents WHERE state IN ('prepared','effecting','applied')",
    )
    .all() as { id: string; state: string; created_at: string }[];
  const old = stale.filter((i) => now - Date.parse(i.created_at) > DAY);
  add(
    "intents",
    old.length > 0 ? "warn" : "ok",
    old.length > 0 ? `${old.length} open intent(s) older than a day` : `${stale.length} open`,
  );

  const migrations = d.db
    .prepare(
      "SELECT id, phase, blocked_reason FROM migrations WHERE phase NOT IN ('done','aborted')",
    )
    .all() as { id: string; phase: string; blocked_reason: string | null }[];
  add(
    "migrations",
    migrations.length > 0 ? "warn" : "ok",
    migrations.length > 0
      ? migrations
          .map((m) => `${m.id} in ${m.phase}${m.blocked_reason ? ` (${m.blocked_reason})` : ""}`)
          .join("; ")
      : "none unfinished",
  );

  return out;
}

export const worst = (checks: readonly Check[]): CheckStatus =>
  checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";
