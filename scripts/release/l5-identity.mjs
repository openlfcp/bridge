#!/usr/bin/env node
// The test side of the L5 job "artifact identity" (T§3, PLAN §E-051, scripts/release/l5-identity.sh):
// what the job does with the host's own code (run `pnpm build` first) and never in a release build.
//
//   l5-identity.mjs trust-key <public-key>
//       puts this one key into packages/host/src/artifact/keys.ts (the job's own build only: the
//       key is the job's ephemeral manifest key, A§9.1; the release chain never runs this)
//   l5-identity.mjs certify <artifact-manifest.json> --key <private.pem> --macos <x.y> --os-build <b>
//                   --out <certification-manifest.json>
//       a public certification manifest (seq 1) with a certified record for both slices of that
//       artifact manifest on that macOS, signed with the same key
//   l5-identity.mjs seed <bridge.sqlite> --artifact <file> --certification <file> --public-key <k>
//       offers both to the write gate's cache (ManifestCache), as a download would; prints
//       manifestSha256. The app must not be running.

import { createPrivateKey } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "../..");
const dist = (p) => import(join(ROOT, "packages/host/dist", p));

function usage(message) {
  console.error(`l5-identity: ${message}`);
  process.exit(2);
}

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    key: { type: "string" },
    macos: { type: "string" },
    "os-build": { type: "string" },
    out: { type: "string" },
    artifact: { type: "string" },
    certification: { type: "string" },
    "public-key": { type: "string" },
  },
});
const [target] = positionals;
if (!target || positionals.length !== 1) usage(`${command ?? "<command>"}: one argument expected`);

switch (command) {
  case "trust-key": {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(target)) usage("trust-key: a raw Ed25519 key in base64");
    const file = join(ROOT, "packages/host/src/artifact/keys.ts");
    const text = readFileSync(file, "utf8");
    const empty = "Object.freeze([])";
    if (text.split(empty).length !== 2) usage(`trust-key: ${file} has no single ${empty}`);
    writeFileSync(file, text.replace(empty, `Object.freeze(["${target}"])`));
    break;
  }
  case "certify": {
    const { key, macos, out } = values;
    const osBuild = values["os-build"];
    if (!key || !macos || !osBuild || !out)
      usage("certify needs --key, --macos, --os-build, --out");
    const m = await dist("artifact/manifest.js");
    const c = await dist("artifact/certification.js");
    const privateKey = createPrivateKey(readFileSync(key));
    const { manifest, manifestSha256 } = m.parseSignedManifest(readFileSync(target, "utf8"), [
      m.rawPublicKey(privateKey),
    ]);
    const entries = m.ARCHS.map((arch) => ({
      manifestSha256,
      artifactSliceId: manifest.slices[arch].shell,
      arch,
      macos,
      osBuilds: [osBuild],
      status: "certified",
      scenariosVersion: "l5-identity",
      report: "L5 artifact identity (CI, dry run)",
    }));
    const certification = { format: c.CERTIFICATION_MANIFEST_FORMAT, seq: 1, entries };
    writeFileSync(out, c.signCertification(certification, privateKey));
    break;
  }
  case "seed": {
    const { artifact, certification } = values;
    const publicKey = values["public-key"];
    if (!artifact || !certification || !publicKey)
      usage("seed needs --artifact, --certification, --public-key");
    const { openBridgeDatabase } = await dist("db/database.js");
    const { ManifestCache } = await dist("artifact/cache.js");
    const db = openBridgeDatabase(target);
    try {
      const cache = new ManifestCache(db, [publicKey]);
      const sha = cache.storeArtifact(readFileSync(artifact, "utf8"));
      const offer = cache.offerCertification(readFileSync(certification, "utf8"));
      if (offer.kind !== "stored" && offer.kind !== "same")
        throw new Error(`the certification manifest was not kept: ${JSON.stringify(offer)}`);
      console.log(sha);
    } finally {
      db.close();
    }
    break;
  }
  default:
    usage(`unknown command: ${command ?? ""} (trust-key, certify, seed)`);
}
