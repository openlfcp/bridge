#!/usr/bin/env node
// The detached artifact manifest of a signed, notarized and stapled LFCP Bridge.app (A§9.1,
// E-052): built by the release chain after the staple and before the DMG; nothing in the bundle
// is written. The format is packages/host/src/artifact/manifest.ts (run `pnpm build` first);
// cdhashes come from codesign (macOS).
//
//   artifact-manifest.mjs keygen <private.pem>
//       a new Ed25519 key (PKCS#8 PEM, mode 600); prints its raw public key (base64)
//   artifact-manifest.mjs build <app> --key <private.pem> --out <artifact-manifest.json>
//       app, version and build from the bundle's Info.plist; prints manifestSha256
//   artifact-manifest.mjs cdhashes <app>
//       the cdhash of the shell and of every nested Mach-O per slice and the resource seal hash, as
//       canonical JSON: run before and after `build` and compare (they must be equal)
//   artifact-manifest.mjs check <app> --manifest <file> --public-key <base64>
//       the signature, then the bundle against the manifest: exit 0 when it is this build
//
// Exit codes: 0 ok, 1 the check found differences or a refused manifest, 2 usage.

import { execFileSync, spawnSync } from "node:child_process";
import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";

const ROOT = resolve(import.meta.dirname, "../..");
const m = await import(join(ROOT, "packages/host/dist/artifact/manifest.js"));

function usage(message) {
  console.error(`artifact-manifest: ${message}`);
  process.exit(2);
}

/** codesign -d -vvv -a <arch>: the CDHash= line (codesign writes it to stderr). */
function cdhashOf(app) {
  return (path, arch) => {
    const target = path === "" ? app : join(app, path);
    const r = spawnSync("codesign", ["-d", "-vvv", "-a", arch, target], { encoding: "utf8" });
    const hash = /^CDHash=([0-9a-f]{40})$/m.exec(r.stderr)?.[1];
    if (r.status !== 0 || !hash)
      throw new Error(`codesign -d ${arch} ${path || "<bundle>"}: ${r.stderr.trim()}`);
    return hash;
  };
}

function plist(app, key) {
  return execFileSync("plutil", ["-extract", key, "raw", "-o", "-", join(app, "Contents/Info.plist")], {
    encoding: "utf8",
  }).trim();
}

function manifestOf(app) {
  return m.buildManifest({
    appPath: app,
    app: plist(app, "CFBundleIdentifier"),
    version: plist(app, "CFBundleShortVersionString"),
    build: plist(app, "CFBundleVersion"),
    cdhash: cdhashOf(app),
  });
}

const [command, ...rest] = process.argv.slice(2);
const { values, positionals } = parseArgs({
  args: rest,
  allowPositionals: true,
  options: {
    key: { type: "string" },
    out: { type: "string" },
    manifest: { type: "string" },
    "public-key": { type: "string" },
  },
});
const [target] = positionals;
if (!target || positionals.length !== 1) usage(`${command ?? "<command>"}: one path expected`);

switch (command) {
  case "keygen": {
    const { privateKey } = generateKeyPairSync("ed25519");
    writeFileSync(target, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
    console.log(m.rawPublicKey(privateKey));
    break;
  }
  case "build": {
    if (!values.key || !values.out) usage("build needs --key and --out");
    const key = createPrivateKey(readFileSync(values.key));
    const manifest = manifestOf(resolve(target));
    writeFileSync(values.out, m.signManifest(manifest, key));
    console.log(m.manifestSha256(manifest));
    break;
  }
  case "cdhashes": {
    const { slices, resourceSealHash } = manifestOf(resolve(target));
    console.log(m.canonicalJson({ slices, resourceSealHash }));
    break;
  }
  case "check": {
    if (!values.manifest || !values["public-key"]) usage("check needs --manifest and --public-key");
    let manifest;
    try {
      ({ manifest } = m.parseSignedManifest(readFileSync(values.manifest, "utf8"), [
        values["public-key"],
      ]));
    } catch (e) {
      console.error(String(e instanceof Error ? e.message : e));
      process.exit(1);
    }
    const problems = m.compareBundle(manifest, manifestOf(resolve(target)));
    for (const p of problems) console.error(`differs: ${p}`);
    if (problems.length) process.exit(1);
    console.log(`ok: ${target} is the build of ${values.manifest}`);
    break;
  }
  default:
    usage(`unknown command: ${command ?? ""} (keygen, build, cdhashes, check)`);
}
