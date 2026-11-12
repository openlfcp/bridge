// The commands of `lfcp-bridge` (D-010 §2.1) and the pull request that brings
// each (§11). Until then a command answers "not available in this build"
// (exit 2), and `status` lists it the same way.

import { mkdirSync, readFileSync } from "node:fs";
import { type BindOutcome, Bootstrap } from "./bootstrap.js";
import { loadConfig, saveConfig } from "./config.js";
import { HOLD_REASONS, type HoldReason } from "./db/holds.js";
import { resume, stop, stopState } from "./db/stop.js";
import { doctor, worst } from "./doctor.js";
import { EXIT, type ExitCode } from "./exit.js";
import { installLaunchAgent, uninstallLaunchAgent } from "./launchd.js";
import { MigrationError, type MigrationRow, Migrations } from "./migration.js";
import {
  approveCommand,
  dryRunCommand,
  pairCommand,
  runCommand,
  sectionsCommand,
} from "./run/cli.js";
import { bumpControl } from "./run/process.js";
import { machineRuntime, type Runtime } from "./runtime.js";
import { decideRecord, parseVerificationReport } from "./verification.js";

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
  { name: "quarantine", summary: "ambiguous matches and unknown outcomes", pr: "12" },
  { name: "refused", summary: "refused intents", pr: "7" },
  {
    name: "verify",
    summary: "the verification run of the owner; --record <report.json> sets writesVerified",
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
] satisfies CommandInfo[]);

export const VERSION = "0.0.0";

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

/**
 * `verify --record <report.json>` (§7.6): a green verification report sets writesVerified for the
 * helper that runs here and this macOS. Refused, config unchanged: a red or empty report, no
 * verification binding, no helper, or a report made with another helper or macOS.
 */
async function recordCommand(
  rt: Runtime,
  file: string | true | undefined,
  env: CliEnvironment,
): Promise<ExitCode> {
  if (typeof file !== "string") return usage(env, "lfcp-bridge verify --record <report.json>");
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (e) {
    env.err(`cannot read ${file}: ${(e as Error).message}`);
    return EXIT.NOT_FOUND;
  }
  const report = parseVerificationReport(text);
  if (typeof report === "string") {
    env.err(`${file}: ${report} (docs/devel/testing/verification-report.template.json)`);
    return EXIT.USAGE;
  }
  const binding = rt.db
    .prepare("SELECT 1 FROM bindings WHERE verification = 1 AND state <> 'removed' LIMIT 1")
    .get();
  const decision = decideRecord(loadConfig(rt.paths.config), report, {
    running: await rt.helperIdentity?.(),
    verificationBinding: binding !== undefined,
  });
  if (decision.kind === "refused") {
    env.err(
      `verify --record refused (${decision.reason}): ${decision.detail}; writesVerified unchanged`,
    );
    return EXIT.NEEDS_PERSON;
  }
  saveConfig(rt.paths.config, decision.config);
  const r = decision.record;
  env.out(`writesVerified: helper ${r.helperVersion} on macOS ${r.macOS}, recorded ${r.at}`);
  env.out(
    "normal bindings may now write with this helper on this macOS; another helper build or macOS resets it",
  );
  return EXIT.OK;
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
      if (name === "verify" && opts.has("record"))
        return recordCommand(rt, opts.get("record"), env);
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
    case "status": {
      const s = stopState(rt.paths.home);
      env.out(`STOP: ${s === undefined ? "no" : `yes${s.at ? ` (since ${s.at})` : ""}`}`);
      const wv = rt.config.writesVerified;
      env.out(
        `writesVerified: ${wv ? `helper ${wv.helperVersion} on macOS ${wv.macOS} (recorded ${wv.at}; another helper or macOS resets it)` : "no (dry run only; lfcp-bridge verify --record <report.json>)"}`,
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

function usage(env: CliEnvironment, line: string): ExitCode {
  env.err(`usage: ${line}`);
  return EXIT.USAGE;
}
