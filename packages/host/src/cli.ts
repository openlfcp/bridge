#!/usr/bin/env node
// lfcp-bridge: the command line of the bridge (D-010 §2).

import { main } from "./commands.js";

process.exitCode = await main(process.argv.slice(2), {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
});
