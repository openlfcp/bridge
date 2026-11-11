// The run process of lfcp-bridge (D-010 r4 §2, §5.1–§5.9, §7.6; PR 9b): the pieces of PRs 3–13
// in one loop.
//
// start:  Safe Mode (runs) → open the bound sections, start the SectionHosts → ownership check of
//         every binding (§6.5) → recover open intents (§5.7) → the helper's write mode → a full
//         pass of every binding → the triggers.
// a pass of one binding (one at a time per binding; a trigger during a pass runs it again after):
//         plan (PR 8, recorded in runs) → only an approved binding the write gate allows applies
//         (B16: a verification binding, or writesVerified) → LinkApplier checks the whole pass and
//         applies the link transitions (PR 12) → the "bases" / "shadow" decisions → the prepared
//         intents run (PR 7), with every due retry. Anything else stays a dry run.
// triggers (§5.1): a section's remote or rebuilt nodes, lfcp_live coming back, the transport's
//         change hint (EventKit: coarse) — debounced 400 ms, at most 3 s; wake → the ownership
//         check again, networkBack, a full pass; a timer: a full pass every 15 min.
// delivery (§5.9): every batch status of a section goes to deliver().
// stop:   the triggers off, the passes in flight finished, the process run closed.

import type { RemindersTransport } from "@openlfcp/bridge-reminders";
import type { BatchStatus, Receipt } from "@openlfcp/client";
import { fromHex, type PrincipalId, type ResourceId, resourceId, toHex } from "@openlfcp/core";
import type { BridgeDatabase } from "../db/database.js";
import { Holds } from "../db/holds.js";
import { Journal } from "../db/journal.js";
import { Executor, type Gates, type Outcome } from "../executor/executor.js";
import { Runs } from "../executor/safe-mode.js";
import { type AccessChange, applyAccessHolds } from "../lfcp/access.js";
import { deliver } from "../lfcp/delivery.js";
import type { LiveChange } from "../lfcp/live.js";
import type { GuardedCommit, GuardedCommitResult, RebuiltEvent } from "../lfcp/section-host.js";
import { OwnershipGuard } from "../ownership.js";
import { recordDecisions } from "../reconcile/bases.js";
import { bridgeHandler, currentLfcp } from "../reconcile/handler.js";
import { LinkApplier } from "../reconcile/links.js";
import { Pass } from "../reconcile/pass.js";
import type { LfcpReader } from "../reconcile/section-view.js";

/** What the process needs of a SectionHost (the real one, or a test's). */
export interface SectionHostPort extends LfcpReader {
  open(resource: ResourceId): Promise<void>;
  isOpen(resource: ResourceId): boolean;
  start(): void;
  stop(): Promise<void>;
  commitGuarded(c: GuardedCommit): Promise<GuardedCommitResult>;
  onNodesChanged(
    listener: (
      resource: ResourceId,
      e: { readonly origin: "local" | "remote" | "rebuild" },
    ) => void,
  ): () => void;
  onRebuilt(listener: (e: RebuiltEvent) => void): () => void;
  onLiveChange(listener: (c: LiveChange) => void): () => void;
  onBatch(listener: (resource: ResourceId, b: BatchStatus) => void): () => void;
  networkBack(): void;
  readonly connected: boolean;
}

/** One installation of the bridge: its SectionHost, its access readiness, who it is. */
export interface InstallationPorts {
  readonly id: string;
  readonly host: SectionHostPort;
  receipt(resource: ResourceId, operationId: string): Promise<Receipt | undefined>;
  /** access_checked_now / offline_commit_allowed (§5.3; an AccessTracker). */
  readonly access: {
    accessCheckedNow(resource: ResourceId): boolean;
    offlineCommitAllowed(resource: ResourceId): boolean;
    /** Answers as they come (an AccessTracker): the process sets or lifts access_refused (§5.9). */
    onChange?(listener: (c: AccessChange) => void): () => void;
  };
  /** The person's root as a PrincipalRef, for the filter (deviceIdentity). */
  readonly me?: string;
  /** This installation's Principal: created_by of imported Tasks. */
  readonly createdBy?: PrincipalId;
  /** A blocked batch (§5.9): the access tracker asks revocationStatus. */
  readonly onBlocked?: (resourceHex: string) => void;
}

export type WriteModeTransport = RemindersTransport & {
  setWriteMode?: (mode: "off" | "bootstrap" | "verification" | "verified") => Promise<void>;
};

export interface BridgeProcessOptions {
  readonly db: BridgeDatabase;
  readonly transport: WriteModeTransport;
  readonly installations: readonly InstallationPorts[];
  /** This bridge's instance id (config.json): its ownership markers (§6.5). */
  readonly instanceId: string;
  /** writesVerified holds for this helper build and macOS (§7.6). */
  readonly writesVerified: () => boolean;
  /** STOP is set (§7.3). */
  readonly stopped: () => boolean;
  readonly timeZone?: string;
  readonly now?: () => number;
  readonly debounceMs?: number;
  readonly maxDelayMs?: number;
  readonly fullEveryMs?: number;
  /**
   * How often the control state (STOP, holds, acceptances) is looked at (default 2 s): a change
   * by `stop` / `resume` / `resume --accept` from another process wakes a full pass.
   */
  readonly controlEveryMs?: number;
  /** Holds lifted by a person since the last look (helper_unavailable: the supervisor resumes). */
  readonly onHoldsLifted?: (reasons: ReadonlySet<string>) => void;
  readonly timers?: {
    setTimeout(fn: () => void, ms: number): unknown;
    clearTimeout(h: unknown): void;
    setInterval(fn: () => void, ms: number): unknown;
    clearInterval(h: unknown): void;
  };
}

export type PassOutcome =
  | { readonly kind: "dry"; readonly runId: string; readonly why: "pending_dry_run" | "gate" }
  | { readonly kind: "refused"; readonly runId: string; readonly reason: string }
  | { readonly kind: "held"; readonly runId: string; readonly holds: readonly string[] }
  | {
      readonly kind: "applied";
      readonly runId: string;
      readonly outcomes: readonly Outcome[];
      readonly recorded: number;
    }
  | { readonly kind: "skipped"; readonly reason: string };

interface BindingRow {
  id: string;
  installation_id: string;
  resource_id: string;
  state: string;
  verification: number;
}

const defaultTimers = {
  setTimeout: (fn: () => void, ms: number) => {
    const h = setTimeout(fn, ms);
    h.unref?.();
    return h;
  },
  clearTimeout: (h: unknown) => clearTimeout(h as NodeJS.Timeout),
  setInterval: (fn: () => void, ms: number) => {
    const h = setInterval(fn, ms);
    h.unref?.();
    return h;
  },
  clearInterval: (h: unknown) => clearInterval(h as NodeJS.Timeout),
};

export class BridgeProcess {
  readonly #o: BridgeProcessOptions;
  readonly #now: () => number;
  readonly #timers: NonNullable<BridgeProcessOptions["timers"]>;
  readonly #journal: Journal;
  readonly #holds: Holds;
  readonly #runs: Runs;
  readonly #ownership: OwnershipGuard;
  readonly #executor: Executor;
  readonly #links: LinkApplier;
  readonly #installations: ReadonlyMap<string, InstallationPorts>;
  readonly #running = new Map<string, Promise<PassOutcome>>();
  readonly #again = new Set<string>();
  readonly #scheduled = new Map<string, { handle: unknown; first: number }>();
  /** The pass triggers: off first at stop. */
  #triggers: (() => void)[] = [];
  /** Delivery and access: on from before the SDK starts until after it stopped (§5.2, §5.9). */
  #lifecycle: (() => void)[] = [];
  #interval: unknown;
  #control: unknown;
  #controlSeen = "";
  #holdsSeen = new Set<string>();
  /** start() has made its full pass: triggers before it are covered by that pass. */
  #ready = false;
  #runId: string | undefined;
  #stopping = false;

  constructor(options: BridgeProcessOptions) {
    this.#o = options;
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? defaultTimers;
    this.#journal = new Journal(options.db, this.#now);
    this.#holds = new Holds(options.db, this.#now);
    this.#runs = new Runs(options.db, this.#now);
    this.#installations = new Map(options.installations.map((i) => [i.id, i]));
    this.#ownership = new OwnershipGuard(
      options.db,
      this.#holds,
      this.#journal,
      options.transport,
      options.instanceId,
    );
    const inst = (installationId: string) => this.#installations.get(installationId);
    const gates: Gates = {
      stopped: () => options.stopped(),
      safeMode: () => this.#runs.safeMode() !== undefined,
      ownershipChecked: (b) => this.#ownership.isChecked(b),
      accessCheckedNow: (i, R) => inst(i)?.access.accessCheckedNow(R) ?? false,
      offlineCommitAllowed: (i, R) => inst(i)?.access.offlineCommitAllowed(R) ?? false,
      connected: (i) => inst(i)?.host.connected ?? false,
    };
    this.#executor = new Executor({
      db: options.db,
      transport: options.transport,
      lfcp: {
        commitGuarded: (c) => this.#hostOf(c.resource).commitGuarded(c),
        receipt: (r, op) => this.#installationOf(r).receipt(r, op),
      },
      gates,
      handler: bridgeHandler({ timeZone: this.#timeZone(), now: this.#now }),
      // §7.6, B16: an approved binding writes only if it is a verification binding, or writesVerified.
      effects: { enabled: true, permit: (i) => this.#writable(i.bindingId) },
      now: this.#now,
    });
    this.#links = new LinkApplier({ db: options.db, transport: options.transport, now: this.#now });
  }

  get executor(): Executor {
    return this.#executor;
  }

  /** Starts the process: see the header. */
  async start(): Promise<void> {
    seedInstanceId(this.#o.db, this.#o.instanceId, this.#journal);
    const started = this.#runs.start();
    this.#runId = started.runId;
    for (const b of this.#bindings()) {
      const host = this.#installations.get(b.installation_id)?.host;
      const R = resourceId(fromHex(b.resource_id));
      if (host !== undefined && !host.isOpen(R)) await host.open(R);
    }
    // Subscribed before any exchange starts (§5.2): a batch status of a stored operation can come
    // at once, and SectionHost does not replay it (review PR 9b #25). Triggers until the full
    // pass below are covered by it.
    this.#subscribe();
    for (const i of this.#installations.values()) i.host.start();
    await this.#ownership.checkAll();
    // §5.7 at the start, without sending: the passes below send what is still wanted (#31).
    for (const b of this.#bindings()) await this.#executor.settle(b.id);
    await this.#writeMode();
    this.#ready = true;
    await this.passAll();
    this.#interval = this.#timers.setInterval(
      () => void this.passAll(),
      this.#o.fullEveryMs ?? 15 * 60_000,
    );
    this.#controlSeen = this.#controlState();
    this.#holdsSeen = this.#holdKeys();
    this.#control = this.#timers.setInterval(
      () => this.#lookAtControl(),
      this.#o.controlEveryMs ?? 2000,
    );
  }

  /**
   * Stops it: no new pass; the ones in flight finish; the sections stop, delivery still
   * listening until they have (review PR 9b #25); the run is closed. A pass or a section that
   * failed makes the run's outcome "failed: …" and stop() rejects with them (review PR 9b #26).
   */
  async stop(reason = "exit"): Promise<void> {
    this.#stopping = true;
    for (const u of this.#triggers) u();
    this.#triggers = [];
    if (this.#interval !== undefined) this.#timers.clearInterval(this.#interval);
    if (this.#control !== undefined) this.#timers.clearInterval(this.#control);
    for (const sc of this.#scheduled.values()) this.#timers.clearTimeout(sc.handle);
    this.#scheduled.clear();
    this.#again.clear();
    const errors: unknown[] = [];
    for (const r of await Promise.allSettled([...this.#running.values()]))
      if (r.status === "rejected") errors.push(r.reason);
    for (const i of this.#installations.values())
      try {
        await i.host.stop();
      } catch (e) {
        errors.push(e);
      }
    for (const u of this.#lifecycle) u();
    this.#lifecycle = [];
    if (this.#runId !== undefined)
      this.#runs.end(
        this.#runId,
        errors.length === 0
          ? reason
          : `failed: ${errors.map((e) => (e instanceof Error ? e.message : String(e))).join("; ")}`,
      );
    if (errors.length > 0) throw new AggregateError(errors, "the run process did not stop cleanly");
  }

  /** A full pass of every binding (start, rebuild, the timer, wake). */
  async passAll(): Promise<readonly PassOutcome[]> {
    return Promise.all(this.#bindings().map((b) => this.pass(b.id)));
  }

  /**
   * One pass of a binding, after the one in flight (one at a time per binding). A pass asked
   * while one runs makes it run once more after it.
   */
  pass(bindingId: string): Promise<PassOutcome> {
    if (this.#stopping) return Promise.resolve({ kind: "skipped", reason: "stopping" });
    const current = this.#running.get(bindingId);
    if (current !== undefined) {
      this.#again.add(bindingId);
      return current;
    }
    const p = this.#passNow(bindingId).finally(() => {
      this.#running.delete(bindingId);
      if (this.#again.delete(bindingId) && !this.#stopping) void this.pass(bindingId);
    });
    this.#running.set(bindingId, p);
    return p;
  }

  /** A trigger: the binding's pass after debounceMs of quiet, at most maxDelayMs after the first. */
  schedule(bindingId: string): void {
    if (this.#stopping || !this.#ready) return;
    const now = this.#now();
    const s = this.#scheduled.get(bindingId);
    const first = s?.first ?? now;
    if (s !== undefined) this.#timers.clearTimeout(s.handle);
    const wait = Math.max(
      0,
      Math.min(this.#o.debounceMs ?? 400, first + (this.#o.maxDelayMs ?? 3000) - now),
    );
    const handle = this.#timers.setTimeout(() => {
      this.#scheduled.delete(bindingId);
      void this.pass(bindingId);
    }, wait);
    this.#scheduled.set(bindingId, { handle, first });
  }

  /** Every pass scheduled or running is done (tests, a clean stop). */
  async idle(): Promise<void> {
    while (this.#running.size > 0 || this.#scheduled.size > 0) {
      await Promise.allSettled([...this.#running.values()]);
      if (this.#running.size === 0 && this.#scheduled.size > 0)
        await new Promise((r) => setTimeout(r, 5));
    }
  }

  // ------------------------------------------------------------------ a pass

  async #passNow(bindingId: string): Promise<PassOutcome> {
    const b = this.#binding(bindingId);
    if (b === undefined) return { kind: "skipped", reason: "no_binding" };
    const inst = this.#installations.get(b.installation_id);
    if (inst === undefined) return { kind: "skipped", reason: "installation_not_open" };
    // §6.5: ownership on every pass, before any transition or effect (review PR 9b #23); an
    // incomplete search leaves the binding unchecked, so the executor writes nothing.
    await this.#ownership.check(b.id, b.resource_id);
    // An answer lost while running (B19): settled now, not at the next start (review PR 9b #27) —
    // this binding's only, and without sending: a not_started intent goes after the plan and the
    // link transitions, which may supersede it (review PR 9b #31).
    if (this.#o.transport.status().state === "ok") await this.#executor.settle(b.id);
    const apply = b.state === "active" && this.#writable(b.id);
    const pass = new Pass({
      db: this.#o.db,
      transport: this.#o.transport,
      lfcp: inst.host,
      me: async () => inst.me,
      ...(inst.createdBy === undefined ? {} : { createdBy: async () => inst.createdBy }),
      timeZone: this.#timeZone(),
      now: this.#now,
    });
    const r = await pass.plan(b.id, apply ? "apply" : "dry");
    if (r.kind !== "planned") return { kind: "refused", runId: r.runId, reason: r.reason };
    if (!apply)
      return {
        kind: "dry",
        runId: r.runId,
        why: b.state === "pending_dry_run" ? "pending_dry_run" : "gate",
      };
    const applied = await this.#links.apply(b.id, r.plan, {
      executor: this.#executor,
      guards: r.guards,
      runId: r.runId,
    });
    if (applied.kind === "held") return { kind: "held", runId: r.runId, holds: applied.holds };
    const recorded = recordDecisions(this.#o.db, r.plan, this.#now);
    const outcomes: Outcome[] = [];
    for (const i of applied.prepared) outcomes.push(await this.#executor.run(i.id));
    // This binding's queue only: another binding's waits for its own plan and transitions.
    for (const o of await this.#executor.runDue(b.id)) outcomes.push(o);
    return { kind: "applied", runId: r.runId, outcomes, recorded };
  }

  // ------------------------------------------------------------------ gates and lookups

  /** The write gate (§7.6, B16): a verification binding, or writesVerified. */
  #writable(bindingId: string): boolean {
    const b = this.#binding(bindingId);
    return b !== undefined && (b.verification === 1 || this.#o.writesVerified());
  }

  /** The helper's write mode for synchronization: verified, else verification if any, else off. */
  async #writeMode(): Promise<void> {
    const anyVerification = this.#bindings().some((b) => b.verification === 1);
    await this.#o.transport.setWriteMode?.(
      this.#o.writesVerified() ? "verified" : anyVerification ? "verification" : "off",
    );
  }

  #bindings(): BindingRow[] {
    return this.#o.db
      .prepare(
        "SELECT id, installation_id, resource_id, state, verification FROM bindings WHERE state IN ('pending_dry_run','active') ORDER BY id",
      )
      .all() as BindingRow[];
  }

  #binding(id: string): BindingRow | undefined {
    return this.#o.db
      .prepare(
        "SELECT id, installation_id, resource_id, state, verification FROM bindings WHERE id = ? AND state IN ('pending_dry_run','active')",
      )
      .get(id) as BindingRow | undefined;
  }

  #installationOf(resource: ResourceId): InstallationPorts {
    const hex = toHex(resource);
    const b = this.#bindings().find((x) => x.resource_id === hex);
    const inst = b === undefined ? undefined : this.#installations.get(b.installation_id);
    if (inst === undefined) throw new Error(`no open installation for section ${hex}`);
    return inst;
  }

  #hostOf(resource: ResourceId): SectionHostPort {
    return this.#installationOf(resource).host;
  }

  #timeZone(): string {
    return this.#o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  // ------------------------------------------------------------------ triggers

  #subscribe(): void {
    const ofResource = (r: ResourceId | null) => {
      if (r === null) return this.#bindings();
      const hex = toHex(r);
      return this.#bindings().filter((b) => b.resource_id === hex);
    };
    for (const inst of this.#installations.values()) {
      const h = inst.host;
      this.#lifecycle.push(
        h.onBatch((r, status) => {
          deliver(this.#o.db, status, {
            current: currentLfcp(() => h.replica(r)),
            now: this.#now,
            ...(inst.onBlocked === undefined ? {} : { onBlocked: inst.onBlocked }),
          });
        }),
        ...(inst.access.onChange === undefined
          ? []
          : [
              inst.access.onChange((c) => {
                applyAccessHolds(this.#o.db, inst.id, c.resource, c.answer);
                for (const b of ofResource(c.resource)) this.schedule(b.id);
              }),
            ]),
      );
      this.#triggers.push(
        // Own commits change nothing to plan: their bases come with finalize.
        h.onNodesChanged((r, e) => {
          if (e.origin !== "local") for (const b of ofResource(r)) this.schedule(b.id);
        }),
        h.onRebuilt((e) => {
          if (this.#ready) for (const b of ofResource(e.resource)) void this.pass(b.id);
        }),
        // LIVE again: conclusions from LFCP absence are possible now.
        h.onLiveChange((c) => {
          if (c.live) for (const b of ofResource(c.resource)) this.schedule(b.id);
        }),
      );
    }
    const t = this.#o.transport;
    this.#triggers.push(
      // EventKit's hint is coarse: every binding.
      t.onChange(() => {
        for (const b of this.#bindings()) this.schedule(b.id);
      }),
      t.onSystem((e) => {
        if (e === "wake") void this.#wake();
        else if (e === "access_changed") for (const b of this.#bindings()) this.schedule(b.id);
      }),
    );
  }

  /** STOP, the holds and the acceptances, as one string: a change is a person's command. */
  #controlState(): string {
    const holds = this.#o.db
      .prepare("SELECT binding_id, reason FROM binding_holds ORDER BY binding_id, reason")
      .all() as { binding_id: string; reason: string }[];
    const accepted = this.#o.db
      .prepare("SELECT key FROM meta WHERE key LIKE 'hold_accepted%' ORDER BY key")
      .all() as { key: string }[];
    // A command's sequence: a stop and a resume between two looks is still seen.
    const seq = this.#o.db.prepare("SELECT value FROM meta WHERE key = 'control_seq'").get() as
      | { value: string }
      | undefined;
    return JSON.stringify([this.#o.stopped(), holds, accepted, seq?.value ?? "0"]);
  }

  #holdKeys(): Set<string> {
    return new Set(
      (
        this.#o.db.prepare("SELECT binding_id, reason FROM binding_holds").all() as {
          binding_id: string;
          reason: string;
        }[]
      ).map((h) => `${h.binding_id}\u0000${h.reason}`),
    );
  }

  /**
   * `stop` / `resume` / `resume --accept` run as other processes (review PR 9b #28): when the
   * control state changed, the lifted holds go to onHoldsLifted (helper_unavailable → the
   * supervisor resumes) and every binding gets a full pass — its gates and ownership checked again.
   */
  #lookAtControl(): void {
    if (this.#stopping) return;
    const now = this.#controlState();
    if (now === this.#controlSeen) return;
    this.#controlSeen = now;
    const holds = this.#holdKeys();
    const lifted = new Set<string>();
    for (const k of this.#holdsSeen) if (!holds.has(k)) lifted.add(k.split("\u0000")[1] as string);
    this.#holdsSeen = holds;
    if (lifted.size > 0) this.#o.onHoldsLifted?.(lifted);
    void this.passAll();
  }

  /** wake (§2.2, §5.3, §6.5): ownership unchecked until checked again; the network back; a full pass. */
  async #wake(): Promise<void> {
    this.#ownership.reset();
    for (const i of this.#installations.values()) i.host.networkBack();
    await this.#ownership.checkAll();
    await this.passAll();
  }
}

/**
 * One bridge instance id for markers (config.json, §6.5) and task links' `b` (meta, PR 8): the
 * config's goes to meta. A different one already there is replaced only while no link carries it.
 */
export function seedInstanceId(db: BridgeDatabase, instanceId: string, journal?: Journal): void {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'bridge_instance_id'").get() as
    | { value: string }
    | undefined;
  if (row?.value === instanceId) return;
  const links = (db.prepare("SELECT count(*) AS n FROM links").get() as { n: number }).n;
  if (row !== undefined && links > 0) {
    journal?.append("warn", "bridge.instance_mismatch", {
      params: { meta: row.value, config: instanceId },
    });
    return;
  }
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('bridge_instance_id', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
  ).run(instanceId);
}

/**
 * A person's command for a running process (stop, resume, resume --accept): the run process
 * notices it at its next look at the control state, however short the command was.
 */
export function bumpControl(db: BridgeDatabase): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('control_seq', '1') ON CONFLICT (key) DO UPDATE SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT)",
  ).run();
}
