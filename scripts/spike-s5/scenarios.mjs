// Spike S-5 (T§4, PLAN §E-003): can a CI test read the app's window and press its buttons through the
// Accessibility API, given a kTCCServiceAccessibility row in the *system* TCC.db (SIP is off on hosted
// runners)? Steps: launch the probe app; baseline; control with every Accessibility row removed (must
// be untrusted); then a row for the driver binary alone, and for each ancestor process alone, to find
// the one tccd holds responsible; then, under the nearest sufficient single row and nothing else
// (control again, then insert without a tccd restart), read the label and press the button through
// AXUIElement. Writes results.json and summary.md; exit 1 unless both controls are real refusals (check
// ran, found the app, untrusted and AXWindows = -25211 kAXErrorAPIDisabled) and the read and press
// pass. macOS CI only: it edits the runner's system TCC.db.
//
// Usage: node scripts/spike-s5/scenarios.mjs <build-dir> <results-dir>
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const [BUILD, R] = process.argv.slice(2).map((p) => path.resolve(p));
if (!BUILD || !R) throw new Error("usage: scenarios.mjs <build-dir> <results-dir>");
mkdirSync(R, { recursive: true });
const APP = path.join(BUILD, "S5Probe.app");
const DRIVER = path.join(BUILD, "s5-ax");
const BUNDLE_ID = "org.openlfcp.spike.s5probe";
const SDB = "/Library/Application Support/com.apple.TCC/TCC.db";
const SERVICE = "kTCCServiceAccessibility";
const STATE = path.join(R, "app-state");
const EVENTS = path.join(STATE, "events.jsonl");
const CODE = `S5-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;

const logFile = path.join(R, "scenarios.log");
const log = (s) => {
  console.log(s);
  appendFileSync(logFile, `${s}\n`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, args, timeoutMs = 60_000) {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: timeoutMs });
  log(`$ ${cmd} ${args.join(" ")} → ${r.status ?? r.signal ?? r.error?.message}`);
  if (r.stderr?.trim()) log(r.stderr.trim().replace(/^/gm, "    "));
  return r;
}

const sql = (q) => execFileSync("sudo", ["sqlite3", SDB, q], { encoding: "utf8" }).trim();
const quote = (s) => `'${String(s).replaceAll("'", "''")}'`;

/** Compiled designated requirement (csreq) of a signed path, hex; null when it has none. */
function csreqHex(p, name) {
  const r = spawnSync("codesign", ["-d", "-r-", p], { encoding: "utf8" });
  const m = /designated => (.*)/.exec(`${r.stdout}${r.stderr}`);
  if (!m) return { requirement: null, hex: null };
  const bin = path.join(R, `${name}.csreq`);
  execFileSync("csreq", ["-r-", "-b", bin], { input: m[1] });
  return { requirement: m[1], hex: readFileSync(bin).toString("hex") };
}

/** INSERT OR REPLACE an Accessibility row, columns from PRAGMA table_info (the S-3 technique). */
function grant(client, clientType, hex) {
  const cols = [];
  const vals = [];
  for (const row of sql("PRAGMA table_info(access)").split("\n")) {
    const [, name, type, notnull, dflt] = row.split("|");
    const fixed = {
      service: quote(SERVICE),
      client: quote(client),
      client_type: String(clientType),
      auth_value: "2",
      auth_reason: "4",
      auth_version: "1",
      csreq: hex ? `X'${hex}'` : "NULL",
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
const rows = () =>
  sql(
    `SELECT client,client_type,auth_value,auth_reason,length(csreq) FROM access WHERE service=${quote(SERVICE)}`,
  );

async function restartTccd() {
  run("sudo", ["killall", "-9", "tccd"]);
  await sleep(3000);
}

function driver(args, timeoutMs = 60_000) {
  const r = run(DRIVER, args, timeoutMs);
  let json = null;
  try {
    json = JSON.parse(r.stdout.trim().split("\n").pop());
  } catch {
    log(`    unparsable driver output: ${String(r.stdout).slice(0, 400)}`);
  }
  if (json) log(`    ${JSON.stringify(json).slice(0, 1500)}`);
  return { code: r.status, json };
}
const check = () => {
  const { code, json } = driver(["check", BUNDLE_ID]);
  return {
    code,
    appFound: json?.appFound ?? null,
    trusted: json?.trusted ?? null,
    windowsAXError: json?.windowsAXError ?? null,
    chain: json?.chain ?? [],
  };
};
const AX_API_DISABLED = -25211;
/** A negative control holds only on a real refusal: check exited 0, found the app, made the AX call,
 * and got kAXErrorAPIDisabled while untrusted. A missing probe or any other error fails the control. */
const refused = (c) =>
  c.code === 0 &&
  c.appFound === true &&
  c.trusted === false &&
  c.windowsAXError === AX_API_DISABLED;

const res = {
  runner: process.env.RUNNER_LABEL ?? null,
  os: execFileSync("sw_vers", ["-productVersion"], { encoding: "utf8" }).trim(),
  build: execFileSync("sw_vers", ["-buildVersion"], { encoding: "utf8" }).trim(),
  arch: process.arch,
  sip: execFileSync("csrutil", ["status"], { encoding: "utf8" }).trim(),
  code: CODE,
  rowsBefore: null,
  variants: [],
  winner: null,
  drive: null,
  controlUntrusted: null,
  accepted: false,
};

// The app, started like a user would start it.
mkdirSync(STATE, { recursive: true });
run("open", ["-n", APP, "--args", CODE, STATE]);
for (
  let i = 0;
  i < 50 && !(existsSync(EVENTS) && readFileSync(EVENTS, "utf8").includes('"launched"'));
  i++
) {
  await sleep(200);
}
if (!existsSync(EVENTS)) throw new Error("the probe app did not start (no launched record)");
log(`app launched: ${readFileSync(EVENTS, "utf8").trim()}`);

res.rowsBefore = rows();
log(`system TCC.db ${SERVICE} rows before:\n${res.rowsBefore}`);
writeFileSync(path.join(R, "rows-before.txt"), `${res.rowsBefore}\n`);

const variant = (name, extra = {}) => {
  const c = check();
  const v = {
    name,
    ...extra,
    checkExit: c.code,
    appFound: c.appFound,
    trusted: c.trusted,
    windowsAXError: c.windowsAXError,
  };
  res.variants.push(v);
  log(
    `== ${name}: exit=${c.code} appFound=${c.appFound} trusted=${c.trusted} windowsAXError=${c.windowsAXError}`,
  );
  return c;
};
const revokeAll = () => sql(`DELETE FROM access WHERE service=${quote(SERVICE)}`);
const grantAll = (clients) => {
  const granted = clients.map((client, i) => {
    const { requirement, hex } = csreqHex(client, `client-${i}`);
    grant(client, 1, hex);
    return { client, requirement };
  });
  log(`rows now:\n${rows()}`);
  return granted;
};

const base = variant("baseline (image rows)");
const chain = base.chain.map((p) => p.path).filter((p) => p !== "/sbin/launchd" && p !== "?");
res.chain = base.chain;

// Control: no Accessibility row at all.
revokeAll();
await restartTccd();
res.controlUntrusted = refused(variant("control: no rows (after tccd restart)"));

// Which single row is enough? The driver binary itself first, then each ancestor alone.
const sufficient = [];
let granted = grantAll([DRIVER]);
let ok = variant("only the driver binary (no restart)", { granted }).trusted;
if (!ok) {
  await restartTccd();
  ok = variant("only the driver binary (after tccd restart)", { granted }).trusted;
}
if (ok) sufficient.push(DRIVER);
for (const client of [...new Set(chain.slice(1))]) {
  revokeAll();
  granted = grantAll([client]);
  await restartTccd();
  if (variant(`only ${client} (after tccd restart)`, { granted }).trusted) sufficient.push(client);
}
res.sufficient = sufficient;
const clients = sufficient.length ? [sufficient[0]] : chain;

// Drive under the smallest grant, alone in the table: control, insert without restart, then read and press.
revokeAll();
await restartTccd();
const control2 = refused(variant("drive config: control, no rows (after tccd restart)"));
granted = grantAll(clients);
let restartNeeded = false;
if (!variant(`drive config: ${clients.join(" + ")} (no restart)`, { granted }).trusted) {
  restartNeeded = true;
  await restartTccd();
  variant(`drive config: ${clients.join(" + ")} (after tccd restart)`, { granted });
}
const final = res.variants.at(-1);
res.controlUntrusted = res.controlUntrusted && control2;
if (final.trusted) {
  res.winner = { clients, granted, tccdRestart: restartNeeded };
  const d = driver(["drive", BUNDLE_ID, CODE, EVENTS, "--menu"], 90_000);
  res.drive = d.json;
  res.accepted = res.controlUntrusted === true && d.code === 0 && d.json?.pass === true;
} else {
  log("no grant made the driver trusted");
}

writeFileSync(path.join(R, "results.json"), `${JSON.stringify(res, null, 2)}\n`);

const d = res.drive ?? {};
const md = [
  `## Spike S-5 — ${res.runner} (macOS ${res.os} ${res.build}, ${res.arch})`,
  "",
  `${res.sip}  `,
  `accepted: **${res.accepted}**; control (no rows) refused (untrusted, AXWindows -25211): **${res.controlUntrusted}**; drive grant: **${res.winner ? `${res.winner.clients.map((c) => `\`${c}\``).join(" + ")}${res.winner.tccdRestart ? ", after tccd restart" : ", no restart"}` : "none"}**; single rows that suffice: ${(res.sufficient ?? []).map((c) => `\`${c}\``).join(", ") || "none"}`,
  "",
  "| variant | check exit | app found | AXIsProcessTrusted | AXWindows error on the app |",
  "|---|---|---|---|---|",
  ...res.variants.map(
    (v) => `| ${v.name} | ${v.checkExit} | ${v.appFound} | ${v.trusted} | ${v.windowsAXError} |`,
  ),
  "",
  `process chain: ${res.chain.map((p) => `\`${p.path}\``).join(" ← ")}`,
  "",
  "| step | result | detail |",
  "|---|---|---|",
  `| read label \`s5-code\` | ${d.readOk ?? "–"} | expected ${CODE}, read ${JSON.stringify(d.readCode ?? null)} |`,
  `| press \`s5-confirm\` (AXPress) | ${d.pressOk ?? "–"} | AXError ${d.pressAXError ?? "–"}, app recorded: ${d.pressRecordedByApp ?? "–"}, label after: ${JSON.stringify(d.statusAfter ?? null)} |`,
  `| status item menu (info) | ${d.menu?.recordedByApp ?? "–"} | ${JSON.stringify(d.menu ?? null).slice(0, 300)} |`,
  "",
  `rows before (image): \`${(res.rowsBefore || "none").replaceAll("\n", "; ")}\``,
  "",
].join("\n");
writeFileSync(path.join(R, "summary.md"), md);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
log(md);
process.exit(res.accepted ? 0 : 1);
