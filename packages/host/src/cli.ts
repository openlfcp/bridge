#!/usr/bin/env node
// lfcp-bridge: the command line of the bridge (D-010 §2).

import { readFileSync } from "node:fs";
import { main } from "./commands.js";

process.exitCode = await main(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
  // `pbpaste | lfcp-bridge pair …`: the link comes on standard input, read only when asked.
  stdin: () => readFileSync(0, "utf8"),
});
