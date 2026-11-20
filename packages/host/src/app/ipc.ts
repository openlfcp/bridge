// The shell ↔ host channel, version 1 (A§1, PLAN §E-004; docs/reference/app-ipc-v1.md).
//
// stdio, JSON lines: one JSON object per line, UTF-8, "\n" at the end, at most MAX_LINE bytes.
// The shell (LFCP Bridge.app) writes commands to the host's stdin; the host writes events and
// replies to its stdout. Nothing else goes to stdout in `run --app` (logs go to stderr).
//
//   shell → host   {"v":1,"id":"7","cmd":"pause"}
//                  pause · resume · answer{questionId,choice} · export{path} · remove{bindingId,ack?}
//                  shutdown{reason} · openURL{url}
//                  codeIdentity{requestId, …}: the answer to codeCheck (A§9.1 (3)–(5), E-051b)
//   host → shell   {"v":1,"type":"hello","version":"0.5.0","pid":123}          once, first
//                  {"v":1,"type":"status","state":"running",…}
//                  {"v":1,"type":"question",…} · {"v":1,"type":"needsAttention",…}
//                  {"v":1,"type":"reply","id":"7","ok":true}  /  "ok":false,"error":{"code":…}
//                  {"v":1,"type":"codeCheck","id":"c1","paths":[…]}: the write gate asks the shell
//
// This file is pure: parsing and encoding only. src/app/serve.ts runs it.

import type { CodeIdentity } from "../artifact/gate.js";
import { ARCHS, type Arch } from "../artifact/manifest.js";

export const IPC_VERSION = 1;

/** The longest line either side accepts (bytes, without the "\n"). */
export const MAX_LINE = 64 * 1024;

export const SHUTDOWN_REASONS = ["update", "quit", "logout"] as const;
export type ShutdownReason = (typeof SHUTDOWN_REASONS)[number];

export type Command =
  | { readonly cmd: "pause" }
  | { readonly cmd: "resume" }
  | { readonly cmd: "answer"; readonly questionId: string; readonly choice: string }
  | { readonly cmd: "export"; readonly path: string }
  | { readonly cmd: "remove"; readonly bindingId: string; readonly ack: boolean }
  | { readonly cmd: "shutdown"; readonly reason: ShutdownReason }
  | { readonly cmd: "openURL"; readonly url: string }
  | {
      readonly cmd: "codeIdentity";
      readonly requestId: string;
      /** What the shell's Security.framework says, or why it could not say. */
      readonly identity: CodeIdentity | { readonly error: string };
    };

export type CommandName = Command["cmd"];

export interface Envelope {
  /** Echoed in the reply; the shell numbers its commands. */
  readonly id: string;
  readonly command: Command;
}

export type ErrorCode =
  /** Not JSON, not an object, too long, or v is not 1. */
  | "bad_line"
  /** A cmd this host does not know (a newer shell). */
  | "unknown_command"
  /** A known cmd with a missing or wrong field. */
  | "bad_arguments"
  /** Known, not built yet (answer: E-042, remove: E-034). */
  | "not_implemented"
  /** The host is shutting down: nothing new starts. */
  | "shutting_down"
  /** The command failed; detail says why (no task data). */
  | "failed";

export type HostState =
  /** Before the run process is up. */
  | "starting"
  /** Syncing. */
  | "running"
  /** STOP is set (Pause syncing, or `lfcp-bridge stop`). */
  | "paused"
  /** The run process could not start (reason says why); the host waits for resume or shutdown. */
  | "unavailable"
  /** shutdown received: finishing what is in flight. */
  | "stopping";

export interface SectionStatus {
  readonly bindingId: string;
  readonly title: string;
  readonly state: string;
}

export type Event =
  | { readonly type: "hello"; readonly version: string; readonly pid: number }
  | {
      readonly type: "status";
      readonly state: HostState;
      readonly reason?: string;
      readonly sections: readonly SectionStatus[];
    }
  | {
      readonly type: "question";
      readonly questionId: string;
      readonly bindingId: string;
      readonly kind: string;
      /** The question is gone (answered, or resolved by itself). */
      readonly resolved?: boolean;
    }
  | {
      readonly type: "needsAttention";
      readonly bindingId: string;
      /** A code of A§7.3, or null when it no longer needs attention. */
      readonly code: string | null;
    }
  | {
      /**
       * The write gate (A§9.1 (3)–(5)): the shell answers with codeIdentity{requestId: id} —
       * SecStaticCodeCheckValidity of its bundle, its own cdhash and the cdhash of every one of
       * `paths` (bundle-relative Mach-O files) for its arch.
       */
      readonly type: "codeCheck";
      readonly id: string;
      readonly paths: readonly string[];
    }
  | {
      readonly type: "reply";
      /** null: the line could not be read far enough to know its id. */
      readonly id: string | null;
      readonly ok: true;
      readonly result?: Readonly<Record<string, unknown>>;
    }
  | {
      readonly type: "reply";
      readonly id: string | null;
      readonly ok: false;
      readonly error: { readonly code: ErrorCode; readonly detail?: string };
    };

export type Parsed =
  | { readonly ok: true; readonly envelope: Envelope }
  | {
      readonly ok: false;
      readonly id: string | null;
      readonly code: Extract<ErrorCode, "bad_line" | "unknown_command" | "bad_arguments">;
      readonly detail: string;
    };

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const nonEmpty = (v: unknown): v is string => typeof v === "string" && v !== "";

const HEX40 = /^[0-9a-f]{40}$/;

/** codeIdentity's fields; a string is what is wrong. */
function codeIdentity(v: Record<string, unknown>): CodeIdentity | { error: string } | string {
  if (v.error !== undefined) return nonEmpty(v.error) ? { error: v.error } : "error";
  if (!ARCHS.includes(v.arch as Arch)) return "arch";
  if (typeof v.valid !== "boolean") return "valid";
  if (v.detail !== undefined && typeof v.detail !== "string") return "detail";
  if (typeof v.shell !== "string" || !HEX40.test(v.shell)) return "shell";
  if (!Array.isArray(v.nested)) return "nested";
  const nested = [];
  for (const n of v.nested as unknown[]) {
    if (!isObject(n) || !nonEmpty(n.path) || typeof n.cdhash !== "string" || !HEX40.test(n.cdhash))
      return "nested";
    nested.push({ path: n.path, cdhash: n.cdhash });
  }
  return {
    arch: v.arch as Arch,
    validity: v.valid ? { ok: true } : { ok: false, detail: (v.detail as string) || "invalid" },
    runningShell: v.shell,
    nested,
  };
}

/**
 * Reads one command line. The detail of an error never repeats the line or a field's value: an
 * openURL carries a link secret in its fragment (A§4.1), and replies end up in logs.
 */
export function parseCommand(line: string): Parsed {
  if (Buffer.byteLength(line, "utf8") > MAX_LINE)
    return { ok: false, id: null, code: "bad_line", detail: "line too long" };
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return { ok: false, id: null, code: "bad_line", detail: "not JSON" };
  }
  if (!isObject(v)) return { ok: false, id: null, code: "bad_line", detail: "not an object" };
  const id = nonEmpty(v.id) ? v.id : null;
  if (v.v !== IPC_VERSION)
    return { ok: false, id, code: "bad_line", detail: `v must be ${IPC_VERSION}` };
  if (id === null) return { ok: false, id, code: "bad_line", detail: "no id" };
  const bad = (detail: string): Parsed => ({ ok: false, id, code: "bad_arguments", detail });
  const done = (command: Command): Parsed => ({ ok: true, envelope: { id, command } });
  switch (v.cmd) {
    case "pause":
    case "resume":
      return done({ cmd: v.cmd });
    case "answer":
      if (!nonEmpty(v.questionId) || !nonEmpty(v.choice)) return bad("questionId and choice");
      return done({ cmd: "answer", questionId: v.questionId, choice: v.choice });
    case "export":
      if (!nonEmpty(v.path)) return bad("path");
      return done({ cmd: "export", path: v.path });
    case "remove":
      if (!nonEmpty(v.bindingId)) return bad("bindingId");
      if (v.ack !== undefined && typeof v.ack !== "boolean") return bad("ack");
      return done({ cmd: "remove", bindingId: v.bindingId, ack: v.ack === true });
    case "shutdown":
      if (!SHUTDOWN_REASONS.includes(v.reason as ShutdownReason))
        return bad(`reason: one of ${SHUTDOWN_REASONS.join(", ")}`);
      return done({ cmd: "shutdown", reason: v.reason as ShutdownReason });
    case "openURL":
      if (!nonEmpty(v.url) || !v.url.startsWith("lfcp-bridge:")) return bad("url: lfcp-bridge:");
      return done({ cmd: "openURL", url: v.url });
    case "codeIdentity": {
      if (!nonEmpty(v.requestId)) return bad("requestId");
      const identity = codeIdentity(v);
      if (typeof identity === "string") return bad(identity);
      return done({ cmd: "codeIdentity", requestId: v.requestId, identity });
    }
    default:
      return { ok: false, id, code: "unknown_command", detail: "unknown cmd" };
  }
}

/** One event as its line (without the "\n"). */
export function encodeEvent(e: Event): string {
  return JSON.stringify({ v: IPC_VERSION, ...e });
}

/**
 * Splits a byte stream into lines. A line longer than MAX_LINE is dropped up to its "\n" and
 * reported as `overlong` once, so one runaway writer cannot grow the buffer without bound.
 */
export class LineSplitter {
  #buffer = "";
  #skipping = false;

  constructor(
    private readonly onLine: (line: string) => void,
    private readonly onOverlong: () => void,
  ) {}

  push(chunk: string): void {
    let text = this.#buffer + chunk;
    this.#buffer = "";
    for (;;) {
      const nl = text.indexOf("\n");
      if (nl < 0) break;
      const line = text.slice(0, nl);
      text = text.slice(nl + 1);
      if (this.#skipping) {
        this.#skipping = false;
        continue;
      }
      if (line.trim() !== "") this.onLine(line.endsWith("\r") ? line.slice(0, -1) : line);
    }
    if (this.#skipping) return;
    if (Buffer.byteLength(text, "utf8") > MAX_LINE) {
      this.#skipping = true;
      this.onOverlong();
      return;
    }
    this.#buffer = text;
  }
}
