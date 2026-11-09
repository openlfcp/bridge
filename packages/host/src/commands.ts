// The commands of `lfcp-bridge` (D-010 §2.1) and the pull request that brings
// each (§11). Until then a command answers "not available in this build"
// (exit 2), and `status` will list it the same way.

import { EXIT, type ExitCode } from "./exit.js";

export interface CommandInfo {
  readonly name: string;
  readonly summary: string;
  /** The PR of D-010 §11 that implements it. */
  readonly pr: string;
}

export const COMMANDS: readonly CommandInfo[] = Object.freeze([
  { name: "pair", summary: "pair a new installation (link on standard input)", pr: "9" },
  { name: "sections", summary: "the sections of the installations", pr: "9" },
  { name: "bind", summary: "bind a section to a new Reminders list", pr: "9" },
  { name: "dry-run", summary: "a full pass without effects", pr: "8" },
  { name: "approve", summary: "pending_dry_run -> active", pr: "9" },
  { name: "unbind", summary: "remove a binding (the list and reminders stay)", pr: "9" },
  { name: "status", summary: "installations, bindings, holds, readiness, intents", pr: "9" },
  { name: "run", summary: "the long-running process", pr: "9" },
  { name: "stop", summary: "write STOP: no effect runs until resume", pr: "9" },
  { name: "resume", summary: "remove STOP, or accept one hold", pr: "9" },
  { name: "doctor", summary: "preflight checks; the TCC request", pr: "9" },
  { name: "conflicts", summary: "field conflicts", pr: "10" },
  { name: "quarantine", summary: "ambiguous matches and unknown outcomes", pr: "12" },
  { name: "refused", summary: "refused intents", pr: "7" },
  { name: "verify", summary: "the verification run of the owner", pr: "9" },
  { name: "sections add", summary: "N8: a section for a new installation", pr: "13" },
  { name: "migrate", summary: "N8: status, resume, abort", pr: "13" },
  { name: "service", summary: "install or uninstall the LaunchAgent", pr: "9" },
  { name: "log", summary: "the log", pr: "9" },
] satisfies CommandInfo[]);

export const VERSION = "0.0.0";

export const USAGE = `usage: lfcp-bridge <command> [arguments]

${COMMANDS.map((c) => `  ${c.name.padEnd(14)} ${c.summary}`).join("\n")}

  --version      print the version`;

export interface CliEnvironment {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Runs one `lfcp-bridge` invocation; returns its exit code. */
export async function main(argv: readonly string[], env: CliEnvironment): Promise<ExitCode> {
  const [first, second] = argv;
  if (first === undefined || first === "help" || first === "--help" || first === "-h") {
    env.out(USAGE);
    return first === undefined ? EXIT.USAGE : EXIT.OK;
  }
  if (first === "--version") {
    env.out(VERSION);
    return EXIT.OK;
  }
  const name = first === "sections" && second === "add" ? "sections add" : first;
  const command = COMMANDS.find((c) => c.name === name);
  if (command === undefined) {
    env.err(`unknown command ${first}\n\n${USAGE}`);
    return EXIT.USAGE;
  }
  env.err(`${command.name}: not available in this build (D-010 PR ${command.pr})`);
  return EXIT.USAGE;
}
