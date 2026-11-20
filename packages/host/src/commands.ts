// The commands of `lfcp-bridge` (D-010 §2.1) and the pull request that brings
// each (§11). Until then a command answers "not available in this build"
// (exit 2), and `status` lists it the same way.

import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { retire05 } from "./app/legacy.js";
import { type AppIo, serveApp } from "./app/serve.js";
import {
  type PeerUid,
  SUPPORT_SOCKET,
  type SupportIo,
  shellExecutable,
  shellPeerUid,
} from "./app/support.js";
import { keptGate } from "./artifact/write-gate.js";
import { type BindOutcome, Bootstrap } from "./bootstrap.js";
import { bridgePaths } from "./config.js";
import { HOLD_REASONS, type HoldReason } from "./db/holds.js";
import { Journal } from "./db/journal.js";
import { resume, stop, stopState } from "./db/stop.js";
import { recordHostCrash } from "./diag/crash.js";
import { errorCode } from "./diag/errors.js";
import {
  type DiagnosticsSource,
  defaultExportDir,
  defaultExportPath,
  exportDiagnostics,
} from "./diag/export.js";
import { type Check, doctor, worst } from "./doctor.js";
import { Runs } from "./executor/safe-mode.js";
import { EXIT, type ExitCode } from "./exit.js";
import {
  installLaunchAgent,
  type LaunchAgent05,
  type Launchctl,
  uninstallLaunchAgent,
} from "./launchd.js";
import { MigrationError, type MigrationRow, Migrations } from "./migration.js";
import {
  acceptOutcome,
  candidates,
  ignoreReminder,
  linkReminder,
  quarantineCounts,
  quarantined,
  type Resolution,
  redoOutcome,
  resolveCommands,
  shortId,
} from "./quarantine.js";
import { bridgeHandler } from "./reconcile/handler.js";
import {
  approveCommand,
  dryRunCommand,
  pairCommand,
  runCommand,
  sectionsCommand,
  takeRunLock,
} from "./run/cli.js";
import { bumpControl } from "./run/process.js";
import { machineRuntime, type RunningProcess, type Runtime } from "./runtime.js";

export interface CommandInfo {
  readonly name: string;
  readonly summary: string;
  /** The PR of D-010 §11 that implements it. */
  readonly pr: string;
  /** Implemented in this build. */
  readonly ready?: boolean;
}

export const COMMANDS: readonly CommandInfo[] = Object.freeze([
  {
    name: "pair",
    summary: "pair a new installation (link on standard input)",
    pr: "9b",
    ready: true,
  },
  { name: "sections", summary: "the sections of the installations", pr: "9b", ready: true },
  { name: "bind", summary: "bind a section to a new Reminders list", pr: "9", ready: true },
  { name: "dry-run", summary: "a full pass without effects", pr: "9b", ready: true },
  { name: "approve", summary: "pending_dry_run -> active", pr: "9b", ready: true },
  {
    name: "unbind",
    summary: "remove a binding (the list and reminders stay)",
    pr: "9",
    ready: true,
  },
  {
    name: "status",
    summary: "installations, bindings, holds, readiness, intents",
    pr: "9",
    ready: true,
  },
  { name: "run", summary: "the long-running process", pr: "9b", ready: true },
  { name: "stop", summary: "write STOP: no effect runs until resume", pr: "9", ready: true },
  { name: "resume", summary: "remove STOP, or accept one hold", pr: "9", ready: true },
  { name: "doctor", summary: "preflight checks; the TCC request", pr: "9", ready: true },
  { name: "conflicts", summary: "field conflicts", pr: "10" },
  {
    name: "quarantine",
    summary: "ambiguous matches and unknown outcomes: list, accept, redo, link, ignore",
    pr: "12",
    ready: true,
  },
  { name: "refused", summary: "refused intents", pr: "7" },
  {
    name: "verify",
    summary: "a verification binding (--section): its own list, writes as in 0.5 (A§9.4)",
    pr: "9",
    ready: true,
  },
  {
    name: "sections add",
    summary: "N8: a section for a new installation",
    pr: "13",
    ready: true,
  },
  { name: "migrate", summary: "N8: status, resume, abort", pr: "13", ready: true },
  { name: "service", summary: "install or uninstall the LaunchAgent", pr: "9", ready: true },
  { name: "log", summary: "the log", pr: "9", ready: true },
  { name: "links", summary: "the links of the bindings (--binding <b>)", pr: "E-006", ready: true },
  {
    name: "safe-mode",
    summary: "safe-mode reset: off after doctor finds no cause",
    pr: "E-006",
    ready: true,
  },
  {
    name: "certification-test",
    summary: "on|off: the certification test mode (E-050)",
    pr: "E-006",
    ready: true,
  },
  {
    name: "export",
    summary: "export diagnostics: a zip to send to support yourself (--out <file.zip>)",
    pr: "E-045",
    ready: true,
  },
] satisfies CommandInfo[]);

export const VERSION = "0.5.0";

export const USAGE = `usage: lfcp-bridge <command> [arguments]

${COMMANDS.map((c) => `  ${c.name.padEnd(14)} ${c.summary}`).join("\n")}

  --version      print the version`;

export interface CliEnvironment {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** `run`: resolves when the process should stop (default: SIGTERM / SIGINT). */
  readonly until?: Promise<string>;
  /** `pair`: the link (default: standard input). */
  readonly stdin?: () => string;
  /** The machine (tests pass their own). */
  readonly runtime?: () => Promise<Runtime>;
  /** `run --app`: the shell's channel (default: stdin and stdout). */
  readonly app?: AppIo;
  /**
   * `run --app`: 0.5's LaunchAgent and the data directory whose run.lock is taken, both before the
   * runtime opens bridge.sqlite (src/app/legacy.ts; default: the machine's paths and launchctl).
   */
  readonly launchAgent05?: {
    readonly path: string;
    readonly home: string;
    readonly launchctl?: Launchctl;
    readonly waitMs?: number;
  };
  /**
   * `run --app`: who may use support.sock (default: this process's uid, told by the shell's
   * executable of LFCP_BRIDGE_APP; none outside the app).
   */
  readonly support?: { readonly uid?: number; readonly peerUid?: PeerUid };
}

/** A person's decision on an unknown bootstrap outcome (A§7.3), in either syntax. */
const BIND_USAGE =
  "lfcp-bridge bind --resolve-list <binding> <list id>|none | --resolve-marker <binding> <marker id>|none | --retry-marker <binding>";

/**
 * `bind` on an existing binding. A§7.3 (0.6): `--resolve-list <b> <listId|none>`,
 * `--resolve-marker <b> <markerId|none>`, `--retry-marker <b>`. 0.5, still accepted:
 * `--binding <b> --resolve-list <id>`, `--binding <b> --resolve-marker <id>`,
 * `--binding <b> --retry-marker`, and `--binding <b>` alone (continue the bootstrap).
 * undefined: not a decision (`bind <section>` binds a new one).
 */
function bindDecision(
  positional: readonly string[],
  opts: ReadonlyMap<string, string | true>,
):
  | {
      readonly bindingId: string;
      readonly kind: "resolve-list" | "resolve-marker" | "retry-marker" | "resume";
      readonly choice?: string;
    }
  | undefined {
  const kinds = ["resolve-list", "resolve-marker", "retry-marker"] as const;
  const binding = opts.get("binding");
  if (typeof binding === "string") {
    for (const kind of kinds) {
      const v = opts.get(kind);
      if (v === undefined) continue;
      return {
        bindingId: binding,
        kind,
        ...(typeof v === "string" ? { choice: v } : {}),
      };
    }
    return { bindingId: binding, kind: "resume" };
  }
  for (const kind of kinds) {
    const v = opts.get(kind);
    if (v === undefined) continue;
    // The binding is the option's value; a missing one is a usage error, never `bind <section>`.
    return {
      bindingId: typeof v === "string" ? v : "",
      kind,
      ...(positional[0] === undefined ? {} : { choice: positional[0] }),
    };
  }
  return undefined;
}

/** Only these `bind`s go through support.sock: binding a section is the plugin's (A§7.3). */
function isBindDecision(args: readonly string[]): boolean {
  const { positional, opts } = options(args);
  const d = bindDecision(positional, opts);
  return d !== undefined && d.kind !== "resume";
}

/** --name value / --flag parsing for the commands below. */
function options(args: readonly string[]): {
  positional: string[];
  opts: Map<string, string | true>;
} {
  const positional: string[] = [];
  const opts = new Map<string, string | true>();
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (!a.startsWith("--")) positional.push(a);
    else if (i + 1 < args.length && !(args[i + 1] as string).startsWith("--"))
      opts.set(a.slice(2), args[++i] as string);
    else opts.set(a.slice(2), true);
  }
  return { positional, opts };
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
  if (command.ready !== true) {
    env.err(`${command.name}: not available in this build (D-010 PR ${command.pr})`);
    return EXIT.USAGE;
  }
  if (command.name === "run" && options(argv.slice(1)).opts.get("app") === true)
    return appMain(env);
  const rt = await (env.runtime ?? (() => machineRuntime()))();
  try {
    return await run(command.name, argv.slice(1), rt, env);
  } finally {
    await rt.close();
  }
}

/**
 * `run --app`, in this order (PLAN §E-007): 0.5's LaunchAgent retired; run.lock taken; only then
 * the runtime, which opens and migrates bridge.sqlite; run.lock released after the database is
 * closed. A bootout that failed, or run.lock held by another run process, ends it before the
 * database is touched: exit NEEDS_PERSON, and the shell starts it again with its back-off.
 */
async function appMain(env: CliEnvironment): Promise<ExitCode> {
  const legacy = env.launchAgent05 ?? {
    path: bridgePaths().launchAgent,
    home: bridgePaths().home,
  };
  const retired = await retire05({
    launchAgent: legacy.path,
    home: legacy.home,
    ...(legacy.launchctl === undefined ? {} : { launchctl: legacy.launchctl }),
    ...(legacy.waitMs === undefined ? {} : { waitMs: legacy.waitMs }),
  });
  if (retired.state === "failed") {
    env.err(
      `run --app: the LaunchAgent of lfcp-bridge 0.5 could not be booted out (${retired.detail}); not started, it is tried again at the next start`,
    );
    return EXIT.NEEDS_PERSON;
  }
  const release = takeRunLock(legacy.home);
  if (typeof release !== "function") {
    env.err(`run --app: another lfcp-bridge run is running (pid ${release.held})`);
    return EXIT.NEEDS_PERSON;
  }
  try {
    const rt = await (env.runtime ?? (() => machineRuntime()))();
    try {
      if (rt.paths.home !== legacy.home)
        throw new Error("run --app: run.lock and the runtime name different data directories");
      return await appCommand(rt, env, retired);
    } finally {
      await rt.close();
    }
  } finally {
    release();
  }
}

/** `run --app` (src/app/serve.ts): the host under LFCP Bridge.app. */
async function appCommand(
  rt: Runtime,
  env: CliEnvironment,
  retired: LaunchAgent05,
): Promise<ExitCode> {
  const startProcess = rt.startProcess;
  if (startProcess === undefined) {
    env.err("run --app: not available on this machine");
    return EXIT.USAGE;
  }
  if (retired.state === "removed") {
    // A 0.5 agent with another LFCP_BRIDGE_HOME left its data there: said, never moved (E-007).
    const sameHome = retired.home === undefined || retired.home === rt.paths.home;
    rt.journal.append(sameHome ? "info" : "warn", "bridge.launch_agent_05_removed", {
      params: { sameHome },
    });
    env.err(
      `run --app: the LaunchAgent of lfcp-bridge 0.5 was removed${sameHome ? "" : "; it used another data directory, which is left as it is"}`,
    );
  }
  // A crash of the host leaves its signature, never its message (A§11, src/diag/crash.ts).
  const onCrash = (e: unknown) => recordHostCrash(rt.paths.home, e);
  process.on("uncaughtExceptionMonitor", onCrash);
  try {
    return await serveAppCommand(rt, env, startProcess);
  } finally {
    process.off("uncaughtExceptionMonitor", onCrash);
  }
}

async function serveAppCommand(
  rt: Runtime,
  env: CliEnvironment,
  startProcess: NonNullable<Runtime["startProcess"]>,
): Promise<ExitCode> {
  const r = await serveApp({
    home: rt.paths.home,
    version: VERSION,
    // Taken by appMain before the runtime opened bridge.sqlite; released there after it is closed.
    lock: () => () => {},
    start: (shuttingDown, shell) => startProcess(shuttingDown, { shell, version: VERSION }),
    sections: () =>
      (
        rt.db
          .prepare(
            "SELECT id, target_title, state FROM bindings WHERE state <> 'removed' ORDER BY created_at, id",
          )
          .all() as { id: string; target_title: string | null; state: string }[]
      ).map((b) => ({ bindingId: b.id, title: b.target_title ?? "", state: b.state })),
    // The menu's Export diagnostics… (E-008): the zip at the path the person chose.
    exportDiagnostics: (path) => {
      exportDiagnostics(diagnosticsSource(rt), path);
    },
    io: env.app ?? {
      input: process.stdin,
      write: (line) => process.stdout.write(`${line}\n`),
    },
    log: env.err,
    support: {
      path: join(rt.paths.home, SUPPORT_SOCKET),
      uid: env.support?.uid ?? process.getuid?.() ?? -1,
      peerUid:
        env.support?.peerUid ??
        (process.env.LFCP_BRIDGE_APP
          ? shellPeerUid(shellExecutable(process.env.LFCP_BRIDGE_APP))
          : undefined),
      run: (argv, io, p) =>
        supportCommand(rt, argv, io, p, process.env.LFCP_BRIDGE_APP || undefined),
    },
  });
  return typeof r === "string" ? EXIT.OK : EXIT.NEEDS_PERSON;
}

/** The author of what a support command journals (A§7.3). */
export const SUPPORT_AUTHOR = "support CLI";

/** The commands support.sock runs (A§7.3; links, safe-mode reset, certification-test: E-006b). */
export const SUPPORT_COMMANDS: readonly string[] = [
  "status",
  "doctor",
  "quarantine",
  "bind",
  "migrate",
  "resume",
  "stop",
  "links",
  "safe-mode",
  "certification-test",
  "export",
];

/**
 * One support command inside the host (src/app/serve.ts runs it in its queue, serialized with the
 * passes): the 0.5 command, with the run process's transport — never a second one (A§7.3) — and
 * its journal entries authored "support CLI".
 */
async function supportCommand(
  rt: Runtime,
  argv: readonly string[],
  io: SupportIo,
  p: RunningProcess | undefined,
  appBundle?: string,
): Promise<ExitCode> {
  const [name = "", sub] = argv;
  const journal = new Journal(rt.db, Date.now, undefined, SUPPORT_AUTHOR);
  let code: ExitCode;
  if (!SUPPORT_COMMANDS.includes(name)) {
    io.err(`not a support command: ${name} (${SUPPORT_COMMANDS.join(", ")})`);
    code = EXIT.USAGE;
  } else if (name === "bind" && !isBindDecision(argv.slice(1))) {
    // Only decisions on an unknown outcome (A§7.3): binding a section is the plugin's.
    code = usage(io, BIND_USAGE);
  } else {
    const support: Runtime = {
      ...rt,
      journal,
      // doctor's helper is the app itself: the helper runs from its bundle (A§2.1).
      ...(appBundle === undefined ? {} : { config: { ...rt.config, helperPath: appBundle } }),
      serverConnected: () => p?.connected?.(),
      async openTransport() {
        if (p?.transport === undefined)
          throw new Error(
            "Reminders is not open: the run process is not running (lfcp-bridge doctor)",
          );
        return p.transport;
      },
    };
    try {
      code = await run(name, argv.slice(1), support, io);
    } catch (e) {
      io.err(`${name}: ${(e as Error).message}`);
      code = EXIT.NEEDS_PERSON;
    }
  }
  const command = ["quarantine", "migrate", "safe-mode", "certification-test"].includes(name)
    ? `${name} ${sub ?? ""}`
    : name;
  journal.append(code === EXIT.OK ? "info" : "warn", "support.command", {
    params: { command: command.trim(), exit: code },
  });
  return code;
}

function bindResult(r: BindOutcome, env: CliEnvironment): ExitCode {
  switch (r.state) {
    case "pending_dry_run":
      env.out(
        `bound: binding ${r.bindingId}, list "${r.title}" (${r.list}); next: lfcp-bridge dry-run ${r.bindingId}`,
      );
      return EXIT.OK;
    case "unknown_outcome":
      env.err(
        r.step === "list"
          ? `binding ${r.bindingId}: whether the list was created is unknown. Lists with that title:\n${(
              r.candidates ?? []
            )
              .map((c) => `  ${c.id}  ${c.title}`)
              .join("\n")}\nChoose: lfcp-bridge bind --resolve-list ${r.bindingId} <id>|none`
          : `binding ${r.bindingId}: whether the ownership marker was written is unknown. Markers with its url in the list:\n${(
              r.markers ?? []
            )
              .map((m) => `  ${m.ref.id ?? m.ref.externalId}  ${m.title}`)
              .join("\n")}\nChoose: lfcp-bridge bind --resolve-marker ${r.bindingId} <id>|none`,
      );
      return EXIT.NEEDS_PERSON;
    case "refused":
      env.err(`bind refused: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
      return r.reason === "stop"
        ? EXIT.STOPPED
        : r.reason === "not_unknown"
          ? EXIT.USAGE
          : EXIT.NEEDS_PERSON;
  }
}

const QUARANTINE_USAGE = `lfcp-bridge quarantine [list] [--binding <binding>]
       lfcp-bridge quarantine accept <intent>     the write happened: take Reminders as it is
       lfcp-bridge quarantine redo <intent>       write it again from LFCP
       lfcp-bridge quarantine link <reminder> <task>     (or <intent>: the reminder an unknown create made)
       lfcp-bridge quarantine ignore <reminder> <task>`;

/** `quarantine` (D-010 §2.1, §5.4, §5.7): what waits for a person, and their decisions. */
async function quarantineCommand(
  rt: Runtime,
  positional: readonly string[],
  opts: ReadonlyMap<string, string | true>,
  env: CliEnvironment,
): Promise<ExitCode> {
  const [sub = "list", a, b] = positional;
  // Reminders is opened only when a decision needs it (an unknown create looks for its reminder).
  const o = { journal: rt.journal, transport: () => rt.openTransport() };
  const done = (r: Resolution): ExitCode => {
    if (r.kind === "refused") {
      env.err(`quarantine ${sub} refused: ${r.text}`);
      return r.text.startsWith("no ") ? EXIT.NOT_FOUND : EXIT.NEEDS_PERSON;
    }
    // The run process looks at the control state every 2 s: a change starts a full pass.
    bumpControl(rt.db);
    env.out(r.text);
    return EXIT.OK;
  };
  switch (sub) {
    case "list": {
      const binding = opts.get("binding");
      const entries = quarantined(rt.db, typeof binding === "string" ? binding : undefined);
      if (entries.length === 0) {
        env.out("nothing in quarantine");
        return EXIT.OK;
      }
      // Candidates of an ambiguous match come from Reminders: the helper only when one is listed.
      let transport: Awaited<ReturnType<Runtime["openTransport"]>> | undefined;
      if (entries.some((e) => e.kind === "ambiguous_match"))
        transport = await rt.openTransport().catch(() => undefined);
      for (const e of entries) {
        const task = e.taskTitle === undefined ? "" : `  task "${e.taskTitle}"`;
        const reminder =
          e.reminder === undefined
            ? ""
            : `  reminder ${shortId(e.reminder.id)}${e.reminder.title === undefined ? "" : ` "${e.reminder.title}"`}`;
        env.out(
          `${e.id}  ${e.bindingId}  ${e.kind}${task}${reminder}  since ${e.since}${e.detail ? `  (${e.detail})` : ""}`,
        );
        if (e.kind === "ambiguous_match") {
          const c =
            transport?.status().state === "ok"
              ? await candidates(rt.db, transport, e.id).catch(() => undefined)
              : undefined;
          if (c === undefined)
            env.out("    candidates: Reminders not available (lfcp-bridge doctor); try again");
          for (const i of c?.items ?? [])
            env.out(
              `    candidate ${i.ref.id} "${i.title}"${i.completed ? " (completed)" : ""}  → lfcp-bridge quarantine link ${i.ref.id} ${e.id}  |  lfcp-bridge quarantine ignore ${i.ref.id} ${e.id}`,
            );
          continue;
        }
        for (const cmd of resolveCommands(e)) env.out(`    → ${cmd}`);
      }
      return EXIT.OK;
    }
    case "accept":
      if (a === undefined) return usage(env, QUARANTINE_USAGE);
      return done(
        await acceptOutcome(rt.db, a, {
          ...o,
          handler: bridgeHandler({ timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
        }),
      );
    case "redo":
    case "drop":
      if (a === undefined) return usage(env, QUARANTINE_USAGE);
      return done(await redoOutcome(rt.db, a, o));
    case "link":
    case "ignore": {
      if (a === undefined || b === undefined) return usage(env, QUARANTINE_USAGE);
      const transport = await rt.openTransport();
      return done(
        sub === "link"
          ? await linkReminder(rt.db, transport, a, b, o)
          : await ignoreReminder(rt.db, transport, a, b, o),
      );
    }
    default:
      return usage(env, QUARANTINE_USAGE);
  }
}

async function run(
  name: string,
  args: readonly string[],
  rt: Runtime,
  env: CliEnvironment,
): Promise<ExitCode> {
  const { positional, opts } = options(args);
  const stopped = () => stopState(rt.paths.home) !== undefined;
  switch (name) {
    case "run":
      // `run --app` is appMain's, before any runtime.
      return runCommand(rt, env);
    case "dry-run":
      return dryRunCommand(rt, positional[0], env);
    case "approve":
      return approveCommand(rt, positional[0], env);
    case "sections":
      return sectionsCommand(rt, env);
    case "pair": {
      const sections: string[] = [];
      for (let i = 0; i < args.length; i++)
        if (args[i] === "--section" && args[i + 1]) sections.push(args[i + 1] as string);
      const label = opts.get("label");
      const inst = opts.get("installation");
      const wait = opts.get("wait");
      return pairCommand(
        rt,
        {
          ...(typeof label === "string" ? { label } : {}),
          sections,
          ...(typeof inst === "string" ? { installation: inst } : {}),
          ...(typeof wait === "string" ? { wait: Number(wait) } : {}),
        },
        env,
      );
    }
    case "bind":
    case "verify": {
      if (name === "verify" && opts.has("record")) {
        // A§9.1, E-051: writes follow the manifests of the artifact and its certification.
        env.err(
          "verify --record is gone: writes are on when this build is certified for this macOS (lfcp-bridge status)",
        );
        return EXIT.USAGE;
      }
      const transport = await rt.openTransport();
      const boot = new Bootstrap({
        db: rt.db,
        journal: rt.journal,
        transport,
        instanceId: rt.config.bridgeInstanceId,
        stopped,
      });
      const decision = bindDecision(positional, opts);
      if (decision !== undefined) {
        const { bindingId, kind, choice } = decision;
        if (bindingId === "") return usage(env, BIND_USAGE);
        if (kind === "resolve-list" || kind === "resolve-marker") {
          if (choice === undefined) return usage(env, BIND_USAGE);
          return bindResult(
            await (kind === "resolve-list"
              ? boot.resolveList(bindingId, choice)
              : boot.resolveMarker(bindingId, choice)),
            env,
          );
        }
        if (kind === "retry-marker") return bindResult(await boot.retryMarker(bindingId), env);
        return bindResult(await boot.resume(bindingId), env);
      }
      const section = name === "verify" ? opts.get("section") : positional[0];
      if (typeof section !== "string") {
        env.err(
          name === "verify"
            ? "usage: lfcp-bridge verify --section <test section>"
            : "usage: lfcp-bridge bind <section>",
        );
        return EXIT.USAGE;
      }
      const resolved = await rt.resolveSection(section);
      if (resolved === undefined) {
        env.err(`no paired section named "${section}"`);
        return EXIT.NOT_FOUND;
      }
      const filter = opts.get("filter");
      const r = await boot.bind({
        installationId: resolved.installationId,
        resourceId: resolved.resourceId,
        section: resolved.title,
        ...(filter === "mine" || filter === "all" || filter === "default" ? { filter } : {}),
        verification: name === "verify" || opts.get("verification") === true,
      });
      const code = bindResult(r, env);
      if (name === "verify" && code === EXIT.OK)
        env.out(
          "verification binding ready: lfcp-bridge dry-run, then lfcp-bridge approve, then lfcp-bridge run (docs/devel/testing/verification-run.md)",
        );
      return code;
    }
    case "unbind": {
      const id = positional[0];
      if (id === undefined) return usage(env, "lfcp-bridge unbind <binding>");
      const transport = await rt.openTransport();
      const r = await new Bootstrap({
        db: rt.db,
        journal: rt.journal,
        transport,
        instanceId: rt.config.bridgeInstanceId,
        stopped,
      }).unbind(id);
      if (r.refused !== undefined) {
        env.err(`unbind refused: ${r.refused.join(", ")} (lfcp-bridge resume first)`);
        return EXIT.STOPPED;
      }
      env.out(
        `binding ${id} removed${r.retired ? "; its marker retired" : ""}; the list and its reminders stay`,
      );
      const why = [...(r.denied ?? []), ...(r.failed === undefined ? [] : [r.failed])];
      if (why.length > 0)
        env.out(
          `its ownership marker was left in Reminders (${why.join(", ")}); delete "LFCP bridge · не удалять" there if you want`,
        );
      return EXIT.OK;
    }
    case "quarantine":
      return quarantineCommand(rt, positional, opts, env);
    case "status": {
      const s = stopState(rt.paths.home);
      env.out(`STOP: ${s === undefined ? "no" : `yes${s.at ? ` (since ${s.at})` : ""}`}`);
      const cert = keptGate(rt.db);
      env.out(
        `cert.state: ${cert === undefined ? "not checked yet (preview)" : `${cert.state}${cert.state === "certified" ? "" : " (preview)"}: ${cert.detail} (${cert.reason}, ${cert.at})`}`,
      );
      const rows = rt.db
        .prepare(
          "SELECT id, state, target_title, verification FROM bindings WHERE state <> 'removed' ORDER BY id",
        )
        .all() as {
        id: string;
        state: string;
        target_title: string | null;
        verification: number;
      }[];
      if (rows.length === 0) env.out("no bindings");
      const quarantine = quarantineCounts(rt.db);
      for (const b of rows) {
        const holds = rt.holds.of(b.id).map((h) => h.reason);
        const q = quarantine.get(b.id) ?? 0;
        env.out(
          `${b.id}  ${b.state}  "${b.target_title ?? ""}"${b.verification ? "  (verification)" : ""}${holds.length ? `  holds: ${holds.join(", ")}` : ""}${q > 0 ? `  quarantine: ${q} (lfcp-bridge quarantine)` : ""}`,
        );
      }
      for (const c of COMMANDS.filter((x) => x.ready !== true))
        env.out(`not in this build: ${c.name} (PR ${c.pr})`);
      return EXIT.OK;
    }
    case "stop":
      mkdirSync(rt.paths.home, { recursive: true });
      bumpControl(rt.db);
      stop(
        rt.paths.home,
        typeof opts.get("reason") === "string" ? String(opts.get("reason")) : "lfcp-bridge stop",
      );
      env.out("STOP written: no effect runs until `lfcp-bridge resume`");
      return EXIT.OK;
    case "resume": {
      bumpControl(rt.db);
      const accept = opts.get("accept");
      if (typeof accept === "string") {
        const binding = opts.get("binding");
        if (typeof binding !== "string" || !(HOLD_REASONS as readonly string[]).includes(accept))
          return usage(
            env,
            `lfcp-bridge resume --accept <${HOLD_REASONS.join("|")}> --binding <id>`,
          );
        env.out(
          rt.holds.accept(binding, accept as HoldReason)
            ? `hold ${accept} lifted and accepted on ${binding}: the next pass goes through`
            : `no hold ${accept} on ${binding}`,
        );
        return EXIT.OK;
      }
      env.out(resume(rt.paths.home) ? "STOP removed" : "no STOP was set");
      return EXIT.OK;
    }
    case "doctor": {
      const checks = await doctorChecks(rt, opts.get("request-access") === true, env);
      for (const c of checks) env.out(`${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
      const w = worst(checks);
      return w === "fail" ? EXIT.NEEDS_PERSON : EXIT.OK;
    }
    case "links":
      return linksCommand(rt, opts.get("binding"), env);
    case "export": {
      const out = opts.get("out");
      if (out === true || (out !== undefined && (!isAbsolute(out) || !out.endsWith(".zip"))))
        return usage(env, "lfcp-bridge export [--out </absolute/path.zip>]");
      if (out === undefined) defaultExportDir(rt.paths.home);
      const path = out ?? defaultExportPath(rt.paths.home);
      let bytes: number;
      try {
        ({ bytes } = exportDiagnostics(diagnosticsSource(rt), path));
      } catch (e) {
        // A symlink or a directory at the path, a missing folder: its code, never the path's text.
        env.err(`export: not written (${errorCode(e)}): choose a new file in an existing folder`);
        return EXIT.NEEDS_PERSON;
      }
      env.out(`diagnostics exported (${bytes} bytes): ${path}`);
      env.out(
        "titles, URLs, paths and error texts are replaced by one-time HMACs; send the file to support yourself",
      );
      return EXIT.OK;
    }
    case "safe-mode":
      if (positional[0] !== "reset") return usage(env, "lfcp-bridge safe-mode reset");
      return safeModeReset(rt, env);
    case "certification-test":
      if (positional[0] !== "on" && positional[0] !== "off")
        return usage(env, "lfcp-bridge certification-test on|off");
      // A§9.4: the instance's certification_test flag comes with E-050.
      env.err(`certification-test ${positional[0]}: not available in this build (E-050)`);
      return EXIT.USAGE;
    case "service": {
      const action = positional[0];
      if (action === "install") {
        installLaunchAgent(
          rt.paths.launchAgent,
          { node: rt.node, cli: rt.cli, home: rt.paths.home, logs: rt.paths.logs },
          rt.launchctl,
        );
        env.out(`LaunchAgent installed: ${rt.paths.launchAgent}`);
        return EXIT.OK;
      }
      if (action === "uninstall") {
        env.out(
          uninstallLaunchAgent(rt.paths.launchAgent, rt.launchctl)
            ? "LaunchAgent removed"
            : "no LaunchAgent was installed",
        );
        return EXIT.OK;
      }
      return usage(env, "lfcp-bridge service install|uninstall");
    }
    case "sections add":
    case "migrate": {
      const action = name === "sections add" ? "add" : positional[0];
      const ports = rt.migrationPorts === undefined ? undefined : await rt.migrationPorts();
      const migrations = new Migrations({
        db: rt.db,
        journal: rt.journal,
        ports: ports ?? noPorts,
      });
      const needsPorts = action === "add" || action === "resume";
      if (needsPorts && ports === undefined) {
        env.err(
          `${name === "sections add" ? "sections add" : "migrate resume"}: needs pairing and the run process (D-010 PR 9 after 8); not available in this build`,
        );
        return EXIT.USAGE;
      }
      if (action === "add") {
        const section = positional[1];
        if (section === undefined)
          return usage(env, "lfcp-bridge sections add <name> [--from <installation>]");
        const active = rt.db
          .prepare("SELECT id FROM installations WHERE status = 'active' ORDER BY created_at")
          .all() as { id: string }[];
        const fromOpt = opts.get("from");
        const from =
          typeof fromOpt === "string" ? fromOpt : active.length === 1 ? active[0]?.id : undefined;
        if (from === undefined) {
          env.err(
            `sections add: choose the installation with --from (${active.map((a) => a.id).join(", ") || "none active"})`,
          );
          return EXIT.USAGE;
        }
        const r = await migrations.add(from, [section]);
        if (r.state === "refused") {
          env.err(
            `sections add refused: ${
              r.detail ??
              `${r.reasons.map((x) => `${x.reason} ${x.count}`).join(", ")}; wait for the synchronisation, resolve the conflicts, then try again`
            }`,
          );
          return EXIT.NEEDS_PERSON;
        }
        return migrationResult(r.migration, env);
      }
      if (action === "status") {
        const all = migrations.list();
        if (all.length === 0) env.out("no migrations");
        for (const m of all) env.out(migrationLine(m));
        return EXIT.OK;
      }
      if (action === "resume" || action === "abort") {
        const id = positional[1] ?? migrations.open()?.id;
        if (id === undefined || migrations.get(id) === undefined) {
          env.err(
            `migrate ${action}: no migration${positional[1] ? ` ${positional[1]}` : " under way"}`,
          );
          return EXIT.NOT_FOUND;
        }
        try {
          return migrationResult(
            action === "abort" ? migrations.abort(id) : await migrations.advance(id),
            env,
          );
        } catch (e) {
          if (!(e instanceof MigrationError)) throw e;
          env.err(`migrate ${action}: ${e.message}`);
          return EXIT.NEEDS_PERSON;
        }
      }
      return usage(env, "lfcp-bridge migrate status|resume|abort [<migration>]");
    }
    case "log": {
      const binding = opts.get("binding");
      const limit = Number(opts.get("limit") ?? 50);
      for (const e of rt.journal.list({
        ...(typeof binding === "string" ? { bindingId: binding } : {}),
        limit,
      }))
        env.out(
          `${e.ts}  ${e.level.padEnd(5)}  ${e.key}${e.bindingId ? ` [${e.bindingId}]` : ""}  ${e.text}`,
        );
      return EXIT.OK;
    }
  }
  return EXIT.USAGE;
}

const noPorts = {
  pair: async () => undefined,
  catchUp: async () => [],
  closeOld: async () => {},
  revocationStatus: async () => "unreachable" as const,
};

function migrationLine(m: MigrationRow): string {
  return `${m.id}  ${m.phase}  ${m.from} -> ${m.to ?? "?"}${m.blockedReason ? `  blocked: ${m.blockedReason}` : ""}${m.abortedReason ? `  aborted: ${m.abortedReason}` : ""}`;
}

function migrationResult(m: MigrationRow, env: CliEnvironment): ExitCode {
  env.out(migrationLine(m));
  switch (m.phase) {
    case "aborted":
      env.err(
        m.abortedReason?.startsWith("not_quiescent")
          ? "work appeared during the pairing; the old installation works on. Run sections add again later."
          : `migration ${m.id} aborted`,
      );
      return EXIT.NEEDS_PERSON;
    case "awaiting_revocation":
      env.out(
        `revoke the old device (installation ${m.from}) in the plugin, then lfcp-bridge migrate resume ${m.id}`,
      );
      return EXIT.OK;
    case "catching_up":
      env.out(
        m.blockedReason
          ? `the new installation is not live; check the connection, or lfcp-bridge migrate abort ${m.id}`
          : `the new installation is catching up; lfcp-bridge migrate resume ${m.id}`,
      );
      return m.blockedReason ? EXIT.NEEDS_PERSON : EXIT.OK;
    default:
      return EXIT.OK;
  }
}

/** doctor's checks (read-only), with the TCC request when asked. */
async function doctorChecks(
  rt: Runtime,
  requestAccess: boolean,
  env: Pick<CliEnvironment, "out">,
): Promise<readonly Check[]> {
  let transport: Awaited<ReturnType<Runtime["openTransport"]>> | undefined;
  try {
    transport = await rt.openTransport();
  } catch {}
  if (requestAccess && transport !== undefined && transport.status().state !== "ok") {
    env.out(
      "A system dialog asks for access to Reminders for “LFCP Reminders Helper”: choose Allow.",
    );
    await (transport as { requestAccess?: () => Promise<unknown> }).requestAccess?.();
  }
  // Read-only (review PR 9 P2-2): doctor reports markers through inspectMarkers; holds are
  // set by the run loop's OwnershipGuard, never by a diagnosis.
  const server = rt.serverConnected?.();
  return doctor({
    db: rt.db,
    home: rt.paths.home,
    helperApp: rt.config.helperPath ?? rt.paths.helperApp,
    instanceId: rt.config.bridgeInstanceId,
    ...(transport === undefined ? {} : { transport }),
    ...(rt.verifySignature === undefined ? {} : { verifySignature: rt.verifySignature }),
    ...(server === undefined ? {} : { server }),
  });
}

/** The doctor checks whose failure keeps Safe Mode on (A§7.3: TCC, helper, server). */
export const SAFE_MODE_CAUSES: readonly string[] = ["reminders access", "helper", "server"];

/**
 * `safe-mode reset` (A§7.3): Safe Mode off only after doctor finds no active cause; else refused
 * with the cause. Serialized with the passes and journaled by the support queue.
 */
async function safeModeReset(rt: Runtime, env: CliEnvironment): Promise<ExitCode> {
  const runs = new Runs(rt.db);
  if (runs.safeMode() === undefined) {
    env.out("Safe Mode is not on");
    return EXIT.OK;
  }
  const causes = (await doctorChecks(rt, false, env)).filter(
    (c) => c.status === "fail" && SAFE_MODE_CAUSES.includes(c.name),
  );
  if (causes.length > 0) {
    rt.journal.append("warn", "safe_mode.reset_refused", {
      params: { causes: causes.map((c) => c.name) },
    });
    for (const c of causes) env.err(`safe-mode reset refused: ${c.name}: ${c.detail}`);
    env.err("fix the cause (lfcp-bridge doctor), then safe-mode reset again");
    return EXIT.NEEDS_PERSON;
  }
  runs.safeModeOff();
  bumpControl(rt.db);
  env.out("Safe Mode off: the next pass runs");
  return EXIT.OK;
}

/** `links [--binding <b>]`: the links of the bindings, with the reminder ids the commands take. */
function linksCommand(
  rt: Runtime,
  binding: string | true | undefined,
  env: CliEnvironment,
): ExitCode {
  const of = typeof binding === "string";
  const rows = rt.db
    .prepare(
      `SELECT binding_id, task_id, state, state_reason, origin, rem_external_id, rem_id_cache,
              rem_title_snapshot FROM links${of ? " WHERE binding_id = ?" : ""}
        ORDER BY binding_id, task_id`,
    )
    .all(...(of ? [binding] : [])) as {
    binding_id: string;
    task_id: string;
    state: string;
    state_reason: string | null;
    origin: string;
    rem_external_id: string | null;
    rem_id_cache: string | null;
    rem_title_snapshot: string | null;
  }[];
  if (rows.length === 0) {
    env.out(of ? `no links of ${binding}` : "no links");
    return EXIT.OK;
  }
  for (const l of rows) {
    const reminder = l.rem_id_cache ?? l.rem_external_id;
    env.out(
      `${l.binding_id}  ${l.task_id}  ${l.state}${l.state_reason ? ` (${l.state_reason})` : ""}  ${l.origin}${reminder === null ? "" : `  reminder ${reminder}`}${l.rem_title_snapshot === null ? "" : ` "${l.rem_title_snapshot}"`}`,
    );
  }
  return EXIT.OK;
}

/** What an export reads (A§11): the database, the data directory, macOS's crash reports. */
function diagnosticsSource(rt: Runtime): DiagnosticsSource {
  return {
    db: rt.db,
    home: rt.paths.home,
    config: rt.config,
    version: VERSION,
    ...(process.platform === "darwin"
      ? { reports: join(homedir(), "Library", "Logs", "DiagnosticReports") }
      : {}),
  };
}

function usage(env: Pick<CliEnvironment, "err">, line: string): ExitCode {
  env.err(`usage: ${line}`);
  return EXIT.USAGE;
}
