// FALLBACK for sdk-ts G1 (spike B-001; sdk-ts 504 `pairedResources`).
// Remove when the bridge moves to the sdk-ts release that has it: replace
// with `pairedResources({ storage, secrets })` from @openlfcp/client, whose
// `ready` is completePairing's (approval proven, scope, revocation, keys).
//
// storage-node 0.5.2 `lfcp-node pair` stores the chains and keys of the
// granted sections but no Resource rows, and there is no public "my
// Resources": the only list is the pairing journal's `intent.candidates`
// (an internal format of @openlfcp/client 0.5.2). This reads it, and says
// only whether a chain of each is stored here — not that it is usable.

import { OperationJournal } from "@openlfcp/client";
import { fromHex, type ResourceId, resourceId } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";

export interface PairedSection {
  readonly resource: ResourceId;
  readonly name?: string;
  readonly profile: string;
  readonly url: string;
  /** A Control Chain of it is stored here (granted at some point). Not proof that it is usable. */
  readonly chainStored: boolean;
}

interface CandidateJson {
  readonly resource?: unknown;
  readonly url?: unknown;
  readonly profile?: unknown;
  readonly name?: unknown;
}

/** The candidates of this installation's finished pairing request, in its order; [] without one. */
export async function pairedSections(
  storage: Pick<LfcpStorage, "control" | "commit" | "localMarks">,
): Promise<readonly PairedSection[]> {
  const ops = await new OperationJournal(storage).list({ kind: "pairing-request", status: "done" });
  const op = [...ops].sort((a, b) => a.createdAt - b.createdAt).at(-1);
  if (op === undefined) return [];
  const candidates = Array.isArray(op.intent.candidates)
    ? (op.intent.candidates as CandidateJson[])
    : [];
  const out: PairedSection[] = [];
  for (const c of candidates) {
    if (
      typeof c.resource !== "string" ||
      typeof c.url !== "string" ||
      typeof c.profile !== "string"
    )
      continue;
    const resource = resourceId(fromHex(c.resource));
    out.push(
      Object.freeze({
        resource,
        ...(typeof c.name === "string" ? { name: c.name } : {}),
        profile: c.profile,
        url: c.url,
        chainStored: (await storage.control.head(resource)) !== undefined,
      }),
    );
  }
  return Object.freeze(out);
}
