// Test support for the LFCP side: installations, a section Resource owned by
// one of them, stored locally (chain + epoch-0 key) as a pairing or a
// creation leaves it.

import type { WebSocketFactory, WebSocketLike } from "@openlfcp/client";
import { saveControlChain, storeDek } from "@openlfcp/client";
import { dataEpoch, generateObjectId, generateResourceId, type ResourceId } from "@openlfcp/core";
import {
  dekCommitment,
  generateAgreementKeyPair,
  generateResourceDEK,
  generateSigningKeyPair,
  type ResourceDEK,
} from "@openlfcp/crypto";
import { createTask, type Task } from "@openlfcp/shared-objects";
import { SECTIONS_PROFILE_ID } from "@openlfcp/shared-objects/sections";
import { InMemoryLfcpStorage, InMemorySecretStore, type LfcpStorage } from "@openlfcp/storage";
import {
  principalDescriptorFromKeys,
  signControlRecord,
  validateControlChain,
} from "@openlfcp/wire";

export function installation() {
  const key = generateSigningKeyPair();
  const agreement = generateAgreementKeyPair();
  return { signer: { key, descriptor: principalDescriptorFromKeys(key, agreement) }, agreement };
}
export type Party = ReturnType<typeof installation>;

/** A section Resource owned by `owner`: its Genesis (to host) and, stored in `storage`, its chain and key. */
export async function ownedSection(
  owner: Party,
  storage: LfcpStorage,
  secrets: InMemorySecretStore,
  url: string,
): Promise<{ R: ResourceId; genesis: Uint8Array; dek: ResourceDEK }> {
  const R = generateResourceId();
  const dek = generateResourceDEK();
  const genesis = signControlRecord(
    { resourceId: R, controlSeq: 0n, prevControlId: null },
    {
      type: "GENESIS",
      dataProfile: SECTIONS_PROFILE_ID,
      owner: owner.signer.descriptor,
      dekCommitment: dekCommitment(R, dataEpoch(0n), dek),
      endpoints: [{ url, priority: 0n }],
      coordinatorUrl: url,
    },
    owner.signer,
  );
  const chain = validateControlChain([genesis.bytes]);
  if (chain.kind !== "linear") throw new Error(chain.kind);
  const saved = await saveControlChain(storage, chain, null);
  if (!saved.ok) throw new Error("genesis not stored");
  await storeDek(storage, secrets, chain, dataEpoch(0n), dek);
  return { R, genesis: genesis.bytes, dek };
}

export const memory = () => ({
  storage: new InMemoryLfcpStorage(),
  secrets: new InMemorySecretStore(),
});

/** A WebSocket that never connects (an offline host: commits are stored and queued). */
export const offline: WebSocketFactory = () => {
  const ws: WebSocketLike = {
    binaryType: "arraybuffer",
    protocol: "",
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
    send: () => undefined,
    close: () => undefined,
  };
  return ws;
};

export const sectionId = () => generateObjectId();

export function task(title: string, by: Party, due?: string): Task {
  return createTask({
    title,
    createdBy: by.signer.descriptor.principalId,
    ...(due === undefined ? {} : { due }),
  }).task;
}
