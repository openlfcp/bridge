/**
 * The helper process lifecycle under failure (review PR 6, P2-2..P2-4), with a stand-in `open`
 * and helper (test/fixtures) instead of LaunchServices and the Swift app.
 */
import { execFile, execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as publicApi from "../src/index.js";
import {
  executableName,
  fifoTestHooks,
  HelperLostError,
  HelperProcess,
  type HelperProcessOptions,
} from "../src/link.js";

const here = path.dirname(new URL(import.meta.url).pathname);
const FAKE_OPEN = [process.execPath, path.join(here, "fixtures", "fake-open.mjs")];
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Runs fixtures/run-start.mjs; resolves with its report, or "hung" if it did not exit in time. */
function runStart(
  env: Record<string, string>,
  timeoutMs = 8000,
): Promise<{ out: unknown; code: number | null; hung: boolean }> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [path.join(here, "fixtures", "run-start.mjs")],
      {
        env: { ...process.env, ...env },
        timeout: timeoutMs,
        killSignal: "SIGKILL",
      },
      (err, stdout) => {
        let out: unknown = null;
        try {
          out = JSON.parse(stdout.trim().split("\n").pop() ?? "");
        } catch {}
        const hung = (err as { killed?: boolean } | null)?.killed === true;
        resolve({ out, code: child.exitCode, hung });
      },
    );
  });
}

describe("start failures reject and leave nothing behind (P2-2, P2-3)", { timeout: 15_000 }, () => {
  it("direct launch of a missing executable rejects instead of crashing Node", async () => {
    const r = await runStart({ RUN_LAUNCH: "direct" });
    expect(r.hung).toBe(false);
    expect(r.out).toMatchObject({ rejected: true, name: "HelperLostError" });
  });

  it("a missing launcher (open) rejects", async () => {
    const r = await runStart({ RUN_LAUNCHER: "missing" });
    expect(r.hung).toBe(false);
    expect(r.out).toMatchObject({ rejected: true, name: "HelperLostError" });
  });

  it("cleanup leaves no FIFO open blocked: one that starts just before the unlink returns at once", async () => {
    // The race behind a flaky "missing launcher" run: a stream's open of a FIFO end reached the
    // threadpool after cleanup tried to unblock it and before the FIFOs were removed; with no
    // other end it blocked for ever and the process could not exit. The hook runs in exactly that
    // window; a blocking open of each end (in another process, as a pool thread would) must return.
    // Every threadpool thread waits on a FIFO of the test, so the helper streams' own opens are
    // still queued when cleanup runs: cleanup cannot find them waiting.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfcp-pool-"));
    const pool = Number(process.env.UV_THREADPOOL_SIZE ?? 4);
    const blockers = Array.from({ length: pool }, (_, i) => path.join(dir, `b${i}`));
    for (const b of blockers) execFileSync("mkfifo", [b]);
    const held = blockers.map(
      (b) =>
        new Promise<number>((resolve, reject) =>
          fs.open(b, "r", (e, fd) => (e ? reject(e) : resolve(fd))),
        ),
    );
    await new Promise((r) => setTimeout(r, 100));
    const opened: string[] = [];
    fifoTestHooks.beforeUnlink = (fifos) => {
      for (const [file, mode] of [
        [fifos.in, ">"],
        [fifos.out, "<"],
        [fifos.err, "<"],
      ] as const) {
        execFileSync("sh", ["-c", `exec 3${mode}"$0"`, file], { timeout: 2000 });
        opened.push(path.basename(file));
      }
    };
    try {
      await expect(
        HelperProcess.start({
          appPath: "/nonexistent/LFCP Reminders Helper.app",
          launcher: ["/nonexistent/open"],
          helperName: "node",
          readyTimeoutMs: 3000,
        }),
      ).rejects.toBeInstanceOf(HelperLostError);
    } finally {
      delete fifoTestHooks.beforeUnlink;
      // Release the pool: a writer for each blocker.
      const writers = blockers.map((b) => fs.openSync(b, fs.constants.O_RDWR));
      for (const fd of await Promise.all(held)) fs.closeSync(fd);
      for (const fd of writers) fs.closeSync(fd);
      fs.rmSync(dir, { recursive: true, force: true });
    }
    expect(opened).toEqual(["in", "out", "err"]);
  });

  it("the FIFO test seam is not part of the package's API (review fix-launcher-flake P2-1)", () => {
    expect("fifoTestHooks" in publicApi).toBe(false);
    const options: HelperProcessOptions = {
      appPath: "/x.app",
      // @ts-expect-error the options of HelperProcess (and of the transport) have no test hook
      beforeFifoUnlink: () => {},
    };
    expect(options.appPath).toBe("/x.app");
  });

  it("no built declaration names the FIFO test seam (review flake r2 F-P2-1)", () => {
    // CI builds before it tests; a stale or missing dist is a failure here, not a skip.
    const dist = path.join(here, "..", "dist");
    const decls = fs.readdirSync(dist).filter((f) => f.endsWith(".d.ts"));
    expect(decls).toContain("link.d.ts");
    const naming = decls.filter((f) =>
      /fifoTestHooks|beforeUnlink|beforeFifoUnlink/.test(
        fs.readFileSync(path.join(dist, f), "utf8"),
      ),
    );
    expect(naming).toEqual([]);
  });

  it("the transport reports a missing helper as unavailable", async () => {
    const r = await runStart({ RUN_LAUNCH: "direct", RUN_VIA: "transport" });
    expect(r.hung).toBe(false);
    expect(r.out).toMatchObject({ status: { state: "unavailable", reason: "helper_missing" } });
  });

  it("launcher exits before opening the FIFOs: start rejects and the process can exit", async () => {
    const r = await runStart({ FAKE_OPEN_MODE: "exit-early" });
    expect(r.hung).toBe(false);
    expect(r.out).toMatchObject({ rejected: true });
    expect(r.code).toBe(0);
  });

  it("no ready in time: start rejects and the process can exit", async () => {
    const r = await runStart({ FAKE_HELPER_MODE: "silent", RUN_READY_MS: "500" });
    expect(r.hung).toBe(false);
    expect(r.out).toMatchObject({ rejected: true, message: expect.stringContaining("ready") });
  });

  it("wrong protocol: start rejects, the helper is stopped, the process can exit", async () => {
    const r = await runStart({ FAKE_HELPER_MODE: "old-protocol" });
    expect(r.hung).toBe(false);
    expect(r.out).toMatchObject({ rejected: true, message: expect.stringContaining("protocol") });
  });
});

describe("which executable a pid runs (CI on Linux)", () => {
  it("names the executable, not a thread name cut to 15 characters", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      stdio: "ignore",
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(executableName(child.pid as number)).toBe(path.basename(process.execPath));
    } finally {
      child.kill("SIGKILL");
    }
  });
});

describe("FIFOs and the threadpool (R-001 live run, macOS 26.5.2)", () => {
  it("two helpers at once: requests are still written and answered", async () => {
    // A quiet FIFO read through an fs stream holds a threadpool thread; two helpers (out + err
    // each) held all four, and the next request was never written.
    const a = await HelperProcess.start({
      appPath: "/fake.app",
      launcher: FAKE_OPEN,
      helperName: "node",
    });
    const b = await HelperProcess.start({
      appPath: "/fake.app",
      launcher: FAKE_OPEN,
      helperName: "node",
    });
    try {
      expect(await a.request("ping", {}, { timeoutMs: 3000 })).toMatchObject({
        ok: true,
        op: "ping",
      });
      expect(await b.request("ping", {}, { timeoutMs: 3000 })).toMatchObject({
        ok: true,
        op: "ping",
      });
    } finally {
      await a.close();
      await b.close();
    }
  }, 20_000);
});

describe("close and request timeouts (P2-4, timeout policy)", () => {
  it("forced close stops the helper itself, not only the launcher", async () => {
    process.env.FAKE_HELPER_MODE = "ignore-shutdown";
    try {
      const h = await HelperProcess.start({
        appPath: "/fake.app",
        launcher: FAKE_OPEN,
        helperName: "node",
        closeGraceMs: 500,
      });
      const pid = h.ready.pid as number;
      expect(alive(pid)).toBe(true);
      await h.close();
      expect(alive(pid)).toBe(false);
    } finally {
      delete process.env.FAKE_HELPER_MODE;
    }
  }, 20_000);

  it("the launcher exits after ready: the helper is stopped, not left running (review PR 6 r2)", async () => {
    process.env.FAKE_OPEN_MODE = "exit-after-ready";
    process.env.FAKE_HELPER_MODE = "ignore-shutdown"; // does not stop on stdin EOF either
    try {
      const h = await HelperProcess.start({
        appPath: "/fake.app",
        launcher: FAKE_OPEN,
        helperName: "node",
        closeGraceMs: 500,
      });
      const pid = h.ready.pid as number;
      const exited = new Promise<number | null>((r) => h.onExit(r));
      await exited; // the launcher is gone: the connection reports it
      await h.close();
      for (let i = 0; i < 30 && alive(pid); i++) await new Promise((r) => setTimeout(r, 100));
      expect(alive(pid)).toBe(false);
    } finally {
      delete process.env.FAKE_OPEN_MODE;
      delete process.env.FAKE_HELPER_MODE;
    }
  }, 20_000);

  it("a timed-out request rejects alone; the connection stays usable; the late answer is dropped", async () => {
    process.env.FAKE_HELPER_MODE = "slow";
    try {
      const h = await HelperProcess.start({
        appPath: "/fake.app",
        launcher: FAKE_OPEN,
        helperName: "node",
      });
      await expect(h.request("slow", {}, { timeoutMs: 200 })).rejects.toBeInstanceOf(
        HelperLostError,
      );
      expect(await h.request("ping")).toMatchObject({ ok: true, op: "ping" });
      await new Promise((r) => setTimeout(r, 1600)); // the late answer arrives and is ignored
      expect(await h.request("ping")).toMatchObject({ ok: true, op: "ping" });
      await h.close();
    } finally {
      delete process.env.FAKE_HELPER_MODE;
    }
  }, 20_000);
});
