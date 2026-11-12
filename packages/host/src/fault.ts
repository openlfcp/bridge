// Fault injection for the owner's verification run (D-010 r4 §7.6, step 22 of
// docs/devel/testing/verification-run.md): a write whose answer is lost after the helper saved it.
// Off unless `lfcp-bridge run` is started with LFCP_BRIDGE_FAULT=lose-next-write-answer, and
// honoured only for a write of a verification binding (its list, or a reminder linked to it):
// the next such write goes to the helper and is answered, then the answer is dropped and the
// helper is killed (SIGKILL) — a crash between the save and the answer. One shot, then off; the
// journal says which opKey (`fault.injected`), as evidence for the report.
//
// What follows is the ordinary path: the transport has no answer, so the stage stays "sent";
// the executor journals effect.lost; the supervisor restarts the helper (it exited); the next
// pass settles the intent: recover(opKey) is unknown (the helper keeps no opKey journal), so the
// intent is quarantined unknown_outcome (B19) — nothing is inferred from the reminder, even though
// the write did happen.

import { type HelperLink, HelperLostError } from "@openlfcp/bridge-transport-eventkit";
import type { BridgeDatabase } from "./db/database.js";
import type { Journal } from "./db/journal.js";

export const FAULT_ENV = "LFCP_BRIDGE_FAULT";
export const LOSE_NEXT_WRITE_ANSWER = "lose-next-write-answer";

/** The reminder writes the fault applies to (not lists or markers: those are the bootstrap's). */
const WRITES = new Set(["items.create", "items.update", "items.restoreUrl"]);

/** The fault asked for in `env`, if it is one this build knows. */
export function faultFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): typeof LOSE_NEXT_WRITE_ANSWER | undefined {
  return env[FAULT_ENV] === LOSE_NEXT_WRITE_ANSWER ? LOSE_NEXT_WRITE_ANSWER : undefined;
}

/**
 * Whether a helper write request belongs to a verification binding: items.create by its list
 * (bindings.target_ref), an update or restoreUrl by its reminder (links of the binding). Unknown
 * → false: the fault never touches a write it cannot place.
 */
export function verificationWrite(
  db: BridgeDatabase,
): (op: string, body: Record<string, unknown>) => boolean {
  return (op, body) => {
    if (op === "items.create") {
      if (typeof body.list !== "string") return false;
      const b = db
        .prepare("SELECT verification FROM bindings WHERE target_ref = ? AND state <> 'removed'")
        .get(body.list) as { verification: number } | undefined;
      return b?.verification === 1;
    }
    const ref = body.ref as { id?: unknown; externalId?: unknown } | undefined;
    const id = typeof ref?.id === "string" ? ref.id : null;
    const externalId = typeof ref?.externalId === "string" ? ref.externalId : null;
    if (id === null && externalId === null) return false;
    const rows = db
      .prepare(
        `SELECT b.verification FROM links l JOIN bindings b ON b.id = l.binding_id
         WHERE b.state <> 'removed' AND (l.rem_id_cache = ? OR l.rem_external_id = ?)`,
      )
      .all(id, externalId) as { verification: number }[];
    return rows.length > 0 && rows.every((r) => r.verification === 1);
  };
}

/** A shot that fires once: shared by the links of one run (a restart brings a new link). */
export interface FaultShot {
  armed: boolean;
}

/**
 * `link` with the fault: the next write `applies` accepts is sent and answered, then the answer
 * is dropped, the helper SIGKILLed and the request rejected as lost. Everything else passes.
 */
export function loseNextWriteAnswer(
  link: HelperLink,
  o: {
    readonly shot: FaultShot;
    readonly applies: (op: string, body: Record<string, unknown>) => boolean;
    readonly journal: Journal;
    readonly kill?: (pid: number) => void;
  },
): HelperLink {
  const kill = o.kill ?? ((pid: number) => process.kill(pid, "SIGKILL"));
  return {
    get ready() {
      return link.ready;
    },
    onEvent: (cb) => link.onEvent(cb),
    onExit: (cb) => link.onExit(cb),
    close: () => link.close(),
    // The hang analysis G4 sees through the wrapper: which writes the helper started, and whether
    // it is gone (the faulted write was started: it stays unknown).
    ...(link.started === undefined ? {} : { started: (id: number) => link.started?.(id) ?? false }),
    ...(link.gone === undefined ? {} : { gone: () => link.gone?.() ?? Promise.resolve(false) }),
    async request(op, body = {}, opts = {}) {
      if (!o.shot.armed || !WRITES.has(op) || !o.applies(op, body))
        return link.request(op, body, opts);
      o.shot.armed = false;
      const answer = await link.request(op, body, opts);
      const opKey = typeof body.opKey === "string" ? body.opKey : "";
      o.journal.append("warn", "fault.injected", {
        params: { fault: LOSE_NEXT_WRITE_ANSWER, op, opKey, answered: answer.ok },
      });
      const pid = link.ready.pid;
      if (typeof pid === "number") {
        try {
          kill(pid);
        } catch {}
      }
      throw new HelperLostError(
        `${op}: the answer was dropped and the helper killed (fault injection, verification run)`,
      );
    },
  };
}
