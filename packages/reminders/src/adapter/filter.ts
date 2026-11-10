// The binding's filter (D-010 §6.1, r2 §6.1, QB10). `me` is the person's
// root as a PrincipalRef: `deviceIdentity(storage).root` (sdk-ts G4); the
// host passes it in (until 504, from its fallback).
//
// | mode      | in the filter when                                          |
// |-----------|-------------------------------------------------------------|
// | `default` | assignees ∋ me, or (no assignees and a due date) — QB10      |
// | `mine`    | assignees ∋ me                                               |
// | `all`     | always                                                       |
//
// Status is not part of the filter, but a done or cancelled Task never gets
// a new projection. A link the person made from Apple (`origin = apple`) is
// sticky: it never leaves the filter.

import type { LfcpTask } from "./projection.js";

export type FilterMode = "default" | "mine" | "all";

export const isFilterMode = (v: unknown): v is FilterMode =>
  v === "default" || v === "mine" || v === "all";

/** Whether `mode` needs to know who "me" is. */
export const needsMe = (mode: FilterMode): boolean => mode !== "all";

export function inFilter(task: LfcpTask, mode: FilterMode, me: string | undefined): boolean {
  if (mode === "all") return true;
  if (me === undefined) throw new Error(`filter ${mode} needs the person's root (me)`);
  const mine = task.assignees[me] === true;
  if (mode === "mine") return mine;
  const unassigned = Object.keys(task.assignees).length === 0;
  return mine || (unassigned && task.due !== undefined && task.due !== null);
}

/** A Task that may get a new projection: active, in the filter, not closed. */
export function projectable(task: LfcpTask, mode: FilterMode, me: string | undefined): boolean {
  return (
    task.lifecycle === "active" &&
    task.status !== "done" &&
    task.status !== "cancelled" &&
    inFilter(task, mode, me)
  );
}
