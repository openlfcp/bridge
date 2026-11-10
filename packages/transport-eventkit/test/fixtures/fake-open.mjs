#!/usr/bin/env node
// Stands in for `open -n -W -g -a APP --stdin IN --stdout OUT --stderr ERR --args …` in lifecycle tests.
// FAKE_OPEN_MODE=exit-early: exit 1 without opening anything (LaunchServices refused the app);
// exit-after-ready: start the helper, then exit after 0.8 s leaving it running.
// Otherwise: run fake-helper.mjs on the FIFOs and wait for it, like `open -W`.
import { spawn } from "node:child_process";
import path from "node:path";

const args = process.argv.slice(2);
const arg = (name) => args[args.indexOf(name) + 1];
if (process.env.FAKE_OPEN_MODE === "exit-early") process.exit(1);
const helper = spawn(
  process.execPath,
  [
    path.join(path.dirname(new URL(import.meta.url).pathname), "fake-helper.mjs"),
    arg("--stdin"),
    arg("--stdout"),
    arg("--stderr"),
  ],
  { stdio: "ignore" },
);
helper.on("exit", (code) => process.exit(code ?? 0));
// exit-after-ready: the launcher goes away while the helper keeps running (open killed, crashed).
if (process.env.FAKE_OPEN_MODE === "exit-after-ready") setTimeout(() => process.exit(0), 800);
