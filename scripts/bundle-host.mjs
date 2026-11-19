#!/usr/bin/env node
// Bundles the host into one ESM file for the .app (A§2.1, research/s-2-bundle.md):
// everything but better-sqlite3 (a native module, shipped as its own production subtree next to
// the bundle), with Automerge's WebAssembly built in as base64 (its `node` entry would read
// automerge_wasm_bg.wasm from disk at a path that does not exist in the bundle).
//
// Automerge comes in as its `/slim` entry, which does not touch the wasm on import; the host
// awaits @openlfcp/shared-objects' initializeAutomerge() first thing (src/cli.ts), which loads
// `@automerge/automerge/automerge.wasm.base64`, decodes it fast and compiles it asynchronously.
// The `fullfat_base64` entry would instead decode slowly on import and print initSync()'s
// deprecation warning on every start (PB-30, LFCP-059).
//
//   node scripts/bundle-host.mjs <out.mjs>     default dist/app/host/bridge.mjs

import { existsSync, mkdirSync, realpathSync } from "node:fs";
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

// Automerge is a dependency of @openlfcp/shared-objects (and of the host's self-test): one
// version, resolved from shared-objects. package.json is not exported; the CommonJS entry is
// dist/cjs/fullfat_node.cjs, the ESM /slim entry dist/mjs/entrypoints/slim.js.
const sharedObjects = realpathSync(path.join(host, "node_modules", "@openlfcp", "shared-objects"));
const fromShared = createRequire(path.join(sharedObjects, "package.json"));
const automergeDist = path.resolve(path.dirname(fromShared.resolve("@automerge/automerge")), "..");
const automergeSlim = path.join(automergeDist, "mjs", "entrypoints", "slim.js");
if (!existsSync(automergeSlim)) {
  console.error(`bundle-host: no ${automergeSlim} (another @automerge/automerge layout?)`);
  process.exit(1);
}

/** @type {import("esbuild").Plugin} */
const automergeSlimAlias = {
  name: "automerge-slim",
  setup(b) {
    // Only the package itself: its ./automerge.wasm.base64 subpath resolves as usual.
    b.onResolve({ filter: /^@automerge\/automerge$/ }, () => ({ path: automergeSlim }));
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
  plugins: [automergeSlimAlias],
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
const has = (part) => inputs.some((i) => i.includes(part));
const facts = {
  "automerge slim": has("entrypoints/slim.js"),
  "automerge wasm inlined": has("automerge_wasm_bg_base64"),
  // Either would load the wasm on import (fullfat_base64 through the deprecated initSync()).
  "automerge fullfat": has("entrypoints/fullfat"),
  "better-sqlite3 bundled": has("better-sqlite3"),
};
const want = {
  "automerge slim": true,
  "automerge wasm inlined": true,
  "automerge fullfat": false,
  "better-sqlite3 bundled": false,
};
const wrong = Object.keys(want).filter((k) => facts[k] !== want[k]);
if (wrong.length > 0) {
  console.error(
    `bundle-host: ${wrong.map((k) => `${k} ${facts[k]} (want ${want[k]})`).join(", ")}`,
  );
  process.exit(1);
}
console.log(`bundle-host: ${outfile} (${inputs.length} inputs, automerge /slim, wasm inlined)`);
