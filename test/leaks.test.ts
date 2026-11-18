// SPDX-License-Identifier: Apache-2.0
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error The leak check is a plain script, with no types.
import * as leaks from "../scripts/check-leaks.mjs";
import { tempDir } from "./helpers/cli.js";

const { API_PREFIX, scanText, scanFiles, scanHistory, sha256, denyHashesFrom } = leaks as {
  API_PREFIX: string;
  denyHashesFrom(text: string | undefined): Set<string>;
  sha256(text: string): string;
  scanText(text: string, options?: { denyHashes?: Set<string> }): { line: number; kind: string; detail: string }[];
  scanFiles(root: string, files: string[], options?: { denyHashes?: Set<string> }): { file: string }[];
  scanHistory(root: string, options?: { denyHashes?: Set<string> }): { commit: string; detail: string }[];
};

// Invented words stand in for the real deny-list in these tests.
const invented = new Set([sha256("zorblax"), sha256("quux frob")]);

describe("the leak check", () => {
  it("allows the public paths and the manifest path", () => {
    const text = [`${API_PREFIX}client-config`, `${API_PREFIX}auth/status.`, `"${API_PREFIX}cli/manifest"`].join("\n");
    expect(scanText(text)).toEqual([]);
  });

  it("finds any other API path", () => {
    const findings = scanText(`fetch("${API_PREFIX}widgets/{id}")`);
    expect(findings).toEqual([{ line: 1, kind: "path", detail: `${API_PREFIX}widgets/{id}` }]);
    expect(scanText(`${API_PREFIX}auth/status/extra`)).toHaveLength(1);
  });

  it("finds deny-listed words and word pairs, in any case and in camelCase", () => {
    const findings = scanText("const Zorblax = 1;\nlet quuxFrob;\nzorblaxes are fine", { denyHashes: invented });
    expect(findings.map((f) => [f.line, f.detail])).toEqual([
      [1, "zorblax"],
      [2, "quux frob"],
    ]);
  });

  it("reads the deny-list from a secret of hashes, and ignores anything that is not a hash", () => {
    const hashes = denyHashesFrom(`${sha256("zorblax")}, ${sha256("quux frob")}\nzorblax not-a-hash`);
    expect(hashes).toEqual(invented);
    expect(denyHashesFrom(undefined).size).toBe(0);
  });

  it("scans files and skips binary files", () => {
    const root = tempDir("rlx-leaks-");
    writeFileSync(join(root, "a.ts"), "ok\nzorblax\n");
    writeFileSync(join(root, "b.bin"), Buffer.from([0, 1, 2, ...Buffer.from("zorblax")]));
    expect(scanFiles(root, ["a.ts", "b.bin"], { denyHashes: invented })).toEqual([
      { file: "a.ts", line: 2, kind: "term", detail: "zorblax" },
    ]);
  });

  it("scans the git history, also of a file that was removed", () => {
    const root = tempDir("rlx-leaks-git-");
    const git = (...args: string[]) =>
      execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "pipe" });
    git("init", "-q");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "x.ts"), `const p = "${API_PREFIX}widgets";\n`);
    git("add", ".");
    git("commit", "-q", "-m", "first");
    git("rm", "-q", "src/x.ts");
    git("commit", "-q", "-m", "a zorblax in the message");
    const findings = scanHistory(root, { denyHashes: invented });
    const details = new Set(findings.map((f) => f.detail));
    expect([...details].sort()).toEqual([`${API_PREFIX}widgets`, "zorblax"].sort());
  });
});
