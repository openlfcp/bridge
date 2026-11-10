#!/usr/bin/env node
// Runs one HelperProcess.start (built dist) in its own process and reports the outcome on stdout.
// The parent test checks that this process then exits by itself (no FIFO open left blocking it).
//   RUN_LAUNCH=direct|open  RUN_APP=path  FAKE_OPEN_MODE / FAKE_HELPER_MODE for the fakes
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const { HelperProcess } = await import(path.resolve(here, "../../dist/link.js"));
const { EventKitTransport } = await import(path.resolve(here, "../../dist/transport.js"));
const opts = {
  appPath: process.env.RUN_APP ?? "/nonexistent/LFCP Reminders Helper.app",
  launch: process.env.RUN_LAUNCH ?? "open",
  launcher:
    process.env.RUN_LAUNCHER === "missing"
      ? ["/nonexistent/open"]
      : [process.execPath, path.join(here, "fake-open.mjs")],
  helperName: "node",
  readyTimeoutMs: Number(process.env.RUN_READY_MS ?? 3000),
};
if (process.env.RUN_VIA === "transport") {
  const t = new EventKitTransport(opts);
  const s = await t.open({
    installationKey: "i",
    state: { get() {}, put() {}, delete() {}, keys: () => [] },
    scope: { listTitlePrefixes: [], listIds: [] },
  });
  console.log(JSON.stringify({ status: s }));
} else {
  try {
    const h = await HelperProcess.start(opts);
    console.log(JSON.stringify({ started: true, pid: h.ready.pid }));
    await h.close();
  } catch (e) {
    console.log(JSON.stringify({ rejected: true, name: e.name, message: e.message }));
  }
}
