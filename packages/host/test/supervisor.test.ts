// Helper supervision (D-010 r4 §8.2): ping, restart, restart budget, orphan from helper.pid.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HelperSupervisor, type SupervisedHelper } from "../src/supervisor.js";

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
});
