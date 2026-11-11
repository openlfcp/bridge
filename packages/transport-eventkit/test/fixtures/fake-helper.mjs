#!/usr/bin/env node
// A stand-in helper on three FIFOs (stdin, stdout, stderr paths as arguments).
// FAKE_HELPER_MODE: (default) answers everything, exits on shutdown or stdin EOF;
//   silent           never sends ready, exits on stdin EOF;
//   old-protocol     ready with protocol 1;
//   ignore-shutdown  answers, but ignores shutdown and stdin EOF (must be killed);
//   slow             answers op "slow" after 1.5 s;
//   no-id            answers the first request with a line without id, then normally.
import fs from "node:fs";
import { createInterface } from "node:readline";

const [fin, fout, ferr] = process.argv.slice(2);
const mode = process.env.FAKE_HELPER_MODE ?? "";
const input = fs.createReadStream(fin);
const out = fs.openSync(fout, "w");
fs.openSync(ferr, "w");
const send = (o) => fs.writeSync(out, `${JSON.stringify(o)}\n`);
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
  });
}
if (mode === "ignore-shutdown") setInterval(() => {}, 1000);
createInterface({ input })
  .on("line", (l) => {
    const m = JSON.parse(l);
    if (m.op === "shutdown" && mode === "ignore-shutdown") return;
    if (mode === "no-id" && !globalThis.answeredWithoutId) {
      globalThis.answeredWithoutId = true;
      send({ ok: false, error: { code: "internal", message: "no id" } });
      return;
    }
    const reply = () => send({ id: m.id, ok: true, op: m.op });
    if (m.op === "slow" && mode === "slow") setTimeout(reply, 1500);
    else reply();
    if (m.op === "shutdown") process.exit(0);
  })
  .on("close", () => {
    if (mode !== "ignore-shutdown") process.exit(0);
  });
