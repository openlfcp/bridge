// scripts/sdk-ts-pack.mjs: the SDK tarballs are the same bytes whatever the
// checkout of sdk-ts looks like (review r1 of E-022a: a Windows checkout with
// core.autocrlf has CRLF text files).

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { exportCommit, extractTar } from "../sdk-ts-pack.mjs";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const temp = () => {
  const d = mkdtempSync(join(tmpdir(), "sdk-ts-pack test "));
  dirs.push(d);
  return d;
};
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.org", ...args], {
    cwd,
    encoding: "utf8",
  });

describe("exportCommit", () => {
  it("takes the committed bytes, not a CRLF working tree", () => {
    const repo = temp();
    git(repo, "init", "-q");
    git(repo, "config", "core.autocrlf", "false");
    writeFileSync(join(repo, ".gitattributes"), "*.bin -text\n");
    writeFileSync(join(repo, "README.md"), "a\nb\n");
    writeFileSync(join(repo, "blob.bin"), Buffer.from([0x0d, 0x0a, 0x00, 0x0a]));
    git(repo, "add", ".");
    git(repo, "commit", "-q", "-m", "c");
    const commit = git(repo, "rev-parse", "HEAD").trim();
    // A checkout as Windows makes it with core.autocrlf: CRLF text in the working tree.
    git(repo, "config", "core.autocrlf", "true");
    rmSync(join(repo, "README.md"));
    git(repo, "checkout", "--", "README.md");
    expect(readFileSync(join(repo, "README.md"), "utf8")).toBe("a\r\nb\r\n");

    const out = temp();
    extractTar(exportCommit(repo, commit, ["README.md", "blob.bin"]), out);
    expect(readFileSync(join(out, "README.md"), "utf8")).toBe("a\nb\n");
    expect([...readFileSync(join(out, "blob.bin"))]).toEqual([0x0d, 0x0a, 0x00, 0x0a]);
  });

  it("throws for a commit the repository lacks", () => {
    const repo = temp();
    git(repo, "init", "-q");
    expect(() => exportCommit(repo, "0".repeat(40), ["README.md"])).toThrow();
  });
});
