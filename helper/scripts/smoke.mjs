#!/usr/bin/env node
// Smoke test of the built LFCP Reminders Helper.app without Reminders access (no TCC prompt):
// one-shot commands, serve over pipes and over `open` + FIFOs, exit on host death and on EOF.
//   node scripts/smoke.mjs [path/to/LFCP Reminders Helper.app]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const here = path.dirname(new URL(import.meta.url).pathname);
const app = path.resolve(
  process.argv[2] ?? path.join(here, "..", "build", "LFCP Reminders Helper.app"),
);
const exe = path.join(app, "Contents", "MacOS", "lfcp-reminders-helper");
let failures = 0;
const check = (name, cond, detail = "") => {
  console.log(`${cond ? "ok  " : "FAIL"} ${name}${cond || !detail ? "" : `: ${detail}`}`);
  if (!cond) failures += 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** A helper session over a readable/writable pair. */
function session(input, output) {
  const lines = [];
  const waiters = [];
  createInterface({ input: output }).on("line", (l) => {
    const msg = JSON.parse(l);
    lines.push(msg);
    for (const w of [...waiters])
      if (w.match(msg)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve(msg);
      }
  });
  let id = 0;
  const waitFor = (match, ms = 5000) =>
    new Promise((resolve, reject) => {
      const hit = lines.find(match);
      if (hit) return resolve(hit);
      const w = { match, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error("timeout waiting for helper output")), ms);
    });
  return {
    lines,
    waitFor,
    request(op, body = {}) {
      id += 1;
      const rid = id;
      input.write(`${JSON.stringify({ v: 2, id: rid, op, ...body })}\n`);
      // A reply, not an event that names the request (`started` carries its id too).
      return waitFor((m) => m.id === rid && m.event === undefined);
    },
  };
}

// 1. one-shot commands
const version = JSON.parse(execFileSync(exe, ["--version"]).toString());
check("--version reports protocol 2", version.protocol === 2, JSON.stringify(version));
const status = JSON.parse(
  execFileSync(exe, ["status"], { stdio: ["ignore", "pipe", "ignore"] }).toString(),
);
check(
  "status reports authorization without prompting",
  typeof status.authorization === "string",
  JSON.stringify(status),
);
console.log(
  `     authorization=${status.authorization} bundleId=${status.bundleId} (direct exec: TCC subject is the parent)`,
);

// 2. serve --backend memory over pipes: the whole write path
{
  const child = spawn(exe, ["serve", "--backend", "memory"], { stdio: ["pipe", "pipe", "ignore"] });
  const s = session(child.stdin, child.stdout);
  const ready = await s.waitFor((m) => m.event === "ready");
  check(
    "memory: ready event",
    ready.protocol === 2 && ready.backend === "memory" && ready.cas === "strong",
  );
  check(
    "memory: hello",
    (await s.request("hello", { allowListTitlePrefixes: ["LFCP · "] })).writes === "ungated",
  );
  const list = (await s.request("lists.create", { title: "LFCP · Smoke", opKey: "k1" })).list;
  const created = await s.request("items.create", {
    list: list.id,
    linkUrl: "lfcp://task/T1",
    opKey: "k2",
    set: { title: "a", dueDate: "2026-12-01" },
  });
  check(
    "memory: create answers opKey/ref/rev/written",
    created.ok && created.opKey === "k2" && created.rev && created.written.title === "a",
  );
  const updated = await s.request("items.update", {
    ref: created.ref,
    set: { priority: 1 },
    opKey: "k3",
    expect: { rev: created.rev },
  });
  check("memory: update with expect.rev", updated.ok && updated.written.priority === 1);
  const stale = await s.request("items.update", {
    ref: created.ref,
    set: { priority: 9 },
    opKey: "k4",
    expect: { rev: created.rev },
  });
  check("memory: stale rev → conflict_changed", stale.error?.code === "conflict_changed");
  const marker = await s.request("markers.create", {
    list: list.id,
    markerUrl: "lfcp://bridge/smoke?r=R",
    opKey: "k5",
  });
  check("memory: marker is a completed reminder", marker.ok && marker.item.completed === true);
  await s.waitFor((m) => m.event === "changed");
  check("memory: changed events after own writes", true);
  const bye = await s.request("shutdown");
  check("memory: shutdown answers", bye.shutdown === true);
  const code = await new Promise((r) => child.on("exit", r));
  check("memory: exits 0 after shutdown", code === 0, String(code));
}

// 3. serve --backend eventkit without access: reads and writes report TCC, nothing prompts
{
  const child = spawn(exe, ["serve"], { stdio: ["pipe", "pipe", "ignore"] });
  const s = session(child.stdin, child.stdout);
  const ready = await s.waitFor((m) => m.event === "ready");
  check(
    "eventkit: ready with cas best-effort",
    ready.backend === "eventkit" && ready.cas === "best-effort",
  );
  const hello = await s.request("hello", { allowListTitlePrefixes: ["LFCP · "] });
  check("eventkit: hello reports writes off by default", hello.writes === "off");
  if (ready.authorization !== "fullAccess") {
    const r = await s.request("lists.list");
    check(
      "eventkit: reads without access → tcc_*",
      r.error?.code?.startsWith("tcc_"),
      JSON.stringify(r.error),
    );
    const w = await s.request("lists.create", { title: "LFCP · Smoke", opKey: "k" });
    check(
      "eventkit: writes without access → tcc_*",
      w.error?.code?.startsWith("tcc_"),
      JSON.stringify(w.error),
    );
  } else {
    const w = await s.request("lists.create", { title: "LFCP · Smoke", opKey: "k" });
    check(
      "eventkit (access granted): writes off → writes_disabled",
      w.error?.code === "writes_disabled",
      JSON.stringify(w.error),
    );
  }
  const dbg = await s.request("debug.dump");
  check("eventkit: debug ops refused", dbg.error?.code === "invalid");
  child.stdin.end();
  const code = await new Promise((r) => child.on("exit", r));
  check("eventkit: exits 0 on stdin EOF", code === 0, String(code));
}

// 4. host-pid: the helper exits when its host dies
{
  const host = spawn("sleep", ["30"], { stdio: "ignore" });
  const child = spawn(exe, ["serve", "--backend", "memory", "--host-pid", String(host.pid)], {
    stdio: ["pipe", "pipe", "ignore"],
  });
  const s = session(child.stdin, child.stdout);
  const ready = await s.waitFor((m) => m.event === "ready");
  check("host-pid: ready names the host", ready.hostPid === host.pid);
  const exited = new Promise((r) => child.on("exit", r));
  host.kill("SIGKILL");
  const code = await Promise.race([exited, sleep(5000).then(() => "timeout")]);
  check("host-pid: helper exits when the host dies", code === 0, String(code));
  if (code === "timeout") child.kill();
}

// 5. open + FIFOs (how the bridge launches it): LaunchServices makes the app its own responsible process
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfcp-helper-smoke-"));
  const [fin, fout, ferr] = ["in", "out", "err"].map((n) => path.join(dir, n));
  for (const f of [fin, fout, ferr]) execFileSync("mkfifo", [f]);
  const opener = spawn(
    "open",
    [
      "-n",
      "-W",
      "-g",
      "-a",
      app,
      "--stdin",
      fin,
      "--stdout",
      fout,
      "--stderr",
      ferr,
      "--args",
      "serve",
      "--backend",
      "memory",
      "--host-pid",
      String(process.pid),
    ],
    { stdio: "ignore" },
  );
  const input = fs.createWriteStream(fin);
  const output = fs.createReadStream(fout);
  fs.createReadStream(ferr).resume();
  const s = session(input, output);
  try {
    const ready = await s.waitFor((m) => m.event === "ready", 15000);
    check(
      "open: ready via LaunchServices",
      ready.bundleId === "org.openlfcp.bridge.reminders",
      JSON.stringify(ready),
    );
    check(
      "open: parent is launchd (own responsible process)",
      ready.parentPath === "/sbin/launchd",
      ready.parentPath,
    );
    check("open: ping", (await s.request("ping")).pong === true);
    input.end();
    const code = await Promise.race([
      new Promise((r) => opener.on("exit", r)),
      sleep(10000).then(() => "timeout"),
    ]);
    check("open: helper exits on stdin EOF (open -W returns)", code === 0, String(code));
  } catch (e) {
    check("open: helper over FIFOs", false, e.message);
    opener.kill();
  }
  for (const f of [fin, fout, ferr]) fs.rmSync(f, { force: true });
  fs.rmdirSync(dir);
}

console.log(failures === 0 ? "\nsmoke: all passed" : `\nsmoke: ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
