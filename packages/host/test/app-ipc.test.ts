// The shell ↔ host channel v1 (src/app/ipc.ts) and `run --app` (src/app/serve.ts): the commands
// pause/resume/answer/export/remove/shutdown/openURL, the events hello/status/reply, STOP only on
// pause, the URL never in a log line or a reply.

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type Event, encodeEvent, LineSplitter, MAX_LINE, parseCommand } from "../src/app/ipc.js";
import { AppHost, EXIT_DEADLINE, serveApp } from "../src/app/serve.js";
import { bridgePaths } from "../src/config.js";
import { openBridgeDatabase } from "../src/db/database.js";
import { STOP_FILE, stopState } from "../src/db/stop.js";
import { EXIT, main } from "../src/index.js";
import { takeRunLock } from "../src/run/cli.js";
import type { Runtime } from "../src/runtime.js";

const SECRET_URL = "lfcp-bridge://connect?c=abc#k=very-secret-link-key";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "lfcp-app-ipc-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const line = (o: Record<string, unknown>) => JSON.stringify({ v: 1, ...o });

describe("parseCommand", () => {
  it("reads every command of v1", () => {
    const cases: [Record<string, unknown>, unknown][] = [
      [{ cmd: "pause" }, { cmd: "pause" }],
      [{ cmd: "resume" }, { cmd: "resume" }],
      [
        { cmd: "answer", questionId: "q1", choice: "stop_syncing" },
        { cmd: "answer", questionId: "q1", choice: "stop_syncing" },
      ],
      [
        { cmd: "export", path: "/Users/x/Desktop/d.zip" },
        { cmd: "export", path: "/Users/x/Desktop/d.zip" },
      ],
      [
        { cmd: "remove", bindingId: "b1" },
        { cmd: "remove", bindingId: "b1", ack: false },
      ],
      [
        { cmd: "remove", bindingId: "b1", ack: true },
        { cmd: "remove", bindingId: "b1", ack: true },
      ],
      [
        { cmd: "shutdown", reason: "update" },
        { cmd: "shutdown", reason: "update" },
      ],
      [
        { cmd: "shutdown", reason: "quit" },
        { cmd: "shutdown", reason: "quit" },
      ],
      [
        { cmd: "shutdown", reason: "logout" },
        { cmd: "shutdown", reason: "logout" },
      ],
      [
        { cmd: "openURL", url: SECRET_URL },
        { cmd: "openURL", url: SECRET_URL },
      ],
    ];
    for (const [input, command] of cases)
      expect(parseCommand(line({ id: "7", ...input }))).toEqual({
        ok: true,
        envelope: { id: "7", command },
      });
  });

  it("refuses what is not a v1 command line", () => {
    expect(parseCommand("not json")).toMatchObject({ ok: false, id: null, code: "bad_line" });
    expect(parseCommand("[1]")).toMatchObject({ ok: false, code: "bad_line" });
    expect(parseCommand(JSON.stringify({ v: 2, id: "1", cmd: "pause" }))).toMatchObject({
      ok: false,
      id: "1",
      code: "bad_line",
    });
    expect(parseCommand(line({ cmd: "pause" }))).toMatchObject({ ok: false, code: "bad_line" });
    expect(parseCommand(line({ id: "1", cmd: "fly" }))).toMatchObject({
      ok: false,
      id: "1",
      code: "unknown_command",
    });
    expect(
      parseCommand(`${line({ id: "1", cmd: "pause", pad: "x".repeat(MAX_LINE) })}`),
    ).toMatchObject({
      ok: false,
      code: "bad_line",
      detail: "line too long",
    });
  });

  it("refuses wrong arguments without repeating them", () => {
    const bad: Record<string, unknown>[] = [
      { cmd: "answer", questionId: "q1" },
      { cmd: "export" },
      { cmd: "remove", bindingId: "" },
      { cmd: "remove", bindingId: "b", ack: "yes" },
      { cmd: "shutdown" },
      { cmd: "shutdown", reason: "pause" },
      { cmd: "openURL", url: "https://example.org/#k=very-secret-link-key" },
    ];
    for (const b of bad) {
      const r = parseCommand(line({ id: "9", ...b }));
      expect(r).toMatchObject({ ok: false, id: "9", code: "bad_arguments" });
      expect(JSON.stringify(r)).not.toContain("very-secret-link-key");
    }
  });
});

describe("encodeEvent and LineSplitter", () => {
  it("puts v:1 on every event", () => {
    expect(JSON.parse(encodeEvent({ type: "hello", version: "0.6.0", pid: 1 }))).toEqual({
      v: 1,
      type: "hello",
      version: "0.6.0",
      pid: 1,
    });
    expect(
      JSON.parse(encodeEvent({ type: "needsAttention", bindingId: "b1", code: "safe_mode" })),
    ).toEqual({ v: 1, type: "needsAttention", bindingId: "b1", code: "safe_mode" });
    expect(
      JSON.parse(
        encodeEvent({
          type: "question",
          questionId: "q",
          bindingId: "b",
          kind: "guard_mass_unlink",
        }),
      ),
    ).toMatchObject({ v: 1, type: "question", kind: "guard_mass_unlink" });
  });

  it("splits chunks into lines, drops blank lines and CR, skips an overlong line once", () => {
    const lines: string[] = [];
    let overlong = 0;
    const s = new LineSplitter(
      (l) => lines.push(l),
      () => overlong++,
    );
    s.push('{"a":');
    s.push('1}\r\n\n{"b":2}\n{"c"');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
    s.push(":3}\n");
    s.push("x".repeat(MAX_LINE + 1));
    s.push("still the same line\n");
    s.push('{"d":4}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}', '{"c":3}', '{"d":4}']);
    expect(overlong).toBe(1);
  });
});

/** An AppHost over a fake run process, with what it wrote and logged. */
function harness(
  o: {
    failStart?: number;
    stopMs?: number;
    shutdownWaitMs?: number;
    /** The start waits for this before it returns. */
    startGate?: Promise<void>;
    home?: string;
  } = {},
) {
  const events: (Event & { v: number })[] = [];
  const logs: string[] = [];
  const stops: string[] = [];
  const exits: number[] = [];
  let starts = 0;
  const host = new AppHost({
    home: o.home ?? home,
    version: "0.6.0-test",
    pid: 4242,
    exit: (code) => void exits.push(code),
    start: async () => {
      starts++;
      if (o.startGate) await o.startGate;
      if (starts <= (o.failStart ?? 0)) throw new Error("helper did not start");
      return {
        stop: async (reason) => {
          stops.push(reason ?? "");
          if (o.stopMs) await new Promise((r) => setTimeout(r, o.stopMs));
        },
      };
    },
    sections: () => [{ bindingId: "b1", title: "LFCP · Work", state: "active" }],
    write: (l) => events.push(JSON.parse(l)),
    log: (l) => logs.push(l),
    ...(o.shutdownWaitMs === undefined ? {} : { shutdownWaitMs: o.shutdownWaitMs }),
  });
  const send = async (cmd: Record<string, unknown>) => {
    host.input(`${line(cmd)}\n`);
    // Commands run one at a time on a promise chain: let it drain.
    for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
  };
  const replies = () => events.filter((e) => e.type === "reply");
  const statuses = () => events.filter((e) => e.type === "status").map((e) => e.state);
  return { host, events, logs, stops, exits, send, replies, statuses, starts: () => starts };
}

describe("AppHost", () => {
  it("says hello first, then starting, then running with the sections", async () => {
    const h = harness();
    await h.host.begin();
    expect(h.events[0]).toEqual({ v: 1, type: "hello", version: "0.6.0-test", pid: 4242 });
    expect(h.statuses()).toEqual(["starting", "running"]);
    expect(h.events.at(-1)).toMatchObject({
      sections: [{ bindingId: "b1", title: "LFCP · Work", state: "active" }],
    });
  });

  it("pause writes STOP and reports paused; resume removes it", async () => {
    const h = harness();
    await h.host.begin();
    await h.send({ id: "1", cmd: "pause" });
    expect(stopState(home)).toMatchObject({ reason: "Pause syncing (menu)" });
    expect(h.replies().at(-1)).toEqual({ v: 1, type: "reply", id: "1", ok: true });
    expect(h.statuses().at(-1)).toBe("paused");
    await h.send({ id: "2", cmd: "resume" });
    expect(stopState(home)).toBeUndefined();
    expect(h.statuses().at(-1)).toBe("running");
  });

  it("starts paused when STOP is already there", async () => {
    const h = harness();
    await h.send({ id: "0", cmd: "pause" }); // before begin: queued, writes STOP
    await h.host.begin();
    expect(h.statuses().at(-1)).toBe("paused");
  });

  for (const reason of ["update", "quit", "logout"] as const)
    it(`shutdown{${reason}} stops the run process and ends without STOP`, async () => {
      const h = harness();
      await h.host.begin();
      await h.send({ id: "5", cmd: "shutdown", reason });
      expect(await h.host.ended).toBe(reason);
      expect(h.stops).toEqual([`shutdown: ${reason}`]);
      expect(existsSync(join(home, STOP_FILE))).toBe(false);
      expect(h.replies()).toEqual([{ v: 1, type: "reply", id: "5", ok: true }]);
      expect(h.statuses().at(-1)).toBe("stopping");
      await h.send({ id: "6", cmd: "pause" });
      expect(h.replies().at(-1)).toMatchObject({
        id: "6",
        ok: false,
        error: { code: "shutting_down" },
      });
      expect(existsSync(join(home, STOP_FILE))).toBe(false);
    });

  it("stdin closing ends it like a shutdown, without STOP", async () => {
    const h = harness();
    await h.host.begin();
    expect(await h.host.end("stdin_closed")).toBe("stdin_closed");
    expect(h.stops).toEqual(["shutdown: stdin_closed"]);
    expect(existsSync(join(home, STOP_FILE))).toBe(false);
  });

  it("past the deadline it exits with EXIT_DEADLINE and does not report a clean end", async () => {
    const h = harness({ stopMs: 5_000, shutdownWaitMs: 20 });
    await h.host.begin();
    let ended = false;
    void h.host.ended.then(() => {
      ended = true;
    });
    await h.send({ id: "1", cmd: "shutdown", reason: "update" });
    await new Promise((r) => setTimeout(r, 60));
    expect(h.exits).toEqual([EXIT_DEADLINE]);
    expect(ended).toBe(false);
    expect(h.logs).toContain("app: shutdown deadline passed with work still running; exiting");
  });

  it("a shutdown during a start that hangs is not queued behind it; the deadline still holds", async () => {
    const h = harness({ startGate: new Promise(() => {}), shutdownWaitMs: 30 });
    void h.host.begin();
    await h.send({ id: "1", cmd: "shutdown", reason: "update" });
    expect(h.replies()).toEqual([{ v: 1, type: "reply", id: "1", ok: true }]);
    expect(h.statuses()).toEqual(["starting", "stopping"]);
    await new Promise((r) => setTimeout(r, 60));
    expect(h.exits).toEqual([EXIT_DEADLINE]);
  });

  it("stdin closing during a start: what the start brings is stopped, then the end", async () => {
    let release!: () => void;
    const h = harness({
      startGate: new Promise<void>((r) => {
        release = r;
      }),
    });
    void h.host.begin();
    const ended = h.host.end("stdin_closed");
    expect(h.statuses()).toEqual(["starting", "stopping"]);
    await h.send({ id: "2", cmd: "pause" });
    expect(h.replies().at(-1)).toMatchObject({ id: "2", error: { code: "shutting_down" } });
    release();
    expect(await ended).toBe("stdin_closed");
    expect(h.stops).toEqual(["shutdown: stdin_closed"]);
    expect(h.exits).toEqual([]);
    expect(existsSync(join(home, STOP_FILE))).toBe(false);
  });

  it("commands do not wait for a start in progress", async () => {
    const h = harness({ startGate: new Promise(() => {}) });
    void h.host.begin();
    await h.send({ id: "1", cmd: "pause" });
    await h.send({ id: "2", cmd: "openURL", url: SECRET_URL });
    expect(h.replies().map((r) => [r.id, r.ok])).toEqual([
      ["1", true],
      ["2", true],
    ]);
  });

  it("a command that throws gets reply failed (its code, no message) and the queue goes on", async () => {
    const h = harness({ home: join(home, "missing", "dir") });
    await h.host.begin();
    await h.send({ id: "1", cmd: "pause" });
    await h.send({ id: "2", cmd: "openURL", url: SECRET_URL });
    expect(h.replies()).toEqual([
      { v: 1, type: "reply", id: "1", ok: false, error: { code: "failed", detail: "ENOENT" } },
      { v: 1, type: "reply", id: "2", ok: true, result: { handled: false } },
    ]);
    expect(h.logs.join("\n")).not.toContain(home);
  });

  it("a run process that failed to start is unavailable; resume tries again", async () => {
    const h = harness({ failStart: 1 });
    await h.host.begin();
    expect(h.events.at(-1)).toMatchObject({
      type: "status",
      state: "unavailable",
      reason: "start_failed",
    });
    await h.send({ id: "1", cmd: "resume" });
    expect(h.starts()).toBe(2);
    expect(h.statuses().at(-1)).toBe("running");
  });

  it("acknowledges openURL and never writes the URL to a log line or a reply", async () => {
    const h = harness();
    await h.host.begin();
    await h.send({ id: "u", cmd: "openURL", url: SECRET_URL });
    expect(h.replies().at(-1)).toEqual({
      v: 1,
      type: "reply",
      id: "u",
      ok: true,
      result: { handled: false },
    });
    const everything = JSON.stringify(h.events) + h.logs.join("\n");
    expect(everything).not.toContain("very-secret-link-key");
    expect(everything).not.toContain("lfcp-bridge://");
  });

  it("answer, export and remove are not implemented yet", async () => {
    const h = harness();
    await h.host.begin();
    await h.send({ id: "a", cmd: "answer", questionId: "q", choice: "later" });
    await h.send({ id: "e", cmd: "export", path: "/tmp/x.zip" });
    await h.send({ id: "r", cmd: "remove", bindingId: "b1" });
    expect(h.replies().map((r) => [r.id, !r.ok && r.error.code])).toEqual([
      ["a", "not_implemented"],
      ["e", "not_implemented"],
      ["r", "not_implemented"],
    ]);
  });

  it("answers a bad line with a reply, and goes on", async () => {
    const h = harness();
    await h.host.begin();
    h.host.input("{oops\n");
    await h.send({ id: "x", cmd: "teleport" });
    await h.send({ id: "y", cmd: "pause" });
    expect(h.replies().map((r) => [r.id, r.ok ? "ok" : r.error.code])).toEqual([
      [null, "bad_line"],
      ["x", "unknown_command"],
      ["y", "ok"],
    ]);
  });
});

describe("serveApp and main run --app", () => {
  it("is refused while another run holds run.lock", async () => {
    const release = takeRunLock(home);
    expect(typeof release).toBe("function");
    const logs: string[] = [];
    const r = await serveApp({
      home,
      version: "t",
      lock: () => takeRunLock(home),
      start: async () => ({ stop: async () => {} }),
      sections: () => [],
      io: { input: new PassThrough(), write: () => {} },
      log: (l) => logs.push(l),
      signals: false,
    });
    expect(r).toEqual({ held: process.pid });
    (release as () => void)();
  });

  it("runs over stdio through main: hello, status, shutdown{update}, exit 0, no STOP", async () => {
    const paths = bridgePaths(
      { LFCP_BRIDGE_HOME: home, LFCP_BRIDGE_LOGS: join(home, "logs") },
      home,
    );
    const db = openBridgeDatabase(paths.database);
    const stops: string[] = [];
    const rt = {
      paths,
      db,
      startProcess: async () => ({ stop: async (why?: string) => void stops.push(why ?? "") }),
      close: async () => db.close(),
    } as unknown as Runtime;
    const input = new PassThrough();
    const out: string[] = [];
    const err: string[] = [];
    const done = main(["run", "--app"], {
      out: (l) => err.push(l),
      err: (l) => err.push(l),
      runtime: async () => rt,
      app: { input, write: (l) => out.push(l) },
    });
    for (let i = 0; i < 50 && out.length < 3; i++) await new Promise((r) => setTimeout(r, 5));
    expect(existsSync(join(home, "run.lock"))).toBe(true);
    input.write(`${line({ id: "1", cmd: "openURL", url: SECRET_URL })}\n`);
    input.write(`${line({ id: "2", cmd: "shutdown", reason: "update" })}\n`);
    expect(await done).toBe(EXIT.OK);
    const events = out.map((l) => JSON.parse(l));
    expect(events.map((e) => e.type)).toEqual([
      "hello",
      "status",
      "status",
      "reply",
      "reply",
      "status",
    ]);
    expect(events[2]).toMatchObject({ state: "running", sections: [] });
    expect(events[5]).toMatchObject({ state: "stopping", reason: "update" });
    expect(stops).toEqual(["shutdown: update"]);
    expect(existsSync(join(home, STOP_FILE))).toBe(false);
    expect(existsSync(join(home, "run.lock"))).toBe(false);
    expect(err.join("\n")).not.toContain("very-secret-link-key");
  });
});

describe("the deadline in a real process", () => {
  it("a stop that never ends: exit EXIT_DEADLINE after the deadline, run.lock kept, no STOP", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/app-deadline.mjs", import.meta.url));
    const child = spawn(process.execPath, [fixture, home, "300"], { stdio: "pipe" });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => {
      out += d;
    });
    child.stderr.on("data", (d) => {
      err += d;
    });
    for (let i = 0; i < 200 && !out.includes('"state":"running"'); i++)
      await new Promise((r) => setTimeout(r, 10));
    expect(out).toContain('"state":"running"');
    const t0 = Date.now();
    child.stdin.write(`${line({ id: "1", cmd: "shutdown", reason: "update" })}\n`);
    // stdin stays open, as the shell keeps it: only the deadline can end this process.
    const code = await new Promise<number | null>((r) => child.on("exit", r));
    expect(code).toBe(EXIT_DEADLINE);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250);
    expect(Date.now() - t0).toBeLessThan(5_000);
    expect(err).toContain("app: shutdown deadline passed with work still running; exiting");
    expect(err).not.toContain("fixture: ended");
    // Not released under work that still ran: its pid is dead now, the next host takes it over.
    expect(readFileSync(join(home, "run.lock"), "utf8").trim()).toBe(String(child.pid));
    expect(typeof takeRunLock(home)).toBe("function");
    expect(existsSync(join(home, STOP_FILE))).toBe(false);
  }, 15_000);
});
