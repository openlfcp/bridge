// FALLBACK for sdk-ts G9 (`sectionEnd`). Remove when the bridge moves to the
// sdk-ts release that has it.
//
// Where a new Task goes at the end of a section (D-010 §6.2): under the
// section, after its last visible node at depth 0; first when there is none.
// Read from the replica's tree (SHARED-SECTIONS-PROFILE-01 §6, §9).

import type { SectionReplica } from "@openlfcp/shared-objects/sections";

export function sectionEnd(
  replica: SectionReplica,
): { readonly parent: string; readonly after: string | null } | undefined {
  const sectionId = replica.validate().sectionId;
  if (sectionId === undefined) return undefined;
  const top = replica.tree().tree.filter((e) => e.depth === 0 && e.parent === sectionId);
  return { parent: sectionId, after: top.at(-1)?.id ?? null };
}
