#!/usr/bin/env node
// Bundles the host into one ESM file for the .app (A§2.1, spike S-2):
// everything but better-sqlite3 (a native module, shipped as its own production subtree next to
// the bundle), with Automerge's WebAssembly built in as base64 (its `node` entry would read
// automerge_wasm_bg.wasm from disk at a path that does not exist in the bundle).
//
//   node scripts/bundle-host.mjs <out.mjs>     default dist/app/host/bridge.mjs

import { existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const host = path.join(root, "packages", "host");
const outfile = path.resolve(
  process.argv[2] ?? path.join(root, "dist", "app", "host", "bridge.mjs"),
);
mkdirSync(path.dirname(outfile), { recursive: true });

// The fullfat_base64 entry: the wasm is a base64 string inside the JS, instantiated on import.
const fromHost = createRequire(path.join(host, "package.json"));
// (package.json is not exported; the CommonJS entry is dist/cjs/fullfat_node.cjs.)
const automergeDist = path.resolve(path.dirname(fromHost.resolve("@automerge/automerge")), "..");
const automergeBase64 = path.join(automergeDist, "mjs", "entrypoints", "fullfat_base64.js");
if (!existsSync(automergeBase64)) {
  console.error(`bundle-host: no ${automergeBase64} (another @automerge/automerge layout?)`);
  process.exit(1);
}

/** @type {import("esbuild").Plugin} */
const automergeInline = {
  name: "automerge-inline-wasm",
  setup(b) {
    b.onResolve({ filter: /^@automerge\/automerge$/ }, () => ({ path: automergeBase64 }));
  },
};

const result = await build({
  // The tsc output (pnpm build first): the workspace packages export their dist/ too.
  entryPoints: [path.join(host, "dist", "cli.js")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node24",
  external: ["better-sqlite3"],
  plugins: [automergeInline],
  // CommonJS dependencies call require() for Node built-ins; an ESM bundle has no require of its own.
  banner: {
    js: [
      'import { createRequire as __lfcpCreateRequire } from "node:module";',
      "const require = __lfcpCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  legalComments: "linked",
  metafile: true,
  logLevel: "info",
});

const inputs = Object.keys(result.metafile.inputs);
const wasmInlined = inputs.some((i) => i.includes("automerge_wasm_bg_base64"));
const sqliteBundled = inputs.some((i) => i.includes("better-sqlite3"));
if (!wasmInlined || sqliteBundled) {
  console.error(
    `bundle-host: wasm inlined ${wasmInlined}, better-sqlite3 bundled ${sqliteBundled} (want true, false)`,
  );
  process.exit(1);
}
console.log(`bundle-host: ${outfile} (${inputs.length} inputs, automerge wasm inlined)`);
