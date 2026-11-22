// The artifact manifest (A§9.1, E-052): canonical bytes, Ed25519, the shape, the bundle walk and
// the comparison with a bundle on disk. The shared fixture fixtures/artifact-manifest/ is what
// the release chain writes for a bundle like fixtureBundle() below, signed with the test key;
// the write gate (E-051) reads the same file. UPDATE_ARTIFACT_FIXTURE=1 rewrites it.

import { createPrivateKey, generateKeyPairSync } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  type Arch,
  ArtifactManifestError,
  buildManifest,
  canonicalJson,
  compareBundle,
  machOArchs,
  manifestSha256,
  parseSignedManifest,
  rawPublicKey,
  signManifest,
} from "../src/artifact/manifest.js";

const FIXTURE = join(import.meta.dirname, "fixtures/artifact-manifest");
const KEY = createPrivateKey(readFileSync(join(FIXTURE, "test-key.pem")));
const PUB = readFileSync(join(FIXTURE, "test-key.pub"), "utf8").trim();
// The fixture's manifestSha256: changes only with the format (then E-051's copy changes too).
const FIXTURE_SHA256 = "0c1b49b0336589837d3aab4d8014730df439cfb843a1cd483b3aeb1528ae0fc1";

/** Mach-O headers: thin 64-bit (little-endian) and universal. */
function thin(cpu: number): Buffer {
  const b = Buffer.alloc(32);
  b.writeUInt32LE(0xfeedfacf, 0);
  b.writeUInt32LE(cpu, 4);
  return b;
}
function fat(...cpus: number[]): Buffer {
  const b = Buffer.alloc(8 + cpus.length * 20 + 16);
  b.writeUInt32BE(0xcafebabe, 0);
  b.writeUInt32BE(cpus.length, 4);
  cpus.forEach((c, i) => {
    b.writeUInt32BE(c, 8 + i * 20);
  });
  return b;
}
const ARM = 0x0100000c;
const X86 = 0x01000007;

/** A small bundle shaped like LFCP Bridge.app after the staple. */
function fixtureBundle(app: string): void {
  const put = (p: string, data: string | Buffer) => {
    mkdirSync(dirname(join(app, p)), { recursive: true });
    writeFileSync(join(app, p), data);
  };
  put("Contents/Info.plist", "<plist/>\n");
  put("Contents/MacOS/LFCP Bridge", fat(ARM, X86));
  put("Contents/MacOS/lfcp-reminders-helper", fat(ARM, X86));
  put("Contents/Resources/node/bin/node", fat(ARM, X86));
  put("Contents/Resources/host/bridge.mjs", "export {};\n");
  put(
    "Contents/Resources/host/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
    fat(ARM, X86),
  );
  put("Contents/Resources/x86-only.dylib", thin(X86));
  put("Contents/Resources/Café.txt".normalize("NFD"), "nfc\n");
  put("Contents/Resources/class.bin", Buffer.from("cafebabe00000034", "hex"));
  put("Contents/_CodeSignature/CodeResources", "<seal/>\n");
  put("Contents/CodeResources", "<ticket/>\n");
  symlinkSync("host/bridge.mjs", join(app, "Contents/Resources/current.mjs"));
}

/** A stand-in for codesign: a stable cdhash per (path, arch). */
const fakeCdhash = (path: string, arch: Arch) =>
  canonicalJson([path, arch]).length.toString(16).padStart(8, "0").repeat(5);

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "artifact-manifest-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function build(app: string) {
  return buildManifest({
    appPath: app,
    app: "org.openlfcp.bridge",
    version: "0.6.0",
    build: "7",
    cdhash: fakeCdhash,
  });
}

describe("artifact manifest", () => {
  it("canonical JSON: sorted keys, no whitespace, integers only", () => {
    expect(canonicalJson({ b: [1, "é"], a: { d: null, c: true } })).toBe(
      '{"a":{"c":true,"d":null},"b":[1,"é"]}',
    );
    expect(() => canonicalJson({ a: 1.5 })).toThrow(TypeError);
  });

  it("canonical JSON refuses a lone UTF-16 surrogate, in a value or a key (PB-41)", () => {
    expect(canonicalJson("😀")).toBe('"😀"');
    for (const lone of ["\ud800", "a\udfff", "\ude00\ud83d"]) {
      expect(() => canonicalJson(lone)).toThrow(TypeError);
      expect(() => canonicalJson({ [lone]: 1 })).toThrow(TypeError);
    }
  });

  it("Mach-O architectures: thin, universal, not Mach-O", () => {
    expect(machOArchs(fat(ARM, X86))).toEqual(["arm64", "x86_64"]);
    expect(machOArchs(thin(X86))).toEqual(["x86_64"]);
    expect(machOArchs(Buffer.from("cafebabe00000034", "hex"))).toEqual([]);
    expect(machOArchs(Buffer.from("#!/bin/sh\n"))).toEqual([]);
  });

  it("builds from the bundle: files, nested code by slice, the seal", () => {
    const app = join(dir, "LFCP Bridge.app");
    fixtureBundle(app);
    const m = build(app);
    const paths = m.files.map((f) => f.path);
    expect(paths).not.toContain("Contents/CodeResources");
    expect(paths.some((p) => p.startsWith("Contents/_CodeSignature/"))).toBe(false);
    expect(paths).toContain("Contents/Resources/Café.txt".normalize("NFC"));
    expect(m.files).toContainEqual({
      path: "Contents/Resources/current.mjs",
      symlink: "host/bridge.mjs",
    });
    expect([...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))).toEqual(
      paths,
    );
    expect(m.slices.arm64.shell).toBe(fakeCdhash("", "arm64"));
    expect(m.slices.arm64.nested.map((n) => n.path)).toEqual([
      "Contents/MacOS/lfcp-reminders-helper",
      "Contents/Resources/host/node_modules/better-sqlite3/build/Release/better_sqlite3.node",
      "Contents/Resources/node/bin/node",
    ]);
    expect(m.slices.x86_64.nested.map((n) => n.path)).toContain(
      "Contents/Resources/x86-only.dylib",
    );
    expect(compareBundle(m, build(app))).toEqual([]);
  });

  it("the shared fixture is this bundle's manifest, signed with the test key", () => {
    const app = join(dir, "LFCP Bridge.app");
    fixtureBundle(app);
    const signed = signManifest(build(app), KEY);
    const file = join(FIXTURE, "artifact-manifest.json");
    if (process.env.UPDATE_ARTIFACT_FIXTURE === "1") writeFileSync(file, signed);
    const text = readFileSync(file, "utf8");
    expect(text).toBe(signed);
    const { manifest, manifestSha256: sha } = parseSignedManifest(text, [PUB]);
    expect(sha).toBe(manifestSha256(manifest));
    expect(sha).toBe(FIXTURE_SHA256);
  });

  describe("refuses", () => {
    const text = () => readFileSync(join(FIXTURE, "artifact-manifest.json"), "utf8");
    const code = (f: () => unknown) => {
      try {
        f();
      } catch (e) {
        if (e instanceof ArtifactManifestError) return e.code;
        throw e;
      }
      return "accepted";
    };
    const resign = (edit: (m: Record<string, unknown>) => void) => {
      const doc = JSON.parse(text());
      edit(doc.manifest);
      return doc;
    };

    it("another key, a changed byte, a non-canonical file", () => {
      const other = generateKeyPairSync("ed25519").privateKey;
      expect(code(() => parseSignedManifest(text(), [rawPublicKey(other)]))).toBe("untrusted-key");
      const doc = resign((m) => {
        m.build = "8";
      });
      expect(code(() => parseSignedManifest(canonicalJson(doc), [PUB]))).toBe("bad-signature");
      // A signature by another key that claims the trusted public key.
      const forged = JSON.parse(signManifest(doc.manifest, other));
      forged.signature.publicKey = PUB;
      expect(code(() => parseSignedManifest(canonicalJson(forged), [PUB]))).toBe("bad-signature");
      expect(code(() => parseSignedManifest(`${text()}\n`, [PUB]))).toBe("not-canonical");
      expect(
        code(() => parseSignedManifest(JSON.stringify(JSON.parse(text()), null, 1), [PUB])),
      ).toBe("not-canonical");
    });

    it("a lone surrogate, escaped in the file or in the manifest to sign (PB-41)", () => {
      const lone = text().replace(/"version":"[^"]*"/, '"version":"0.6.0\\ud800"');
      expect(lone).toContain('"0.6.0\\ud800"');
      expect(code(() => parseSignedManifest(lone, [PUB]))).toBe("malformed");
      const doc = resign((m) => {
        m.version = "0.6.0\ud800";
      });
      expect(code(() => signManifest(doc.manifest, KEY))).toBe("malformed");
    });

    it("another format, unknown fields, unsorted or non-NFC paths, bad hashes", () => {
      const bad = (edit: (m: Record<string, unknown>) => void) =>
        code(() => signManifest(resign(edit).manifest, KEY));
      expect(
        bad((m) => {
          m.format = "openlfcp-bridge-artifact-manifest/2";
        }),
      ).toBe("format");
      expect(
        bad((m) => {
          m.extra = 1;
        }),
      ).toBe("malformed");
      expect(
        bad((m) => {
          (m.files as unknown[]).reverse();
        }),
      ).toBe("malformed");
      expect(
        bad((m) => {
          (m.files as { path: string }[]).push({
            path: "Contents/Zé",
            sha256: "0".repeat(64),
          } as never);
        }),
      ).toBe("malformed");
      expect(
        bad((m) => {
          (m.slices as { arm64: { shell: string } }).arm64.shell = "ABC";
        }),
      ).toBe("malformed");
    });
  });

  it("finds what differs from the manifest on disk", () => {
    const app = join(dir, "LFCP Bridge.app");
    fixtureBundle(app);
    const m = build(app);
    writeFileSync(join(app, "Contents/Resources/host/bridge.mjs"), "export const x = 1;\n");
    writeFileSync(join(app, "Contents/Resources/extra.txt"), "x");
    rmSync(join(app, "Contents/Info.plist"));
    const helper = "Contents/MacOS/lfcp-reminders-helper";
    const other = buildManifest({
      appPath: app,
      app: "org.openlfcp.bridge",
      version: "0.6.0",
      build: "7",
      cdhash: (p, a) => (p === helper ? "f".repeat(40) : fakeCdhash(p, a)),
    });
    expect(compareBundle(m, other)).toEqual([
      `arm64 ${helper}: ${"f".repeat(40)}, manifest ${fakeCdhash(helper, "arm64")}`,
      `x86_64 ${helper}: ${"f".repeat(40)}, manifest ${fakeCdhash(helper, "x86_64")}`,
      "Contents/Resources/extra.txt: not in the manifest",
      "Contents/Resources/host/bridge.mjs: changed",
      "Contents/Info.plist: missing",
    ]);
  });
});
