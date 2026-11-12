// The commands of PR 9b (D-010 r4 §2.1): run, dry-run, approve, pair, sections.
//
// | command                              | here                                                       |
// |--------------------------------------|------------------------------------------------------------|
// | `run`                                | run.lock (one process), the process until SIGTERM / SIGINT |
// | `dry-run [<binding>]`                | a full pass without effects, recorded in runs; the summary |
// | `approve <binding>`                  | pending_dry_run → active: a planned dry run ≤ 1 h old,     |
// |                                      | ownership not lost; strict for 24 h (§7.2)                 |
// | `pair --label <l> --section <n>…`    | storage-node's pair (link on standard input), then the     |
// |                                      | installation row; run again with `--installation` to resume |
// | `sections`                           | the paired sections of every installation, bound or not    |

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Plan } from "@openlfcp/bridge-reminders/adapter";
import { deviceIdentity, pairedResources } from "@openlfcp/client";
import { fromHex, resourceId, toHex } from "@openlfcp/core";
import { openNodeInstallation, PAIR_EXIT, pair } from "@openlfcp/storage-node";
import { EXIT, type ExitCode } from "../exit.js";
import { Pass } from "../reconcile/pass.js";
import type { Runtime } from "../runtime.js";
import { seedInstanceId } from "./process.js";

export interface RunCliEnvironment {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Resolves when the process should stop (default: SIGTERM or SIGINT). */
  readonly until?: Promise<string>;
  /** The link for `pair` (default: standard input). */
  readonly stdin?: () => string;
}

const APPROVE_WITHIN_MS = 60 * 60_000;
const STRICT_MS = 24 * 60 * 60_000;

// ------------------------------------------------------------------ run

/** run.lock: one run process. A lock whose pid is gone is stale and taken over. */
export function takeRunLock(home: string): (() => void) | { readonly held: number } {
  mkdirSync(home, { recursive: true });
  const path = join(home, "run.lock");
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      return () => rmSync(path, { force: true });
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      const pid = Number(readFileSync(path, "utf8").trim());
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) return { held: pid };
      rmSync(path, { force: true });
    }
  }
  return { held: -1 };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const signals = () =>
  new Promise<string>((resolve) => {
    for (const s of ["SIGTERM", "SIGINT"] as const) process.once(s, () => resolve(s));
  });

export async function runCommand(rt: Runtime, env: RunCliEnvironment): Promise<ExitCode> {
  if (rt.startProcess === undefined) {
    env.err("run: not available on this machine");
    return EXIT.USAGE;
  }
  const lock = takeRunLock(rt.paths.home);
  if (typeof lock !== "function") {
    env.err(`run: another lfcp-bridge run is running (pid ${lock.held})`);
    return EXIT.NEEDS_PERSON;
  }
  try {
    const p = await rt.startProcess();
    env.out("lfcp-bridge run: started");
    const why = await (env.until ?? signals());
    await p.stop(why);
    env.out(`lfcp-bridge run: stopped (${why})`);
    return EXIT.OK;
  } finally {
    lock();
  }
}

// ------------------------------------------------------------------ dry-run

function summary(plan: Plan, out: (line: string) => void): void {
  const c = plan.counts;
  out(`  tasks ${c.tasks} (in filter ${c.inFilter}), reminders ${c.reminders}, linked ${c.linked}`);
  out(
    `  would: create ${c.creates} reminder(s), update ${c.updates}, import ${c.imports}, unlink ${c.unlinks}`,
  );
  for (const i of plan.intents)
    out(
      `  ${i.direction} ${i.kind} ${i.taskId}${i.fields.length ? ` [${i.fields.join(", ")}]` : ""}`,
    );
  for (const t of plan.transitions)
    out(`  link ${t.taskId}: ${t.kind}${t.reason ? ` (${t.reason})` : ""}`);
  for (const k of plan.conflicts) out(`  conflict ${k.taskId} ${k.field}: ${k.kind}`);
  for (const w of plan.waiting) out(`  waiting ${w.taskId}: ${w.waiting}`);
}

export async function dryRunCommand(
  rt: Runtime,
  bindingId: string | undefined,
  env: RunCliEnvironment,
): Promise<ExitCode> {
  if (rt.openInstallations === undefined) {
    env.err("dry-run: not available on this machine");
    return EXIT.USAGE;
  }
  seedInstanceId(rt.db, rt.config.bridgeInstanceId, rt.journal);
  const bindings = (
    rt.db
      .prepare(
        "SELECT id, installation_id, resource_id FROM bindings WHERE state IN ('pending_dry_run','active') ORDER BY id",
      )
      .all() as { id: string; installation_id: string; resource_id: string }[]
  ).filter((b) => bindingId === undefined || b.id === bindingId);
  if (bindings.length === 0) {
    env.err(bindingId === undefined ? "no bindings" : `no binding ${bindingId}`);
    return EXIT.NOT_FOUND;
  }
  const transport = await rt.openTransport();
  const opened = await rt.openInstallations();
  let code: ExitCode = EXIT.OK;
  try {
    for (const b of bindings) {
      const inst = opened.ports.find((p) => p.id === b.installation_id);
      if (inst === undefined) {
        env.err(`${b.id}: its installation is not open`);
        code = EXIT.NEEDS_PERSON;
        continue;
      }
      const R = resourceId(fromHex(b.resource_id));
      if (!inst.host.isOpen(R)) await inst.host.open(R);
      const r = await new Pass({
        db: rt.db,
        transport,
        lfcp: inst.host,
        me: async () => inst.me,
        ...(inst.createdBy === undefined ? {} : { createdBy: async () => inst.createdBy }),
      }).plan(b.id, "dry");
      if (r.kind !== "planned") {
        env.err(`${b.id}: dry run refused: ${r.reason}${r.detail ? ` (${r.detail})` : ""}`);
        code = EXIT.NEEDS_PERSON;
        continue;
      }
      env.out(`${b.id}: dry run ${r.runId}`);
      summary(r.plan, env.out);
      if (r.guards.length > 0) {
        env.out(`  guards that would stop it: ${r.guards.join(", ")}`);
        code = EXIT.STOPPED;
      }
      env.out(`  next: lfcp-bridge approve ${b.id}`);
    }
  } finally {
    for (const p of opened.ports) await p.host.stop().catch(() => {});
    opened.close();
  }
  return code;
}

// ------------------------------------------------------------------ approve

export function approveCommand(
  rt: Runtime,
  bindingId: string | undefined,
  env: RunCliEnvironment,
  now: () => number = Date.now,
): ExitCode {
  if (bindingId === undefined) {
    env.err("usage: lfcp-bridge approve <binding>");
    return EXIT.USAGE;
  }
  const b = rt.db.prepare("SELECT state FROM bindings WHERE id = ?").get(bindingId) as
    | { state: string }
    | undefined;
  if (b === undefined) {
    env.err(`no binding ${bindingId}`);
    return EXIT.NOT_FOUND;
  }
  if (b.state !== "pending_dry_run") {
    env.err(`approve: binding ${bindingId} is ${b.state}, not pending_dry_run`);
    return EXIT.USAGE;
  }
  const lost = rt.holds
    .of(bindingId)
    .map((h) => h.reason)
    .filter((r) => r === "ownership_lost" || r === "foreign_bridge");
  if (lost.length > 0) {
    env.err(`approve: ownership not confirmed (${lost.join(", ")}); see lfcp-bridge doctor`);
    return EXIT.NEEDS_PERSON;
  }
  const run = rt.db
    .prepare(
      "SELECT id, started_at, stats_json FROM runs WHERE binding_id = ? AND kind = 'dry' AND outcome = 'planned' ORDER BY started_at DESC, rowid DESC LIMIT 1",
    )
    .get(bindingId) as { id: string; started_at: string; stats_json: string | null } | undefined;
  if (run === undefined || now() - Date.parse(run.started_at) > APPROVE_WITHIN_MS) {
    env.err(
      `approve: no dry run of ${bindingId} within the last hour; run lfcp-bridge dry-run ${bindingId} first`,
    );
    return EXIT.NEEDS_PERSON;
  }
  const guards = (JSON.parse(run.stats_json ?? "{}") as { guards?: string[] }).guards ?? [];
  if (guards.length > 0) {
    env.err(
      `approve: the dry run would stop on ${guards.join(", ")}; resolve it and dry-run again`,
    );
    return EXIT.STOPPED;
  }
  const at = new Date(now()).toISOString();
  rt.db
    .prepare(
      "UPDATE bindings SET state = 'active', approved_at = ?, approved_plan_run_id = ?, strict_until = ? WHERE id = ? AND state = 'pending_dry_run'",
    )
    .run(at, run.id, new Date(now() + STRICT_MS).toISOString(), bindingId);
  rt.journal.append("info", "binding.approved", {
    bindingId,
    params: {
      run: run.id,
      text: "Approved: the bridge synchronizes this list (strict limits for 24 h).",
    },
  });
  env.out(
    `approved ${bindingId} (dry run ${run.id}); strict limits until ${new Date(now() + STRICT_MS).toISOString()}`,
  );
  return EXIT.OK;
}

// ------------------------------------------------------------------ sections, pair

export async function sectionsCommand(rt: Runtime, env: RunCliEnvironment): Promise<ExitCode> {
  const rows = rt.db
    .prepare("SELECT id, dir, label FROM installations WHERE status = 'active' ORDER BY created_at")
    .all() as { id: string; dir: string; label: string }[];
  if (rows.length === 0) {
    env.out("no installations; pair one: lfcp-bridge pair --label <name> --section <section>");
    return EXIT.OK;
  }
  for (const r of rows) {
    const node = await openNodeInstallation(r.dir);
    try {
      env.out(`installation ${r.id} (${r.label})`);
      for (const s of await pairedResources(node)) {
        const hex = toHex(s.resource);
        const bound = rt.db
          .prepare("SELECT id, state FROM bindings WHERE resource_id = ? AND state <> 'removed'")
          .get(hex) as { id: string; state: string } | undefined;
        env.out(
          `  ${s.name ?? "(no name)"}  ${hex.slice(0, 12)}…${s.ready ? "" : "  (not ready)"}${bound ? `  bound: ${bound.id} ${bound.state}` : ""}`,
        );
      }
    } finally {
      node.close();
    }
  }
  return EXIT.OK;
}

/** A shell word in single quotes: nothing expands in it, `!` included (zsh, bash). */
const quoted = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

/** The command that resumes a pairing waiting for approval, ready to paste (review PR 9b #30). */
export function pairResumeCommand(
  label: string,
  installation: string,
  sections: readonly string[],
): string {
  return `pbpaste | lfcp-bridge pair --label ${quoted(label)} --installation ${installation} ${sections
    .map((x) => `--section ${quoted(x)}`)
    .join(" ")}`;
}

export async function pairCommand(
  rt: Runtime,
  o: {
    readonly label?: string;
    readonly sections: readonly string[];
    readonly installation?: string;
    readonly wait?: number;
  },
  env: RunCliEnvironment,
): Promise<ExitCode> {
  if (o.label === undefined || o.sections.length === 0) {
    env.err(
      "usage: lfcp-bridge pair --label <name> --section <section> [--section …] [--installation <id>] < link",
    );
    return EXIT.USAGE;
  }
  const id = o.installation ?? randomUUID();
  const dir = join(rt.paths.installations, id);
  // A pairing that is neither done nor waiting leaves nothing behind (R-023): the directory it
  // made, keys included, goes; one that existed before (--installation) is never touched.
  const created = !existsSync(dir);
  const discard = () => {
    if (created) rmSync(dir, { recursive: true, force: true });
  };
  let code: number;
  try {
    code = await pair(
      {
        link: "-",
        state: dir,
        label: o.label,
        kind: 1,
        sections: o.sections,
        platform: "macOS",
        wait: o.wait ?? 600,
        poll: 5,
      },
      { out: env.out, ...(env.stdin === undefined ? {} : { stdin: env.stdin }) },
    );
  } catch (e) {
    discard();
    throw e;
  }
  if (code !== PAIR_EXIT.DONE && code !== PAIR_EXIT.WAITING) discard();
  if (code === PAIR_EXIT.WAITING) {
    env.out(
      `not approved yet; approve it on the managing device, then run again:\n  ${pairResumeCommand(o.label, id, o.sections)}`,
    );
    return EXIT.NEEDS_PERSON;
  }
  if (code !== PAIR_EXIT.DONE) return code === PAIR_EXIT.USAGE ? EXIT.USAGE : EXIT.NEEDS_PERSON;
  const node = await openNodeInstallation(dir);
  try {
    const principal = node.installation.signer.descriptor.principalId;
    const root = (await deviceIdentity(node))?.root;
    rt.db
      .prepare(
        `INSERT INTO installations (id, dir, principal, root, label, created_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO NOTHING`,
      )
      .run(
        id,
        dir,
        toHex(principal),
        root === undefined ? "" : toHex(root),
        o.label,
        new Date().toISOString(),
      );
  } finally {
    node.close();
  }
  env.out(
    `paired: installation ${id}; next: lfcp-bridge sections, then lfcp-bridge verify --section <test section>`,
  );
  return EXIT.OK;
}
