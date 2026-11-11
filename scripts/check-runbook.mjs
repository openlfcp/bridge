#!/usr/bin/env node
// Checks the commands a guide shows against the CLI's sources: every `lfcp-bridge …` in a code
// block or an inline code span must name a command that is ready in this build, use only flags
// the code reads, and give the flags its usage line requires. `sections add` and `migrate resume`
// also need the machine's migration ports (runtime.ts).
//
//   node scripts/check-runbook.mjs [--src <packages/host/src>] [docs/guides/running-the-bridge.md …]
//
// The sources are packages/host/src/commands.ts and, when there, packages/host/src/run/cli.ts
// (PR 9b). Run it against the tree the guide describes (for a branch: a `git worktree` of it, or
// `--src` pointing there).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function args(argv) {
  let src = join(root, "packages", "host", "src");
  const docs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--src") src = argv[++i];
    else docs.push(argv[i]);
  }
  if (docs.length === 0) docs.push(join(root, "docs", "guides", "running-the-bridge.md"));
  return { src, docs };
}

/** Commands, ready ones, the flags the code reads, and usage lines, from the CLI sources. */
export function cliOf(src) {
  const files = [join(src, "commands.ts"), join(src, "run", "cli.ts")].filter((f) => existsSync(f));
  const text = files.map((f) => readFileSync(f, "utf8")).join("\n");
  const table = text.slice(
    text.indexOf("export const COMMANDS"),
    text.indexOf("satisfies CommandInfo[]"),
  );
  const commands = new Map();
  for (const m of table.matchAll(/\{([^{}]*)\}/g)) {
    const name = /name:\s*"([^"]+)"/.exec(m[1])?.[1];
    if (name !== undefined) commands.set(name, /ready:\s*true/.test(m[1]));
  }
  const flags = new Set();
  for (const m of text.matchAll(/opts\.get\("([a-z-]+)"\)/g)) flags.add(m[1]);
  for (const m of text.matchAll(/"--([a-z][a-z-]*)"/g)) flags.add(m[1]);
  // usage: lfcp-bridge <command> <words>: the --flags outside [...] are required.
  const usage = new Map();
  for (const m of text.matchAll(/usage: lfcp-bridge ([a-z-]+(?: add)?) ([^"`\n]*)/g)) {
    const required = m[2]
      .replace(/\[[^\]]*\]/g, "")
      .match(/--[a-z-]+/g)
      ?.map((f) => f.slice(2));
    if (required?.length) usage.set(m[1], required);
  }
  // N8's commands that need the machine's migration ports: without them they answer "not
  // available in this build" even though the command table calls them ready.
  const runtime = join(src, "runtime.ts");
  const ports =
    existsSync(runtime) &&
    readFileSync(runtime, "utf8")
      .split("\n")
      .some((l) => /migrationPorts\s*[:(]/.test(l) && !/readonly migrationPorts\?/.test(l));
  return { commands, flags, usage, files, migrationPorts: ports };
}

/** The `lfcp-bridge …` invocations in the code blocks of a markdown text, with line numbers. */
export function invocations(markdown) {
  const out = [];
  let inCode = false;
  markdown.split("\n").forEach((line, i) => {
    if (/^\s*```/.test(line)) {
      inCode = !inCode;
      return;
    }
    const indented = /^ {4}\S/.test(line);
    // Code blocks and indented code, whole lines; elsewhere the inline `code` spans.
    const spans =
      inCode || indented
        ? [line.replace(/\s#\s.*$/, "")]
        : [...line.matchAll(/`([^`]+)`/g)].map((m) => m[1]);
    for (const code of spans)
      for (const m of code.matchAll(/(?:^|[|;&(]\s*|\s)lfcp-bridge\s+([^|;&]*)/g))
        out.push({ line: i + 1, words: m[1].trim().split(/\s+/) });
  });
  return out;
}

export function check(markdown, cli) {
  const problems = [];
  for (const { line, words } of invocations(markdown)) {
    if (words[0] === undefined || words[0].startsWith("-")) continue; // --version, --help
    const name = words[0] === "sections" && words[1] === "add" ? "sections add" : words[0];
    if (!cli.commands.has(name)) {
      problems.push(`${line}: no command "${name}"`);
      continue;
    }
    if (!cli.commands.get(name)) problems.push(`${line}: "${name}" is not in this build`);
    const needsPorts = name === "sections add" || (name === "migrate" && words[1] === "resume");
    if (needsPorts && !cli.migrationPorts)
      problems.push(
        `${line}: ${words.slice(0, 2).join(" ")} needs the run's migration ports, not in this build`,
      );
    const given = words.filter((w) => w.startsWith("--")).map((w) => w.slice(2).split("=")[0]);
    for (const f of given)
      if (!cli.flags.has(f)) problems.push(`${line}: ${name} --${f}: no such flag`);
    // `resume` alone removes STOP; its usage line is for the --accept form.
    if (name === "resume" && given.length === 0) continue;
    for (const f of cli.usage.get(name) ?? [])
      if (!given.includes(f)) problems.push(`${line}: ${name} needs --${f}`);
  }
  return problems;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { src, docs } = args(process.argv.slice(2));
  const cli = cliOf(src);
  let bad = 0;
  for (const doc of docs) {
    for (const p of check(readFileSync(doc, "utf8"), cli)) {
      console.error(`${doc}:${p}`);
      bad++;
    }
  }
  if (bad > 0) {
    console.error(`check-runbook: ${bad} problem(s) against ${cli.files.join(", ")}`);
    process.exitCode = 1;
  } else console.log(`check-runbook: ok against ${cli.files.join(", ")}`);
}
