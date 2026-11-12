// The first run on a fresh machine (R-023, the owner's live run): through the real entry
// (dist/cli.js, spawned with a pipe — what a person runs, not the unit environment) and
// through pairCommand. The spawned cases need `pnpm build` first (CI builds before it tests).

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bridgePaths } from "../src/config.js";
import { pairCommand } from "../src/run/cli.js";
import type { Runtime } from "../src/runtime.js";

const CLI = join(__dirname, "../dist/cli.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-first-run-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** lfcp-bridge as a person runs it: HOME and the bridge's directories under `dir`, none created. */
function lfcpBridge(args: readonly string[], input?: string) {
  if (!existsSync(CLI)) throw new Error(`${CLI} is missing: run pnpm build first`);
  const home = join(dir, "not-yet", "home");
  const r = spawnSync(process.execPath, [CLI, ...args], {
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      TMPDIR: tmpdir(),
      LFCP_BRIDGE_HOME: home,
      LFCP_BRIDGE_LOGS: join(dir, "not-yet", "logs"),
    },
    ...(input === undefined ? {} : { input }),
    encoding: "utf8",
    timeout: 30_000,
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}`, home };
}

describe("R-023 #1: no data directory on the first run", () => {
  it("doctor on a home that does not exist yet creates it (0700) and reports", () => {
    const r = lfcpBridge(["doctor"]);
    expect(r.out).not.toContain("Cannot open database");
    expect(r.out).toMatch(/^ok {4}database: bridge\.sqlite schema \d+/m);
    expect(statSync(r.home).mode & 0o777).toBe(0o700);
  });
});

describe("R-023 #2: pair reads the link from standard input", () => {
  it("`… | lfcp-bridge pair` gets the piped link (a malformed one is rejected for itself)", () => {
    const r = lfcpBridge(["pair", "--label", "Mac", "--section", "Verify"], "lfcp://pair/zz\n");
    expect(r.out).toContain("The link is rejected");
    // Without stdin the link was "": rejected for its prefix, whatever was piped.
    expect(r.out).not.toContain("does not start with lfcp://pair/");
    // And the rejected attempt left nothing (#3).
    expect(readdirSync(join(r.home, "installations"))).toEqual([]);
  });
});

describe("R-023 #3: a rejected pair leaves no installation behind", () => {
  const rt = () =>
    ({ paths: bridgePaths({ LFCP_BRIDGE_HOME: join(dir, "home") }, dir) }) as Runtime;
  const quiet = (link: string) => ({ out: () => {}, err: () => {}, stdin: () => link });

  it("the directory it created, keys included, is removed", async () => {
    const code = await pairCommand(
      rt(),
      { label: "Mac", sections: ["Verify"] },
      quiet("lfcp://pair/zz"),
    );
    expect(code).not.toBe(0);
    expect(readdirSync(rt().paths.installations)).toEqual([]);
  });

  it("an --installation directory that existed before is kept", async () => {
    const kept = join(rt().paths.installations, "inst-1");
    mkdirSync(kept, { recursive: true });
    writeFileSync(join(kept, "mine"), "x");
    const code = await pairCommand(
      rt(),
      { label: "Mac", sections: ["Verify"], installation: "inst-1" },
      quiet("not a link"),
    );
    expect(code).not.toBe(0);
    expect(existsSync(join(kept, "mine"))).toBe(true);
  });
});
