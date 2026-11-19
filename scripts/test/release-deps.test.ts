// A release is built from npm only (scripts/check-release-deps.mjs): the
// development pin of the SDK (sdk-ts.lock, file: tarballs, link: or an
// override to either) refuses it; this repository's workspace: ranges do not.

import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { readManifests, releaseDepsProblems } from "../check-release-deps.mjs";

const npmHost = {
  dependencies: {
    "@openlfcp/bridge-reminders": "workspace:*",
    "@openlfcp/client": "0.7.0",
    "@openlfcp/core": "0.7.0-beta.1",
    other: "^1.0.0",
  },
  devDependencies: { "@openlfcp/wire": "0.7.0" },
};

describe("release dependencies", () => {
  it("accept exact npm versions, exact overrides and workspace packages", () => {
    expect(
      releaseDepsProblems({
        manifests: [
          ["package.json", { pnpm: { overrides: { "@openlfcp/core": "0.7.0" } } }],
          ["packages/host/package.json", npmHost],
        ],
        sdkLock: false,
        workspaceYaml: 'packages:\n  - "packages/*"\n',
      }),
    ).toEqual([]);
  });

  it("refuse the tarballs of an sdk-ts commit", () => {
    const tgz = "file:../../vendor/sdk-ts/openlfcp-core-0.6.0.tgz";
    expect(
      releaseDepsProblems({
        manifests: [
          [
            "package.json",
            {
              pnpm: {
                overrides: { "@openlfcp/core": "file:vendor/sdk-ts/openlfcp-core-0.6.0.tgz" },
              },
            },
          ],
          ["packages/host/package.json", { dependencies: { "@openlfcp/core": tgz } }],
        ],
        sdkLock: true,
      }),
    ).toEqual([
      "sdk-ts.lock is present: the SDK is pinned to a commit, not npm",
      'package.json: pnpm.overrides sends @openlfcp/core to "file:vendor/sdk-ts/openlfcp-core-0.6.0.tgz"',
      `packages/host/package.json: @openlfcp/core is "${tgz}", not an exact npm version`,
    ]);
  });

  it("refuse an override or a devDependency left behind after the pin", () => {
    expect(
      releaseDepsProblems({
        manifests: [
          ["package.json", { pnpm: { overrides: { "@openlfcp/wire": "link:../sdk-ts/wire" } } }],
          [
            "packages/host/package.json",
            {
              dependencies: { "@openlfcp/core": "0.7.0" },
              devDependencies: { "@openlfcp/crypto": "^0.7.0" },
            },
          ],
        ],
        sdkLock: false,
      }),
    ).toEqual([
      'package.json: pnpm.overrides sends @openlfcp/wire to "link:../sdk-ts/wire"',
      'packages/host/package.json: @openlfcp/crypto is "^0.7.0", not an exact npm version',
    ]);
  });

  it("refuse SDK overrides in pnpm-workspace.yaml", () => {
    expect(
      releaseDepsProblems({
        manifests: [],
        sdkLock: false,
        workspaceYaml: "overrides:\n  '@openlfcp/core': file:x.tgz\n",
      }),
    ).toEqual([
      "pnpm-workspace.yaml names an @openlfcp/ package (overrides belong in package.json)",
    ]);
  });

  it("read the root and every workspace package.json", () => {
    const paths = readManifests(resolve(import.meta.dirname, "../..")).map(([p]) => p);
    expect(paths[0]).toBe("package.json");
    expect(paths).toContain("packages/host/package.json");
  });
});
