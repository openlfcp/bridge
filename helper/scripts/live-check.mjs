#!/usr/bin/env node
// Live check of the EventKit backend on the owner's Mac (needs Reminders access: one "Allow").
// Launches the app the way the bridge does (open + FIFOs), in verification mode: writes go only to a
// new list "LFCP Verify · Helper <time>". Manual steps (iPhone or Reminders on the Mac) pause for Enter.
//   node scripts/live-check.mjs [--no-manual] [--app path]
// Results: build/live-check-<time>.json. Checklist: docs/devel/testing/helper-live-checklist.md
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { createInterface as promptInterface } from "node:readline/promises";

const here = path.dirname(new URL(import.meta.url).pathname);
const argv = process.argv.slice(2);
const appArg = argv.indexOf("--app");
const app = path.resolve(
  appArg >= 0 ? argv[appArg + 1] : path.join(here, "..", "build", "LFCP Reminders Helper.app"),
);
const MANUAL = !argv.includes("--no-manual") && process.stdin.isTTY;
// Self-test of this script without Reminders access: --backend memory (EventKit-only checks fail).
const backendArg = argv.indexOf("--backend");
const BACKEND = backendArg >= 0 ? argv[backendArg + 1] : "eventkit";
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const out = path.join(here, "..", "build", `live-check-${stamp}.json`);
const results = { startedAt: new Date().toISOString(), app, manual: MANUAL, checks: [], notes: [] };
const save = () => fs.writeFileSync(out, JSON.stringify(results, null, 2));
const rl = MANUAL ? promptInterface({ input: process.stdin, output: process.stdout }) : null;
const today = new Date();
const dayPlus = (n) => new Date(today.getTime() + n * 86400000).toISOString().slice(0, 10);

function check(name, ok, data) {
  results.checks.push({ name, ok: Boolean(ok), data });
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`);
  save();
}
async function manual(text) {
  if (!MANUAL) return false;
  console.log(`\n\x1b[33m=== РУЧНОЙ ШАГ ===\x1b[0m\n${text}`);
  const a = (await rl.question("Enter — готово, s + Enter — пропустить: ")).trim().toLowerCase();
  return a !== "s";
}

// --- launch via open + FIFOs ---
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lfcp-helper-live-"));
const [fin, fout, ferr] = ["in", "out", "err"].map((n) => path.join(dir, n));
for (const f of [fin, fout, ferr]) execFileSync("mkfifo", [f]);
// The opener (`open -W`) lives as long as the helper; it is not awaited here.
spawn(
  "open",
  [
    "-n",
    "-W",
    "-g",
    "-a",
    app,
    "--stdin",
    fin,
    "--stdout",
    fout,
    "--stderr",
    ferr,
    "--args",
    "serve",
    "--backend",
    BACKEND,
    "--host-pid",
    String(process.pid),
  ],
  { stdio: "ignore" },
);
const input = fs.createWriteStream(fin);
const lines = [];
const waiters = [];
createInterface({ input: fs.createReadStream(fout) }).on("line", (l) => {
  const m = JSON.parse(l);
  lines.push({ at: Date.now(), m });
  for (const w of [...waiters])
    if (w.match(m)) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(m);
    }
});
const stderr = [];
createInterface({ input: fs.createReadStream(ferr) }).on("line", (l) => stderr.push(l));
const waitFor = (match, ms = 15000) =>
  new Promise((resolve, reject) => {
    const hit = lines.find((x) => match(x.m));
    if (hit) return resolve(hit.m);
    waiters.push({ match, resolve });
    setTimeout(() => reject(new Error("timeout waiting for the helper")), ms);
  });
let rid = 0;
async function req(op, body = {}, ms) {
  rid += 1;
  const id = rid;
  input.write(`${JSON.stringify({ v: 2, id, op, ...body })}\n`);
  return waitFor((m) => m.id === id, ms);
}
const eventsSince = (t, name) => lines.filter((x) => x.at >= t && x.m.event === name);

try {
  const ready = await waitFor((m) => m.event === "ready");
  results.ready = ready;
  check(
    "ready via LaunchServices (own responsible process)",
    ready.parentPath === "/sbin/launchd" && ready.bundleId === "org.openlfcp.bridge.reminders",
    ready,
  );

  // 1. access
  let auth = ready.authorization;
  if (auth !== "fullAccess") {
    console.log(
      "\nСейчас появится системный диалог «LFCP Reminders Helper» → Напоминания. Нажми «Разрешить».",
    );
    const r = await req("access.request", { timeoutSec: 300 }, 310000);
    results.accessRequest = r;
    auth = r.authorization;
  }
  check("full Reminders access granted to the helper app", auth === "fullAccess", {
    authorization: auth,
  });
  if (auth !== "fullAccess")
    throw new Error("no access; see System Settings → Privacy & Security → Reminders");

  // 2. write gate
  await req("hello", { allowListTitlePrefixes: ["LFCP Verify · "] });
  const gated = await req("lists.create", { title: `LFCP Verify · Gate ${stamp}`, opKey: "gate" });
  check(
    "writes off by default → writes_disabled (live)",
    gated.error?.code === "writes_disabled",
    gated.error,
  );
  await req("hello", {
    allowListTitlePrefixes: ["LFCP Verify · ", "LFCP · "],
    writes: "verification",
  });
  const outside = await req("lists.create", { title: `LFCP · Not verify ${stamp}`, opKey: "out" });
  check(
    "verification mode refuses non-verify lists",
    outside.error?.code === "forbidden_list",
    outside.error,
  );

  // 3. list + create + read
  const title = `LFCP Verify · Helper ${stamp}`;
  const lc = await req("lists.create", { title, opKey: "list" });
  check("lists.create", lc.ok, lc);
  const list = lc.list.id;
  results.list = lc.list;
  const dup = await req("lists.create", { title, opKey: "list2" });
  check(
    "lists.create with a taken title → list_exists",
    dup.error?.code === "list_exists",
    dup.error,
  );
  const t0 = Date.now();
  const c = await req("items.create", {
    list,
    linkUrl: `lfcp://task/LIVE-1?s=S&b=live`,
    opKey: "c1",
    set: { title: "Helper check: fields", priority: 9, dueDate: dayPlus(20) },
  });
  check(
    "items.create: written matches",
    c.ok &&
      c.written.title === "Helper check: fields" &&
      c.written.priority === 9 &&
      c.written.dueDate === dayPlus(20),
    c,
  );
  const own = await waitFor((m) => m.event === "changed", 10000).catch(() => null);
  check("EKEventStoreChanged after an own write", own !== null, {
    afterMs: own ? Date.now() - t0 : null,
  });
  const again = await req("items.create", {
    list,
    linkUrl: `lfcp://task/LIVE-1?s=S&b=live`,
    opKey: "c1b",
    set: { title: "x" },
  });
  check(
    "items.create is idempotent by link",
    again.existing === true && again.ref.id === c.ref.id,
    again,
  );
  const snap = await req("items.snapshot", { list });
  check("items.snapshot complete", snap.complete === true && snap.count >= 1, {
    count: snap.count,
  });

  // 4. update, stale rev
  const u = await req("items.update", {
    ref: c.ref,
    set: { title: "Helper check: fields (2)", priority: 1, completed: { value: true } },
    opKey: "u1",
    expect: { rev: c.rev },
  });
  check("items.update with current rev", u.ok && u.written.priority === 1, u);
  const stale = await req("items.update", {
    ref: c.ref,
    set: { priority: 9 },
    opKey: "u2",
    expect: { rev: c.rev },
  });
  check("stale rev → conflict_changed", stale.error?.code === "conflict_changed", stale.error);
  const read = (await req("items.get", { ref: c.ref })).item;
  check(
    "written equals what EventKit returns",
    read.title === "Helper check: fields (2)" &&
      read.priority === 1 &&
      read.completed === true &&
      read.rev === u.rev,
    read,
  );

  // 5. personal data: time, alarm, notes (B2, B12, B15) — manual
  const p = await req("items.create", {
    list,
    linkUrl: `lfcp://task/LIVE-2?s=S&b=live`,
    opKey: "c2",
    set: { title: "Helper check: personal", dueDate: dayPlus(21) },
  });
  if (
    await manual(
      `В Reminders (iPhone или Mac) открой список «${title}», напоминание «Helper check: personal».\n` +
        `Включи время 09:00, добавь заметку (любой текст) и раннее напоминание / второй будильник, если есть. Подожди синхронизацию.`,
    )
  ) {
    let before = (await req("items.get", { ref: p.ref })).item;
    for (let i = 0; i < 20 && before.rev === p.rev; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      before = (await req("items.get", { ref: p.ref })).item;
    }
    results.personalBefore = before;
    check(
      "person's edit seen: time and notes",
      before.due?.time !== null && before.hasNotes === true,
      before,
    );
    const moved = await req("items.update", {
      ref: p.ref,
      set: { dueDate: dayPlus(23), title: "Helper check: personal (2)" },
      opKey: "p1",
      expect: { rev: before.rev },
    });
    const after = (await req("items.get", { ref: p.ref })).item;
    results.personalAfter = after;
    check(
      "date change keeps time, zone, notes (B2)",
      moved.ok &&
        after.due?.date === dayPlus(23) &&
        after.due?.time === before.due?.time &&
        after.due?.tz === before.due?.tz &&
        after.hasNotes,
      { moved, after },
    );
    check(
      "alarms untouched by a date change (B15)",
      JSON.stringify(after.alarms) === JSON.stringify(before.alarms),
      { before: before.alarms, after: after.alarms, warnings: moved.warnings },
    );
    const cleared = await req("items.update", {
      ref: p.ref,
      set: { dueDate: null },
      opKey: "p2",
      expect: { rev: after.rev },
    });
    check(
      "dueDate null over a time or alarm → personal_conflict (B12)",
      cleared.error?.code === "personal_conflict",
      cleared.error,
    );
    if (
      await manual(
        "Посмотри на iPhone: «Helper check: personal» — дата сдвинута на +2 дня, время 09:00 и заметка на месте? Будильник остался прежним?",
      )
    ) {
      const a = (await rl.question("Опиши одной строкой, что видишь: ")).trim();
      results.notes.push({ step: "personal on iPhone", answer: a });
    }
  }

  // 6. The bridge's link (EKReminder.url). Reminders.app (iOS, macOS 26) does not show this field,
  // and the card's "URL" field is other storage EventKit cannot see (R-023 F3): a person can
  // neither clear nor replace the link from Reminders. What is checked is what can be observed:
  // the helper reads the link back, a URL typed in the card leaves it alone, and restoreUrl with
  // the link present changes nothing. restoreUrl on a missing link and on a person's URL
  // (personal_conflict) is covered by helper/Tests/HelperCoreTests/WriteTests.swift.
  const LINK = "lfcp://task/LIVE-3?s=S&b=live";
  const url = await req("items.create", {
    list,
    linkUrl: LINK,
    opKey: "c3",
    set: { title: "Helper check: url" },
  });
  let it = (await req("items.get", { ref: url.ref })).item;
  check("the helper reads the bridge's link back (EKReminder.url)", it.linkUrl === LINK, {
    linkUrl: it.linkUrl,
  });
  if (
    await manual(
      "В Reminders открой «Helper check: url». Ссылки lfcp://… в карточке не видно — это ожидаемо: " +
        "Напоминания не показывают поле, куда её пишет мост. Впиши в поле «URL» карточки " +
        "https://example.com, сохрани и подожди синхронизацию (до 40 с).",
    )
  ) {
    // The edit may or may not change the item's rev; wait for it up to 40 s, then look.
    const rev0 = it.rev;
    for (let i = 0; i < 20 && it.rev === rev0; i++) {
      await new Promise((r) => setTimeout(r, 2000));
      it = (await req("items.get", { ref: url.ref })).item;
    }
    check("a URL typed in the card leaves the bridge's link alone", it.linkUrl === LINK, {
      linkUrl: it.linkUrl,
      revChanged: it.rev !== rev0,
    });
  }
  const same = await req("items.restoreUrl", {
    ref: url.ref,
    linkUrl: LINK,
    opKey: "r1",
    expect: { rev: it.rev },
  });
  const after = (await req("items.get", { ref: url.ref })).item;
  check(
    "restoreUrl with the link present: ok, the link unchanged",
    same.ok && after.linkUrl === LINK,
    {
      same,
      linkUrl: after.linkUrl,
    },
  );

  // 7. markers
  const markerUrl = `lfcp://bridge/live-check?r=${stamp}`;
  const m = await req("markers.create", { list, markerUrl, opKey: "m1" });
  check("markers.create: completed marker", m.ok && m.item.completed === true, m);
  const m2 = await req("markers.create", { list, markerUrl, opKey: "m2" });
  check("markers.create idempotent", m2.existing === true, m2);
  const wrong = await req("markers.retire", {
    ref: c.ref,
    markerUrl,
    opKey: "m3",
    expect: { rev: read.rev },
  });
  check("markers.retire refuses a non-marker", wrong.error?.code === "forbidden_list", wrong.error);
  const ret = await req("markers.retire", {
    ref: m.ref,
    markerUrl,
    opKey: "m4",
    expect: { rev: m.rev },
  });
  check("markers.retire removes the exact marker", ret.retired === true, ret);

  // 8. change from the phone — latency
  if (
    await manual(
      "Измени на iPhone название «Helper check: fields (2)» (допиши « iphone») и СРАЗУ нажми Enter.",
    )
  ) {
    const t = Date.now();
    const ev = await waitFor(
      (x) => x.event === "changed" && lines.find((l) => l.m === x)?.at >= t,
      120000,
    ).catch(() => null);
    check("EKEventStoreChanged after a phone edit", ev !== null, {
      afterMs: ev ? (lines.find((l) => l.m === ev)?.at ?? 0) - t : null,
    });
  }

  // 9. wake/sleep
  if (await manual("Отправь Mac в сон (меню Apple → Сон) на ~30 с, разбуди и нажми Enter.")) {
    const since = Date.now() - 10 * 60000;
    check(
      "sleep and wake events from NSWorkspace",
      eventsSince(since, "sleep").length > 0 && eventsSince(since, "wake").length > 0,
      { sleep: eventsSince(since, "sleep").length, wake: eventsSince(since, "wake").length },
    );
  }
} catch (e) {
  results.error = e.message;
  console.error(`\nОШИБКА: ${e.message}`);
} finally {
  results.stderrTail = stderr.slice(-30);
  results.finishedAt = new Date().toISOString();
  save();
  input.end();
  await new Promise((r) => setTimeout(r, 1000));
  for (const f of [fin, fout, ferr]) fs.rmSync(f, { force: true });
  try {
    fs.rmdirSync(dir);
  } catch {}
  rl?.close();
  const failed = results.checks.filter((c) => !c.ok).length;
  console.log(
    `\n${results.checks.length - failed}/${results.checks.length} ok. Результаты: ${out}`,
  );
  console.log(
    `Удали список «LFCP Verify · Helper ${stamp}» в Reminders вручную (helper списки не удаляет).`,
  );
  process.exit(failed === 0 && !results.error ? 0 : 1);
}
