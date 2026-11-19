// A host process for app-ipc.test.ts: serveApp over the real stdio, with a run process whose stop
// never ends and a timer that holds the event loop, as a live helper or socket would.
// argv: <home> <shutdownWaitMs>. The test bundles this file from src/ with esbuild (no dist/, so
// a stale build can never stand in for the code under test).

import { serveApp } from "../../src/app/serve.js";
import { takeRunLock } from "../../src/run/lock.js";

const [home = "", wait = "0"] = process.argv.slice(2);
const r = await serveApp({
  home,
  version: "fixture",
  lock: () => takeRunLock(home),
  start: async () => {
    setInterval(() => {}, 1_000);
    return { stop: () => new Promise<void>(() => {}) };
  },
  sections: () => [],
  io: { input: process.stdin, write: (l) => process.stdout.write(`${l}\n`) },
  log: (l) => process.stderr.write(`${l}\n`),
  shutdownWaitMs: Number(wait),
});
// Reached only when the stop finished in time.
process.stderr.write(`fixture: ended ${JSON.stringify(r)}\n`);
