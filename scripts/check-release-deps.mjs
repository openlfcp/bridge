#!/usr/bin/env node
// A release of the bridge is built from the @openlfcp/* npm packages only.
// A commit that pins the SDK to an sdk-ts commit (sdk-ts.lock with file:
// tarballs from scripts/sdk-ts-pack.mjs, or link: dependencies) must not
// ship, so the release steps run this first and stop on any problem: the
// helper's release signing (helper/scripts/sign-release.sh) and the package
// job of app.yml on a tag. The release chain (E-052) calls it the same way.
//
//   node scripts/check-release-deps.mjs     exit 0: releasable; 1: refused
//
// It reads the root package.json, every packages/*/package.json and
// pnpm-workspace.yaml. Workspace ranges (workspace:*) name this
// repository's own packages and are allowed.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const EXACT = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/;

/**
 * What keeps this checkout from being released: [] when the SDK comes from npm.
 * `manifests` are [path, package.json] pairs; `workspaceYaml` is pnpm-workspace.yaml's text.
 */
export function releaseDepsProblems({ manifests, sdkLock, workspaceYaml = "" }) {
  const problems = [];
  if (sdkLock) problems.push("sdk-ts.lock is present: the SDK is pinned to a commit, not npm");
  for (const [path, pkg] of manifests) {
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"])
      for (const [name, version] of Object.entries(pkg[field] ?? {}))
        if (
          name.startsWith("@openlfcp/") &&
          !version.startsWith("workspace:") &&
          !EXACT.test(version)
        )
          problems.push(`${path}: ${name} is "${version}", not an exact npm version`);
    // An override sends the SDK elsewhere whatever the dependencies say.
    for (const [name, target] of Object.entries(pkg.pnpm?.overrides ?? {}))
      if (name.includes("@openlfcp/") && !EXACT.test(target))
        problems.push(`${path}: pnpm.overrides sends ${name} to "${target}"`);
  }
  // pnpm 10 also takes overrides from pnpm-workspace.yaml; the bridge keeps them in package.json.
  if (/@openlfcp\//.test(workspaceYaml))
    problems.push(
      "pnpm-workspace.yaml names an @openlfcp/ package (overrides belong in package.json)",
    );
  return problems;
}

/** The [path, package.json] pairs of the checkout at `root`. */
export function readManifests(root) {
  const out = [["package.json", JSON.parse(readFileSync(join(root, "package.json"), "utf8"))]];
  for (const dir of readdirSync(join(root, "packages")).sort()) {
    const path = join("packages", dir, "package.json");
    if (existsSync(join(root, path)))
      out.push([path, JSON.parse(readFileSync(join(root, path), "utf8"))]);
  }
  return out;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = resolve(import.meta.dirname, "..");
  const ws = join(root, "pnpm-workspace.yaml");
  const problems = releaseDepsProblems({
    manifests: readManifests(root),
    sdkLock: existsSync(join(root, "sdk-ts.lock")),
    workspaceYaml: existsSync(ws) ? readFileSync(ws, "utf8") : "",
  });
  for (const p of problems) process.stderr.write(`release refused: ${p}\n`);
  process.exit(problems.length === 0 ? 0 : 1);
}
