// SPDX-License-Identifier: Apache-2.0
// Tests of the output fields json, hint, and save; repeated positionals;
// examples and groups in the help; explain; and the download step.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY, runCli, storeKey, tempDir } from "./helpers/cli.js";
import { type MockServer, serveManifest, startMock } from "./helpers/mock.js";
import { validateManifest } from "../src/manifest/schema.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));

let mock: MockServer;
let home: string;
let cwd: string;

beforeEach(async () => {
  mock = await startMock();
  serveManifest(mock, fixture, KEY);
  home = tempDir();
  cwd = tempDir("rlx-project-");
  mkdirSync(join(cwd, ".git"));
  storeKey(home, mock.origin, KEY);
});

afterEach(async () => {
  await mock.close();
});

const rlx = (argv: string[]) => runCli(["--api", mock.origin, ...argv], { home, cwd });
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

describe("output fields", () => {
  beforeEach(() => {
    mock.on("GET", "/v1/gears/g1", (req) => {
      expect(req.query.get("format")).toBe("text");
      return { body: { id: "g1", state: "ready", text: "Gear g1 is ready.", next_step: "Run rlx gears turn g1." } };
    });
  });

  it("prints the text, and the hint on standard error", async () => {
    const run = await rlx(["gears", "show", "g1"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("Gear g1 is ready.\n");
    expect(run.stderr).toBe("Run rlx gears turn g1.\n");
  });

  it("prints the whole answer with --json, and no hint", async () => {
    const run = await rlx(["gears", "show", "g1", "--json"]);
    expect(JSON.parse(run.stdout)).toMatchObject({ id: "g1", state: "ready" });
    expect(run.stderr).toBe("");
  });

  it("hides the hint with --quiet", async () => {
    const run = await rlx(["gears", "show", "g1", "--quiet"]);
    expect(run.stdout).toBe("Gear g1 is ready.\n");
    expect(run.stderr).toBe("");
  });

  it("writes the result to the file of the save option", async () => {
    mock.on("GET", "/v1/gears/g1/script", () => ({ body: "SELECT 1;" }));
    const run = await rlx(["gears", "script", "g1", "--out", "g1.sql"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("Wrote g1.sql.");
    expect(readFileSync(join(cwd, "g1.sql"), "utf8")).toBe("SELECT 1;\n");
    const printed = await rlx(["gears", "script", "g1"]);
    expect(printed.stdout).toBe("SELECT 1;\n");
  });

  it("refuses to save into the folder of rlx", async () => {
    mock.on("GET", "/v1/gears/g1/script", () => ({ body: "SELECT 1;" }));
    const run = await rlx(["gears", "script", "g1", "--out", join(home, ".config", "runlocal", "x.sql")]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("FILE.REFUSED");
  });
});

describe("repeated positionals", () => {
  it("collects each word that is left into a list", async () => {
    mock.on("POST", "/v1/gears/g1/turn", (req) => ({ body: { count: req.json().parts.length } }));
    const run = await rlx(["gears", "turn", "g1", "a", "b", "c"]);
    expect(run.stdout).toBe("Turned 3.\n");
    expect(mock.requests.at(-1)!.json()).toEqual({ parts: ["a", "b", "c"] });
  });

  it("refuses a repeated positional that is not the last", () => {
    const bad = { schema: "runlocal.cli-manifest/1", version: "x", commands: [{ name: ["a"], summary: "x", steps: [], args: [
      { name: "many", kind: "positional", repeat: true }, { name: "one", kind: "positional" },
    ] }] };
    expect(() => validateManifest(bad)).toThrow(/last positional/);
  });

  it("says how to get help when a required argument is missing", async () => {
    const run = await rlx(["gears", "turn"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("<id> is required. Run: rlx gears turn --help");
  });
});

describe("help", () => {
  it("lists the commands under their groups", async () => {
    const run = await rlx(["help"]);
    expect(run.stdout).toContain("  Gears:\n    gears show ");
    expect(run.stdout).toContain("  Other:\n");
  });

  it("shows the examples and a repeated positional", async () => {
    const show = await rlx(["gears", "show", "--help"]);
    expect(show.stdout).toContain("Examples:\n  rlx gears show g1\n  rlx gears show g1 --json");
    const spin = await rlx(["gears", "turn", "--help"]);
    expect(spin.stdout).toContain("Usage: rlx gears turn <id> [<part>...]");
  });

  it("runs the explain steps when the positional is given", async () => {
    mock.on("GET", "/v1/operations/make_widget", () => ({ body: { text: "Fields: name (text, required).", fields: [{ name: "name" }] } }));
    const run = await rlx(["call", "make_widget", "--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage: rlx call <operation>");
    expect(run.stdout).toContain("Fields: name (text, required).");
    expect(mock.count("POST", "/v1/call")).toBe(0);
    const json = await rlx(["call", "make_widget", "--help", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({ text: "Fields: name (text, required).", fields: [{ name: "name" }] });
  });

  it("shows the plain help without the positional", async () => {
    const run = await rlx(["call", "--help"]);
    expect(run.stdout).toContain("Usage: rlx call <operation>");
    expect(mock.requests.some((req) => req.path.startsWith("/v1/operations"))).toBe(false);
  });
});

describe("download", () => {
  const files = (items: unknown[]) => () => ({ body: { items } });

  it("writes each file into the folder with no credential, checks it, and prints the table", async () => {
    mock.on("GET", "/blobs/one", (req) => {
      expect(req.headers.authorization).toBeUndefined();
      return { body: "first" };
    });
    mock.on("GET", "/blobs/two", () => ({ body: "second" }));
    mock.on("GET", "/v1/gears/g1/files", files([
      { name: "a.txt", url: `${mock.origin}/blobs/one`, size: 5, digest: `sha256:${sha("first")}` },
      { name: "sub/b.txt", url: `${mock.origin}/blobs/two`, size: 6, digest: `sha256:${sha("second")}` },
    ]));
    const run = await rlx(["gears", "fetch", "g1", "--out", "got"]);
    expect(run.code).toBe(0);
    expect(readFileSync(join(cwd, "got", "a.txt"), "utf8")).toBe("first");
    expect(readFileSync(join(cwd, "got", "sub", "b.txt"), "utf8")).toBe("second");
    expect(run.stdout).toBe("File       Bytes\na.txt      5\nsub/b.txt  6\n");
    expect(run.stderr).toContain("Downloaded a.txt");
    const again = await rlx(["gears", "fetch", "g1", "--out", "got"]);
    expect(again.code).toBe(0);
    expect(again.stderr).toContain("a.txt is there already.");
  });

  it("refuses a name that leaves the folder", async () => {
    mock.on("GET", "/v1/gears/g1/files", files([{ name: "../evil.txt", url: `${mock.origin}/blobs/one` }]));
    const run = await rlx(["gears", "fetch", "g1", "--out", "got"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("DOWNLOAD.NAME");
    expect(existsSync(join(cwd, "evil.txt"))).toBe(false);
  });

  it("refuses a file whose digest is wrong, and keeps nothing", async () => {
    mock.on("GET", "/blobs/one", () => ({ body: "changed" }));
    mock.on("GET", "/v1/gears/g1/files", files([{ name: "a.txt", url: `${mock.origin}/blobs/one`, digest: `sha256:${sha("first")}` }]));
    const run = await rlx(["gears", "fetch", "g1", "--out", "got"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("DOWNLOAD.DIGEST");
    expect(existsSync(join(cwd, "got", "a.txt"))).toBe(false);
  });

  it("never replaces a different file", async () => {
    mkdirSync(join(cwd, "got"));
    writeFileSync(join(cwd, "got", "a.txt"), "mine");
    mock.on("GET", "/blobs/one", () => ({ body: "first" }));
    mock.on("GET", "/v1/gears/g1/files", files([{ name: "a.txt", url: `${mock.origin}/blobs/one`, digest: `sha256:${sha("first")}` }]));
    const run = await rlx(["gears", "fetch", "g1", "--out", "got"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("DOWNLOAD.EXISTS");
    expect(readFileSync(join(cwd, "got", "a.txt"), "utf8")).toBe("mine");
  });

  // Regressions that the fuzz tests found (test/fuzz.test.ts).
  it("refuses a name that goes through a symbolic link", async () => {
    const elsewhere = tempDir("rlx-elsewhere-");
    mkdirSync(join(cwd, "got"));
    symlinkSync(elsewhere, join(cwd, "got", "sub"));
    mock.on("GET", "/blobs/one", () => ({ body: "first" }));
    mock.on("GET", "/v1/gears/g1/files", files([{ name: "sub/a.txt", url: `${mock.origin}/blobs/one` }]));
    const run = await rlx(["gears", "fetch", "g1", "--out", "got"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("DOWNLOAD.NAME");
    expect(existsSync(join(elsewhere, "a.txt"))).toBe(false);
    expect(mock.count("GET", "/blobs/one")).toBe(0);
  });

  it("refuses a folder that links into the folders of rlx", async () => {
    mkdirSync(join(home, ".config", "runlocal"), { recursive: true });
    symlinkSync(join(home, ".config", "runlocal"), join(cwd, "inbox"));
    mock.on("GET", "/v1/gears/g1/files", files([{ name: "a.txt", url: `${mock.origin}/blobs/one` }]));
    const run = await rlx(["gears", "fetch", "g1", "--out", "inbox"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("FILE.REFUSED");
  });

  it("refuses a size that is not a whole number, before it reads anything", async () => {
    mock.on("GET", "/blobs/one", () => ({ body: "first" }));
    mock.on("GET", "/v1/gears/g1/files", files([{ name: "a.txt", url: `${mock.origin}/blobs/one`, size: "five" }]));
    const run = await rlx(["gears", "fetch", "g1", "--out", "got"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("DOWNLOAD.SIZE");
    expect(mock.count("GET", "/blobs/one")).toBe(0);
  });

  it("does not follow a redirect", async () => {
    mock.on("GET", "/blobs/moved", () => ({ status: 302, headers: { location: `${mock.origin}/blobs/one` } }));
    mock.on("GET", "/blobs/one", () => ({ body: "first" }));
    mock.on("GET", "/v1/gears/g1/files", files([{ name: "a.txt", url: `${mock.origin}/blobs/moved` }]));
    const run = await rlx(["gears", "fetch", "g1", "--out", "got"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("ORIGIN.REFUSED");
    expect(mock.count("GET", "/blobs/one")).toBe(0);
    expect(existsSync(join(cwd, "got", "a.txt"))).toBe(false);
  });

  it("refuses plain http to another host", async () => {
    mock.on("GET", "/v1/gears/g1/files", files([{ name: "a.txt", url: "http://store.example/blob" }]));
    const run = await rlx(["gears", "fetch", "g1"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("ORIGIN.REFUSED");
  });
});
