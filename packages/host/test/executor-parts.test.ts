// The executor's parts that need no transport (D-010 PR 7): the one table
// of effect permissions (§7.1, r3 P2-4), intents in bridge.sqlite (§5.6),
// runs and Safe Mode (§7.3), limits in a sliding window (§7.2).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type BridgeDatabase,
  type EffectContext,
  Holds,
  Intents,
  Journal,
  Limits,
  type NewIntent,
  OpenIntentExistsError,
  openBridgeDatabase,
  permits,
  Runs,
  ulid,
} from "../src/index.js";

let dir: string;
let db: BridgeDatabase;
const T0 = Date.parse("2026-11-10T10:00:00Z");
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-bridge-executor-"));
  db = openBridgeDatabase(join(dir, "bridge.sqlite"));
  const now = new Date(T0).toISOString();
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i', 'd', 'p', 'r', 'l', ?)",
  ).run(now);
  db.prepare(
    "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, state, created_at) VALUES ('b', 'i', 'R', 'apple-reminders', 'fake', 'L', 'active', ?)",
  ).run(now);
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** Everything allowed for a normal to_apple update. */
const ok: EffectContext = {
  mode: "normal",
  effect: "apple_update",
  stopped: false,
  safeMode: false,
  installationActive: true,
  bindingState: "active",
  verificationBinding: false,
  holds: [],
  transportOk: true,
  listPresent: true,
  ownershipChecked: true,
  foreignMarker: false,
  accessCheckedNow: true,
  offlineCommitAllowed: true,
  connected: true,
  writesVerified: true,
};

describe("permits (§7.1, r3 P2-4: one table)", () => {
  it("normal to_apple: every condition of §7.1, access_checked_now and writesVerified included", () => {
    expect(permits(ok)).toEqual([]);
    const each: [Partial<EffectContext>, string][] = [
      [{ stopped: true }, "stopped"],
      [{ safeMode: true }, "safe_mode"],
      [{ installationActive: false }, "installation_not_active"],
      [{ bindingState: "pending_dry_run" }, "binding_state"],
      [{ holds: ["migration"] }, "hold"],
      [{ transportOk: false }, "transport_not_ok"],
      [{ listPresent: false }, "list_missing"],
      [{ ownershipChecked: false }, "ownership_not_checked"],
      [{ accessCheckedNow: false }, "access_not_checked"],
      [{ writesVerified: false }, "writes_not_verified"],
      [{ verificationBinding: true }, "not_verification_binding"],
    ];
    for (const [change, denial] of each)
      expect([denial, permits({ ...ok, ...change })]).toEqual([denial, [denial]]);
  });

  it("to_lfcp: access_checked_now, or offline_commit_allowed without a connection", () => {
    const lfcp = {
      ...ok,
      effect: "lfcp_commit" as const,
      transportOk: false,
      listPresent: false,
      writesVerified: false,
    };
    expect(permits(lfcp)).toEqual([]);
    expect(permits({ ...lfcp, accessCheckedNow: false, connected: false })).toEqual([]);
    expect(permits({ ...lfcp, accessCheckedNow: false, connected: true })).toEqual([
      "access_not_checked",
    ]);
    expect(
      permits({ ...lfcp, accessCheckedNow: false, connected: false, offlineCommitAllowed: false }),
    ).toEqual(["access_not_checked"]);
  });

  it("verification: its own binding only, no writesVerified gate", () => {
    const v = {
      ...ok,
      mode: "verification" as const,
      verificationBinding: true,
      writesVerified: false,
    };
    expect(permits(v)).toEqual([]);
    expect(permits({ ...v, verificationBinding: false })).toEqual(["not_verification_binding"]);
    expect(permits({ ...v, stopped: true, holds: ["foreign_bridge"] })).toEqual([
      "stopped",
      "hold",
    ]);
  });

  it("bootstrap: only list and marker, STOP / TCC / foreign marker apply, no ownership needed yet", () => {
    const b = {
      ...ok,
      mode: "bootstrap" as const,
      effect: "list_create" as const,
      bindingState: "bootstrapping" as const,
      ownershipChecked: false,
      accessCheckedNow: false,
      listPresent: undefined,
    };
    expect(permits(b)).toEqual([]);
    expect(permits({ ...b, effect: "marker_create" })).toEqual(["list_missing"]);
    expect(permits({ ...b, effect: "marker_create", listPresent: true })).toEqual([]);
    expect(permits({ ...b, foreignMarker: true })).toEqual(["foreign_marker"]);
    expect(permits({ ...b, transportOk: false, stopped: true })).toEqual([
      "stopped",
      "transport_not_ok",
    ]);
    expect(permits({ ...b, effect: "apple_update" })).toContain("effect_not_allowed_in_mode");
  });

  it("unbind: only the marker's retirement; holds do not stop it, STOP and Safe Mode do", () => {
    const u = {
      ...ok,
      mode: "unbind" as const,
      effect: "marker_retire" as const,
      holds: ["ownership_lost"],
      accessCheckedNow: false,
    };
    expect(permits(u)).toEqual([]);
    expect(permits({ ...u, safeMode: true })).toEqual(["safe_mode"]);
    expect(permits({ ...u, effect: "apple_create" })).toContain("effect_not_allowed_in_mode");
    expect(permits({ ...u, bindingState: "removed" })).toEqual(["binding_state"]);
  });
});

const newIntent = (task: string, over: Partial<NewIntent> = {}): NewIntent => ({
  bindingId: "b",
  taskId: task,
  installationId: "i",
  direction: "to_apple",
  kind: "update",
  fields: ["title"],
  basis: { rev: "r1" },
  payload: { kind: "update", set: { title: "x" } },
  ...over,
});

describe("Intents (§5.6)", () => {
  it("ULIDs sort by time; prepare is durable with brg1:<id>; one open intent per Task and direction", () => {
    expect(ulid(T0)).toHaveLength(26);
    expect(ulid(T0) < ulid(T0 + 1)).toBe(true);
    const intents = new Intents(db, () => T0);
    const a = intents.prepare(newIntent("T1"));
    expect(a).toMatchObject({ state: "prepared", operationId: `brg1:${a.id}`, attempts: 0 });
    expect(() => intents.prepare(newIntent("T1"))).toThrow(OpenIntentExistsError);
    intents.prepare(newIntent("T1", { direction: "to_lfcp", kind: "update_task" }));
    intents.effecting(a.id);
    expect(intents.get(a.id)).toMatchObject({ state: "effecting", attempts: 1 });
    expect(() => intents.effecting(a.id)).toThrow();
    intents.applied(a.id, { rev: "r2" });
    intents.finalized(a.id);
    expect(intents.get(a.id)).toMatchObject({ state: "finalized", result: { rev: "r2" } });
    // Closed: a new intent of the same Task may be prepared.
    expect(intents.prepare(newIntent("T1")).state).toBe("prepared");
    expect(
      intents
        .open()
        .map((i) => i.direction)
        .sort(),
    ).toEqual(["to_apple", "to_lfcp"]);
  });
});

describe("Runs and Safe Mode (§7.3)", () => {
  it("two crashed runs less than 10 minutes apart: Safe Mode; a clean run in between: none", () => {
    let t = T0;
    const runs = () => new Runs(db, () => t, 1);
    const first = runs().start();
    expect(first.safeMode).toBeUndefined();
    runs().end(first.runId);
    t += 60_000;
    runs().start(); // crashes
    t += 60_000;
    expect(runs().start().safeMode).toBeUndefined(); // one crash so far; this one crashes too
    t += 60_000;
    const fourth = runs().start();
    expect(fourth.safeMode?.reason).toMatch(/two crashed runs/);
    // It stays until turned off, even after a clean run.
    runs().end(fourth.runId);
    expect(runs().start().safeMode).toBeDefined();
    expect(runs().safeModeOff()).toBe(true);
    expect(runs().safeMode()).toBeUndefined();
    expect(new Journal(db).list().map((e) => e.key)).toEqual(["safe_mode.on", "safe_mode.off"]);
  });

  it("two crashes far apart: no Safe Mode", () => {
    let t = T0;
    const runs = () => new Runs(db, () => t, 1);
    runs().start();
    t += 11 * 60_000;
    runs().start();
    t += 60_000;
    expect(runs().start().safeMode).toBeUndefined();
  });
});

describe("Limits (r2 §7.2)", () => {
  let linked = 0;
  const links = (n: number) => {
    for (let k = linked; k < linked + n; k++)
      db.prepare(
        "INSERT INTO links (binding_id, task_id, origin, state, created_at, updated_at) VALUES ('b', ?, 'lfcp', 'linked', ?, ?)",
      ).run(`L${k}`, new Date(T0).toISOString(), new Date(T0).toISOString());
    linked += n;
  };
  const imp = (task: string) =>
    newIntent(task, { direction: "to_lfcp", kind: "create_task", fields: ["title"] });
  const unlink = (t: number) =>
    new Journal(db, () => t).append("info", "link.out_of_filter", { bindingId: "b" });

  it("unlinks: > max(3, 10 % of the links) in the window; in strict > 1", () => {
    let t = T0;
    const limits = new Limits(db, undefined, () => t);
    unlink(t);
    unlink(t);
    expect(limits.admit("b", { intents: [], unlinks: 1 })).toEqual({ ok: true });
    expect(limits.admit("b", { intents: [], unlinks: 2 })).toMatchObject({
      ok: false,
      holds: ["guard_mass_unlink"],
    });
    new Holds(db).lift("b", "guard_mass_unlink");
    links(50); // 10 % of 50 = 5
    expect(limits.admit("b", { intents: [], unlinks: 3 }).ok).toBe(true);
    expect(limits.admit("b", { intents: [], unlinks: 4 }).ok).toBe(false);
    new Holds(db).lift("b", "guard_mass_unlink");
    // An hour later the window has moved.
    t += 3_600_001;
    expect(limits.admit("b", { intents: [], unlinks: 5 }).ok).toBe(true);
    // Strict: 24 h after approve.
    db.prepare("UPDATE bindings SET strict_until = ?").run(new Date(t + 86_400_000).toISOString());
    expect(limits.strict("b")).toBe(true);
    expect(limits.admit("b", { intents: [], unlinks: 1 }).ok).toBe(true);
    expect(limits.admit("b", { intents: [], unlinks: 2 }).ok).toBe(false);
  });

  it("imports: > 10 an hour, counting the prepared ones; in strict the same (E16)", () => {
    const limits = new Limits(db, undefined, () => T0);
    const intents = new Intents(db, () => T0);
    for (let k = 0; k < 10; k++) intents.prepare(imp(`T${k}`));
    expect(limits.admit("b", { intents: [], unlinks: 0 }).ok).toBe(true);
    expect(limits.admit("b", { intents: [imp("X")], unlinks: 0 })).toMatchObject({
      ok: false,
      holds: ["guard_mass_import"],
    });
    expect(db.prepare("SELECT count(*) AS n FROM intents").get()).toEqual({ n: 10 });
    db.prepare("DELETE FROM intents").run();
    new Holds(db).lift("b", "guard_mass_import");
    db.prepare("UPDATE bindings SET strict_until = ?").run(new Date(T0 + 1000).toISOString());
    const n = (k: number) => Array.from({ length: k }, (_, j) => imp(`S${j}`));
    expect(limits.admit("b", { intents: n(10), unlinks: 0 }).ok).toBe(true);
    expect(limits.admit("b", { intents: n(11), unlinks: 0 }).ok).toBe(false);
  });

  it("review PR 9b #24: one accept lets one anomaly through, not the next; no hold, no acceptance; all guards or none", () => {
    let t = T0;
    const limits = new Limits(db, undefined, () => t);
    const intents = new Intents(db, () => t);
    const holds = new Holds(db, () => t);
    for (let k = 0; k < 10; k++) intents.prepare(imp(`H${k}`));
    t += 1000;
    expect(limits.admit("b", { intents: [imp("X")], unlinks: 0 })).toMatchObject({
      ok: false,
      holds: ["guard_mass_import"],
    });
    t += 1000;
    expect(holds.accept("b", "guard_mass_import")).toBe(true);
    t += 1000;
    // The accepted anomaly ({X}) comes again: the acceptance is consumed with it (A§7.1).
    expect(limits.admit("b", { intents: [imp("X")], unlinks: 0 })).toEqual({
      ok: true,
      accepted: ["guard_mass_import"],
    });
    expect(holds.hasAccepted("b", "guard_mass_import")).toBe(false);
    intents.prepare(imp("X"));
    t += 1000;
    const eleven = Array.from({ length: 11 }, (_, k) => imp(`N${k}`));
    expect(limits.admit("b", { intents: eleven, unlinks: 0 })).toMatchObject({
      ok: false,
      holds: ["guard_mass_import"],
    });
    // Accept with no such hold: nothing kept for later.
    expect(holds.accept("b", "guard_mass_unlink")).toBe(false);
    expect(holds.hasAccepted("b", "guard_mass_unlink")).toBe(false);
    // Two guards, one accepted: held, and the acceptance is not used up meanwhile.
    expect(holds.accept("b", "guard_mass_import")).toBe(true);
    // The count drop's links (A§7.1: what it holds).
    const uncounted = { apple: ["L0", "L1", "L2"], lfcp: [] };
    const both = limits.admit("b", { intents: eleven, unlinks: 0, uncounted }, [
      "guard_count_drop",
    ]);
    expect(both).toMatchObject({ ok: false, holds: ["guard_count_drop"] });
    expect(holds.hasAccepted("b", "guard_mass_import")).toBe(true);
    expect(holds.accept("b", "guard_count_drop")).toBe(true);
    expect(
      limits.admit("b", { intents: eleven, unlinks: 0, uncounted }, ["guard_count_drop"]),
    ).toMatchObject({
      ok: true,
    });
    expect(holds.hasAccepted("b", "guard_mass_import")).toBe(false);
  });

  it("status: > 50 % of the links in one pass, only from 6 links; backlog > 200; count drop > 50 % from 5", () => {
    const limits = new Limits(db, undefined, () => T0);
    const status = (task: string) => newIntent(task, { fields: ["completed"] });
    links(5);
    expect(
      limits.admit("b", { intents: ["A", "B", "C", "D", "E"].map(status), unlinks: 0 }).ok,
    ).toBe(true);
    links(1); // 6 links: at most 3
    expect(limits.admit("b", { intents: ["A", "B", "C"].map(status), unlinks: 0 }).ok).toBe(true);
    expect(
      limits.admit("b", { intents: ["A", "B", "C", "D"].map(status), unlinks: 0 }),
    ).toMatchObject({
      ok: false,
      holds: ["guard_mass_status"],
    });
    new Holds(db).lift("b", "guard_mass_status");
    const many = Array.from({ length: 201 }, (_, k) => newIntent(`B${k}`, { fields: ["title"] }));
    expect(limits.admit("b", { intents: many, unlinks: 0 })).toMatchObject({
      ok: false,
      holds: ["guard_backlog"],
    });
    expect(limits.countDrop("b", "apple", 4, 0)).toBe(false);
    expect(limits.countDrop("b", "apple", 5, 3)).toBe(false);
    expect(limits.countDrop("b", "lfcp", 5, 2)).toBe(true);
    expect(new Holds(db).has("b", "guard_count_drop")).toBe(true);
    const [entry] = new Journal(db).list({ minLevel: "error" }).slice(-1);
    expect(entry?.text).toMatch(/Usually the filter got narrower/);
  });
});

describe("A§8: one table of limits (E16), each row at its boundaries", () => {
  let t = T0;
  const at = (ms: number) => new Date(ms).toISOString();
  const limits = () => new Limits(db, undefined, () => t);
  const fires = (planned: Parameters<Limits["check"]>[1], reason: string) => {
    const a = limits().check("b", planned);
    return !a.ok && a.holds.includes(reason as never);
  };
  const links = (n: number) => {
    db.prepare("DELETE FROM links").run();
    for (let k = 0; k < n; k++)
      db.prepare(
        "INSERT INTO links (binding_id, task_id, origin, state, created_at, updated_at) VALUES ('b', ?, 'lfcp', 'linked', ?, ?)",
      ).run(`K${k}`, at(T0), at(T0));
  };
  const journal = (ms: number, key: string, params: Record<string, unknown> = {}) =>
    new Journal(db, () => ms).append("info", key, { bindingId: "b", params });
  const strict = (until: number) =>
    db.prepare("UPDATE bindings SET strict_until = ?").run(at(until));
  const imp = (task: string) =>
    newIntent(task, { direction: "to_lfcp", kind: "create_task", fields: ["title"] });
  const prepared = (ms: number, intents: NewIntent[]) => {
    const i = new Intents(db, () => ms);
    for (const n of intents) i.prepare(n);
  };
  beforeEach(() => {
    t = T0;
  });

  it("unlinks: > max(3, 10 % linked); measure — the journal's unlink keys, not the accepted ones, + the plan", () => {
    links(20);
    expect(fires({ intents: [], unlinks: 3 }, "guard_mass_unlink")).toBe(false);
    expect(fires({ intents: [], unlinks: 4 }, "guard_mass_unlink")).toBe(true);
    links(40); // 10 % = 4
    expect(fires({ intents: [], unlinks: 4 }, "guard_mass_unlink")).toBe(false);
    expect(fires({ intents: [], unlinks: 5 }, "guard_mass_unlink")).toBe(true);
    // Every unlink key counts (out_of_filter, task_gone included); other keys and accepted ones do not.
    journal(t, "link.unlinked");
    journal(t, "link.out_of_filter");
    journal(t, "link.task_gone");
    journal(t, "link.relinked");
    journal(t, "link.unlinked", { accepted: true });
    expect(fires({ intents: [], unlinks: 1 }, "guard_mass_unlink")).toBe(false);
    expect(fires({ intents: [], unlinks: 2 }, "guard_mass_unlink")).toBe(true);
  });

  it("unlinks: the window is 1 h; strict (first 24 h) > 1; after acceptedAt only what came later", () => {
    links(20);
    journal(t - 3_600_000, "link.unlinked"); // exactly 1 h ago: out
    expect(fires({ intents: [], unlinks: 3 }, "guard_mass_unlink")).toBe(false);
    journal(t - 3_599_999, "link.unlinked"); // just inside
    expect(fires({ intents: [], unlinks: 3 }, "guard_mass_unlink")).toBe(true);
    // The 24 h boundary: strict while strict_until is ahead.
    db.prepare("DELETE FROM journal").run();
    strict(t + 1);
    expect(limits().strict("b")).toBe(true);
    expect(fires({ intents: [], unlinks: 1 }, "guard_mass_unlink")).toBe(false);
    expect(fires({ intents: [], unlinks: 2 }, "guard_mass_unlink")).toBe(true);
    strict(t);
    expect(limits().strict("b")).toBe(false);
    expect(fires({ intents: [], unlinks: 3 }, "guard_mass_unlink")).toBe(false);
    // After acceptance: the window starts at acceptedAt.
    journal(t - 60_000, "link.unlinked");
    journal(t - 60_000, "link.unlinked");
    expect(fires({ intents: [], unlinks: 2 }, "guard_mass_unlink")).toBe(true);
    new Holds(db).markAccepted("b", "guard_mass_unlink", at(t - 30_000));
    expect(fires({ intents: [], unlinks: 3 }, "guard_mass_unlink")).toBe(false);
    journal(t - 10_000, "link.unlinked");
    expect(fires({ intents: [], unlinks: 3 }, "guard_mass_unlink")).toBe(true);
  });

  it("imports: > 10 in 1 h, in the first 24 h too (E16); measure — to_lfcp create_task only; after acceptedAt", () => {
    const plan = (k: number) => Array.from({ length: k }, (_, j) => imp(`P${j}`));
    for (const s of [t - 1, t + 86_400_000]) {
      strict(s);
      expect(fires({ intents: plan(10), unlinks: 0 }, "guard_mass_import")).toBe(false);
      expect(fires({ intents: plan(11), unlinks: 0 }, "guard_mass_import")).toBe(true);
    }
    // Not imports: new reminders (to_apple create) and updates.
    const creates = Array.from({ length: 11 }, (_, j) =>
      newIntent(`C${j}`, { kind: "create", fields: ["title"] }),
    );
    expect(limits().check("b", { intents: creates, unlinks: 0 })).toEqual({ ok: true });
    const updates = Array.from({ length: 11 }, (_, j) =>
      newIntent(`U${j}`, { direction: "to_lfcp", kind: "update_task" }),
    );
    expect(fires({ intents: updates, unlinks: 0 }, "guard_mass_import")).toBe(false);
    // The window: prepared exactly 1 h ago is out, just inside counts.
    prepared(t - 3_600_000, [imp("W0")]);
    expect(fires({ intents: plan(10), unlinks: 0 }, "guard_mass_import")).toBe(false);
    prepared(t - 3_599_999, [imp("W1")]);
    expect(fires({ intents: plan(10), unlinks: 0 }, "guard_mass_import")).toBe(true);
    // A dry run's imports beyond its intents count too.
    expect(fires({ intents: plan(8), unlinks: 0, imports: 1 }, "guard_mass_import")).toBe(false);
    expect(fires({ intents: plan(9), unlinks: 0, imports: 1 }, "guard_mass_import")).toBe(true);
    // After acceptance: only what came after acceptedAt.
    new Holds(db).markAccepted("b", "guard_mass_import", at(t - 1000));
    expect(fires({ intents: plan(10), unlinks: 0 }, "guard_mass_import")).toBe(false);
  });

  it("status: > 50 % linked at ≥ 6 links, this plan only (no window), strict the same", () => {
    const status = (k: number, field = "completed") =>
      Array.from({ length: k }, (_, j) => newIntent(`S${j}`, { fields: [field] }));
    links(5);
    expect(fires({ intents: status(5), unlinks: 0 }, "guard_mass_status")).toBe(false);
    links(6);
    for (const s of [t - 1, t + 86_400_000]) {
      strict(s);
      expect(fires({ intents: status(3), unlinks: 0 }, "guard_mass_status")).toBe(false);
      expect(fires({ intents: status(4), unlinks: 0 }, "guard_mass_status")).toBe(true);
    }
    // Every status field counts; others do not.
    expect(fires({ intents: status(4, "status"), unlinks: 0 }, "guard_mass_status")).toBe(true);
    expect(fires({ intents: status(4, "completion_date"), unlinks: 0 }, "guard_mass_status")).toBe(
      true,
    );
    expect(fires({ intents: status(4, "title"), unlinks: 0 }, "guard_mass_status")).toBe(false);
    // No window: status intents prepared a minute ago do not count.
    prepared(t - 60_000, status(3));
    expect(fires({ intents: [], unlinks: 0 }, "guard_mass_status")).toBe(false);
  });

  it("count drop: `linked` of one side, previous pass → this one, > 50 % from ≥ 5 (no window)", () => {
    const l = limits();
    expect(l.wouldDrop(4, 0)).toBe(false);
    expect(l.wouldDrop(5, 3)).toBe(false);
    expect(l.wouldDrop(5, 2)).toBe(true);
    expect(l.wouldDrop(6, 3)).toBe(false);
    expect(l.wouldDrop(6, 2)).toBe(true);
    strict(t + 86_400_000);
    expect(l.wouldDrop(6, 3)).toBe(false);
  });

  it("backlog: open intents now + the plan > 200 (no window); finalized ones do not count", () => {
    const many = (k: number, p: string) =>
      Array.from({ length: k }, (_, j) => newIntent(`${p}${j}`, { fields: ["title"] }));
    prepared(t - 86_400_000, many(150, "O"));
    expect(fires({ intents: many(50, "N"), unlinks: 0 }, "guard_backlog")).toBe(false);
    expect(fires({ intents: many(51, "N"), unlinks: 0 }, "guard_backlog")).toBe(true);
    db.prepare("UPDATE intents SET state = 'finalized' WHERE task_id = 'O0'").run();
    expect(fires({ intents: many(51, "N"), unlinks: 0 }, "guard_backlog")).toBe(false);
  });
});
