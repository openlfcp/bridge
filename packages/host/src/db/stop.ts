// STOP (D-010 §2.1, §7.1): the emergency switch. `lfcp-bridge stop` writes a
// file named STOP in the bridge's directory; while it exists no effect runs
// (no write to Apple, no commit to LFCP), in every process, checked before
// each effect and each retry. `resume` removes it. A file, not a database
// row: it works when the database is locked or unreadable, and a person can
// create it by hand (`touch STOP`).

import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";

export const STOP_FILE = "STOP";

/** The file system steps of stop/resume a test replaces. */
export interface StopFs {
  /** fsyncs a directory, so that a rename or unlink in it is durable. */
  readonly directorySync?: (dir: string) => void;
}

/** The errors Windows gives for opening or fsyncing a directory (NTFS journals the rename). */
const WINDOWS_DIRECTORY_SYNC = new Set(["EPERM", "EISDIR", "EACCES"]);

function syncDirectory(dir: string): void {
  let fd: number;
  try {
    fd = openSync(dir, "r");
  } catch (e) {
    if (
      process.platform === "win32" &&
      WINDOWS_DIRECTORY_SYNC.has(String((e as { code?: unknown }).code))
    )
      return;
    throw e;
  }
  try {
    fsyncSync(fd);
  } catch (e) {
    if (
      !(
        process.platform === "win32" &&
        WINDOWS_DIRECTORY_SYNC.has(String((e as { code?: unknown }).code))
      )
    )
      throw e;
  } finally {
    closeSync(fd);
  }
}

export interface StopState {
  /** RFC 3339 UTC, when known. */
  readonly at?: string;
  readonly reason?: string;
}

/** Whether STOP is set in `dir`, with what `stop` wrote (an empty or hand-made file is still STOP). */
export function stopState(dir: string): StopState | undefined {
  let text: string;
  try {
    text = readFileSync(join(dir, STOP_FILE), "utf8");
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return undefined;
    // Unreadable is not "not stopped": the switch fails closed.
    return Object.freeze({ reason: `STOP is present but unreadable: ${String(e)}` });
  }
  try {
    const v = JSON.parse(text) as { at?: unknown; reason?: unknown };
    return Object.freeze({
      ...(typeof v.at === "string" ? { at: v.at } : {}),
      ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
    });
  } catch {
    return Object.freeze(text.trim() === "" ? {} : { reason: text.trim() });
  }
}

/**
 * Sets STOP durably: a temporary file fsynced, renamed, then the directory
 * fsynced (the name survives a power loss once this returns). A second stop
 * replaces the reason.
 */
export function stop(
  dir: string,
  reason: string,
  now: () => number = Date.now,
  fs: StopFs = {},
): StopState {
  const state = { at: new Date(now()).toISOString(), reason };
  const temp = join(dir, `.${STOP_FILE}.${process.pid}.tmp`);
  const fd = openSync(temp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(state)}\n`);
    fsyncSync(fd);
  } catch (e) {
    closeSync(fd);
    rmSync(temp, { force: true });
    throw e;
  }
  closeSync(fd);
  renameSync(temp, join(dir, STOP_FILE));
  (fs.directorySync ?? syncDirectory)(dir);
  return Object.freeze(state);
}

/** Removes STOP durably (the directory fsynced after the unlink); false when it was not set. */
export function resume(dir: string, fs: StopFs = {}): boolean {
  try {
    unlinkSync(join(dir, STOP_FILE));
    (fs.directorySync ?? syncDirectory)(dir);
    return true;
  } catch (e) {
    if ((e as { code?: unknown }).code === "ENOENT") return false;
    throw e;
  }
}
