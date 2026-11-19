// A host process for app-ipc.test.ts: serveApp over the real stdio, on the built package
// (dist/), with a run process whose stop never ends and a timer that holds the event loop, as a
// live helper or socket would. argv: <home> <shutdownWaitMs>.

import { serveApp } from "../../dist/app/serve.js";
import { takeRunLock } from "../../dist/run/cli.js";

const [home, wait] = process.argv.slice(2);
const r = await serveApp({
  home,
  version: "fixture",
  lock: () => takeRunLock(home),
  start: async () => {
    setInterval(() => {}, 1_000);
    return { stop: () => new Promise(() => {}) };
  },
  sections: () => [],
  io: { input: process.stdin, write: (l) => process.stdout.write(`${l}\n`) },
  log: (l) => process.stderr.write(`${l}\n`),
  shutdownWaitMs: Number(wait),
});
// Reached only when the stop finished in time.
process.stderr.write(`fixture: ended ${JSON.stringify(r)}\n`);
process.exitCode = 0;
