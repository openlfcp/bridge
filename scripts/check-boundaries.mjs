#!/usr/bin/env node
// Enforces the package boundaries of lfcp-bridge (D-010 §1.1).
//
//   graph            a workspace dependency or import outside ALLOWED below
//   subpath          a transport package importing the adapter other than
//                    through its transport contract or capability declaration
//   relative         a relative import that leaves its package
//   unknown-package  a workspace package missing from ALLOWED (decide its edges first)
//
//   node scripts/check-boundaries.mjs              check this repository
//   node scripts/check-boundaries.mjs --root DIR   check another workspace
//   node scripts/check-boundaries.mjs --self-test  run scripts/boundary-fixtures/*
//
// Each problem is one line: <file>:<line> <rule>: <detail>

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/** The workspace packages (by directory) and the workspace packages each may use. */
export const ALLOWED = {
  // The host composes everything.
  host: ["reminders", "transport-eventkit"],
  // The adapter never imports the host (§1.1).
  reminders: [],
  // A transport sees only the adapter's contract (TRANSPORT_SUBPATHS).
  "transport-eventkit": ["reminders"],
};

/** What a transport package may import of the adapter. */
export const TRANSPORT_SUBPATHS = ["transport", "capabilities"];

/** What a transport's tests may import of the adapter besides that: the shared contract suite (D-010 §10.2). */
export const TRANSPORT_TEST_SUBPATHS = ["test-support"];

const SOURCE = /\.(ts|mts|cts|js|mjs|cjs)$/;

/**
 * Every module specifier of a file with its line: static imports and
 * re-exports, `import()` and `require()` with a literal, over the whole text
 * (a specifier on another line than `import` or `from` counts too).
 */
function specifiers(text) {
  const info = ts.preProcessFile(text, true, true);
  return info.importedFiles.map((f) => ({
    spec: f.fileName,
    line: text.slice(0, f.pos).split("\n").length,
  }));
}

function filesOf(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const e of readdirSync(dir)) {
    if (e === "node_modules" || e === "dist") continue;
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...filesOf(p));
    else if (SOURCE.test(e) && !e.endsWith(".d.ts")) out.push(p);
  }
  return out;
}

/** The workspace: directory name → package name, from packages/<dir>/package.json. */
function workspace(root) {
  const dir = join(root, "packages");
  const byDir = new Map();
  if (!existsSync(dir)) return byDir;
  for (const d of readdirSync(dir)) {
    const pj = join(dir, d, "package.json");
    if (existsSync(pj)) byDir.set(d, JSON.parse(readFileSync(pj, "utf8")));
  }
  return byDir;
}

/** Problems of the workspace at `root`, as "<file>:<line> <rule>: <detail>" lines. */
export function check(root) {
  const problems = [];
  const packages = workspace(root);
  const dirOfName = new Map([...packages].map(([d, pj]) => [pj.name, d]));
  const rel = (p) => relative(root, p).split(sep).join("/");
  for (const [dir, pj] of packages) {
    const pjPath = join(root, "packages", dir, "package.json");
    if (!(dir in ALLOWED)) {
      problems.push(`${rel(pjPath)}:1 unknown-package: ${dir} is not in ALLOWED`);
      continue;
    }
    const allowed = new Set(ALLOWED[dir]);
    const deps = { ...pj.dependencies, ...pj.devDependencies, ...pj.peerDependencies };
    for (const name of Object.keys(deps)) {
      const target = dirOfName.get(name);
      if (target !== undefined && target !== dir && !allowed.has(target))
        problems.push(`${rel(pjPath)}:1 graph: ${dir} may not depend on ${name}`);
    }
    const base = join(root, "packages", dir);
    const testDir = join(base, "test") + sep;
    for (const file of [...filesOf(join(base, "src")), ...filesOf(join(base, "test"))]) {
      const isTest = file.startsWith(testDir);
      for (const { spec, line } of specifiers(readFileSync(file, "utf8"))) {
        const at = `${rel(file)}:${line}`;
        if (spec.startsWith(".")) {
          const target = resolve(dirname(file), spec);
          if (!(target === base || target.startsWith(base + sep)))
            problems.push(`${at} relative: ${spec} leaves packages/${dir}`);
          continue;
        }
        const name = spec.startsWith("@")
          ? spec.split("/").slice(0, 2).join("/")
          : spec.split("/")[0];
        const target = dirOfName.get(name);
        if (target === undefined || target === dir) continue;
        if (!allowed.has(target)) {
          problems.push(`${at} graph: ${dir} may not import ${name}`);
          continue;
        }
        if (dir.startsWith("transport-") && target === "reminders") {
          const sub = spec.slice(name.length + 1);
          const subs = isTest
            ? [...TRANSPORT_SUBPATHS, ...TRANSPORT_TEST_SUBPATHS]
            : TRANSPORT_SUBPATHS;
          if (!subs.includes(sub))
            problems.push(
              `${at} subpath: ${dir} may import ${name} only as ${subs.map((s) => `${name}/${s}`).join(" or ")}`,
            );
        }
      }
    }
  }
  return problems;
}

function selfTest(fixtures) {
  let failed = 0;
  for (const name of readdirSync(fixtures).sort()) {
    const root = join(fixtures, name);
    const expected = readFileSync(join(root, "expected.txt"), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "");
    const got = check(root);
    const same = got.length === expected.length && got.every((l, i) => l === expected[i]);
    if (!same) {
      failed++;
      console.error(
        `self-test ${name}: expected\n  ${expected.join("\n  ")}\ngot\n  ${got.join("\n  ")}`,
      );
    }
  }
  if (failed > 0) process.exit(1);
  console.log("check-boundaries self-test: ok");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const here = dirname(fileURLToPath(import.meta.url));
  if (args.includes("--self-test")) selfTest(join(here, "boundary-fixtures"));
  else {
    const i = args.indexOf("--root");
    const root = i >= 0 ? resolve(args[i + 1]) : resolve(here, "..");
    const problems = check(root);
    for (const p of problems) console.error(p);
    if (problems.length > 0) process.exit(1);
    console.log("check-boundaries: ok");
  }
}
