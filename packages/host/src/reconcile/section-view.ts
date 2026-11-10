// The LFCP side of a pass (D-010 §5.5 step 1): the section's Tasks from the
// replica, as the adapter reads them, and lfcp_live.

import type { LfcpTask } from "@openlfcp/bridge-reminders/adapter";
import type { ResourceId } from "@openlfcp/core";
import type { SectionReplica } from "@openlfcp/shared-objects/sections";

export interface LfcpSectionView {
  readonly tasks: readonly LfcpTask[];
  /** Task nodes whose Task cannot be read now (no valid provisional Task). */
  readonly unreadable: readonly string[];
  /** lfcp_live (§5.3) of the section now. */
  readonly live: boolean;
}

/** What a pass needs of the LFCP side (a SectionHost, or a test double). */
export interface LfcpReader {
  replica(resource: ResourceId): SectionReplica | undefined;
  isLive(resource: ResourceId): boolean;
}

/** The section's Tasks (every Task node, deleted ones too); undefined when the section is not open. */
export function sectionView(lfcp: LfcpReader, resource: ResourceId): LfcpSectionView | undefined {
  const replica = lfcp.replica(resource);
  if (replica === undefined) return undefined;
  const tasks: LfcpTask[] = [];
  const unreadable: string[] = [];
  const seen = new Set<string>();
  for (const node of Object.values(replica.snapshot().nodes)) {
    const id = node.taskId;
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    const t = replica.task(id)?.task;
    if (t === undefined) {
      unreadable.push(id);
      continue;
    }
    tasks.push({
      id: t.id,
      lifecycle: t.lifecycle,
      title: t.title,
      status: t.status,
      ...(t.due === undefined ? {} : { due: t.due }),
      ...(t.completion_date === undefined ? {} : { completion_date: t.completion_date }),
      priority: t.priority,
      assignees: t.assignees,
    });
  }
  return { tasks, unreadable, live: lfcp.isLive(resource) };
}
