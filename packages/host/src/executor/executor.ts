// The intent executor (D-010 §5.6, §5.7, §7; PR 7).
//
// Every external write is an intent, prepared durably with its exact payload
// (Intents), then: the permissions of §7.1 (one table, permits) checked
// before the effect and before every retry → `effecting` durable → exactly
// one call (transport.apply with opKey = intent id, or
// SectionHost.commitGuarded) → the result durable (`applied`) → finalize in
// one transaction with the bases. A crash at any boundary is recovered
// (§5.7):
//
// | state      | to_apple                                         | to_lfcp                       |
// |------------|--------------------------------------------------|-------------------------------|
// | prepared   | run (after §7.1)                                 | run (after §7.1)              |
// | effecting  | transport.recover(opKey): done → finalize;       | receiptOf: there → finalize;  |
// |            | not_started → run again, same opKey; unknown →   | none → run again (the basis   |
// |            | quarantine (B19), whatever the item shows: no    | is checked again in stage)    |
// |            | field is inferred. The opKey is never sent again |                               |
// |            | (OutcomeUnknownError); the transport's done      |                               |
// |            | settles it later, or a person does, and a write  |                               |
// |            | still wanted is a new intent under a new opKey   |                               |
// | applied    | finalize                                         | finalize                      |
//
// `unknown_outcome` quarantines only that Task's intent; a person resolves
// it (`conflicts resolve`), or the transport settles it later (recover done).
//
// A field in quarantine (an unresolved `unknown_outcome` conflict) is not
// written again, in either direction, until a person resolves it or the
// transport settles it: prepare leaves such an intent out, and an intent
// prepared before is superseded at its effect (review PR 7 #1).
//
// An intent is checked against its binding (installation, the binding's
// section for to_lfcp, its list for a create) and its payload against its
// kind, at prepare and again before any call; the effect §7.1 checks is the
// one of the operation actually sent (review PR 7 #5).
//
// Effects: without `effects.enabled` the executor gets as far as the transport
// and writes nothing. With it and no `permit`, it writes to Apple only through
// the fake transport and to LFCP only through a port marked `offlineTestPort`
// (tests, the crash suite; review PR 7 #4). The run process (PR 9b) passes
// `permit`: the write gate of §7.6 / B16 — a verification binding, or
// writesVerified for this helper build and macOS.

import { randomUUID } from "node:crypto";
import type {
  AppleItem,
  AppleOp,
  AppleOpResult,
  RemindersTransport,
} from "@openlfcp/bridge-reminders";
import type { Receipt } from "@openlfcp/client";
import { fromHex, type ResourceId, resourceId } from "@openlfcp/core";
import type { SectionReplica } from "@openlfcp/shared-objects/sections";
import type { BridgeDatabase } from "../db/database.js";
import { Holds } from "../db/holds.js";
import { Journal } from "../db/journal.js";
import { BasisChangedError } from "../lfcp/commit-guard.js";
import type { GuardedCommit, GuardedCommitResult } from "../lfcp/section-host.js";
import { type Intent, Intents, type NewIntent } from "./intents.js";
import { Limits, type PlannedWork } from "./limits.js";
import {
  type Denial,
  type EffectContext,
  type EffectKind,
  type Mode,
  permits,
} from "./permissions.js";

/** The LFCP side the executor needs (a SectionHost per installation, behind one port). */
export interface LfcpPort {
  commitGuarded(c: GuardedCommit): Promise<GuardedCommitResult>;
  /** receiptOf of the installation's storage. */
  receipt(resource: ResourceId, operationId: string): Promise<Receipt | undefined>;
}

const OFFLINE_TEST_PORTS = new WeakSet<LfcpPort>();

/**
 * Marks an LFCP port as the offline test port (a SectionHost without a
 * server, in tests): the only port `effects.enabled` commits to in this
 * build. Never for a port that reaches a server.
 */
export function offlineTestPort<P extends LfcpPort>(port: P): P {
  OFFLINE_TEST_PORTS.add(port);
  return port;
}

/** An intent that does not match its binding, or a payload that does not match its kind. */
export class InvalidIntentError extends Error {
  constructor(
    readonly intent: { readonly taskId: string; readonly kind: string },
    detail: string,
  ) {
    super(`intent ${intent.kind} of ${intent.taskId} does not match: ${detail}`);
    this.name = "InvalidIntentError";
  }
}

/** The live state the permissions read, fresh before each effect. */
export interface Gates {
  stopped(): boolean;
  safeMode(): boolean;
  ownershipChecked(bindingId: string): boolean;
  accessCheckedNow(installationId: string, resource: ResourceId): boolean;
  offlineCommitAllowed(installationId: string, resource: ResourceId): boolean;
  connected(installationId: string): boolean;
}

/** What only the adapter knows: the bases of a finalize, the LFCP basis. */
export interface IntentHandler {
  /** Writes the bases of the intent's fields (§5.6 formulas) and their `intent_id`, in `db`'s transaction. */
  finalize(intent: Intent, result: unknown, db: BridgeDatabase): void;
  /**
   * Called in prepare's transaction for each intent prepared: what must be durable with it
   * (an import's pending_lfcp_create link, §6.2). Optional.
   */
  prepared?(intent: Intent, db: BridgeDatabase): void;
  /** to_lfcp, inside the SDK's stage: the replica still matches the intent's basis. */
  lfcpBasis(replica: SectionReplica, intent: Intent): true | false | string;
}

/** Boundaries where the crash suite stops the process (tests only). */
export type CrashPoint = "after_effecting" | "after_effect" | "after_result" | "after_finalize";

export interface ExecutorOptions {
  readonly db: BridgeDatabase;
  readonly transport: RemindersTransport;
  readonly lfcp: LfcpPort;
  readonly gates: Gates;
  readonly handler: IntentHandler;
  /** Off in this PR; on only with the fake transport. */
  /**
   * Effects. Without `permit`, only the fake transport and an offlineTestPort write (tests,
   * the crash suite). With it (the run process, PR 9b), an effect runs when `permit` says so:
   * the write gate of §7.6 / B16 — a verification binding, or writesVerified.
   */
  readonly effects?: {
    readonly enabled: boolean;
    readonly permit?: (intent: Intent) => boolean;
  };
  readonly now?: () => number;
  /** The crash suite's hook: throws to stop at a boundary. */
  readonly crash?: (point: CrashPoint, intent: Intent) => void;
}

export type Outcome =
  | { readonly kind: "finalized" }
  | { readonly kind: "denied"; readonly denials: readonly Denial[] }
  | { readonly kind: "effects_off" }
  | { readonly kind: "retry"; readonly reason: string }
  /** The answer was lost: the intent stays effecting, recovery decides. */
  | { readonly kind: "lost" }
  /** Another call with this opKey is in flight: nothing sent, nothing changed; that call settles it. */
  | { readonly kind: "in_flight" }
  | { readonly kind: "superseded"; readonly reason: string }
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "quarantined"; readonly reason: string }
  | { readonly kind: "not_due" }
  | { readonly kind: "skipped"; readonly state: string };

/** The backoff of a retry: 1 s, doubling, at most 15 min. */
const retryDelay = (attempts: number) =>
  Math.min(15 * 60_000, 1000 * 2 ** Math.max(0, attempts - 1));

interface BindingRow {
  id: string;
  installation_id: string;
  resource_id: string;
  target_ref: string | null;
  state: EffectContext["bindingState"];
  verification: number;
  installation_status: string;
}

export class Executor {
  readonly #o: ExecutorOptions;
  readonly #intents: Intents;
  readonly #journal: Journal;
  readonly #now: () => number;
  /** Intents this executor is running now: never run or recovered twice at once. */
  readonly #running = new Set<string>();

  constructor(options: ExecutorOptions) {
    if (
      options.effects?.enabled === true &&
      options.effects.permit === undefined &&
      options.transport.id !== "fake"
    )
      throw new Error(
        "effects are off in this build: they may run only on the fake transport (D-010 PR 7)",
      );
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#intents = new Intents(options.db, this.#now);
    this.#journal = new Journal(options.db, this.#now);
  }

  get intents(): Intents {
    return this.#intents;
  }

  /**
   * Prepares a pass's intents of one binding, after the limits (§7.2): all or
   * none, in one transaction. undefined: a limit stopped it (holds are set).
   * An intent that does not match its binding or its kind throws
   * (InvalidIntentError) before anything is prepared; one that would write a
   * field in quarantine is left out (journaled) and the rest prepared.
   */
  prepare(
    bindingId: string,
    planned: PlannedWork,
    /** admitted: the whole pass was already checked against the limits (LinkApplier). */
    o: { readonly admitted?: boolean } = {},
  ): readonly Intent[] | undefined {
    const binding = this.#binding(bindingId);
    for (const n of planned.intents) {
      const invalid = this.#invalid(n, binding);
      if (invalid !== undefined) throw new InvalidIntentError(n, invalid);
    }
    if (o.admitted !== true) {
      const admitted = new Limits(this.#o.db, undefined, this.#now).admit(bindingId, planned);
      if (!admitted.ok) return undefined;
    }
    return this.#o.db
      .transaction(() => {
        const out: Intent[] = [];
        for (const n of planned.intents) {
          const held = this.#quarantinedFields(n);
          if (held.length > 0) {
            this.#journal.append("warn", "intent.field_quarantined", {
              bindingId: n.bindingId,
              taskId: n.taskId,
              params: { fields: held.join(", "), direction: n.direction },
            });
            continue;
          }
          const prepared = this.#intents.prepare(n);
          this.#o.handler.prepared?.(prepared, this.#o.db);
          out.push(prepared);
        }
        return out;
      })
      .immediate();
  }

  // ------------------------------------------------------------------ validity (review #5)

  #binding(bindingId: string): BindingRow {
    const b = this.#o.db
      .prepare(
        `SELECT b.id, b.installation_id, b.resource_id, b.target_ref, b.state, b.verification,
                i.status AS installation_status
           FROM bindings b JOIN installations i ON i.id = b.installation_id WHERE b.id = ?`,
      )
      .get(bindingId) as BindingRow | undefined;
    if (b === undefined) throw new Error(`no binding ${bindingId}`);
    return b;
  }

  /**
   * Why an intent does not match its binding or its payload its kind;
   * undefined when it does. This executor sends reminder writes (create,
   * update, restore_url) and section commits (create_task, update_task);
   * markers and lists are bootstrap's and unbind's (PR 9).
   */
  #invalid(n: NewIntent, b: BindingRow): string | undefined {
    if (n.bindingId !== b.id) return `binding ${n.bindingId}, not ${b.id}`;
    if (n.installationId !== b.installation_id)
      return `installation ${n.installationId}, the binding's is ${b.installation_id}`;
    const p = n.payload as Record<string, unknown> | null | undefined;
    if (p === null || typeof p !== "object") return "no payload";
    if (n.direction === "to_lfcp") {
      if (n.kind !== "create_task" && n.kind !== "update_task") return `to_lfcp kind ${n.kind}`;
      if (p.resource !== b.resource_id) return "the payload's section is not the binding's";
      if (!Array.isArray(p.intents)) return "no section intents";
      return undefined;
    }
    if (n.direction !== "to_apple") return `direction ${String(n.direction)}`;
    if (n.kind !== "create" && n.kind !== "update" && n.kind !== "restore_url")
      return `to_apple kind ${n.kind}`;
    if (p.kind !== n.kind) return `payload kind ${String(p.kind)} for intent kind ${n.kind}`;
    if (n.kind === "create") {
      if (b.target_ref === null || p.list !== b.target_ref)
        return "the payload's list is not the binding's";
      return undefined;
    }
    const ref = p.ref as { id?: unknown } | undefined;
    const expect = p.expect as { rev?: unknown } | undefined;
    if (typeof ref?.id !== "string") return "no item ref";
    if (typeof expect?.rev !== "string") return "no expected revision";
    return undefined;
  }

  /**
   * The intent's fields that are in quarantine: an unresolved
   * `unknown_outcome` of the same Task, either direction, other than its own.
   */
  #quarantinedFields(n: {
    readonly bindingId: string;
    readonly taskId: string;
    readonly fields: readonly string[];
    readonly id?: string;
  }): readonly string[] {
    if (n.fields.length === 0) return [];
    const rows = this.#o.db
      .prepare(
        `SELECT DISTINCT field FROM conflicts
          WHERE binding_id = ? AND task_id = ? AND kind = 'unknown_outcome' AND resolved_at IS NULL
            AND field IN (${n.fields.map(() => "?").join(", ")})
            AND (intent_id IS NULL OR intent_id <> ?)`,
      )
      .all(n.bindingId, n.taskId, ...n.fields, n.id ?? "") as { field: string }[];
    return rows.map((r) => r.field);
  }

  /** A start (§5.2 step 2): every open intent, and the unknown outcomes the transport may settle now. */
  /**
   * The open intents of one binding, settled without sending anything (review PR 9b #31): a
   * confirmed done (or a stored receipt) finalized, an applied one finalized, an unknown outcome
   * quarantined (B19), a not_started one back to prepared — sent later by runDue, after the pass
   * brought its link up to date, so #stale sees the Task leave the filter, go, or get locked.
   */
  async settle(bindingId: string): Promise<readonly Outcome[]> {
    const out: Outcome[] = [];
    for (const i of this.#intents.open()) {
      if (i.bindingId !== bindingId) continue;
      if (i.state === "effecting")
        out.push(await this.#exclusive(i.id, () => this.#recover(i, { resend: false })));
      else if (i.state === "applied")
        out.push(await this.#exclusive(i.id, async () => this.#finalize(i)));
    }
    // Unknown outcomes the transport may have confirmed since (P2-1): finalize, never resend.
    for (const i of this.#intents.unknownOutcomes())
      if (i.bindingId === bindingId && i.direction === "to_apple")
        out.push(await this.#exclusive(i.id, () => this.#settleUnknown(i)));
    return out;
  }

  async recoverAll(): Promise<readonly Outcome[]> {
    const out: Outcome[] = [];
    for (const i of this.#intents.open()) {
      if (i.state === "effecting") out.push(await this.#exclusive(i.id, () => this.#recover(i)));
      else if (i.state === "applied")
        out.push(await this.#exclusive(i.id, async () => this.#finalize(i)));
    }
    for (const i of this.#intents.unknownOutcomes())
      if (i.direction === "to_apple")
        out.push(await this.#exclusive(i.id, () => this.#settleUnknown(i)));
    return out;
  }

  /**
   * One runner per intent in this process: a second one gets `in_flight` at once. (Recovering an
   * intent whose call is still under way would read its stage `sent` as an unknown outcome.)
   */
  async #exclusive(id: string, f: () => Promise<Outcome>): Promise<Outcome> {
    if (this.#running.has(id)) return { kind: "in_flight" };
    this.#running.add(id);
    try {
      return await f();
    } finally {
      this.#running.delete(id);
    }
  }

  /** Runs every prepared intent that is due. */
  async runDue(
    /** Only this binding's (the run process: after its own plan and transitions, review PR 9b #31). */
    bindingId?: string,
  ): Promise<readonly Outcome[]> {
    const now = new Date(this.#now()).toISOString();
    const out: Outcome[] = [];
    for (const i of this.#intents.open())
      if (bindingId !== undefined && i.bindingId !== bindingId) continue;
      else if (i.state === "prepared" && (i.nextAt === null || i.nextAt <= now))
        out.push(await this.run(i.id));
    return out;
  }

  /** One intent, from its state (§5.7). */
  async run(id: string): Promise<Outcome> {
    return this.#exclusive(id, () => this.#run(id));
  }

  async #run(id: string): Promise<Outcome> {
    const i = this.#intents.get(id);
    if (i === undefined) throw new Error(`no intent ${id}`);
    switch (i.state) {
      case "prepared":
        return this.#execute(i);
      case "effecting":
        return this.#recover(i);
      case "applied":
        return this.#finalize(i);
      default:
        return { kind: "skipped", state: i.state };
    }
  }

  // ------------------------------------------------------------------ permissions

  /** The effect of the operation actually sent (its payload), not of the intent's own kind. */
  #effectOf(i: Intent): EffectKind {
    if (i.direction === "to_lfcp") return "lfcp_commit";
    switch ((i.payload as { kind?: unknown } | null)?.kind) {
      case "create":
        return "apple_create";
      case "update":
        return "apple_update";
      case "restore_url":
        return "apple_restore_url";
      case "marker_create":
        return "marker_create";
      case "marker_retire":
        return "marker_retire";
      default:
        throw new InvalidIntentError(i, "a payload of no known operation");
    }
  }

  /**
   * The state §7.1 reads. The one asynchronous read (the transport's lists)
   * comes first; everything else is read after it, synchronously, so nothing
   * can change between this context and the dispatch that follows it
   * (review PR 7 #2).
   */
  async #context(i: Intent): Promise<EffectContext> {
    const effect = this.#effectOf(i);
    const t = this.#o.transport;
    let lists: Awaited<ReturnType<RemindersTransport["lists"]>> | undefined;
    if (effect !== "lfcp_commit" && t.status().state === "ok")
      lists = await t.lists().catch(() => undefined);
    // From here on, no await until the caller dispatches.
    const b = this.#binding(i.bindingId);
    const mode: Mode = b.verification === 1 ? "verification" : "normal";
    const R = resourceId(fromHex(b.resource_id));
    const g = this.#o.gates;
    const transportOk = t.status().state === "ok";
    let listPresent: boolean | undefined;
    if (effect !== "lfcp_commit" && b.target_ref !== null && transportOk)
      listPresent =
        lists?.complete === true ? lists.lists.some((l) => l.id === b.target_ref) : false;
    return {
      mode,
      effect,
      stopped: g.stopped(),
      safeMode: g.safeMode(),
      installationActive: b.installation_status === "active",
      bindingState: b.state,
      verificationBinding: b.verification === 1,
      holds: new Holds(this.#o.db).of(b.id).map((h) => h.reason),
      transportOk,
      listPresent,
      ownershipChecked: g.ownershipChecked(b.id),
      foreignMarker: false,
      accessCheckedNow: g.accessCheckedNow(b.installation_id, R),
      offlineCommitAllowed: g.offlineCommitAllowed(b.installation_id, R),
      connected: g.connected(b.installation_id),
      writesVerified: t.capabilities.writesVerified,
    };
  }

  async #denials(i: Intent): Promise<readonly Denial[]> {
    return permits(await this.#context(i));
  }

  // ------------------------------------------------------------------ effect

  /**
   * What stops an intent for good before any call: it does not match its
   * binding or its kind (#5), or a field of it is in quarantine (#1).
   */
  #blocked(i: Intent): Outcome | undefined {
    const invalid = this.#invalid(i, this.#binding(i.bindingId));
    if (invalid !== undefined) {
      this.#intents.end(i.id, "refused", "invalid_intent", { detail: invalid });
      this.#journal.append("error", "intent.invalid", {
        bindingId: i.bindingId,
        taskId: i.taskId,
        params: { intent: i.id, detail: invalid },
      });
      return { kind: "refused", reason: "invalid_intent" };
    }
    const stale = this.#stale(i);
    if (stale !== undefined) {
      // The link changed since the plan (review PR 12 #14): not sent; the next pass re-plans.
      this.#intents.end(i.id, "superseded", stale);
      this.#journal.append("info", "intent.stale", {
        bindingId: i.bindingId,
        taskId: i.taskId,
        params: { intent: i.id, reason: stale },
      });
      return { kind: "superseded", reason: stale };
    }
    const held = this.#quarantinedFields(i);
    if (held.length > 0) {
      // Planned on a basis the quarantine makes doubtful: re-plan after it is resolved.
      this.#intents.end(i.id, "superseded", "field_quarantined", { fields: held });
      this.#journal.append("warn", "intent.field_quarantined", {
        bindingId: i.bindingId,
        taskId: i.taskId,
        params: { intent: i.id, fields: held.join(", "), direction: i.direction },
      });
      return { kind: "superseded", reason: "field_quarantined" };
    }
    return undefined;
  }

  /**
   * Why a prepared intent no longer fits its Task's link (§6.1–6.4, B11; review PR 12 #14): the
   * link left synchronization (out_of_filter, task_gone, unlinked, quarantine), or it is locked by
   * a recurrence and the intent writes status or due. Undefined when it still fits (no link yet:
   * a create).
   */
  #stale(i: Intent): string | undefined {
    const link = this.#o.db
      .prepare("SELECT state, status_locked FROM links WHERE binding_id = ? AND task_id = ?")
      .get(i.bindingId, i.taskId) as { state: string; status_locked: number } | undefined;
    if (link === undefined) return undefined;
    if (!["linked", "pending_apple_create", "pending_lfcp_create"].includes(link.state))
      return `link_${link.state}`;
    if (link.status_locked === 1 && i.fields.some((f) => f === "status" || f === "due"))
      return "status_locked";
    return undefined;
  }

  /** Effects of this intent's direction are on: Apple via the fake transport, LFCP via the offline test port. */
  #effectsOn(i: Intent): boolean {
    if (this.#o.effects?.enabled !== true) return false;
    if (this.#o.effects.permit !== undefined) return this.#o.effects.permit(i);
    return i.direction === "to_apple"
      ? this.#o.transport.id === "fake"
      : OFFLINE_TEST_PORTS.has(this.#o.lfcp);
  }

  async #execute(i: Intent): Promise<Outcome> {
    const blocked = this.#blocked(i);
    if (blocked !== undefined) return blocked;
    // §7.1 before the effect (and before every retry: a retry comes back here).
    const denials = await this.#denials(i);
    if (denials.length > 0) return { kind: "denied", denials };
    if (!this.#effectsOn(i)) {
      this.#journal.append("debug", "effect.off", {
        bindingId: i.bindingId,
        taskId: i.taskId,
        params: { intent: i.id, direction: i.direction, kind: i.kind },
      });
      return { kind: "effects_off" };
    }
    // Another executor (or process) took it meanwhile: not ours to send.
    if (!this.#intents.tryEffecting(i.id)) return { kind: "in_flight" };
    const effecting = this.#intents.get(i.id) as Intent;
    this.#o.crash?.("after_effecting", effecting);
    // Checked again after the durable step: nothing may have changed meanwhile.
    const again = await this.#denials(effecting);
    if (again.length > 0) {
      this.#intents.retry(i.id, this.#now(), { denied: again });
      return { kind: "denied", denials: again };
    }
    // Nothing was sent yet: a link change that came meanwhile still stops it.
    const stale = this.#stale(effecting);
    if (stale !== undefined) {
      this.#intents.end(i.id, "superseded", stale);
      return { kind: "superseded", reason: stale };
    }
    // Nothing was sent yet: a quarantine that appeared meanwhile still stops it.
    const held = this.#quarantinedFields(effecting);
    if (held.length > 0) {
      this.#intents.end(i.id, "superseded", "field_quarantined", { fields: held });
      return { kind: "superseded", reason: "field_quarantined" };
    }
    return i.direction === "to_apple" ? this.#effectApple(effecting) : this.#effectLfcp(effecting);
  }

  #appleOp(i: Intent): AppleOp {
    return { ...(i.payload as Omit<AppleOp, "opKey">), opKey: i.id } as AppleOp;
  }

  async #effectApple(i: Intent): Promise<Outcome> {
    let result: AppleOpResult;
    try {
      result = await this.#o.transport.apply(this.#appleOp(i));
    } catch (error) {
      const name = error instanceof Error ? error.name : undefined;
      // Refused without sending: an earlier attempt with this opKey has an unknown outcome.
      // It is never resent; a person settles it, then a new intent writes under a new opKey.
      if (name === "OutcomeUnknownError") return this.#quarantine(i, undefined, undefined);
      // Refused without sending: a call with this opKey is in flight. Not repeated: it settles.
      if (name === "OperationInFlightError") {
        this.#journal.append("debug", "effect.in_flight", {
          bindingId: i.bindingId,
          taskId: i.taskId,
          params: { intent: i.id },
        });
        return { kind: "in_flight" };
      }
      // The answer is lost (the helper died, the call failed after sending): §5.7 decides.
      this.#journal.append("warn", "effect.lost", {
        bindingId: i.bindingId,
        taskId: i.taskId,
        params: { intent: i.id, error: String(error) },
      });
      return { kind: "lost" };
    }
    this.#o.crash?.("after_effect", i);
    return this.#appleResult(i, result);
  }

  #appleResult(i: Intent, result: AppleOpResult): Outcome {
    if (result.ok) {
      this.#intents.applied(i.id, result);
      this.#o.crash?.("after_result", this.#intents.get(i.id) as Intent);
      return this.#finalize(this.#intents.get(i.id) as Intent);
    }
    if (result.code === "conflict_changed") {
      // The person changed it since the plan: re-plan from the current state (§5.6).
      this.#intents.end(i.id, "superseded", "basis_changed", { fresh: result.fresh });
      return { kind: "superseded", reason: "basis_changed" };
    }
    if (result.retryable) {
      this.#intents.retry(i.id, this.#now() + retryDelay(i.attempts), result);
      return { kind: "retry", reason: result.code };
    }
    this.#intents.end(i.id, "refused", result.code, result);
    this.#journal.append("warn", "effect.refused", {
      bindingId: i.bindingId,
      taskId: i.taskId,
      params: { intent: i.id, code: result.code },
    });
    return { kind: "refused", reason: result.code };
  }

  async #effectLfcp(i: Intent): Promise<Outcome> {
    const p = i.payload as { readonly resource: string; readonly intents: readonly unknown[] };
    let receipt: Receipt;
    try {
      const r = await this.#o.lfcp.commitGuarded({
        resource: resourceId(fromHex(p.resource)),
        intents: p.intents,
        operationId: i.operationId,
        check: (replica) => this.#o.handler.lfcpBasis(replica, i),
      });
      receipt = r.receipt;
    } catch (error) {
      if (error instanceof BasisChangedError) {
        // Nothing was written (§5.8): re-plan from the replica now.
        this.#intents.end(i.id, "superseded", "basis_changed", { detail: error.detail ?? null });
        return { kind: "superseded", reason: "basis_changed" };
      }
      this.#intents.retry(i.id, this.#now() + retryDelay(i.attempts), { error: String(error) });
      return { kind: "retry", reason: String(error) };
    }
    this.#o.crash?.("after_effect", i);
    this.#intents.applied(i.id, receipt);
    this.#o.crash?.("after_result", this.#intents.get(i.id) as Intent);
    return this.#finalize(this.#intents.get(i.id) as Intent);
  }

  // ------------------------------------------------------------------ finalize

  #finalize(i: Intent): Outcome {
    this.#o.db
      .transaction(() => {
        this.#o.handler.finalize(i, i.result, this.#o.db);
        this.#intents.finalized(i.id);
      })
      .immediate();
    this.#o.crash?.("after_finalize", this.#intents.get(i.id) as Intent);
    return { kind: "finalized" };
  }

  // ------------------------------------------------------------------ recovery (§5.7)

  async #recover(i: Intent, o: { readonly resend?: boolean } = {}): Promise<Outcome> {
    const resend = o.resend ?? true;
    if (i.direction === "to_lfcp") {
      const p = i.payload as { readonly resource: string };
      const receipt = await this.#o.lfcp.receipt(resourceId(fromHex(p.resource)), i.operationId);
      if (receipt !== undefined) {
        this.#intents.applied(i.id, receipt);
        return this.#finalize(this.#intents.get(i.id) as Intent);
      }
      // Not stored: run it again; its basis is checked again inside stage.
      this.#intents.retry(i.id, this.#now(), { recovered: "not_started" });
      if (!resend) return { kind: "retry", reason: "not_started" };
      return this.#execute(this.#intents.get(i.id) as Intent);
    }
    let r: Awaited<ReturnType<RemindersTransport["recover"]>>;
    try {
      r = await this.#o.transport.recover(i.id);
    } catch (error) {
      // Its answer is lost but the helper that has it may still run it (it never said it started,
      // the hang analysis G4): not unknown yet. It stays effecting; a later settle decides.
      if (error instanceof Error && error.name === "OperationInFlightError") {
        this.#journal.append("debug", "effect.in_flight", {
          bindingId: i.bindingId,
          taskId: i.taskId,
          params: { intent: i.id },
        });
        return { kind: "in_flight" };
      }
      throw error;
    }
    if (r.state === "done") {
      if (!("rev" in r.result))
        throw new Error(`intent ${i.id}: a list result for a reminder write`);
      return this.#appleResult(i, r.result);
    }
    if (r.state === "not_started") {
      this.#intents.retry(i.id, this.#now(), { recovered: "not_started" });
      if (!resend) return { kind: "retry", reason: "not_started" };
      return this.#execute(this.#intents.get(i.id) as Intent);
    }
    return this.#unknown(i, r.stage);
  }

  /**
   * An unknown outcome (§5.7, B19): always quarantined, with field conflicts.
   * Nothing is inferred from the item, not even fields equal to the payload:
   * only the transport's confirmed done settles it on its own
   * (#settleUnknown), else a person does, and a write still wanted is a new
   * intent under a new opKey. The item, when it can be read, is kept as the
   * conflicts' evidence.
   */
  async #unknown(i: Intent, stage: string | undefined): Promise<Outcome> {
    const op = this.#appleOp(i);
    let item: AppleItem | undefined;
    if (op.kind === "update" || op.kind === "restore_url" || op.kind === "marker_retire") {
      const ref = op.ref;
      const query =
        ref.externalId !== undefined ? { externalId: ref.externalId } : { id: ref.id as string };
      const found = await this.#o.transport.find(query, "all").catch(() => undefined);
      item = found?.complete === true && found.items.length === 1 ? found.items[0] : undefined;
    }
    return this.#quarantine(i, stage, item);
  }

  #quarantine(i: Intent, stage: string | undefined, item: AppleItem | undefined): Outcome {
    const now = new Date(this.#now()).toISOString();
    this.#o.db
      .transaction(() => {
        this.#intents.end(i.id, "quarantined", "unknown_outcome", { stage: stage ?? null });
        for (const field of i.fields)
          this.#o.db
            .prepare(
              `INSERT INTO conflicts (id, binding_id, task_id, field, kind, lfcp_json, apple_json, intent_id, created_at)
               VALUES (?, ?, ?, ?, 'unknown_outcome', ?, ?, ?, ?)`,
            )
            .run(
              randomUUID(),
              i.bindingId,
              i.taskId,
              field,
              JSON.stringify((i.payload as { set?: Record<string, unknown> }).set?.[field] ?? null),
              item === undefined ? null : JSON.stringify(item),
              i.id,
              now,
            );
        this.#journal.append("warn", "intent.unknown_outcome", {
          bindingId: i.bindingId,
          taskId: i.taskId,
          params: { intent: i.id, stage: stage ?? null },
        });
      })
      .immediate();
    return { kind: "quarantined", reason: "unknown_outcome" };
  }

  /** A quarantined unknown outcome: the transport may have settled it since (P2-1: only it may). */
  async #settleUnknown(i: Intent): Promise<Outcome> {
    const r = await this.#o.transport.recover(i.id);
    if (r.state !== "done" || !("rev" in r.result) || !r.result.ok)
      return { kind: "skipped", state: i.state };
    this.#o.db
      .transaction(() => {
        this.#o.db
          .prepare(
            "UPDATE intents SET state = 'applied', state_reason = NULL, result_json = ? WHERE id = ?",
          )
          .run(JSON.stringify(r.result), i.id);
        this.#o.db
          .prepare(
            "UPDATE conflicts SET resolved_at = ?, resolution = 'transport_done' WHERE intent_id = ? AND kind = 'unknown_outcome' AND resolved_at IS NULL",
          )
          .run(new Date(this.#now()).toISOString(), i.id);
      })
      .immediate();
    return this.#finalize(this.#intents.get(i.id) as Intent);
  }
}
