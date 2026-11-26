// The cold connection of the synthetic year (A§3.5, T§3): a new personal client of the root, in a
// process of its own, connects to `C` with nothing stored — the chain, its key, then the Snapshot
// and the tail — and is ready when it reads the status the bridge wrote last. It prints one JSON
// line: the time to ready, the time its profile spent admitting units, the peak memory (maxRSS).
//
//   node c-year-cold.mjs '{"url":…,"C":<hex>,"signing":<hex>,"agreement":<hex>,"heartbeatAt":…,"waitMs":…}'
//
// It gives up `waitMs` after its start (the parent's timeout less a margin) and then says how far it
// got: the time of each phase, the units admitted, the state of `C`.

import {
  connectionNetwork,
  DataUnitApplier,
  dekResolver,
  fetchDeks,
  loadControlChain,
  OutboundQueue,
  SyncClient,
  serviceControlPort,
  serviceControlSignerFacts,
  startSyncDriver,
  syncChain,
} from "@openlfcp/client";
import { fromHex } from "@openlfcp/core";
import { importAgreementKey, importSigningKey } from "@openlfcp/crypto";
import {
  ServiceControlDataProfile,
  serviceControlSignerClass,
} from "@openlfcp/shared-objects/service-control";
import { InMemoryLfcpStorage, InMemorySecretStore } from "@openlfcp/storage";
import {
  controlRecordSigner,
  decodeControlRecord,
  principalDescriptorFromKeys,
} from "@openlfcp/wire";

const o = JSON.parse(process.argv[2] ?? "{}");
const started = performance.now();
const deadline = Date.now() + (o.waitMs ?? 300_000);
const phases = {};
const phase = (name) => {
  phases[name] = Math.round(performance.now() - started);
};
const C = fromHex(o.C);
const key = importSigningKey(Buffer.from(o.signing, "hex"));
const agreement = importAgreementKey(Buffer.from(o.agreement, "hex"));
const signer = { key, descriptor: principalDescriptorFromKeys(key, agreement) };
const storage = new InMemoryLfcpStorage();
const secrets = new InMemorySecretStore();

const ch = await connectionNetwork({ now: () => Date.now() }).connect(signer, o.url);
const chain = await syncChain(storage, ch, C);
phase("chainMs");
await fetchDeks(storage, secrets, ch, chain, { signer, agreement });
phase("deksMs");
ch.close();
if ((await loadControlChain(storage, C))?.kind !== "linear") throw new Error("no chain of C");

const genesis = decodeControlRecord((await storage.control.records(C))[0].bytes);
const profile = new ServiceControlDataProfile({
  resource: C,
  root: genesis.body.owner.principalId,
  genesisSigner: controlRecordSigner(genesis),
  signerClassOf: (u) =>
    u.control === undefined
      ? "other"
      : serviceControlSignerClass(serviceControlSignerFacts(u.control, u.actor)),
});
let admissionMs = 0;
let admittedUnits = 0;
const timed =
  (f, count) =>
  (...a) => {
    const t = performance.now();
    try {
      return f(...a);
    } finally {
      admissionMs += performance.now() - t;
      admittedUnits += count(...a);
    }
  };
const snapshot = profile.snapshotBinding();
const client = new SyncClient({
  url: o.url,
  signer,
  agreement,
  storage,
  secrets,
  outbound: new OutboundQueue({ storage }),
  now: () => Date.now(),
});
client.open({
  resourceId: C,
  applier: new DataUnitApplier({
    storage,
    dek: dekResolver(storage, secrets, C),
    handlers: [
      {
        dataProfile: profile.dataProfile,
        codecFor: (u) => profile.codecFor(u),
        apply: timed(
          (u, v) => profile.apply(u, v),
          () => 1,
        ),
        applyBatch: timed(
          (units) => profile.applyBatch(units),
          (units) => units.length,
        ),
        exclude: (ids) => profile.exclude(ids),
        has: (id) => profile.has(id),
        reset: () => profile.reset(),
      },
    ],
  }),
  commit: profile.commitBinding(signer.descriptor.principalId, "personal"),
  snapshot,
});
const port = serviceControlPort({
  client,
  profile,
  resource: C,
  synchronised: () => client.resourceState(C) === "LIVE",
});
client.start();
const stopDriver = startSyncDriver(
  client,
  { now: () => Date.now(), setInterval, clearInterval },
  100,
);
phase("startMs");
while (port.state()?.status?.heartbeatAt !== o.heartbeatAt) {
  if (Date.now() > deadline) {
    const progress = {
      ...phases,
      waitedMs: Math.round(performance.now() - started),
      admissionMs: Math.round(admissionMs),
      admittedUnits,
      state: client.resourceState(C),
      lastHeartbeatAt: port.state()?.status?.heartbeatAt ?? null,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    };
    throw new Error(`the cold client never read the last status: ${JSON.stringify(progress)}`);
  }
  await new Promise((r) => setTimeout(r, 20));
}
const coldMs = performance.now() - started;
stopDriver();
await client.stop();
process.stdout.write(
  `${JSON.stringify({
    coldMs: Math.round(coldMs),
    admissionMs: Math.round(admissionMs),
    maxRssBytes: process.resourceUsage().maxRSS * 1024,
  })}\n`,
);
process.exit(0);
