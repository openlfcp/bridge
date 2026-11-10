/**
 * The helper process lifecycle under failure (review PR 6, P2-2..P2-4), with a stand-in `open`
 * and helper (test/fixtures) instead of LaunchServices and the Swift app.
 */
import { execFile, spawn } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { executableName, HelperLostError, HelperProcess } from "../src/link.js";

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
