// The Task a new reminder becomes (D-010 §6.2, PR 11). Its id is stable for
// the reminder: a UUIDv7 whose random bits come from a hash of (section,
// binding, the reminder's key — its externalId, else its id), so planning
// the same import again gives the same Task, and a create_task that already
// reached LFCP is not a second Task. Object IDs order nothing (§19), so the
// fixed timestamp says nothing either. No assignee: the person assigns.

import { createHash } from "node:crypto";
import type { NewTaskInput } from "@openlfcp/bridge-reminders/adapter";
import { generateObjectId, type PrincipalId } from "@openlfcp/core";
import { createTask, type TaskPriority } from "@openlfcp/shared-objects";

/** The timestamp of every import id: 2026-01-01T00:00:00Z. */
const EPOCH = Date.UTC(2026, 0, 1);

export function importTaskId(section: string, bindingId: string, key: string): string {
  const h = createHash("sha256")
    .update(`lfcp-bridge/import\0${section}\0${bindingId}\0${key}`)
    .digest();
  return generateObjectId({ now: EPOCH, random: (n) => new Uint8Array(h.subarray(0, n)) });
}

/** The factory a pass gives the adapter: a new Task (profile JSON) for an imported reminder. */
export function importTaskFactory(o: {
  readonly section: string;
  readonly bindingId: string;
  readonly createdBy: PrincipalId;
}): (input: NewTaskInput) => { readonly id: string; readonly task: unknown } {
  return (input) => {
    const id = importTaskId(o.section, o.bindingId, input.key);
    const { task } = createTask({
      id: id as Parameters<typeof createTask>[0]["id"] & string,
      title: input.title,
      createdBy: o.createdBy,
      priority: input.priority as TaskPriority,
      ...(input.due === null ? {} : { due: input.due }),
    });
    return { id, task };
  };
}
