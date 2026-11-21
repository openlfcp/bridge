#!/usr/bin/env node
// lfcp-bridge: the command line of the bridge (D-010 §2).

import { readFileSync } from "node:fs";
import { initializeAutomerge } from "@openlfcp/shared-objects";
import { main } from "./commands.js";

const argv = process.argv.slice(2);

// The bundle's Resources/bin/lfcp-bridge: a thin client of the running host (src/app/client.ts).
// It needs no Automerge, no database and no Reminders.
if (argv[0] === "--support-client") {
  const { supportClientMain } = await import("./app/client.js");
  process.exitCode = await supportClientMain(argv.slice(1), {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
} else {
  await host();
}

async function host(): Promise<void> {
  // The .app's bundle carries Automerge's /slim entry (scripts/bundle-host.mjs): its wasm is ready
  // only after this. From node_modules it is ready on import and this does nothing.
  await initializeAutomerge();

  // `run --app` (src/app/serve.ts): stdout is the shell's channel, so every other line goes to stderr.
  const app = argv[0] === "run" && argv.includes("--app");

  if (argv[0] === "--self-test") {
    // The packaged host's own check (src/self-test.ts, T§2 L5), loaded only when asked.
    const { selfTest } = await import("./self-test.js");
    process.exitCode = await selfTest(argv.slice(1), (line) => process.stdout.write(`${line}\n`));
  } else {
    process.exitCode = await main(argv, {
      out: (line) => (app ? process.stderr : process.stdout).write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
      // `pbpaste | lfcp-bridge pair …`: the link comes on standard input, read only when asked.
      stdin: () => readFileSync(0, "utf8"),
    });
    // The shell may keep its end of stdin open after shutdown: do not wait for it.
    if (app) process.stdin.destroy();
  }
}
