// The commands of `lfcp-bridge` (D-010 §2.1) and the pull request that brings
// each (§11). Until then a command answers "not available in this build"
// (exit 2), and `status` lists it the same way.

import { mkdirSync } from "node:fs";
import { type BindOutcome, Bootstrap } from "./bootstrap.js";
import { HOLD_REASONS, type HoldReason } from "./db/holds.js";
import { resume, stop, stopState } from "./db/stop.js";
import { doctor, worst } from "./doctor.js";
import { EXIT, type ExitCode } from "./exit.js";
import { installLaunchAgent, uninstallLaunchAgent } from "./launchd.js";
import { machineRuntime, type Runtime } from "./runtime.js";

export interface CommandInfo {
  readonly name: string;
  readonly summary: string;
  /** The PR of D-010 §11 that implements it. */
  readonly pr: string;
  /** Implemented in this build. */
  readonly ready?: boolean;
}

export const COMMANDS: readonly CommandInfo[] = Object.freeze([
  { name: "pair", summary: "pair a new installation (link on standard input)", pr: "9 (after 8)" },
  { name: "sections", summary: "the sections of the installations", pr: "9 (after 8)" },
  { name: "bind", summary: "bind a section to a new Reminders list", pr: "9", ready: true },
  { name: "dry-run", summary: "a full pass without effects", pr: "8" },
  { name: "approve", summary: "pending_dry_run -> active", pr: "9 (after 8)" },
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
  { name: "run", summary: "the long-running process", pr: "9 (after 8)" },
  { name: "stop", summary: "write STOP: no effect runs until resume", pr: "9", ready: true },
  { name: "resume", summary: "remove STOP, or accept one hold", pr: "9", ready: true },
  { name: "doctor", summary: "preflight checks; the TCC request", pr: "9", ready: true },
  { name: "conflicts", summary: "field conflicts", pr: "10" },
  { name: "quarantine", summary: "ambiguous matches and unknown outcomes", pr: "12" },
  { name: "refused", summary: "refused intents", pr: "7" },
  { name: "verify", summary: "the verification run of the owner", pr: "9", ready: true },
  { name: "sections add", summary: "N8: a section for a new installation", pr: "13" },
  { name: "migrate", summary: "N8: status, resume, abort", pr: "13" },
  { name: "service", summary: "install or uninstall the LaunchAgent", pr: "9", ready: true },
  { name: "log", summary: "the log", pr: "9", ready: true },
] satisfies CommandInfo[]);

export const VERSION = "0.0.0";

export const USAGE = `usage: lfcp-bridge <command> [arguments]

${COMMANDS.map((c) => `  ${c.name.padEnd(14)} ${c.summary}`).join("\n")}

  --version      print the version`;

export interface CliEnvironment {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** The machine (tests pass their own). */
  readonly runtime?: () => Promise<Runtime>;
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
  const rt = await (env.runtime ?? (() => machineRuntime()))();
  try {
    return await run(command.name, argv.slice(1), rt, env);
  } finally {
    await rt.close();
  }
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
              .join(
                "\n",
              )}\nChoose: lfcp-bridge bind --binding ${r.bindingId} --resolve-list <id>|none`
          : `binding ${r.bindingId}: whether the ownership marker was written is unknown. Markers with its url in the list:\n${(
              r.markers ?? []
            )
              .map((m) => `  ${m.ref.id ?? m.ref.externalId}  ${m.title}`)
              .join(
                "\n",
              )}\nChoose: lfcp-bridge bind --binding ${r.bindingId} --resolve-marker <id>|none`,
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

async function run(
  name: string,
  args: readonly string[],
  rt: Runtime,
  env: CliEnvironment,
): Promise<ExitCode> {
  const { positional, opts } = options(args);
  const stopped = () => stopState(rt.paths.home) !== undefined;
  switch (name) {
    case "bind":
    case "verify": {
      const transport = await rt.openTransport();
      const boot = new Bootstrap({
        db: rt.db,
        journal: rt.journal,
        transport,
        instanceId: rt.config.bridgeInstanceId,
        stopped,
      });
      const bindingId = opts.get("binding");
      if (typeof bindingId === "string") {
        const choice = opts.get("resolve-list");
        if (typeof choice === "string")
          return bindResult(await boot.resolveList(bindingId, choice), env);
        const marker = opts.get("resolve-marker");
        if (typeof marker === "string")
          return bindResult(await boot.resolveMarker(bindingId, marker), env);
        if (opts.get("retry-marker") === true)
          return bindResult(await boot.retryMarker(bindingId), env);
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
          "verification binding ready. Its writes start with the verification run, which comes with PR 8 (apply).",
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
    case "status": {
      const s = stopState(rt.paths.home);
      env.out(`STOP: ${s === undefined ? "no" : `yes${s.at ? ` (since ${s.at})` : ""}`}`);
      env.out(
        `writesVerified: ${rt.config.writesVerified ? `${rt.config.writesVerified.helperVersion} on macOS ${rt.config.writesVerified.macOS}` : "no (dry run only)"}`,
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
      for (const b of rows) {
        const holds = rt.holds.of(b.id).map((h) => h.reason);
        env.out(
          `${b.id}  ${b.state}  "${b.target_title ?? ""}"${b.verification ? "  (verification)" : ""}${holds.length ? `  holds: ${holds.join(", ")}` : ""}`,
        );
      }
      for (const c of COMMANDS.filter((x) => x.ready !== true))
        env.out(`not in this build: ${c.name} (PR ${c.pr})`);
      return EXIT.OK;
    }
    case "stop":
      mkdirSync(rt.paths.home, { recursive: true });
      stop(
        rt.paths.home,
        typeof opts.get("reason") === "string" ? String(opts.get("reason")) : "lfcp-bridge stop",
      );
      env.out("STOP written: no effect runs until `lfcp-bridge resume`");
      return EXIT.OK;
    case "resume": {
      const accept = opts.get("accept");
      if (typeof accept === "string") {
        const binding = opts.get("binding");
        if (typeof binding !== "string" || !(HOLD_REASONS as readonly string[]).includes(accept))
          return usage(
            env,
            `lfcp-bridge resume --accept <${HOLD_REASONS.join("|")}> --binding <id>`,
          );
        env.out(
          rt.holds.lift(binding, accept as HoldReason)
            ? `hold ${accept} lifted on ${binding}`
            : `no hold ${accept} on ${binding}`,
        );
        return EXIT.OK;
      }
      env.out(resume(rt.paths.home) ? "STOP removed" : "no STOP was set");
      return EXIT.OK;
    }
    case "doctor": {
      let transport: Awaited<ReturnType<Runtime["openTransport"]>> | undefined;
      try {
        transport = await rt.openTransport();
      } catch {}
      if (
        opts.get("request-access") === true &&
        transport !== undefined &&
        transport.status().state !== "ok"
      ) {
        env.out(
          "A system dialog asks for access to Reminders for “LFCP Reminders Helper”: choose Allow.",
        );
        await (transport as { requestAccess?: () => Promise<unknown> }).requestAccess?.();
      }
      // Read-only (review PR 9 P2-2): doctor reports markers through inspectMarkers; holds are
      // set by the run loop's OwnershipGuard, never by a diagnosis.
      const checks = await doctor({
        db: rt.db,
        home: rt.paths.home,
        helperApp: rt.config.helperPath ?? rt.paths.helperApp,
        instanceId: rt.config.bridgeInstanceId,
        ...(transport === undefined ? {} : { transport }),
        ...(rt.verifySignature === undefined ? {} : { verifySignature: rt.verifySignature }),
      });
      for (const c of checks) env.out(`${c.status.padEnd(4)}  ${c.name}: ${c.detail}`);
      const w = worst(checks);
      return w === "fail" ? EXIT.NEEDS_PERSON : EXIT.OK;
    }
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

function usage(env: CliEnvironment, line: string): ExitCode {
  env.err(`usage: ${line}`);
  return EXIT.USAGE;
}
