// FALLBACK for sdk-ts G4 (sdk-ts 504 `deviceIdentity`). Remove when the
// bridge moves to the sdk-ts release that has it: replace with
// `(await deviceIdentity({ storage, installation }))?.root`.
//
// The bridge is a paired device (`lfcp-node pair`): its person's root is the
// `root` of its finished pairing request, an internal format of
// @openlfcp/client 0.5.2 (`intent.root`, `intent.device`). deviceIdentity
// does the same and also checks the approved certificate chain; this reads
// the request only, and only when it was made for this installation's
// Principal. It is used for the filter (who "me" is, D-010 §6.1), never for
// access.

import { OperationJournal } from "@openlfcp/client";
import { bytesEqual, fromHex, type PrincipalId, principalId } from "@openlfcp/core";
import type { LfcpStorage } from "@openlfcp/storage";

const HEX = /^[0-9a-f]+$/;

/** The person's root of this installation (`device`), from its finished pairing request; undefined without one. */
export async function deviceRoot(
  storage: Pick<LfcpStorage, "control" | "commit" | "localMarks">,
  device: PrincipalId,
): Promise<PrincipalId | undefined> {
  const ops = await new OperationJournal(storage).list({ kind: "pairing-request", status: "done" });
  for (const op of [...ops].sort((a, b) => b.createdAt - a.createdAt)) {
    const { root, device: asked } = op.intent as { root?: unknown; device?: unknown };
    if (typeof root !== "string" || typeof asked !== "string") continue;
    if (!HEX.test(root) || !HEX.test(asked)) continue;
    if (!bytesEqual(principalId(fromHex(asked)), device)) continue;
    return principalId(fromHex(root));
  }
  return undefined;
}
