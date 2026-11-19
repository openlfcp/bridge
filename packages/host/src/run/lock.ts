// run.lock (D-010 §2.1): one run process per bridge directory. Its own module, without the SDK, so
// that `run --app` and its tests can use it alone.

import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** run.lock: one run process. A lock whose pid is gone is stale and taken over. */
export function takeRunLock(home: string): (() => void) | { readonly held: number } {
  // The data directory is the person's alone (A§7.3): 0700 also when run.lock is what creates it.
  mkdirSync(home, { recursive: true, mode: 0o700 });
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

/** The pid of a live run process holding run.lock, or undefined (no lock, or a stale one). */
export function runLockHolder(home: string): number | undefined {
  let pid: number;
  try {
    pid = Number(readFileSync(join(home, "run.lock"), "utf8").trim());
  } catch (e) {
    if ((e as { code?: string }).code === "ENOENT") return undefined;
    throw e;
  }
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : undefined;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
