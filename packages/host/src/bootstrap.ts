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
// - marker answer lost → recover the same way; unknown → the marker record itself (its exact url
//   in the bound list) is the proof of the effect; without it, unknown_outcome and
//   `bind --retry-marker`.
// There is no --adopt-list (B17): the bootstrap only binds a list it created.

import { randomUUID } from "node:crypto";
import {
  type AppleOpResult,
  ForbiddenListError,
  ListExistsError,
  type ListInfo,
  type ListRef,
  type RemindersTransport,
} from "@openlfcp/bridge-reminders/transport";
import type { BridgeDatabase } from "./db/database.js";
import type { Journal } from "./db/journal.js";
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
  | "not_unknown";

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

  /** A person decides an unknown marker outcome: create it again (a new attempt). */
  async retryMarker(bindingId: string): Promise<BindOutcome> {
    const op = this.#op(bindingId, "marker");
    if (op?.state !== "unknown_outcome")
      return { state: "refused", reason: "not_unknown", bindingId };
    this.#nextAttempt(bindingId, "marker", op.client_id);
    return this.resume(bindingId);
  }

  /** unbind: the binding is removed; this bridge's own marker is retired; list and reminders stay. */
  async unbind(bindingId: string): Promise<{ readonly retired: boolean }> {
    const b = this.#binding(bindingId);
    let retired = false;
    if (b.target_ref !== null) {
      const url = markerUrl(this.#d.instanceId, b.resource_id);
      const found = await this.#d.transport.find({ url }, [b.target_ref as ListRef]);
      const marker = found.items[0];
      if (marker !== undefined && !this.#d.stopped()) {
        const r = await this.#d.transport.apply({
          opKey: `unbind:${bindingId}:${randomUUID().slice(0, 8)}`,
          kind: "marker_retire",
          ref: marker.ref,
          markerUrl: url,
          expect: { rev: marker.rev },
        });
        retired = r.ok;
      }
    }
    this.#d.db.prepare("UPDATE bindings SET state = 'removed' WHERE id = ?").run(bindingId);
    this.#d.journal.append("info", "binding.removed", {
      bindingId,
      params: { text: "Binding removed; the list and its reminders stay.", ...{ retired } },
    });
    return { retired };
  }

  // ---------- steps ----------

  /**
   * Before every effect (the bootstrap column of PR 7's permission table, review r3 P2-4): STOP, an
   * active installation, the transport (TCC), no foreign marker for the section, then the write mode.
   */
  async #gate(b: BindingRow): Promise<void> {
    if (this.#d.stopped()) throw new Refused("stop", "STOP is set");
    const inst = this.#d.db
      .prepare(
        "SELECT i.status FROM installations i JOIN bindings b ON b.installation_id = i.id WHERE b.id = ?",
      )
      .get(b.id) as { status: string } | undefined;
    if (inst?.status !== "active")
      throw new Refused("transport", `installation ${inst?.status ?? "missing"}`);
    const s = this.#d.transport.status();
    if (s.state !== "ok") throw new Refused("transport", s.reason);
    const v = await inspectMarkers(this.#d.transport, this.#d.instanceId, b.resource_id, false);
    if (v.state === "incomplete")
      throw new Refused("incomplete", "the marker search is incomplete");
    if (v.state === "foreign")
      throw new Refused(
        "foreign_bridge",
        `another bridge (${v.instances.join(", ")}) has this section`,
      );
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
    await this.#gate(b);
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
    if (op.state === "unknown_outcome")
      return { state: "unknown_outcome", bindingId: b.id, step: "marker" };
    if (op.state === "effecting") {
      const settled = await this.#recoverMarker(b, op.client_id, list, url);
      if (settled !== "retry")
        return settled === "done"
          ? undefined
          : { state: "unknown_outcome", bindingId: b.id, step: "marker" };
      op = this.#setOp(b.id, "marker", "prepared");
    }
    await this.#gate(b);
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
      const settled = await this.#recoverMarker(b, op.client_id, list, url);
      if (settled === "retry") {
        this.#setOp(b.id, "marker", "prepared");
        throw e;
      }
      return settled === "done"
        ? undefined
        : { state: "unknown_outcome", bindingId: b.id, step: "marker" };
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
  async #recoverMarker(
    b: BindingRow,
    opKey: string,
    list: ListRef,
    url: string,
  ): Promise<"done" | "retry" | "unknown"> {
    const r = await this.#d.transport.recover(opKey);
    if (r.state === "done" && "ref" in r.result) {
      this.#doneMarker(b.id, r.result.ref);
      return "done";
    }
    if (r.state === "not_started") return "retry";
    // Unknown: the marker record itself is the effect; its exact url in the list proves it.
    const found = await this.#d.transport.find({ url }, [list]);
    const only = found.items.length === 1 ? found.items[0] : undefined;
    if (found.complete && only !== undefined) {
      this.#doneMarker(b.id, only.ref);
      return "done";
    }
    this.#setOp(b.id, "marker", "unknown_outcome");
    this.#d.journal.append("warn", "bootstrap.marker.unknown", {
      bindingId: b.id,
      params: {
        text: "Whether the ownership marker was written is unknown. Check Reminders, then run bind --retry-marker.",
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

  /** A new attempt with a new opKey: only after a person decided (the old outcome stays unknown). */
  #nextAttempt(binding: string, step: string, oldKey: string): void {
    const n = Number(oldKey.split(":").pop() ?? "1") + 1;
    this.#d.db
      .prepare("DELETE FROM bootstrap_ops WHERE binding_id = ? AND step = ?")
      .run(binding, step);
    this.#newOp(binding, step, Number.isFinite(n) ? n : 2);
    this.#setStep(binding, step as "list" | "marker");
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
