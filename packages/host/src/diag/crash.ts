// Crash signatures (A§11, E20): instead of a raw crash report — which holds messages, paths,
// registers and memory — the process, the exception's class and the top frames of our own code.
// The host's own crash (an exception nobody caught) is written as a signature, at once, to
// <home>/crashes/; the shell's and the helper's come from macOS's .ips reports, read at export.

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ERROR_CLASSES, MACH_EXCEPTIONS } from "./codes.js";

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
/** The largest file read: a host signature, an .ips report. Bigger ones are skipped unread. */
export const MAX_SIGNATURE_BYTES = 64 * 1024;
export const MAX_REPORT_BYTES = 4 * 1024 * 1024;

const HOST_FILE = /^host-\d{1,16}\.json$/;
/** An .ips report of one of our processes, by its name alone: the only reports opened. */
function ownReport(name: string): boolean {
  return name.endsWith(".ips") && OWN_PROCESSES.some((p) => name.startsWith(`${p}-`));
}

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
    exception: typeof name === "string" && ERROR_CLASSES.has(name) ? name : "unknown",
    frames,
  };
}

/**
 * A signature rebuilt from what a file says: the three fields, each checked — the process ours,
 * the exception a known class or Mach type, the frames in FRAME's form. Nothing else is carried.
 */
export function checkedSignature(v: unknown): CrashSignature | undefined {
  if (typeof v !== "object" || v === null) return undefined;
  const { process, exception, frames } = v as Record<string, unknown>;
  if (typeof process !== "string" || (process !== "host" && !OWN_PROCESSES.includes(process)))
    return undefined;
  return {
    process,
    exception:
      typeof exception === "string" &&
      (process === "host" ? ERROR_CLASSES : MACH_EXCEPTIONS).has(exception)
        ? exception
        : "unknown",
    frames: (Array.isArray(frames) ? frames : [])
      .filter((f): f is string => typeof f === "string" && FRAME.test(f))
      .slice(0, TOP_FRAMES),
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
  return checkedSignature({ process: proc, exception: body.exception?.type, frames });
}

/**
 * The newest crash signatures: the host's (<home>/crashes) and our processes' .ips reports. Files
 * are chosen by name, type (regular, no symlink) and size first; only the newest MAX_CRASHES of
 * them are opened. A report of another process is never read.
 */
export function crashSignatures(
  home: string,
  reports?: string,
  read: (file: string) => string = (file) => readFileSync(file, "utf8"),
): readonly CrashSignature[] {
  const candidates: { at: number; file: string; ips: boolean }[] = [];
  const scan = (dir: string, wanted: (name: string) => boolean, max: number, ips: boolean) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      if (!wanted(name)) continue;
      try {
        const file = join(dir, name);
        const st = lstatSync(file);
        if (st.isFile() && st.size <= max) candidates.push({ at: st.mtimeMs, file, ips });
      } catch {}
    }
  };
  scan(join(home, CRASHES_DIR), (n) => HOST_FILE.test(n), MAX_SIGNATURE_BYTES, false);
  if (reports !== undefined) scan(reports, ownReport, MAX_REPORT_BYTES, true);
  const out: CrashSignature[] = [];
  for (const c of candidates.sort((a, b) => b.at - a.at).slice(0, MAX_CRASHES)) {
    try {
      const text = read(c.file);
      const s = c.ips ? ipsSignature(text) : checkedSignature(JSON.parse(text));
      if (s !== undefined) out.push(s);
    } catch {}
  }
  return out;
}
