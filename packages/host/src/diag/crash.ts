// Crash signatures (A§11, E20): instead of a raw crash report — which holds messages, paths,
// registers and memory — the process, the exception's class and the top frames of our own code.
// The host's own crash (an exception nobody caught) is written as a signature, at once, to
// <home>/crashes/; the shell's and the helper's come from macOS's .ips reports, read at export.

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { CODE } from "./errors.js";

export interface CrashSignature {
  /** "host", or one of OWN_PROCESSES. */
  readonly process: string;
  /** The exception's class (host) or the Mach exception type (.ips). */
  readonly exception: string;
  /** Top frames of our own modules: "function (file:line)" or "image+offset". */
  readonly frames: readonly string[];
}

/** Our executables: an .ips report of anything else is never read. */
export const OWN_PROCESSES: readonly string[] = ["LFCP Bridge", "lfcp-reminders-helper"];
export const CRASHES_DIR = "crashes";
export const TOP_FRAMES = 8;
/** How many signatures an export carries (the newest). */
export const MAX_CRASHES = 10;

/** One frame, as a signature keeps it: identifiers, a file's base name and numbers only. */
export const FRAME = /^(?:[\w$.#<>]{1,96} \([\w.-]{1,64}:\d{1,7}\)|[\w .-]{1,64}\+\d{1,10})$/;

// "    at fn (file:///…/packages/host/dist/executor/executor.js:602:7)", "    at file:///…:1:2"
const NODE_FRAME = /^\s*at (?:(?:async )?([^\s(]+) \()?(.+?):(\d+):\d+\)?$/;

/** Whether a stack's file is the host's own code: its sources, its build, the app's bundle. */
function ownFile(file: string): boolean {
  if (file.includes("/node_modules/") || file.startsWith("node:")) return false;
  return /\/packages\/host\/(?:src|dist)\//.test(file) || basename(file) === "bridge.mjs";
}

/** The signature of an exception of the host: its class and its own top frames. */
export function hostSignature(e: unknown): CrashSignature {
  const name = (e as { name?: unknown } | null)?.name;
  const stack = (e as { stack?: unknown } | null)?.stack;
  const frames: string[] = [];
  for (const line of typeof stack === "string" ? stack.split("\n") : []) {
    const m = NODE_FRAME.exec(line);
    if (m === null || !ownFile(m[2] as string)) continue;
    const frame = `${m[1] ?? "<anonymous>"} (${basename(m[2] as string)}:${m[3]})`;
    if (FRAME.test(frame)) frames.push(frame);
    if (frames.length === TOP_FRAMES) break;
  }
  return {
    process: "host",
    exception: typeof name === "string" && CODE.test(name) ? name : "unknown",
    frames,
  };
}

/** Writes the host's crash signature; never throws (it runs while the process dies). */
export function recordHostCrash(home: string, e: unknown, now = Date.now()): void {
  try {
    const dir = join(home, CRASHES_DIR);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, `host-${now}.json`), JSON.stringify(hostSignature(e)), { mode: 0o600 });
  } catch {}
}

interface Ips {
  readonly procName?: unknown;
  readonly exception?: { readonly type?: unknown };
  readonly faultingThread?: unknown;
  readonly threads?: readonly { readonly frames?: readonly IpsFrame[] }[];
  readonly usedImages?: readonly { readonly name?: unknown }[];
}
interface IpsFrame {
  readonly imageIndex?: unknown;
  readonly imageOffset?: unknown;
  readonly symbol?: unknown;
  readonly sourceFile?: unknown;
  readonly sourceLine?: unknown;
}

/** The signature of a macOS .ips crash report of one of our processes; undefined for any other. */
export function ipsSignature(text: string): CrashSignature | undefined {
  // An .ips report: a JSON header line, then the JSON body.
  const nl = text.indexOf("\n");
  let body: Ips;
  try {
    body = JSON.parse(text.slice(nl + 1)) as Ips;
  } catch {
    return undefined;
  }
  const proc = body.procName;
  if (typeof proc !== "string" || !OWN_PROCESSES.includes(proc)) return undefined;
  const thread = body.threads?.[typeof body.faultingThread === "number" ? body.faultingThread : 0];
  const frames: string[] = [];
  for (const f of thread?.frames ?? []) {
    const image = body.usedImages?.[typeof f.imageIndex === "number" ? f.imageIndex : -1]?.name;
    if (image !== proc) continue;
    const symbolic =
      typeof f.symbol === "string" && typeof f.sourceFile === "string"
        ? `${f.symbol} (${f.sourceFile}:${String(f.sourceLine ?? 0)})`
        : undefined;
    const frame =
      symbolic !== undefined && FRAME.test(symbolic)
        ? symbolic
        : `${proc}+${typeof f.imageOffset === "number" ? f.imageOffset : 0}`;
    if (FRAME.test(frame)) frames.push(frame);
    if (frames.length === TOP_FRAMES) break;
  }
  const type = body.exception?.type;
  return {
    process: proc,
    exception: typeof type === "string" && CODE.test(type) ? type : "unknown",
    frames,
  };
}

/** The newest crash signatures: the host's (<home>/crashes) and our processes' .ips reports. */
export function crashSignatures(home: string, reports?: string): readonly CrashSignature[] {
  const found: { at: number; s: CrashSignature }[] = [];
  const read = (dir: string, take: (name: string, text: string) => CrashSignature | undefined) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      try {
        const file = join(dir, name);
        const s = take(name, readFileSync(file, "utf8"));
        if (s !== undefined) found.push({ at: statSync(file).mtimeMs, s });
      } catch {}
    }
  };
  read(join(home, CRASHES_DIR), (name, text) =>
    /^host-\d+\.json$/.test(name) ? (JSON.parse(text) as CrashSignature) : undefined,
  );
  if (reports !== undefined)
    read(reports, (name, text) =>
      name.endsWith(".ips") && OWN_PROCESSES.some((p) => name.startsWith(`${p}-`))
        ? ipsSignature(text)
        : undefined,
    );
  return found
    .sort((a, b) => b.at - a.at)
    .slice(0, MAX_CRASHES)
    .map((f) => f.s);
}
