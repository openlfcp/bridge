#!/usr/bin/env node
// The development pin of the TypeScript SDK until @openlfcp/* 0.7.0 is on
// npm: the eight packages of openlfcp/sdk-ts at the commit in sdk-ts.lock,
// built from a checkout of that commit and packed into vendor/sdk-ts/
// (gitignored). packages/host/package.json takes them as file: tarballs
// (with pnpm.overrides in the root package.json, so a package's own
// ^version dependencies resolve to the tarballs too, never to npm) and
// pnpm-lock.yaml records each tarball's integrity: sdk-ts.lock pins the
// commit, the lockfile pins the bytes. The same script packs the SDK for
// openlfcp/obsidian; keep the two copies alike.
//
//   node scripts/sdk-ts-pack.mjs [--checkout DIR]
//   node scripts/sdk-ts-pack.mjs --self-test
//
// DIR is a clone of openlfcp/sdk-ts that has the commit in sdk-ts.lock
// (default ../sdk-ts next to this repository, as CI checks it out); its
// working tree, branch and line-ending settings do not matter. The packing
// is byte-identical on every system, as the lockfile's integrity needs:
// - the commit's files are exported from the repository's objects (git
//   archive, no line-ending conversion) into a temporary directory, and
//   installed, built and packed there: a CRLF checkout (core.autocrlf on
//   Windows) or a local edit changes nothing;
// - `pnpm pack` writes `workspace:` ranges in no stable order, so each
//   package.json has its ranges rewritten first (workspace:^ and
//   workspace:~ to ^version and ~version, workspace:* to the version, in
//   place);
// - its tar lists the files in the file system's order (APFS and ext4
//   differ) and its gzip output depends on the zlib build, so each tarball
//   is written again (canonicalTarball): entries sorted by path, fixed
//   mode, owner and time, stored (gzip level 0) with no OS in the header.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { gunzipSync, gzipSync } from "node:zlib";

/** The packages, in dependency order. */
export const SDK_PACKAGES = [
  "core",
  "crypto",
  "storage",
  "wire",
  "storage-idb",
  "shared-objects",
  "client",
  "storage-node",
];

/** One `workspace:` range as published, given the workspace's version of its package. */
export function publishedRange(range, version) {
  if (!range.startsWith("workspace:")) return range;
  const spec = range.slice("workspace:".length);
  if (spec === "*") return version;
  if (spec === "^" || spec === "~") return `${spec}${version}`;
  throw new Error(`unsupported workspace range "${range}"`);
}

/** A package.json with its workspace ranges rewritten, every key in its order. */
export function publishedManifest(pkg, versions) {
  const out = { ...pkg };
  for (const field of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    if (pkg[field] === undefined) continue;
    out[field] = Object.fromEntries(
      Object.entries(pkg[field]).map(([name, range]) => {
        if (!range.startsWith("workspace:")) return [name, range];
        const version = versions[name];
        if (version === undefined) throw new Error(`${name} is not a workspace package`);
        return [name, publishedRange(range, version)];
      }),
    );
  }
  return out;
}

/** The regular files of a ustar archive: [{ path, data }] in archive order. */
export function tarEntries(tar, { skip = [] } = {}) {
  const out = [];
  const text = (b) => b.toString("latin1").replace(/\0.*$/s, "");
  for (let at = 0; at + 512 <= tar.length; ) {
    const header = tar.subarray(at, at + 512);
    if (header.every((b) => b === 0)) break;
    const size = Number.parseInt(text(header.subarray(124, 136)).trim() || "0", 8);
    const type = String.fromCharCode(header[156] || 0x30);
    const prefix = text(header.subarray(345, 500));
    const name = text(header.subarray(0, 100));
    const data = tar.subarray(at + 512, at + 512 + size);
    if (!skip.includes(type)) {
      if (type !== "0") throw new Error(`unexpected tar entry type "${type}" (${name})`);
      out.push({ path: prefix === "" ? name : `${prefix}/${name}`, data });
    }
    at += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

/** 1985-10-26T08:15:00Z, the time npm and pnpm give every packed file. */
const PACK_MTIME = 499162500;

function tarHeader(path, size) {
  if (Buffer.byteLength(path) > 100) throw new Error(`tar path over 100 bytes: ${path}`);
  const h = Buffer.alloc(512);
  const put = (at, len, value) => h.write(value, at, len, "latin1");
  const octal = (at, len, n) => put(at, len, `${n.toString(8).padStart(len - 1, "0")}\0`);
  put(0, 100, path);
  octal(100, 8, 0o644);
  octal(108, 8, 0);
  octal(116, 8, 0);
  octal(124, 12, size);
  octal(136, 12, PACK_MTIME);
  put(148, 8, "        ");
  put(156, 1, "0");
  put(257, 8, "ustar\x0000");
  let sum = 0;
  for (const b of h) sum += b;
  put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** A .tgz with the same files, byte-identical whatever packed it and on what system. */
export function canonicalTarball(tgz) {
  const entries = tarEntries(gunzipSync(tgz)).sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const blocks = [];
  for (const { path, data } of entries) {
    blocks.push(
      tarHeader(path, data.length),
      data,
      Buffer.alloc((512 - (data.length % 512)) % 512),
    );
  }
  blocks.push(Buffer.alloc(1024));
  const gz = gzipSync(Buffer.concat(blocks), { level: 0 });
  gz[9] = 255; // RFC 1952 OS: unknown (zlib writes the build's own)
  return gz;
}

/** pnpm (a .cmd on Windows, hence the shell there): arguments must hold no path or metacharacter. */
const run = (cmd, args, cwd) =>
  execFileSync(cmd, args, {
    cwd,
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
    shell: process.platform === "win32",
  });

function selfTest() {
  const versions = { "@openlfcp/core": "0.6.0", "@openlfcp/wire": "0.6.0" };
  const got = publishedManifest(
    {
      name: "@openlfcp/x",
      dependencies: {
        "@openlfcp/wire": "workspace:^",
        other: "^1.0.0",
        "@openlfcp/core": "workspace:*",
      },
    },
    versions,
  );
  const want = { "@openlfcp/wire": "^0.6.0", other: "^1.0.0", "@openlfcp/core": "0.6.0" };
  if (JSON.stringify(got.dependencies) !== JSON.stringify(want))
    throw new Error(`self-test: ${JSON.stringify(got.dependencies)}`);
  if (publishedRange("workspace:~", "1.2.3") !== "~1.2.3")
    throw new Error("self-test: workspace:~");
  let threw = false;
  try {
    publishedManifest({ dependencies: { "@openlfcp/y": "workspace:^" } }, versions);
  } catch {
    threw = true;
  }
  if (!threw) throw new Error("self-test: an unknown workspace package must throw");
  const file = (path, text) => ({ path, data: Buffer.from(text) });
  const raw = (files) => {
    const blocks = files.flatMap(({ path, data }) => [
      tarHeader(path, data.length),
      data,
      Buffer.alloc((512 - (data.length % 512)) % 512),
    ]);
    return Buffer.concat([...blocks, Buffer.alloc(1024)]);
  };
  const a = [file("package/b.js", "b"), file("package/package.json", "{}")];
  const one = canonicalTarball(gzipSync(raw(a), { level: 9 }));
  const two = canonicalTarball(gzipSync(raw([...a].reverse()), { level: 1 }));
  if (!one.equals(two)) throw new Error("self-test: canonicalTarball depends on order or gzip");
  const back = tarEntries(gunzipSync(one)).map((e) => `${e.path}=${e.data}`);
  if (back.join() !== "package/b.js=b,package/package.json={}")
    throw new Error(`self-test: canonicalTarball lost files: ${back.join()}`);
  process.stdout.write("sdk-ts-pack self-test: ok\n");
}

/** What the packages install and build from: the root files of the workspace and packages/. */
const EXPORTED = [
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "tsconfig.json",
  "tsconfig.base.json",
  "packages",
];

/**
 * The tree of `commit` under `paths`, from the repository's objects (never
 * its working tree): the bytes as committed, whatever core.autocrlf or the
 * checkout says, as a ustar archive. Throws if the repository lacks it.
 */
export function exportCommit(repo, commit, paths) {
  execFileSync("git", ["-C", repo, "cat-file", "-e", `${commit}^{commit}`], { stdio: "ignore" });
  return execFileSync(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "-C",
      repo,
      "archive",
      "--format=tar",
      commit,
      "--",
      ...paths,
    ],
    { maxBuffer: 1 << 30 },
  );
}

/** Writes a `git archive` tar (regular files and directories) under `dir`. */
export function extractTar(tar, dir) {
  for (const e of tarEntries(tar, { skip: ["g", "5"] })) {
    if (e.path.split("/").includes("..")) throw new Error(`tar path outside: ${e.path}`);
    const to = join(dir, ...e.path.split("/"));
    mkdirSync(dirname(to), { recursive: true });
    writeFileSync(to, e.data);
  }
}

function main(argv) {
  if (argv.includes("--self-test")) return selfTest();
  const root = resolve(import.meta.dirname, "..");
  const at = argv.indexOf("--checkout");
  const repo = resolve(at === -1 ? join(root, "..", "sdk-ts") : argv[at + 1]);
  const lock = JSON.parse(readFileSync(join(root, "sdk-ts.lock"), "utf8"));
  const stage = mkdtempSync(join(tmpdir(), "sdk-ts-pack-"));
  try {
    let tar;
    try {
      tar = exportCommit(repo, lock.commit, EXPORTED);
    } catch {
      process.stderr.write(
        `sdk-ts-pack: ${repo} has no commit ${lock.commit} (sdk-ts.lock): clone openlfcp/sdk-ts there and fetch it\n`,
      );
      process.exit(1);
    }
    const src = join(stage, "sdk-ts");
    extractTar(tar, src);
    // No path on these command lines (cwd is an option): Windows runs pnpm through cmd.exe.
    run("pnpm", ["install", "--frozen-lockfile"], src);
    run("pnpm", ["build"], src);
    const manifests = Object.fromEntries(
      SDK_PACKAGES.map((p) => [
        p,
        JSON.parse(readFileSync(join(src, "packages", p, "package.json"), "utf8")),
      ]),
    );
    const versions = Object.fromEntries(Object.values(manifests).map((m) => [m.name, m.version]));
    const out = join(root, "vendor", "sdk-ts");
    rmSync(out, { recursive: true, force: true });
    mkdirSync(out, { recursive: true });
    for (const p of SDK_PACKAGES) {
      const dir = join(src, "packages", p);
      writeFileSync(
        join(dir, "package.json"),
        `${JSON.stringify(publishedManifest(manifests[p], versions), null, 2)}\n`,
      );
      run("pnpm", ["pack"], dir);
      const name = `${manifests[p].name.replace("@", "").replace("/", "-")}-${manifests[p].version}.tgz`;
      writeFileSync(join(out, name), canonicalTarball(readFileSync(join(dir, name))));
      process.stdout.write(`packed ${manifests[p].name}@${manifests[p].version}\n`);
    }
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2));
