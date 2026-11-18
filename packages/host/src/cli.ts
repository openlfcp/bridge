#!/usr/bin/env node
// lfcp-bridge: the command line of the bridge (D-010 §2).

import { readFileSync } from "node:fs";
import { main } from "./commands.js";

const argv = process.argv.slice(2);
// Spike S-2: the packaged host's self-test (src/self-test.ts), loaded only when asked.
process.exitCode =
  argv[0] === "--self-test"
    ? await (await import("./self-test.js")).selfTest(argv.slice(1), (line) =>
        process.stdout.write(`${line}\n`),
      )
    : await main(argv, {
        out: (line) => process.stdout.write(`${line}\n`),
        err: (line) => process.stderr.write(`${line}\n`),
        // `pbpaste | lfcp-bridge pair …`: the link comes on standard input, read only when asked.
        stdin: () => readFileSync(0, "utf8"),
      });
