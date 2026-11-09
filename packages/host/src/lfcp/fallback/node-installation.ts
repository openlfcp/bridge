// FALLBACK for sdk-ts G3 (spike B-001; sdk-ts 504 `openNodeInstallation`).
// Remove when the bridge moves to the sdk-ts release that has it: replace
// every use with `openNodeInstallation` from @openlfcp/storage-node.
//
// The installation of a state directory as `lfcp-node pair` (storage-node
// 0.5.2) made it: lfcp.sqlite, secrets/ and installation.json; and the
// options of the identity flows on the real network. Unlike 504 it keeps no
// identity session for reuse (that is 501): each flow call opens its own.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  connectionNetwork,
  type IdentityFlowOptions,
  type IdentityNetwork,
  type Installation,
} from "@openlfcp/client";
import { sharedObjectsUnitProfile } from "@openlfcp/shared-objects";
import { identityUnitProfile } from "@openlfcp/shared-objects/identity";
import { sectionsUnitProfile } from "@openlfcp/shared-objects/sections";
import {
  FileSecretStore,
  identityDocument,
  openInstallation,
  SqliteLfcpStorage,
} from "@openlfcp/storage-node";

export interface NodeInstallation {
  readonly state: string;
  readonly installation: Installation;
  readonly storage: SqliteLfcpStorage;
  readonly secrets: FileSecretStore;
  /** What every identity flow takes. */
  readonly flow: IdentityFlowOptions;
  close(): void;
}

/** Opens (creating, 0700) the installation in `state`. */
export async function openNodeInstallation(
  state: string,
  options: { readonly network?: IdentityNetwork; readonly now?: () => number } = {},
): Promise<NodeInstallation> {
  const now = options.now ?? (() => Date.now());
  mkdirSync(state, { recursive: true, mode: 0o700 });
  const secrets = new FileSecretStore(join(state, "secrets"));
  const storage = SqliteLfcpStorage.open(join(state, "lfcp.sqlite"));
  try {
    const installation = await openInstallation(state, secrets);
    const network =
      options.network ??
      connectionNetwork({
        now,
        timeout: () =>
          new Promise<void>((r) => {
            setTimeout(r, 30_000).unref();
          }),
      });
    return Object.freeze({
      state,
      installation,
      storage,
      secrets,
      flow: {
        installation,
        storage,
        secrets,
        network,
        now,
        document: identityDocument,
        profiles: [sharedObjectsUnitProfile, sectionsUnitProfile, identityUnitProfile],
      },
      close: () => storage.close(),
    });
  } catch (e) {
    storage.close();
    throw e;
  }
}
