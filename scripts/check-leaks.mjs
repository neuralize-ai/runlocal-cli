#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Fails when the repository, the package, or the git history holds an API
// path that is not public, or a word of the deny-list.
//
// The deny-list of words comes from the RLX_DENY_HASHES secret of CI, not
// from this repository (see DENY_HASHES).

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** The API prefix, built so that this file does not hold a bare path. */
export const API_PREFIX = ["", "api", "v1", ""].join("/");

/** The only API paths that may appear: the public sign-in, and the manifest. */
export const ALLOWED_PATHS = new Set([
  `${API_PREFIX}client-config`,
  `${API_PREFIX}auth/status`,
  `${API_PREFIX}cli/manifest`,
]);

/**
 * The hashes of a deny-list text: SHA-256 of lower-case words and word pairs,
 * separated by commas or white space. Anything else is ignored.
 */
export function denyHashesFrom(text) {
  return new Set(String(text ?? "").split(/[\s,]+/).filter((hash) => /^[0-9a-f]{64}$/.test(hash)));
}

/**
 * The deny-list. It is not kept in this repository: an unsalted hash of a
 * common word is easy to reverse, so the list would name what it hides.
 * CI passes it in the RLX_DENY_HASHES secret. Without it, the check of API
 * paths still runs, and the check of words is skipped (CI requires it).
 */
export const DENY_HASHES = denyHashesFrom(process.env.RLX_DENY_HASHES);

export function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

const PATH_PATTERN = new RegExp(
  API_PREFIX.replace(/\//g, "\\/") + "[A-Za-z0-9_\\-.{}:/]*",
  "gi",
);

/**
 * A GitHub Actions workflow must have a top-level key whose name is on the
 * deny-list. Only that exact line passes: the key alone, with no indent. A
 * line of `git log -p` can start with "+", "-", or " ".
 */
const WORKFLOW_KEY_HASH = "5d9a17cb70b9733aadc073a44c21889d33325874c51f9c0c461de3e61a2425eb";

function allowedLine(line) {
  const key = /^[+\- ]?([a-z]+):\s*$/.exec(line);
  return Boolean(key && sha256(key[1]) === WORKFLOW_KEY_HASH);
}

/** Splits a line into lower-case words, also at camelCase boundaries. */
function words(line) {
  return line
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter(Boolean);
}

/**
 * Scans one text. Returns each finding as { line, kind, detail }.
 * `denyHashes` replaces the deny-list (the tests use invented words).
 */
export function scanText(text, { denyHashes = DENY_HASHES } = {}) {
  const findings = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const match of line.matchAll(PATH_PATTERN)) {
      const path = match[0].replace(/[.:/]+$/, "");
      if (!ALLOWED_PATHS.has(path)) {
        findings.push({ line: i + 1, kind: "path", detail: match[0] });
      }
    }
    if (allowedLine(line)) continue;
    const list = words(line);
    for (let w = 0; w < list.length; w++) {
      const candidates = [list[w]];
      if (w + 1 < list.length) candidates.push(`${list[w]} ${list[w + 1]}`);
      for (const candidate of candidates) {
        if (denyHashes.has(sha256(candidate))) {
          findings.push({ line: i + 1, kind: "term", detail: candidate });
        }
      }
    }
  }
  return findings;
}

function isBinary(buffer) {
  return buffer.subarray(0, 8000).includes(0);
}

/** Scans files under `root`. Returns findings with a `file` field. */
export function scanFiles(root, files, options) {
  const findings = [];
  for (const file of files) {
    const full = join(root, file);
    if (!existsSync(full) || !statSync(full).isFile()) continue;
    const buffer = readFileSync(full);
    if (isBinary(buffer)) continue;
    for (const finding of scanText(buffer.toString("utf8"), options)) {
      findings.push({ file, ...finding });
    }
  }
  return findings;
}

function git(root, args) {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 512 * 1024 * 1024,
  });
}

/** The files of the working tree that git tracks or would track. */
export function repositoryFiles(root) {
  const tracked = git(root, ["ls-files", "-z"]).split("\0");
  const untracked = git(root, ["ls-files", "-z", "--others", "--exclude-standard"]).split("\0");
  return [...new Set([...tracked, ...untracked])].filter(Boolean);
}

/** The files that `npm pack` would put in the tarball. */
export function packageFiles(root) {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const parsed = JSON.parse(out);
  // npm 10 answers an array; npm 11 and later answer an object keyed by name.
  const report = Array.isArray(parsed) ? parsed[0] : Object.values(parsed)[0];
  return report.files.map((f) => f.path);
}

/** Scans every commit of the history: messages and patches. */
export function scanHistory(root, options) {
  const log = git(root, ["log", "-p", "--all", "--format=commit %H%n%an%n%B"]);
  const findings = [];
  let commit = "";
  let offset = 0;
  const lines = log.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const header = /^commit ([0-9a-f]{40})$/.exec(lines[i]);
    if (header) {
      commit = header[1];
      offset = i;
      continue;
    }
    // A hunk header repeats a nearby line of the file as context ("@@ -1,2 +1,3 @@ <line>"): that line is scanned where it is, not here.
    const line = lines[i].replace(/^(@@ [^@]* @@).*$/, "$1");
    for (const finding of scanText(line, options)) {
      findings.push({ commit: commit.slice(0, 10), ...finding, line: i - offset });
    }
  }
  return findings;
}

function report(title, findings) {
  if (findings.length === 0) {
    console.log(`ok   ${title}`);
    return 0;
  }
  console.log(`FAIL ${title}: ${findings.length} finding(s)`);
  for (const f of findings.slice(0, 50)) {
    const where = f.commit ? `commit ${f.commit}` : f.file;
    console.log(`  ${where}:${f.line}  ${f.kind}  ${f.detail}`);
  }
  return findings.length;
}

function main() {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  let failures = 0;
  if (DENY_HASHES.size === 0) {
    if (process.env.CI) {
      console.log("FAIL deny-list: RLX_DENY_HASHES is not set. CI must pass the secret.");
      failures += 1;
    } else {
      console.log("The deny-list is not set (RLX_DENY_HASHES), so only API paths are checked.");
    }
  }
  failures += report("repository files", scanFiles(root, repositoryFiles(root)));
  const packed = packageFiles(root);
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  for (const bin of Object.values(pkg.bin ?? {})) {
    if (!packed.includes(bin.replace(/^\.\//, ""))) {
      console.log(`FAIL package files: ${bin} is missing. Run npm run build first.`);
      failures += 1;
    }
  }
  failures += report(`package files (${packed.join(", ")})`, scanFiles(root, packed));
  failures += report("git history", scanHistory(root));
  if (failures > 0) {
    console.log("The leak check failed.");
    process.exit(1);
  }
  console.log("The leak check passed.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
