// Helper supervision (D-010 r4 §8.2): ping, restart, restart budget, orphan from helper.pid.

import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { HelperSupervisor, isHelperProcess, type SupervisedHelper } from "../src/supervisor.js";

class FakeHelper implements SupervisedHelper {
  static next = 50_000;
  readonly pid = FakeHelper.next++;
  answering = true;
  closed = false;
  #exit = new Set<(c: number | null) => void>();
  async ping(): Promise<void> {
    if (!this.answering) throw new Error("no answer");
  }
  async close(): Promise<void> {
    this.closed = true;
  }
  onExit(cb: (c: number | null) => void): () => void {
    this.#exit.add(cb);
    return () => this.#exit.delete(cb);
  }
  crash(): void {
    for (const cb of this.#exit) cb(1);
  }
}

function rig(now = { t: 0 }) {
  const dir = mkdtempSync(join(tmpdir(), "lfcp-sup-"));
  const helpers: FakeHelper[] = [];
  const unavailable: string[] = [];
  const s = new HelperSupervisor({
    start: async () => {
      const h = new FakeHelper();
      helpers.push(h);
      return h;
    },
    pidFile: join(dir, "helper.pid"),
    now: () => now.t,
    setInterval: () => ({}),
    clearInterval: () => {},
    isOurs: () => false,
    onUnavailable: (r) => unavailable.push(r),
  });
  return { s, helpers, unavailable, dir, now, pidFile: join(dir, "helper.pid") };
}

describe("HelperSupervisor", () => {
  it("writes helper.pid on start and removes it on stop", async () => {
    const r = rig();
    await r.s.start();
    expect(readFileSync(r.pidFile, "utf8").trim()).toBe(String(r.helpers[0]?.pid));
    await r.s.stop();
    expect(existsSync(r.pidFile)).toBe(false);
    expect(r.helpers[0]?.closed).toBe(true);
  });

  it("restarts after a ping without answer and after an unexpected exit", async () => {
    const r = rig();
    await r.s.start();
    (r.helpers[0] as FakeHelper).answering = false;
    await r.s.pingNow();
    expect(r.helpers).toHaveLength(2);
    expect(r.helpers[0]?.closed).toBe(true);
    expect(r.s.state).toBe("running");
    (r.helpers[1] as FakeHelper).crash();
    await r.s.pingNow();
    expect(r.helpers).toHaveLength(3);
    expect(readFileSync(r.pidFile, "utf8").trim()).toBe(String(r.helpers[2]?.pid));
  });

  it("more than 3 restarts within 5 minutes: unavailable, no more restarts; resume starts again", async () => {
    const r = rig();
    await r.s.start();
    for (let i = 0; i < 4; i++) {
      r.now.t += 30_000;
      (r.helpers.at(-1) as FakeHelper).answering = false;
      await r.s.pingNow();
    }
    expect(r.s.state).toBe("unavailable");
    expect(r.unavailable).toHaveLength(1);
    const count = r.helpers.length;
    await r.s.pingNow();
    expect(r.helpers).toHaveLength(count);
    await r.s.resume();
    expect(r.s.state).toBe("running");
    expect(r.helpers).toHaveLength(count + 1);
  });

  it("restarts spread over more than 5 minutes stay within the budget", async () => {
    const r = rig();
    await r.s.start();
    for (let i = 0; i < 6; i++) {
      r.now.t += 2 * 60_000;
      (r.helpers.at(-1) as FakeHelper).answering = false;
      await r.s.pingNow();
    }
    expect(r.s.state).toBe("running");
  });

  it("stops an orphan from helper.pid only when the pid runs our helper", async () => {
    const orphan = spawn("sleep", ["30"], { stdio: "ignore" });
    const other = spawn("sleep", ["30"], { stdio: "ignore" });
    try {
      const dir = mkdtempSync(join(tmpdir(), "lfcp-sup-"));
      const pidFile = join(dir, "helper.pid");
      const start = async () => new FakeHelper();
      writeFileSync(pidFile, `${orphan.pid}\n`);
      const exited = new Promise((r) => orphan.on("exit", r));
      await new HelperSupervisor({
        start,
        pidFile,
        isOurs: (p) => p === orphan.pid,
        setInterval: () => ({}),
      }).start();
      await exited;
      writeFileSync(pidFile, `${other.pid}\n`);
      await new HelperSupervisor({
        start,
        pidFile,
        isOurs: () => false,
        setInterval: () => ({}),
      }).start();
      expect(other.exitCode).toBeNull();
      expect(() => process.kill(other.pid as number, 0)).not.toThrow();
    } finally {
      orphan.kill();
      other.kill();
    }
  });

  it("a ping in flight when stop() runs never starts a helper after stop (review PR 9 P2-3)", async () => {
    const r = rig();
    await r.s.start();
    let fail: (e: Error) => void = () => {};
    (r.helpers[0] as FakeHelper).ping = () => new Promise<void>((_, reject) => (fail = reject));
    const round = r.s.pingNow();
    await new Promise((res) => setImmediate(res));
    await r.s.stop();
    fail(new Error("closed"));
    await round;
    expect(r.s.state).toBe("stopped");
    expect(r.helpers).toHaveLength(1);
    expect(existsSync(r.pidFile)).toBe(false);
  });

  it("a helper whose start was in flight when stop() ran is closed before stop resolves", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lfcp-sup-"));
    const pidFile = join(dir, "helper.pid");
    const helpers: FakeHelper[] = [];
    let release: () => void = () => {};
    const s = new HelperSupervisor({
      start: async () => {
        if (helpers.length === 1) await new Promise<void>((res) => (release = res));
        const h = new FakeHelper();
        helpers.push(h);
        return h;
      },
      pidFile,
      setInterval: () => ({}),
      clearInterval: () => {},
      isOurs: () => false,
    });
    await s.start();
    (helpers[0] as FakeHelper).answering = false;
    const round = s.pingNow(); // restart: the second start waits
    await new Promise((res) => setImmediate(res));
    const stopped = s.stop();
    release();
    await stopped;
    await round;
    expect(s.state).toBe("stopped");
    expect(helpers).toHaveLength(2);
    expect(helpers[1]?.closed).toBe(true);
    expect(existsSync(pidFile)).toBe(false);
  });

  it("an orphan that ignores SIGTERM is killed before the replacement starts (review PR 9 P2-4)", async () => {
    const orphan = spawn(
      process.execPath,
      ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    try {
      await once(orphan.stdout, "data");
      const dir = mkdtempSync(join(tmpdir(), "lfcp-sup-"));
      const pidFile = join(dir, "helper.pid");
      writeFileSync(pidFile, `${orphan.pid}\n`);
      let orphanAliveAtStart: boolean | undefined;
      const s = new HelperSupervisor({
        start: async () => {
          orphanAliveAtStart = orphan.exitCode === null && orphan.signalCode === null;
          return new FakeHelper();
        },
        pidFile,
        isOurs: (p) => p === orphan.pid,
        orphanGraceMs: 300,
        setInterval: () => ({}),
        clearInterval: () => {},
      });
      await s.start();
      expect(orphanAliveAtStart).toBe(false);
      expect(orphan.signalCode).toBe("SIGKILL");
      await s.stop();
    } finally {
      orphan.kill("SIGKILL");
    }
  });

  it("recognises the executable a pid runs on Linux too (not ps comm, a thread name there)", async () => {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 5000)"], {
      stdio: "ignore",
    });
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(isHelperProcess(child.pid as number, basename(process.execPath))).toBe(true);
      expect(isHelperProcess(child.pid as number)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("restartNow restarts the helper that stalled, within the restart budget (R-001 live run 2)", async () => {
    const r = rig();
    await r.s.start();
    const stalled = r.s.helper;
    await r.s.restartNow("stalled: items.snapshot", stalled);
    expect(r.helpers).toHaveLength(2);
    expect(r.helpers[0]?.closed).toBe(true);
    expect(r.s.state).toBe("running");
    // A late report about the helper that was already replaced restarts nothing.
    await r.s.restartNow("stalled again", stalled);
    expect(r.helpers).toHaveLength(2);
    // Each stall counts: more than 3 within 5 minutes and the helper is unavailable.
    for (let i = 0; i < 3; i++) await r.s.restartNow("stalled", r.s.helper);
    expect(r.s.state).toBe("unavailable");
    expect(r.unavailable[0]).toMatch(/stalled/);
  });

  for (const pingOutcome of ["answers", "fails"] as const) {
    it(`a stall and the exit of the same helper, queued behind a ping that ${pingOutcome}, restart it once (review #23 r2 P2-1)`, async () => {
      const r = rig();
      await r.s.start();
      const a = r.helpers[0] as FakeHelper;
      let settle: (ok: boolean) => void = () => {};
      a.ping = () =>
        new Promise<void>((res, rej) => {
          settle = (ok) => (ok ? res() : rej(new Error("no answer")));
        });
      const round = r.s.pingNow(); // holds the queue
      await new Promise((res) => setImmediate(res));
      const stall = r.s.restartNow("the helper stalled on items.snapshot", a);
      a.crash(); // its exit, queued too
      settle(pingOutcome === "answers");
      await round;
      await stall;
      await r.s.pingNow(); // whatever else was queued
      expect(r.helpers).toHaveLength(2);
      expect(r.helpers[0]?.closed).toBe(true);
      expect(r.helpers[1]?.closed).toBe(false);
      expect(r.s.helper).toBe(r.helpers[1]);
      expect(r.s.state).toBe("running");
    });
  }
});
