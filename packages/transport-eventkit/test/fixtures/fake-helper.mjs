#!/usr/bin/env node
// A stand-in helper on three FIFOs (stdin, stdout, stderr paths as arguments).
// FAKE_HELPER_MODE: (default) answers everything, exits on shutdown or stdin EOF;
//   silent           never sends ready, exits on stdin EOF;
//   old-protocol     ready with protocol 1;
//   ignore-shutdown  answers, but ignores shutdown and stdin EOF (must be killed);
//   slow             answers op "slow" after 1.5 s;
//   no-id            answers the first request with a line without id, then normally;
//   stall-after:N    a helper stuck in EventKit (the hang analysis): answers the first N requests,
//                    then starts request N+1 and never answers it; later requests are queued
//                    behind it (no `started`, no answer). It ignores shutdown, stdin EOF and
//                    SIGTERM: only SIGKILL ends it. With FAKE_HELPER_STALL_EVENT_MS it also sends
//                    the helper's own `stalled` event (op, list of the stuck request) after that
//                    many ms, as its watchdog would, and still does not exit (G3: main blocked).
// Every mode but old-protocol announces each request it runs with `started` (ready
// requestStarted), as the helper does.
import fs from "node:fs";
import { createInterface } from "node:readline";

const [fin, fout, ferr] = process.argv.slice(2);
const mode = process.env.FAKE_HELPER_MODE ?? "";
const stallAfter = mode.startsWith("stall-after:") ? Number(mode.slice(12)) : undefined;
const stallEventMs = Number(process.env.FAKE_HELPER_STALL_EVENT_MS ?? "");
const input = fs.createReadStream(fin);
const out = fs.openSync(fout, "w");
fs.openSync(ferr, "w");
const send = (o) => fs.writeSync(out, `${JSON.stringify(o)}\n`);
const acks = mode !== "old-protocol";
if (mode !== "silent") {
  send({
    event: "ready",
    protocol: mode === "old-protocol" ? 1 : 2,
    helperVersion: "fake",
    backend: "memory",
    cas: "strong",
    authorization: "fullAccess",
    pid: process.pid,
    parentPath: "/sbin/launchd",
    bundleId: "fake",
    ...(acks ? { requestStarted: true } : {}),
  });
}
const stuck = mode === "ignore-shutdown" || stallAfter !== undefined;
if (stuck) setInterval(() => {}, 1000);
if (stallAfter !== undefined) process.on("SIGTERM", () => {});
let handled = 0;
let stalled = false;
createInterface({ input })
  .on("line", (l) => {
    const m = JSON.parse(l);
    if (stalled) return; // queued behind the stuck request: never started, never answered
    if (m.op === "shutdown" && stuck) return;
    if (mode === "no-id" && !globalThis.answeredWithoutId) {
      globalThis.answeredWithoutId = true;
      send({ ok: false, error: { code: "internal", message: "no id" } });
      return;
    }
    if (acks) send({ event: "started", id: m.id });
    if (stallAfter !== undefined && handled++ >= stallAfter) {
      stalled = true;
      if (stallEventMs > 0)
        setTimeout(
          () =>
            send({
              event: "stalled",
              op: m.op,
              ...(typeof m.list === "string" ? { list: m.list } : {}),
              timeoutS: stallEventMs / 1000,
            }),
          stallEventMs,
        );
      return;
    }
    const reply = () => send({ id: m.id, ok: true, op: m.op });
    if (m.op === "slow" && mode === "slow") setTimeout(reply, 1500);
    else reply();
    if (m.op === "shutdown") process.exit(0);
  })
  .on("close", () => {
    if (!stuck) process.exit(0);
  });
