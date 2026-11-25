// The synthetic year of `C` (A§3.5, T§3, E26 №8): a year of C's history written through the real
// sdk-ts APIs against the reference server, by the writers 0.6 has:
//
// - the bridge: the host's own ControlClient (heartbeat every 30 min, binding transitions at most
//   once a minute per binding, events, question resolution, the 7-day cleanup) on a simulated
//   clock, with what the ControlClient does not write yet committed through the same port — a
//   preview at each turn-on and the questions (E-033/E-042 write them);
// - the plugin (the root): answers to the questions and a Snapshot of C once a week.
//
// A transition is a complete check of the binding (lastCompleteCheckAt moves): one binding.put of
// the whole binding, as any other transition of its fields. A section is turned on at the start
// and again once a month (a new generation, then its preview). Times in C are the simulated ones;
// the run goes as fast as the server takes the units.
//
// What it measures is in YearResult; c-year-cold.mjs measures a new personal client's cold
// connection in its own process.

import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  connectionNetwork,
  DataUnitApplier,
  dekResolver,
  fetchDeks,
  leafPayload,
  loadControlChain,
  OutboundQueue,
  queueControlRecord,
  queueKeyPackage,
  SyncClient,
  serviceControlPort,
  serviceControlSignerFacts,
  signChain,
  startSyncDriver,
  syncChain,
} from "@openlfcp/client";
import { dataEpoch, type ResourceId, toBase64url, toHex } from "@openlfcp/core";
import { importAgreementKey, importSigningKey, type ResourceDEK } from "@openlfcp/crypto";
import { principalRef } from "@openlfcp/shared-objects";
import {
  SERVICE_CONTROL_PROFILE_ID,
  ServiceControlDataProfile,
  type ServiceControlIntent,
  type ServiceControlSignerClass,
  serviceControlSignerClass,
} from "@openlfcp/shared-objects/service-control";
import type { LfcpStorage, SecretStore } from "@openlfcp/storage";
import {
  type ControlState,
  controlRecordSigner,
  DEVICE_KIND,
  decodeControlRecord,
  principalDescriptorFromKeys,
  sealKeyPackage,
  signControlRecord,
} from "@openlfcp/wire";
import Database from "better-sqlite3";
import type { BridgeDatabase } from "../../src/db/database.js";
import {
  ControlClient,
  type ControlPort,
  markCompleteCheck,
  nextGeneration,
  SectionHost,
} from "../../src/index.js";
import { memory, ownedSection, type Party } from "./lfcp.js";
import { waitFor } from "./server.js";

export const DAY_MS = 86_400_000;

export interface YearOptions {
  readonly url: string;
  readonly db: BridgeDatabase;
  /** Simulated days (365 for the year). */
  readonly days: number;
  readonly sections?: number;
  readonly transitionsPerDay?: number;
  readonly questionsPerWeek?: number;
  readonly seed?: number;
  /** Progress, once a simulated week. */
  readonly onWeek?: (week: number, units: number) => void;
}

/** A device of the root with its keys as seeds: what a new personal client starts from. */
export interface PersonalSeeds {
  readonly signing: string;
  readonly agreement: string;
}

export interface YearResult {
  readonly C: ResourceId;
  readonly personal: PersonalSeeds;
  /** The status the bridge wrote last: a cold client is ready when it reads it. */
  readonly lastHeartbeatAt: string;
  readonly units: { readonly bridge: number; readonly root: number };
  readonly bytes: { readonly bridge: number; readonly root: number };
  readonly counts: {
    readonly heartbeats: number;
    readonly transitions: number;
    readonly turnOns: number;
    readonly questions: number;
    readonly snapshots: number;
  };
  /**
   * control_exec rows, the answers the cleanup removed from C, and how many of those still have
   * their row, applied (the dedup evidence, A§3.4 step 5): `kept` must equal `cleaned`.
   */
  readonly controlExec: { readonly rows: number; readonly cleaned: number; readonly kept: number };
  readonly wallMs: number;
  stop(): Promise<void>;
  /**
   * Admission of the whole history (A§3.5): a fresh profile over the bridge's stored units, as at a
   * restart with no state (replayStored). After stop().
   */
  admitHistory(): Promise<{ readonly ms: number; readonly units: number }>;
}

/** The measures of a new personal client's cold connection (c-year-cold.mjs, its own process). */
export interface ColdResult {
  readonly coldMs: number;
  readonly admissionMs: number;
  readonly maxRssBytes: number;
}

/** The cold client did not finish (crashed, or past its time): the figures are unknown. */
export interface ColdFailure {
  readonly failed: string;
  readonly elapsedMs: number;
}

/**
 * Runs c-year-cold.mjs as a new personal device of the year's root. A child that fails or runs out
 * of time is a result, not an exception: those budgets wait on sdk-ts (report-only), and the run
 * must still check the history and the dedup evidence and write its figures.
 */
export async function coldConnect(url: string, y: YearResult): Promise<ColdResult | ColdFailure> {
  const arg = JSON.stringify({ url, C: toHex(y.C), ...y.personal, heartbeatAt: y.lastHeartbeatAt });
  const script = fileURLToPath(new URL("./c-year-cold.mjs", import.meta.url));
  const started = performance.now();
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [script, arg], {
      timeout: 600_000,
      maxBuffer: 1 << 20,
    });
    return JSON.parse(stdout.trim().split("\n").at(-1) as string) as ColdResult;
  } catch (e) {
    const err = e as { stderr?: string; killed?: boolean; message?: string };
    const why = err.killed === true ? "killed after the timeout" : (err.message ?? String(e));
    return {
      failed: `${why}${err.stderr ? `: ${err.stderr.slice(-2000)}` : ""}`,
      elapsedMs: Math.round(performance.now() - started),
    };
  }
}

const iso = (ms: number) => `${new Date(ms).toISOString().slice(0, 19)}Z`;

/** A seeded PRNG (mulberry32): the same year for the same seed. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A UUIDv7 at `ms` (§2.1 ids). */
export function uuid7(ms: number): string {
  const b = randomBytes(16);
  b.writeUIntBE(ms, 0, 6);
  b[6] = 0x70 | ((b[6] as number) & 0x0f);
  b[8] = 0x80 | ((b[8] as number) & 0x3f);
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** The bytes the server stores under `dir`. */
export function treeBytes(dir: string): number {
  let n = 0;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    n += e.isDirectory() ? treeBytes(p) : statSync(p).size;
  }
  return n;
}

/**
 * The history of C on the server (A§3.5, the owner's measure): the stored bytes of C's Data Units
 * and Snapshots — the length of each object the reference server keeps, read from its database
 * (`<state_dir>/server.sqlite3`) once it has stopped. Not the size of the database file.
 */
export function historyBytes(
  stateDir: string,
  C: ResourceId,
): { readonly units: number; readonly snapshots: number; readonly total: number } {
  const db = new Database(join(stateDir, "server.sqlite3"), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const id = Buffer.from(toHex(C), "hex");
    const sum = (table: "data_units" | "snapshots") =>
      (
        db
          .prepare(
            `SELECT COALESCE(SUM(length(bytes)), 0) AS n FROM ${table} WHERE resource_id = ?`,
          )
          .get(id) as { n: number }
      ).n;
    const units = sum("data_units");
    const snapshots = sum("snapshots");
    return { units, snapshots, total: units + snapshots };
  } finally {
    db.close();
  }
}

function partyFrom(seeds: PersonalSeeds): Party {
  const key = importSigningKey(Buffer.from(seeds.signing, "hex"));
  const agreement = importAgreementKey(Buffer.from(seeds.agreement, "hex"));
  return { signer: { key, descriptor: principalDescriptorFromKeys(key, agreement) }, agreement };
}

/** A device of A in C's chain (DEVICE_GRANT) with the epoch-0 key for it. */
async function grantDevice(
  a: { storage: LfcpStorage },
  A: Party,
  C: ResourceId,
  dek: ResourceDEK,
  device: Party,
  kind: number,
  mask: bigint[],
): Promise<ReturnType<typeof signChain>> {
  const chain = await loadControlChain(a.storage, C);
  if (chain?.kind !== "linear") throw new Error("no chain of C");
  const root = A.signer.descriptor.principalId;
  const cert = signChain(
    chain.state,
    A.signer,
    leafPayload(root, device.signer.descriptor, kind as 0, mask, kind === 1 ? [C] : []),
  );
  const grant = signControlRecord(
    { resourceId: C, controlSeq: chain.state.seq + 1n, prevControlId: chain.state.head },
    { type: "DEVICE_GRANT", root, chain: cert },
    A.signer,
  );
  await queueControlRecord(a.storage, grant.bytes);
  const kp = await sealKeyPackage({
    resourceId: C,
    epoch: dataEpoch(0n),
    controlHead: grant.recordId,
    recipient: device.signer.descriptor,
    dek,
    signer: A.signer,
  });
  await queueKeyPackage(a.storage, kp.bytes);
  return cert;
}

/** The profile of C as SectionHost.openControl builds it. */
async function controlProfile(storage: LfcpStorage, C: ResourceId) {
  const first = (await storage.control.records(C))[0];
  if (first === undefined) throw new Error("no chain of C");
  const genesis = decodeControlRecord(first.bytes);
  if (genesis.body.type !== "GENESIS") throw new Error("no Genesis");
  return new ServiceControlDataProfile({
    resource: C,
    root: genesis.body.owner.principalId,
    genesisSigner: controlRecordSigner(genesis),
    signerClassOf: (u) =>
      u.control === undefined
        ? "other"
        : serviceControlSignerClass(serviceControlSignerFacts(u.control as ControlState, u.actor)),
  });
}

/**
 * The plugin's side of C: SectionHost.openControl's wiring plus the Snapshot binding (the bridge
 * never publishes one; the human's clients do, SOP §13).
 */
export async function publishingControl(o: {
  url: string;
  installation: Party;
  storage: LfcpStorage;
  secrets: SecretStore;
  C: ResourceId;
  signerClass: ServiceControlSignerClass;
}) {
  const { storage, secrets, C } = o;
  const profile = await controlProfile(storage, C);
  const client = new SyncClient({
    url: o.url,
    signer: o.installation.signer,
    agreement: o.installation.agreement,
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
          apply: (u, v) => profile.apply(u as never, v as never),
          applyBatch: (units) => profile.applyBatch(units as never),
          exclude: (ids) => profile.exclude(ids),
          has: (id) => profile.has(id),
          reset: () => profile.reset(),
        },
      ],
    }),
    commit: profile.commitBinding(
      o.installation.signer.descriptor.principalId,
      o.signerClass,
    ) as never,
    snapshot: profile.snapshotBinding() as never,
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
    {
      now: () => Date.now(),
      setInterval: (fn, ms) => setInterval(fn, ms),
      clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
    },
    100,
  );
  return {
    port: {
      state: () => port.state() as ReturnType<ControlPort["state"]>,
      commit: port.commit,
    },
    live: () => client.resourceState(C) === "LIVE",
    publishSnapshot: () => client.publishSnapshot(C),
    stop: async () => {
      stopDriver();
      await client.stop();
    },
  };
}

type Ev =
  | { t: number; k: "beat" }
  | { t: number; k: "transition"; b: number }
  | { t: number; k: "turn-on"; b: number }
  | { t: number; k: "question"; b: number }
  | { t: number; k: "snapshot" };

/** The year's events in time order (seeded). */
function schedule(
  t0: number,
  o: Required<Pick<YearOptions, "days" | "sections" | "transitionsPerDay" | "questionsPerWeek">>,
  rnd: () => number,
): Ev[] {
  const end = t0 + o.days * DAY_MS;
  const out: Ev[] = [];
  for (let t = t0; t < end; t += 30 * 60_000) out.push({ t, k: "beat" });
  for (let t = t0 + 7 * DAY_MS - 3_600_000; t < end; t += 7 * DAY_MS)
    out.push({ t, k: "snapshot" });
  for (let b = 0; b < o.sections; b++) {
    for (let t = t0 + 60_000 * (b + 1); t < end; t += 30 * DAY_MS) out.push({ t, k: "turn-on", b });
    const transitions = Math.round(o.days * o.transitionsPerDay);
    for (let i = 0; i < transitions; i++)
      out.push({ t: t0 + 600_000 + Math.floor(rnd() * (end - t0 - 600_000)), k: "transition", b });
    const weeks = Math.floor(o.days / 7);
    for (let w = 0; w < weeks; w++)
      for (let q = 0; q < o.questionsPerWeek; q++)
        out.push({ t: t0 + w * 7 * DAY_MS + Math.floor(rnd() * 7 * DAY_MS), k: "question", b });
  }
  // A minute apart at most once per kind and binding is the ControlClient's own limit; the order
  // within a minute does not matter.
  return out.sort((x, y) => x.t - y.t);
}

/** The bytes and count of the units `storage` holds of C by `actor`. */
async function unitsBy(storage: LfcpStorage, C: ResourceId, actor: string) {
  let n = 0;
  let bytes = 0;
  for (const u of await storage.dataUnits.withStatus(C, "merged"))
    if (toHex(u.actor) === actor) {
      n++;
      bytes += u.bytes.length;
    }
  return { n, bytes };
}

export async function synthesizeYear(o: YearOptions): Promise<YearResult> {
  const started = Date.now();
  const sections = o.sections ?? 8;
  const rnd = prng(o.seed ?? 1);
  const T0 = Date.parse("2026-01-01T00:00:00Z");
  const network = connectionNetwork({ now: () => Date.now() });
  const seed = () => randomBytes(32).toString("hex");
  const party = () => partyFrom({ signing: seed(), agreement: seed() });

  // A, the root and owner of C; B, the bridge (a service device with the base approval); P, a
  // personal device of A that connects only at the end (c-year-cold.mjs).
  const A = party();
  const a = memory();
  const { R: C, dek } = await ownedSection(
    A,
    a.storage,
    a.secrets,
    o.url,
    SERVICE_CONTROL_PROFILE_ID,
  );
  const genesis = (await a.storage.control.records(C))[0]?.bytes as Uint8Array;
  const ch = await network.connect(A.signer, o.url);
  if ((await ch.host(genesis)).kind !== "ack") throw new Error("C not hosted");
  ch.close();
  const B = party();
  const cert = await grantDevice(a, A, C, dek, B, DEVICE_KIND.SERVICE, [1n, 2n]);

  const root = await publishingControl({
    url: o.url,
    installation: A,
    ...a,
    C,
    signerClass: "root",
  });
  const rootCommit = async (intents: ServiceControlIntent[]) => {
    const r = await root.port.commit(intents, `year-root:${uuid7(Date.now())}`);
    if (r.kind === "rejected") throw new Error(`root's change refused: ${JSON.stringify(r)}`);
  };
  await waitFor("root's C live", () => root.live(), 60_000);
  await rootCommit([{ intent: "initialize", attemptId: "year", createdAt: iso(T0 - 60_000) }]);
  await rootCommit([
    {
      intent: "approval.create",
      approval: {
        role: "base",
        resource: toBase64url(C),
        principal: principalRef(B.signer.descriptor.principalId),
        certDigest: toBase64url(cert.leaf.payloadDigest),
        certId: toBase64url(cert.leaf.id),
        generation: 1,
        origin: "pairing",
        at: iso(T0 - 60_000),
      },
    },
  ]);
  await waitFor("A sent", async () => (await a.storage.outbound.list(C)).length === 0, 60_000);
  // After B's grant is on the chain: each grant extends the head the last one made.
  const personal = { signing: seed(), agreement: seed() };
  await grantDevice(a, A, C, dek, partyFrom(personal), DEVICE_KIND.PERSONAL, [1n, 2n, 13n]);
  await waitFor("A sent", async () => (await a.storage.outbound.list(C)).length === 0, 60_000);

  const b = memory();
  const chB = await network.connect(B.signer, o.url);
  const bChain = await syncChain(b.storage, chB, C);
  await fetchDeks(b.storage, b.secrets, chB, bChain, { signer: B.signer, agreement: B.agreement });
  chB.close();
  const hostB = new SectionHost({ url: o.url, installation: B, ...b, tickMs: 100 });
  const port: ControlPort = await hostB.openControl(C);
  hostB.start();
  await waitFor(
    "B sees its approval",
    () => Object.keys(port.state()?.approvals ?? {}).length === 1,
    60_000,
  );

  const db = o.db;
  db.prepare(
    "INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES ('i1', 'i', 'p', 'r', 'l', 'x')",
  ).run();
  const refs: string[] = [];
  for (let i = 0; i < sections; i++) {
    const r = randomBytes(32).toString("hex");
    refs.push(toBase64url(Buffer.from(r, "hex")));
    db.prepare(
      "INSERT INTO bindings (id, installation_id, resource_id, adapter, transport, target_ref, target_title, state, created_at) VALUES (?, 'i1', ?, 'apple-reminders', 'eventkit', ?, ?, 'active', 'x')",
    ).run(`b${i}`, r, `list-${i}`, `Shared list ${i + 1}`);
  }

  let now = T0;
  const client = new ControlClient({
    db,
    installation: "i1",
    port,
    answer: {
      run: async ({ effect }) =>
        effect() ? { state: "applied" } : { state: "failed", code: "cancelled" },
    },
    questionKinds: ["mass_delete"],
    service: () => ({
      instance: "bridge-year",
      kind: "reminders",
      label: "MacBook Air",
      platform: "macos",
      app: "0.6.0",
      artifactSliceId: "",
      macos: "15.0",
      cert: { state: "certified", manifestSeq: 1, certTestMode: false },
      capacity: { sections, max: 8, devicesFree: 8 - sections },
    }),
    status: () => ({ state: "running" }),
    now: () => now,
  });
  const bridgeCommit = async (intents: ServiceControlIntent[]) => {
    const r = await port.commit(intents, `year-bridge:${uuid7(Date.now())}`);
    if (r.kind === "rejected") throw new Error(`bridge's change refused: ${JSON.stringify(r)}`);
  };
  const heartbeatAt = () =>
    (port.state()?.status as { heartbeatAt?: string } | undefined)?.heartbeatAt;

  const counts = { heartbeats: 0, transitions: 0, turnOns: 0, questions: 0, snapshots: 0 };
  const cleanedIds = new Set<string>();
  const events = schedule(
    T0,
    {
      days: o.days,
      sections,
      transitionsPerDay: o.transitionsPerDay ?? 20,
      questionsPerWeek: o.questionsPerWeek ?? 2,
    },
    rnd,
  );
  let week = 0;
  let lastBeat = "";
  for (const ev of events) {
    now = ev.t;
    const bi = "b" in ev ? ev.b : 0;
    const ref = refs[bi] as string;
    if (ev.k === "beat") {
      await client.tick();
      const hb = heartbeatAt() ?? "";
      if (hb !== lastBeat) counts.heartbeats++;
      lastBeat = hb;
    } else if (ev.k === "transition") {
      markCompleteCheck(db, `b${bi}`, iso(now));
      await client.tick();
      counts.transitions++;
    } else if (ev.k === "turn-on") {
      if (counts.turnOns >= sections) nextGeneration(db, `b${bi}`);
      await client.tick();
      await bridgeCommit([
        {
          intent: "binding.put",
          binding: ref,
          fields: {
            preview: {
              id: uuid7(now),
              planHash: randomBytes(32).toString("hex"),
              filter: "default",
              list: `Shared list ${bi + 1}`,
              items: ["Buy milk", "Call the bank", "Renew passport", "Book flights", "Pay rent"],
              counts: { toApple: 12, toLfcp: 3, unchanged: 40 },
            },
          },
        },
      ]);
      counts.turnOns++;
    } else if (ev.k === "question") {
      const qid = uuid7(now);
      const generation = Number(
        (
          db.prepare("SELECT generation FROM bindings WHERE id = ?").get(`b${bi}`) as {
            generation: number;
          }
        ).generation,
      );
      const snapshotHash = randomBytes(32).toString("hex");
      await bridgeCommit([
        {
          intent: "question.create",
          qid,
          question: {
            binding: ref,
            generation,
            kind: "mass_delete",
            anomalyId: uuid7(now),
            snapshotHash,
            items: ["Buy milk", "Call the bank", "Renew passport", "Book flights", "Pay rent"],
            counts: { deleted: 14 },
            options: ["restore", "accept"],
            at: iso(now),
          },
        },
      ]);
      await waitFor(
        "root sees the question",
        () => root.port.state()?.questions[qid] !== undefined,
        60_000,
      );
      const aid = uuid7(now + 300_000);
      await rootCommit([
        {
          intent: "answer.create",
          aid,
          answer: { qid, snapshotHash, choice: "restore", at: iso(now + 300_000) },
        },
      ]);
      await waitFor(
        "the bridge sees the answer",
        () => port.state()?.answers[aid] !== undefined,
        60_000,
      );
      now += 300_000;
      await waitFor(
        "the answer applied",
        async () => {
          await client.tick();
          const s = port.state();
          return s?.events[aid]?.state === "applied" && s.questions[qid]?.resolved !== undefined;
        },
        60_000,
      );
      cleanedIds.add(aid);
      counts.questions++;
    } else {
      await root.publishSnapshot();
      counts.snapshots++;
    }
    if (
      process.env.LFCP_C_TRACE === "1" &&
      Math.floor((ev.t - T0) / DAY_MS) !== Math.floor((ev.t - T0 - 1) / DAY_MS)
    )
      console.log(`day ${Math.floor((ev.t - T0) / DAY_MS)} at ${Date.now() - started} ms`);
    const w = Math.floor((ev.t - T0) / (7 * DAY_MS));
    if (w !== week) {
      week = w;
      // Backpressure: the week's units are on the server before the next week.
      await waitFor("B sent", async () => (await b.storage.outbound.list(C)).length === 0, 120_000);
      o.onWeek?.(week, (await b.storage.dataUnits.withStatus(C, "merged")).length);
    }
  }
  now = T0 + o.days * DAY_MS;
  await client.tick();
  await waitFor("B sent", async () => (await b.storage.outbound.list(C)).length === 0, 120_000);
  await waitFor("A sent", async () => (await a.storage.outbound.list(C)).length === 0, 120_000);
  const last = heartbeatAt() ?? "";
  await waitFor(
    "root has the last status",
    () => {
      const st = root.port.state()?.status as { heartbeatAt?: string } | undefined;
      return st?.heartbeatAt === last;
    },
    120_000,
  );

  const s = port.state();
  const stillInC = [...cleanedIds].filter(
    (id) => s?.answers[id] !== undefined || s?.events[id] !== undefined,
  );
  const rows = (db.prepare("SELECT count(*) AS n FROM control_exec").get() as { n: number }).n;
  const cleaned = [...cleanedIds].filter((id) => !stillInC.includes(id));
  const applied = db.prepare("SELECT 1 FROM control_exec WHERE id = ? AND state = 'applied'");
  const kept = cleaned.filter((id) => applied.get(id) !== undefined).length;
  const bu = await unitsBy(b.storage, C, toHex(B.signer.descriptor.principalId));
  const au = await unitsBy(b.storage, C, toHex(A.signer.descriptor.principalId));
  return {
    C,
    personal,
    lastHeartbeatAt: last,
    units: { bridge: bu.n, root: au.n },
    bytes: { bridge: bu.bytes, root: au.bytes },
    counts,
    controlExec: { rows, cleaned: cleaned.length, kept },
    wallMs: Date.now() - started,
    stop: async () => {
      await client.stop();
      await hostB.stop();
      await root.stop();
    },
    admitHistory: async () => {
      const profile = await controlProfile(b.storage, C);
      const view = await loadControlChain(b.storage, C);
      if (view?.kind !== "linear") throw new Error("no chain of C");
      const applier = new DataUnitApplier({
        storage: b.storage,
        dek: dekResolver(b.storage, b.secrets, C),
        handlers: [
          {
            dataProfile: profile.dataProfile,
            codecFor: (u) => profile.codecFor(u),
            apply: (u, v) => profile.apply(u as never, v as never),
            applyBatch: (units) => profile.applyBatch(units as never),
            exclude: (ids) => profile.exclude(ids),
            has: (id) => profile.has(id),
            reset: () => profile.reset(),
          },
        ],
      });
      const t = performance.now();
      const r = await applier.replayStored(view);
      const ms = performance.now() - t;
      if (r.skipped.length > 0) throw new Error(`replay skipped ${JSON.stringify(r.skipped[0])}`);
      return { ms: Math.round(ms), units: r.replayed.length };
    },
  };
}
