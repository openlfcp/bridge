#!/usr/bin/env node
// lfcp-bridge: the command line of the bridge (D-010 §2).

import { readFileSync } from "node:fs";
import { main } from "./commands.js";

const argv = process.argv.slice(2);
// `run --app` (src/app/serve.ts): stdout is the shell's channel, so every other line goes to stderr.
const app = argv[0] === "run" && argv.includes("--app");

process.exitCode = await main(argv, {
  out: (line) => (app ? process.stderr : process.stdout).write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  // `pbpaste | lfcp-bridge pair …`: the link comes on standard input, read only when asked.
  stdin: () => readFileSync(0, "utf8"),
});
// The shell may keep its end of stdin open after shutdown: do not wait for it.
if (app) process.stdin.destroy();
