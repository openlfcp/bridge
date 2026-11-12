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
import { OperationJournal } from "@openlfcp/client";
import { openNodeInstallation, PAIR_EXIT } from "@openlfcp/storage-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { bridgePaths } from "../src/config.js";
import { EXIT } from "../src/exit.js";
import { claimDirectory, pairCommand } from "../src/run/cli.js";
import type { Runtime } from "../src/runtime.js";

// storage-node's pair, replaced in a test that sets `fake.pair` (the real one otherwise).
const fake = vi.hoisted(() => ({
  pair: undefined as undefined | ((state: string) => Promise<number>),
}));
vi.mock("@openlfcp/storage-node", async (original) => {
  const m = await original<typeof import("@openlfcp/storage-node")>();
  return {
    ...m,
    pair: (args: Parameters<typeof m.pair>[0], env: Parameters<typeof m.pair>[1]) =>
      fake.pair === undefined ? m.pair(args, env) : fake.pair(args.state),
  };
});

/** What a pair that made its request leaves in `state`: the installation and the request. */
async function recordRequest(state: string): Promise<void> {
  const node = await openNodeInstallation(state);
  try {
    await new OperationJournal(node.storage).begin({
      id: "pairing-request.1",
      kind: "pairing-request",
      createdAt: 1,
      intent: {},
    });
  } finally {
    node.close();
  }
}

const CLI = join(__dirname, "../dist/cli.js");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "lfcp-first-run-"));
});
afterEach(() => {
  fake.pair = undefined;
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

  it("a WAITING pair keeps its directory, to be resumed with --installation", async () => {
    fake.pair = async (state) => {
      await recordRequest(state);
      return PAIR_EXIT.WAITING;
    };
    const out: string[] = [];
    const code = await pairCommand(
      rt(),
      { label: "Mac", sections: ["Verify"], installation: "inst-w" },
      { out: (l) => out.push(l), err: () => {}, stdin: () => "" },
    );
    expect(code).not.toBe(0);
    expect(out.join("\n")).toContain("--installation inst-w");
    expect(existsSync(join(rt().paths.installations, "inst-w", "lfcp.sqlite"))).toBe(true);
  });

  it("review #25: a claimed directory with a request in it (a concurrent pair's) is kept on failure", async () => {
    fake.pair = async (state) => {
      // Meanwhile a second `pair --installation inst-c` made its request here and waits.
      await recordRequest(state);
      return PAIR_EXIT.FAILED;
    };
    const code = await pairCommand(
      rt(),
      { label: "Mac", sections: ["Verify"], installation: "inst-c" },
      quiet("lfcp://pair/zz"),
    );
    expect(code).not.toBe(0);
    expect(existsSync(join(rt().paths.installations, "inst-c", "lfcp.sqlite"))).toBe(true);
  });

  it("review #25: while a pair of an installation holds its lock, a second is refused and the directory kept", async () => {
    const installations = rt().paths.installations;
    let second: { code: number; err: string } | undefined;
    fake.pair = async (state) => {
      await recordRequest(state);
      // The first pair is running (lock held): a second pair of inst-l now.
      const err: string[] = [];
      const code = await pairCommand(
        rt(),
        { label: "Mac", sections: ["Verify"], installation: "inst-l" },
        { out: () => {}, err: (l) => err.push(l), stdin: () => "lfcp://pair/zz" },
      );
      second = { code, err: err.join("\n") };
      expect(existsSync(join(state, "lfcp.sqlite"))).toBe(true);
      return PAIR_EXIT.WAITING;
    };
    await pairCommand(
      rt(),
      { label: "Mac", sections: ["Verify"], installation: "inst-l" },
      quiet("lfcp://pair/zz"),
    );
    expect(second?.code).toBe(EXIT.USAGE);
    expect(second?.err).toContain("a pairing of installation inst-l is already running");
    expect(second?.err).toContain(join(installations, "inst-l.lock"));
    expect(existsSync(join(installations, "inst-l", "lfcp.sqlite"))).toBe(true);
    // Released when the first returns.
    expect(existsSync(join(installations, "inst-l.lock"))).toBe(false);
  });

  it("review #25: a lock left behind refuses pair without touching the directory", async () => {
    const installations = rt().paths.installations;
    mkdirSync(installations, { recursive: true });
    writeFileSync(join(installations, "inst-s.lock"), "999999999\n");
    const err: string[] = [];
    const code = await pairCommand(
      rt(),
      { label: "Mac", sections: ["Verify"], installation: "inst-s" },
      { out: () => {}, err: (l) => err.push(l), stdin: () => "lfcp://pair/zz" },
    );
    expect(code).toBe(EXIT.USAGE);
    expect(err.join("\n")).toContain("remove");
    expect(readdirSync(installations)).toEqual(["inst-s.lock"]);
  });

  it("review #25: the claim is atomic — the first mkdir owns the directory, a second does not", () => {
    const parent = join(dir, "home", "installations");
    const x = join(parent, "x");
    expect(claimDirectory(parent, x)).toBe(true);
    expect(claimDirectory(parent, x)).toBe(false);
    expect(statSync(x).mode & 0o777).toBe(0o700);
  });
});
