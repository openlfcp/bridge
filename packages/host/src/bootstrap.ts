// The bootstrap of a binding (D-010 r4 §6.5, B16, B17): scan → list → marker → done, each step
// durable in bindings.bootstrap_step and bootstrap_ops, with a narrow set of effects allowed before
// the binding is approved: a NEW empty list and this bridge's marker, nothing else (the helper is
// in write mode "bootstrap"; verification bindings use "verification"). STOP, TCC and a foreign
// marker are checked before every effect (review r3 P2-4, bootstrap row).
//
// Unknown outcomes are never bypassed automatically (review PR 6 r2):
// - createList answer lost → recover: done → take its list; not_started → retry the same opKey;
//   unknown → bootstrap_ops.list = unknown_outcome. A person picks the list by id
//   (`bind --resolve-list <id>`) or `none` (rename the lists with that title first, then a new
//   attempt). A title match never assigns a list (B17).
// - marker answer lost → recover the same way; unknown → bootstrap_ops.marker = unknown_outcome,
//   even when a marker with the exact url is visible (B19: only recover=done is accepted). The
//   visible markers are shown as evidence; a person picks one by id (`bind --resolve-marker <id>`)
//   or `none` (delete such markers first, then a new attempt with a new opKey).
// There is no --adopt-list (B17): the bootstrap only binds a list it created.

import { randomUUID } from "node:crypto";
import {
  type AppleItem,
  type AppleOpResult,
  ForbiddenListError,
  ListExistsError,
  type ListInfo,
  type ListRef,
  type RemindersTransport,
} from "@openlfcp/bridge-reminders/transport";
import type { BridgeDatabase } from "./db/database.js";
import type { Journal } from "./db/journal.js";
import { type Denial, type EffectContext, permits } from "./executor/permissions.js";
import { Runs } from "./executor/safe-mode.js";
import { inspectMarkers, markerUrl } from "./ownership.js";

export const LIST_PREFIX = "LFCP · ";
export const VERIFY_PREFIX = "LFCP Verify · ";

export interface BindRequest {
  readonly installationId: string;
  readonly resourceId: string;
  /** The section title: the list is "LFCP · <section>" (verification: "LFCP Verify · <section>"). */
  readonly section: string;
  readonly filter?: "default" | "mine" | "all";
  readonly verification?: boolean;
}

export type BindRefusal =
  | "stop"
  | "transport"
  | "incomplete"
  | "foreign_bridge"
  | "list_exists"
  | "forbidden_list"
  | "already_bound"
  | "marker_exists"
  | "not_unknown"
  /** permits() of PR 7 refused the effect; detail lists its denials. */
  | "denied";

export type BindOutcome =
  | {
      readonly state: "pending_dry_run";
      readonly bindingId: string;
      readonly list: ListRef;
      readonly title: string;
    }
  | {
      readonly state: "refused";
      readonly reason: BindRefusal;
      readonly bindingId?: string;
      readonly detail?: string;
    }
  | {
      readonly state: "unknown_outcome";
      readonly bindingId: string;
      readonly step: "list" | "marker";
      /** Lists with the title the bootstrap tried to create (to choose from by id). */
      readonly candidates?: readonly ListInfo[];
      /** Markers with this binding's exact url in the bound list: evidence, never a result. */
      readonly markers?: readonly AppleItem[];
    };

/** The transport, plus the helper write mode when it has one (EventKit). */
export type BootstrapTransport = RemindersTransport & {
  setWriteMode?: (mode: "off" | "bootstrap" | "verification" | "verified") => Promise<void>;
};

export interface BootstrapDeps {
  readonly db: BridgeDatabase;
  readonly journal: Journal;
  readonly transport: BootstrapTransport;
  readonly instanceId: string;
  /** STOP is present (checked before every effect). */
  readonly stopped: () => boolean;
  readonly now?: () => number;
}

interface BindingRow {
  id: string;
  resource_id: string;
  target_ref: string | null;
  target_title: string | null;
  verification: number;
  state: string;
  bootstrap_step: string | null;
}

interface OpRow {
  client_id: string;
  state: "prepared" | "effecting" | "done" | "unknown_outcome";
  result_json: string | null;
}

/** The first denial that has its own refusal; otherwise "denied" with all of them. */
function refusalOf(denials: readonly Denial[]): Refused {
  if (denials.includes("stopped")) return new Refused("stop", "STOP is set");
  if (denials.includes("foreign_marker"))
    return new Refused("foreign_bridge", "another bridge has this section");
  return new Refused("denied", denials.join(", "));
}

class Refused extends Error {
  constructor(
    readonly reason: BindRefusal,
    readonly detail?: string,
  ) {
    super(`${reason}${detail ? `: ${detail}` : ""}`);
  }
}

export class Bootstrap {
  readonly #d: BootstrapDeps;
  readonly #now: () => number;

  constructor(deps: BootstrapDeps) {
    this.#d = deps;
    this.#now = deps.now ?? Date.now;
  }

  // ---------- public ----------

  async bind(req: BindRequest): Promise<BindOutcome> {
    const existing = this.#d.db
      .prepare(
        "SELECT * FROM bindings WHERE resource_id = ? AND adapter = 'apple-reminders' AND state <> 'removed'",
      )
      .get(req.resourceId) as BindingRow | undefined;
    if (existing !== undefined) {
      if (existing.state === "bootstrapping") return this.resume(existing.id);
      return { state: "refused", reason: "already_bound", bindingId: existing.id };
    }
    const id = `b_${randomUUID().slice(0, 8)}`;
    const title = `${req.verification ? VERIFY_PREFIX : LIST_PREFIX}${req.section}`;
    this.#d.db
      .prepare(
        `INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_title, filter_mode,
           verification, state, bootstrap_step, created_at)
         VALUES (?, ?, ?, 'apple-reminders', ?, ?, ?, ?, 'bootstrapping', 'scan', ?)`,
      )
      .run(
        id,
        req.installationId,
        req.resourceId,
        this.#d.transport.id,
        title,
        req.filter ?? "default",
        req.verification ? 1 : 0,
        this.#iso(),
      );
    return this.resume(id);
  }

  /** Continues a bootstrap from its durable step (after a crash, or after a person resolved). */
  async resume(bindingId: string): Promise<BindOutcome> {
    try {
      for (;;) {
        const b = this.#binding(bindingId);
        switch (b.bootstrap_step) {
          case "scan":
            await this.#scan(b);
            this.#setStep(b.id, "list");
            break;
          case "list": {
            const r = await this.#list(b);
            if (r !== undefined) return r;
            this.#setStep(b.id, "marker");
            break;
          }
          case "marker": {
            const r = await this.#marker(b);
            if (r !== undefined) return r;
            this.#d.db
              .prepare(
                "UPDATE bindings SET bootstrap_step = 'done', state = 'pending_dry_run' WHERE id = ?",
              )
              .run(b.id);
            this.#d.journal.append("info", "bootstrap.done", {
              bindingId: b.id,
              params: { text: `Bound to the Reminders list "${b.target_title}".` },
            });
            break;
          }
          default: {
            const done = this.#binding(bindingId);
            return {
              state: "pending_dry_run",
              bindingId,
              list: done.target_ref as ListRef,
              title: done.target_title ?? "",
            };
          }
        }
      }
    } catch (e) {
      if (!(e instanceof Refused)) throw e;
      const b = this.#binding(bindingId);
      // A bootstrap refused before its list exists leaves nothing behind: the binding is removed.
      if (b.target_ref === null) {
        this.#d.db.prepare("DELETE FROM bootstrap_ops WHERE binding_id = ?").run(bindingId);
        this.#d.db.prepare("UPDATE bindings SET state = 'removed' WHERE id = ?").run(bindingId);
      }
      this.#d.journal.append("warn", `bootstrap.refused.${e.reason}`, {
        bindingId,
        params: { text: `Binding refused: ${e.message}.` },
      });
      return {
        state: "refused",
        reason: e.reason,
        bindingId,
        ...(e.detail ? { detail: e.detail } : {}),
      };
    }
  }

  /**
   * A person decides an unknown createList outcome: the id of the list this bootstrap created, or
   * "none" (no such list: try again, after renaming any list with that title).
   */
  async resolveList(bindingId: string, choice: string): Promise<BindOutcome> {
    const op = this.#op(bindingId, "list");
    if (op?.state !== "unknown_outcome")
      return { state: "refused", reason: "not_unknown", bindingId };
    const b = this.#binding(bindingId);
    const lists = await this.#d.transport.lists();
    if (choice === "none") {
      if (lists.lists.some((l) => l.title === b.target_title))
        return {
          state: "refused",
          reason: "list_exists",
          bindingId,
          detail: `rename the list "${b.target_title}" first`,
        };
      this.#nextAttempt(bindingId, "list", op.client_id);
      this.#d.journal.append("info", "bootstrap.list.resolved", {
        bindingId,
        params: { text: "A person decided no list was created; creating it again." },
      });
      return this.resume(bindingId);
    }
    const list = lists.lists.find((l) => l.id === choice);
    if (list === undefined)
      return { state: "refused", reason: "not_unknown", bindingId, detail: `no list ${choice}` };
    this.#acceptList(bindingId, list, "person");
    this.#setStep(bindingId, "marker");
    return this.resume(bindingId);
  }

  /**
   * A person decides an unknown marker outcome: the id of the marker reminder this bootstrap wrote,
   * or "none" (it wrote none: try again, after deleting any marker with this binding's url).
   */
  async resolveMarker(bindingId: string, choice: string): Promise<BindOutcome> {
    const op = this.#op(bindingId, "marker");
    if (op?.state !== "unknown_outcome")
      return { state: "refused", reason: "not_unknown", bindingId };
    const b = this.#binding(bindingId);
    const found = await this.#markerEvidence(b);
    if (!found.complete)
      return { state: "refused", reason: "incomplete", bindingId, detail: "markers not readable" };
    if (choice === "none") {
      if (found.items.length > 0)
        return {
          state: "refused",
          reason: "marker_exists",
          bindingId,
          detail: `delete the marker ${found.items.map((i) => i.ref.id ?? i.ref.externalId).join(", ")} first, or choose it by id`,
        };
      this.#nextAttempt(bindingId, "marker", op.client_id);
      this.#d.journal.append("info", "bootstrap.marker.resolved", {
        bindingId,
        params: { text: "A person decided no marker was written; writing it again." },
      });
      return this.resume(bindingId);
    }
    const marker = found.items.find((i) => i.ref.id === choice || i.ref.externalId === choice);
    if (marker === undefined)
      return { state: "refused", reason: "not_unknown", bindingId, detail: `no marker ${choice}` };
    this.#doneMarker(bindingId, marker.ref);
    return this.resume(bindingId);
  }

  /** `bind --retry-marker`: the person says no marker was written. */
  retryMarker(bindingId: string): Promise<BindOutcome> {
    return this.resolveMarker(bindingId, "none");
  }

  /**
   * unbind (the unbind column of permits()): STOP and Safe Mode refuse it entirely (nothing
   * changes); holds do not count. When the marker may not be retired (no TCC, the list is gone,
   * ownership not checked) the binding is still removed and the marker stays — `denied` says why.
   * When permitted, the helper's narrow write mode is switched on first (each command opens a
   * transport with writes off, review PR 9 r2 P2-1); a retire the transport refuses is a partial
   * unbind too — `failed` names its code.
   */
  async unbind(bindingId: string): Promise<{
    readonly retired: boolean;
    readonly refused?: readonly Denial[];
    readonly denied?: readonly Denial[];
    readonly failed?: string;
  }> {
    const b = this.#binding(bindingId);
    const denials = permits(await this.#context(b, "unbind", "marker_retire"));
    const blocking = denials.filter((d) => d === "stopped" || d === "safe_mode");
    if (blocking.length > 0) return { retired: false, refused: blocking };
    let retired = false;
    let failed: string | undefined;
    if (denials.length === 0 && b.target_ref !== null) {
      const url = markerUrl(this.#d.instanceId, b.resource_id);
      const found = await this.#d.transport.find({ url }, [b.target_ref as ListRef]);
      const marker = found.items[0];
      if (marker !== undefined) {
        await this.#d.transport.setWriteMode?.(b.verification === 1 ? "verification" : "bootstrap");
        const r = await this.#d.transport.apply({
          opKey: `unbind:${bindingId}:${randomUUID().slice(0, 8)}`,
          kind: "marker_retire",
          ref: marker.ref,
          markerUrl: url,
          expect: { rev: marker.rev },
        });
        retired = r.ok;
        if (!r.ok) failed = r.code;
      }
    }
    this.#d.db.prepare("UPDATE bindings SET state = 'removed' WHERE id = ?").run(bindingId);
    this.#d.journal.append("info", "binding.removed", {
      bindingId,
      params: {
        text: "Binding removed; the list and its reminders stay.",
        retired,
        denied: denials,
        ...(failed === undefined ? {} : { failed }),
      },
    });
    return {
      retired,
      ...(denials.length > 0 ? { denied: denials } : {}),
      ...(failed === undefined ? {} : { failed }),
    };
  }

  // ---------- steps ----------

  /** The table of PR 7 (review r3 P2-4): what every effect needs, read fresh before it. */
  async #context(
    b: BindingRow,
    mode: "bootstrap" | "unbind",
    effect: EffectContext["effect"],
  ): Promise<EffectContext> {
    const inst = this.#d.db
      .prepare(
        "SELECT i.status FROM installations i JOIN bindings b ON b.installation_id = i.id WHERE b.id = ?",
      )
      .get(b.id) as { status: string } | undefined;
    const holds = (
      this.#d.db.prepare("SELECT reason FROM binding_holds WHERE binding_id = ?").all(b.id) as {
        reason: string;
      }[]
    ).map((h) => h.reason);
    const transportOk = this.#d.transport.status().state === "ok";
    let listPresent: boolean | undefined;
    let foreign = false;
    let ownershipChecked = false;
    if (transportOk) {
      const current = this.#binding(b.id);
      if (current.target_ref !== null) {
        const lists = await this.#d.transport.lists();
        listPresent = lists.complete
          ? lists.lists.some((l) => l.id === current.target_ref)
          : undefined;
      }
      const v = await inspectMarkers(
        this.#d.transport,
        this.#d.instanceId,
        b.resource_id,
        mode === "unbind",
      );
      if (v.state === "incomplete" && mode === "bootstrap")
        throw new Refused("incomplete", "the marker search is incomplete");
      foreign = v.state === "foreign";
      ownershipChecked = v.state === "ok";
    }
    return {
      mode,
      effect,
      stopped: this.#d.stopped(),
      safeMode: new Runs(this.#d.db).safeMode() !== undefined,
      installationActive: inst?.status === "active",
      bindingState: b.state as EffectContext["bindingState"],
      verificationBinding: b.verification === 1,
      holds,
      transportOk,
      listPresent,
      ownershipChecked,
      foreignMarker: foreign,
      accessCheckedNow: false,
      offlineCommitAllowed: false,
      connected: false,
      writesVerified: false,
    };
  }

  /** Before every bootstrap effect: permits() (bootstrap column), then the helper write mode. */
  async #gate(b: BindingRow, effect: "list_create" | "marker_create"): Promise<void> {
    const denials = permits(await this.#context(this.#binding(b.id), "bootstrap", effect));
    if (denials.length > 0) throw refusalOf(denials);
    await this.#d.transport.setWriteMode?.(b.verification === 1 ? "verification" : "bootstrap");
  }

  async #scan(b: BindingRow): Promise<void> {
    if (this.#d.stopped()) throw new Refused("stop", "STOP is set");
    const s = this.#d.transport.status();
    if (s.state !== "ok") throw new Refused("transport", s.reason);
    const lists = await this.#d.transport.lists();
    if (!lists.complete)
      throw new Refused("incomplete", "the list of Reminders lists is incomplete");
    const v = await inspectMarkers(this.#d.transport, this.#d.instanceId, b.resource_id, false);
    if (v.state === "incomplete")
      throw new Refused("incomplete", "the marker search is incomplete");
    if (v.state === "foreign")
      throw new Refused(
        "foreign_bridge",
        `another bridge (${v.instances.join(", ")}) has this section`,
      );
    if (lists.lists.some((l) => l.title === b.target_title))
      throw new Refused(
        "list_exists",
        `a list titled "${b.target_title}" exists; rename it or choose another`,
      );
  }

  async #list(b: BindingRow): Promise<BindOutcome | undefined> {
    let op = this.#op(b.id, "list") ?? this.#newOp(b.id, "list", 1);
    if (op.state === "done") return undefined;
    if (op.state === "unknown_outcome") return this.#unknownList(b);
    if (op.state === "effecting") {
      const r = await this.#d.transport.recover(op.client_id);
      if (r.state === "done" && "list" in r.result) {
        this.#acceptList(b.id, r.result.list, "recovered");
        return undefined;
      }
      if (r.state === "unknown") return this.#markUnknown(b, "list");
      op = this.#setOp(b.id, "list", "prepared");
    }
    await this.#gate(b, "list_create");
    this.#setOp(b.id, "list", "effecting");
    try {
      const list = await this.#d.transport.createList({
        opKey: op.client_id,
        title: b.target_title ?? "",
      });
      this.#acceptList(b.id, list, "created");
      return undefined;
    } catch (e) {
      if (e instanceof ListExistsError || (e as Error).name === "ListExistsError")
        throw new Refused("list_exists", `a list titled "${b.target_title}" appeared`);
      if (e instanceof ForbiddenListError || (e as Error).name === "ForbiddenListError")
        throw new Refused("forbidden_list", (e as Error).message);
      // The answer is lost: what happened is for recover to say, now.
      const r = await this.#d.transport.recover(op.client_id);
      if (r.state === "done" && "list" in r.result) {
        this.#acceptList(b.id, r.result.list, "recovered");
        return undefined;
      }
      if (r.state === "not_started") {
        this.#setOp(b.id, "list", "prepared");
        throw e;
      }
      return this.#markUnknown(b, "list");
    }
  }

  async #marker(b0: BindingRow): Promise<BindOutcome | undefined> {
    const b = this.#binding(b0.id);
    const list = b.target_ref as ListRef;
    const url = markerUrl(this.#d.instanceId, b.resource_id);
    let op = this.#op(b.id, "marker") ?? this.#newOp(b.id, "marker", 1);
    if (op.state === "done") return undefined;
    if (op.state === "unknown_outcome") return this.#unknownMarker(b);
    if (op.state === "effecting") {
      const settled = await this.#recoverMarker(b, op.client_id);
      if (settled !== "retry") return settled === "done" ? undefined : this.#unknownMarker(b);
      op = this.#setOp(b.id, "marker", "prepared");
    }
    await this.#gate(b, "marker_create");
    this.#setOp(b.id, "marker", "effecting");
    let r: AppleOpResult;
    try {
      r = await this.#d.transport.apply({
        opKey: op.client_id,
        kind: "marker_create",
        list,
        markerUrl: url,
      });
    } catch (e) {
      const settled = await this.#recoverMarker(b, op.client_id);
      if (settled === "retry") {
        this.#setOp(b.id, "marker", "prepared");
        throw e;
      }
      return settled === "done" ? undefined : this.#unknownMarker(b);
    }
    if (!r.ok) {
      this.#setOp(b.id, "marker", "prepared");
      throw new Refused(
        r.code === "forbidden_list" ? "forbidden_list" : "transport",
        `marker: ${r.code}`,
      );
    }
    this.#doneMarker(b.id, r.ref);
    return undefined;
  }

  /** "done" (proven), "retry" (not started), "unknown" (unknown_outcome recorded). */
  async #recoverMarker(b: BindingRow, opKey: string): Promise<"done" | "retry" | "unknown"> {
    const r = await this.#d.transport.recover(opKey);
    if (r.state === "done" && "ref" in r.result) {
      this.#doneMarker(b.id, r.result.ref);
      return "done";
    }
    if (r.state === "not_started") return "retry";
    // Unknown stays unknown (B19): a visible marker is evidence for the person, not a result.
    this.#setOp(b.id, "marker", "unknown_outcome");
    this.#d.journal.append("warn", "bootstrap.marker.unknown", {
      bindingId: b.id,
      params: {
        text: "Whether the ownership marker was written is unknown. Check Reminders, then choose it by id (bind --resolve-marker <id>) or answer none.",
      },
    });
    return "unknown";
  }

  // ---------- rows ----------

  #iso(): string {
    return new Date(this.#now()).toISOString();
  }

  #binding(id: string): BindingRow {
    const b = this.#d.db.prepare("SELECT * FROM bindings WHERE id = ?").get(id) as
      | BindingRow
      | undefined;
    if (b === undefined) throw new Error(`no binding ${id}`);
    return b;
  }

  #setStep(id: string, step: "list" | "marker"): void {
    this.#d.db.prepare("UPDATE bindings SET bootstrap_step = ? WHERE id = ?").run(step, id);
  }

  #op(binding: string, step: string): OpRow | undefined {
    return this.#d.db
      .prepare(
        "SELECT client_id, state, result_json FROM bootstrap_ops WHERE binding_id = ? AND step = ?",
      )
      .get(binding, step) as OpRow | undefined;
  }

  #newOp(binding: string, step: string, attempt: number): OpRow {
    const key = `boot:${binding}:${step}:${attempt}`;
    this.#d.db
      .prepare(
        "INSERT INTO bootstrap_ops (binding_id, step, client_id, state) VALUES (?, ?, ?, 'prepared')",
      )
      .run(binding, step, key);
    return { client_id: key, state: "prepared", result_json: null };
  }

  /**
   * A new attempt with a new opKey: only after a person decided (the old outcome stays unknown).
   * One transaction (review PR 9 P2-5): a crash leaves either the unknown row or the new attempt,
   * never neither (which would restart at attempt 1, the old key).
   */
  #nextAttempt(binding: string, step: string, oldKey: string): void {
    const n = Number(oldKey.split(":").pop() ?? "1") + 1;
    this.#d.db.transaction(() => {
      this.#d.db
        .prepare("DELETE FROM bootstrap_ops WHERE binding_id = ? AND step = ?")
        .run(binding, step);
      this.#newOp(binding, step, Number.isFinite(n) ? n : 2);
      this.#setStep(binding, step as "list" | "marker");
    })();
  }

  #setOp(binding: string, step: string, state: OpRow["state"], result?: unknown): OpRow {
    this.#d.db
      .prepare(
        "UPDATE bootstrap_ops SET state = ?, result_json = COALESCE(?, result_json) WHERE binding_id = ? AND step = ?",
      )
      .run(state, result === undefined ? null : JSON.stringify(result), binding, step);
    return this.#op(binding, step) as OpRow;
  }

  #acceptList(binding: string, list: ListInfo, how: string): void {
    this.#d.db.transaction(() => {
      this.#setOp(binding, "list", "done", { list, how });
      this.#d.db.prepare("UPDATE bindings SET target_ref = ? WHERE id = ?").run(list.id, binding);
    })();
  }

  #doneMarker(binding: string, ref: { id: string; externalId?: string }): void {
    this.#d.db.transaction(() => {
      this.#setOp(binding, "marker", "done", { ref });
      this.#d.db
        .prepare("UPDATE bindings SET marker_ref = ? WHERE id = ?")
        .run(JSON.stringify(ref), binding);
    })();
  }

  #markUnknown(b: BindingRow, step: "list"): Promise<BindOutcome> {
    this.#setOp(b.id, step, "unknown_outcome");
    this.#d.journal.append("warn", "bootstrap.list.unknown", {
      bindingId: b.id,
      params: {
        text: `Whether the list "${b.target_title}" was created is unknown. Choose it by id (bind --resolve-list <id>) or answer none.`,
      },
    });
    return this.#unknownList(b);
  }

  /** Markers with this binding's exact url in its bound list. */
  async #markerEvidence(
    b: BindingRow,
  ): Promise<{ readonly items: readonly AppleItem[]; readonly complete: boolean }> {
    if (b.target_ref === null) return { items: [], complete: true };
    const url = markerUrl(this.#d.instanceId, b.resource_id);
    return this.#d.transport
      .find({ url }, [b.target_ref as ListRef])
      .catch(() => ({ items: [] as AppleItem[], complete: false }));
  }

  async #unknownMarker(b: BindingRow): Promise<BindOutcome> {
    const found = await this.#markerEvidence(b);
    return { state: "unknown_outcome", bindingId: b.id, step: "marker", markers: found.items };
  }

  async #unknownList(b: BindingRow): Promise<BindOutcome> {
    const lists = await this.#d.transport.lists().catch(() => ({ lists: [] as ListInfo[] }));
    return {
      state: "unknown_outcome",
      bindingId: b.id,
      step: "list",
      candidates: lists.lists.filter((l) => l.title === b.target_title),
    };
  }
}
