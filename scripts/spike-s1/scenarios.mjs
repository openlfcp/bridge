// Spike S-1 (A§2.2, T§3 S-1): the three launches of the installed "LFCP Bridge.app" (version N),
// each probing the helper `direct` through app → node → helper, against a Reminders row in the
// user TCC.db (the S-3 technique). macOS CI only; it edits the runner's TCC.db.
//
//   node scripts/spike-s1/scenarios.mjs <installed-app> <feed-dir> <results-dir>
//
// Control (row only for the helper, never for the app) → expected notDetermined:
//   open; SMAppService register (RunAtLoad, informational); launchctl kickstart.
// Acceptance (row for org.openlfcp.bridge only) → expected fullAccess:
//   open; launchctl kickstart gui/<uid>/org.openlfcp.bridge.agent; Sparkle N → N+1 (relaunch by Sparkle).
// Informational: kickstart after the update. Writes results.json and summary.md into <results-dir>
// (and the job summary); exits 1 unless every acceptance launch got what it expected.

import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const [APP, FEED_DIR, R] = process.argv.slice(2);
if (!APP || !FEED_DIR || !R) {
  console.error("usage: scenarios.mjs <installed-app> <feed-dir> <results-dir>");
  process.exit(2);
}
mkdirSync(R, { recursive: true });
const HOME = os.homedir();
const UDB = path.join(HOME, "Library/Application Support/com.apple.TCC/TCC.db");
const STATE = path.join(HOME, "Library/Application Support/org.openlfcp.bridge.spike-s1");
const PROBES = path.join(STATE, "probes.jsonl");
const EVENTS = path.join(STATE, "events.jsonl");
const LABEL = "org.openlfcp.bridge.agent";
const AGENT = `gui/${process.getuid()}/${LABEL}`;
const APP_ID = "org.openlfcp.bridge";
const HELPER = path.join(APP, "Contents/MacOS/lfcp-reminders-helper");
const HELPER_ID = "org.openlfcp.bridge.reminders-helper";
const PORT = 8765;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (s) => console.log(s);

function run(cmd, args, timeoutMs = 60_000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  log(`$ ${cmd} ${args.join(" ")} → ${r.status ?? r.signal ?? r.error?.message}`);
  for (const s of [r.stdout, r.stderr]) if (s?.trim()) log(s.trim().replace(/^/gm, "    "));
  return r;
}

const sql = (q) => execFileSync("sqlite3", [UDB, q], { encoding: "utf8" }).trim();
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;

/** The designated requirement of a signed path, and its compiled form (csreq) in hex. */
function requirement(p, name) {
  const r = spawnSync("codesign", ["-d", "-r-", p], { encoding: "utf8" });
  const m = /designated => (.*)/.exec(`${r.stdout}${r.stderr}`);
  if (!m) throw new Error(`no designated requirement for ${p}: ${r.stderr}`);
  const bin = path.join(R, `${name}.csreq`);
  execFileSync("csreq", ["-r-", "-b", bin], { input: m[1] });
  return { requirement: m[1], hex: readFileSync(bin).toString("hex") };
}

/** INSERT OR REPLACE a kTCCServiceReminders row, columns taken from PRAGMA table_info (S-3). */
function grant(client, clientType, csreqHex) {
  const cols = [];
  const vals = [];
  for (const row of sql("PRAGMA table_info(access)").split("\n")) {
    const [, name, type, notnull, dflt] = row.split("|");
    const fixed = {
      service: "'kTCCServiceReminders'",
      client: quote(client),
      client_type: String(clientType),
      auth_value: "2",
      auth_reason: "4",
      auth_version: "1",
      csreq: `X'${csreqHex}'`,
      policy_id: "NULL",
      indirect_object_identifier_type: "0",
      indirect_object_identifier: "'UNUSED'",
      indirect_object_code_identity: "NULL",
      flags: "0",
      last_modified: "CAST(strftime('%s','now') AS INTEGER)",
    };
    let v = fixed[name];
    if (v === undefined) {
      if (notnull !== "1" || dflt !== "") continue;
      v = type.startsWith("INT") ? "0" : "''";
    }
    cols.push(name);
    vals.push(v);
  }
  sql(`INSERT OR REPLACE INTO access (${cols.join(",")}) VALUES (${vals.join(",")});`);
}
const revoke = (client) =>
  sql(`DELETE FROM access WHERE service='kTCCServiceReminders' AND client=${quote(client)}`);
const rows = () =>
  sql(
    "SELECT client,client_type,auth_value,auth_reason,length(csreq) FROM access WHERE service='kTCCServiceReminders'",
  );

const readLines = (f) => {
  try {
    return readFileSync(f, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l));
  } catch {
    return [];
  }
};
const isLaunchd = (p) => p.trigger === "launchd" || p.xpcServiceName === LABEL;

async function waitProbe(after, pred, timeoutS) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutS * 1000) {
    const p = readLines(PROBES).slice(after).find(pred);
    if (p) return p;
    await sleep(1000);
  }
  return null;
}

const openApp = (...args) =>
  run("open", ["-n", "-g", "-a", APP, ...(args.length ? ["--args", ...args] : [])]);
const kickstart = () => run("launchctl", ["kickstart", "-k", AGENT]);
const lastEvent = (name) =>
  readLines(EVENTS)
    .filter((e) => e.event === name)
    .at(-1) ?? null;

const results = [];
async function scenario(name, expected, launch, pred, { timeoutS = 150, acceptance = true } = {}) {
  log(`\n== ${name} (expect ${expected})`);
  const before = readLines(PROBES).length;
  launch();
  const p = await waitProbe(before, pred, timeoutS);
  const tcc = p?.checks?.find((c) => c.check === "tcc");
  const got = p ? p.authorization : "no probe";
  const r = {
    scenario: name,
    acceptance,
    expected,
    authorization: got,
    pass: got === expected,
    lists: p?.lists ?? null,
    tccCheckOk: tcc?.ok ?? null,
    version: p?.version ?? null,
    trigger: p?.trigger ?? null,
    xpcServiceName: p?.xpcServiceName ?? null,
    shellPid: p?.pid ?? null,
    shellPpid: p?.ppid ?? null,
    nodePpid: tcc?.nodePpid ?? null,
    helperParent: tcc?.parentPath ?? null,
    nodeExit: p?.nodeExit ?? null,
    error: p?.error ?? (tcc?.error ? String(tcc.error).slice(0, 400) : null),
  };
  results.push(r);
  log(JSON.stringify(r));
  if (p && !r.pass) log(`probe: ${JSON.stringify(p).slice(0, 3000)}`);
  return r;
}

const shell = requirement(APP, "shell");
const helper = requirement(HELPER, "helper");
const info = {
  macOS: run("sw_vers", ["-productVersion"]).stdout.trim(),
  arch: os.arch(),
  sip: run("csrutil", ["status"]).stdout.trim(),
  shellRequirement: shell.requirement,
  helperRequirement: helper.requirement,
};
log(JSON.stringify(info, null, 2));

const server = spawn(
  "python3",
  ["-m", "http.server", String(PORT), "--bind", "127.0.0.1", "--directory", FEED_DIR],
  {
    stdio: "ignore",
  },
);
try {
  // Control: the helper alone has a row (by identifier and by path); the app has none.
  revoke(APP_ID);
  grant(HELPER_ID, 0, helper.hex);
  grant(HELPER, 1, helper.hex);
  log(rows());
  await scenario(
    "control: open",
    "notDetermined",
    () => openApp(),
    (p) => !isLaunchd(p),
  );
  await scenario(
    "control: SMAppService register (RunAtLoad)",
    "notDetermined",
    () => run("open", ["-n", "-W", "-g", "-a", APP, "--args", "--register"], 60_000),
    isLaunchd,
    { timeoutS: 60, acceptance: false },
  );
  info.register = lastEvent("register");
  run("launchctl", ["print", AGENT]);
  await scenario("control: launchctl kickstart", "notDetermined", kickstart, isLaunchd);

  // Acceptance: the row is for the app only.
  revoke(HELPER_ID);
  revoke(HELPER);
  grant(APP_ID, 0, shell.hex);
  log(rows());
  await scenario(
    "open",
    "fullAccess",
    () => openApp(),
    (p) => !isLaunchd(p),
  );
  await scenario("launchctl kickstart", "fullAccess", kickstart, isLaunchd);
  await scenario(
    "Sparkle N→N+1 (relaunch)",
    "fullAccess",
    () => openApp("--update"),
    (p) => p.version === "2" && !isLaunchd(p),
    { timeoutS: 420 },
  );
  info.installedVersion = run("/usr/libexec/PlistBuddy", [
    "-c",
    "Print :CFBundleVersion",
    `${APP}/Contents/Info.plist`,
  ]).stdout.trim();
  info.installedRequirement = requirement(APP, "shell-updated").requirement;
  info.sparkle = readLines(EVENTS).filter(
    (e) => e.event === "sparkle" || e.event.startsWith("update"),
  );
  await scenario(
    "launchctl kickstart after the update",
    "fullAccess",
    kickstart,
    (p) => isLaunchd(p) && p.version === "2",
    { acceptance: false },
  );
} finally {
  server.kill();
  run("open", ["-n", "-W", "-g", "-a", APP, "--args", "--unregister"], 60_000);
}

const accepted =
  results.filter((r) => r.acceptance).length === 5 && results.every((r) => !r.acceptance || r.pass);
const summary = { runner: process.env.RUNNER_LABEL ?? null, ...info, accepted, results };
writeFileSync(path.join(R, "results.json"), JSON.stringify(summary, null, 2));
const md = [
  `## Spike S-1 — ${summary.runner} (macOS ${info.macOS}, ${info.arch}): ${accepted ? "ACCEPTED" : "NOT ACCEPTED"}`,
  "",
  `SIP: ${info.sip}  `,
  `shell DR: \`${info.shellRequirement}\`  `,
  `after update: version ${info.installedVersion ?? "?"}, DR ${info.installedRequirement === info.shellRequirement ? "unchanged" : `\`${info.installedRequirement}\``}  `,
  `register: \`${JSON.stringify(info.register)}\``,
  "",
  "| launch | acceptance | expected | helper authorization | lists.list | app version | trigger | helper parent |",
  "|---|---|---|---|---|---|---|---|",
  ...results.map(
    (r) =>
      `| ${r.scenario} | ${r.acceptance ? "yes" : "info"} | ${r.expected} | **${r.authorization}** ${r.pass ? "✓" : "✗"} | ${r.lists?.ok === true ? `ok (${r.lists.count})` : (r.lists?.error?.code ?? "–")} | ${r.version ?? "–"} | ${r.trigger ?? "–"} | ${r.helperParent ? path.basename(r.helperParent) : "–"} |`,
  ),
  "",
].join("\n");
writeFileSync(path.join(R, "summary.md"), md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md);
log(`\n${md}`);
process.exit(accepted ? 0 : 1);
