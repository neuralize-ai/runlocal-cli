// SPDX-License-Identifier: Apache-2.0
// Tests of positionals from an input file, --version after a command name,
// --quiet, and the errors for a refused key. The commands are invented.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseCommandArgs, parseGlobals } from "../src/args.js";
import type { Command } from "../src/manifest/schema.js";
import { validateManifest } from "../src/manifest/schema.js";
import { KEY, runCli, storeKey, tempDir } from "./helpers/cli.js";
import { type MockServer, serveManifest, startMock, TEST_KEY_ENV } from "./helpers/mock.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));

const INPUT = { name: "input", kind: "option", type: "path", help: "A YAML or JSON file of the options." } as const;

const paint: Command = {
  name: ["widgets", "paint"],
  summary: "Paint a widget.",
  args: [
    { name: "widget", kind: "positional" },
    { name: "color", kind: "option" },
    INPUT,
  ],
  steps: [{ op: "http", method: "POST", path: "/v1/widgets/{{args.widget}}/paint", body: { color: "{{args.color}}" }, as: "painted" }],
  output: { kind: "markdown", text: "Painted {{painted.id}}." },
};

const fit: Command = {
  name: ["widgets", "fit"],
  summary: "Fit parts to a widget.",
  args: [
    { name: "spare-part", kind: "positional" },
    { name: "slot", kind: "positional", type: "integer" },
    { name: "extra", kind: "positional", repeat: true },
    INPUT,
  ],
  steps: [{ op: "http", method: "POST", path: "/v1/fits", body: { part: "{{args.spare-part}}", slot: "{{args.slot}}", extra: "{{args.extra}}" }, as: "fitted" }],
  output: { kind: "json", from: "fitted" },
};

/** Like paint, with an input option of another type: the engine does not read its file. */
const polish: Command = {
  name: ["widgets", "polish"],
  summary: "Polish a widget.",
  args: [
    { name: "widget", kind: "positional" },
    { name: "input", kind: "option", help: "A word, not a file." },
  ],
  steps: [{ op: "http", method: "POST", path: "/v1/widgets/{{args.widget}}/polish", as: "polished" }],
};

const manifest = validateManifest({
  ...fixture,
  version: "test.inputs",
  commands: [...fixture.commands, paint, fit, polish],
});

let mock: MockServer;
let home: string;
let cwd: string;

beforeEach(async () => {
  mock = await startMock();
  home = tempDir();
  cwd = tempDir("rlx-project-");
  mkdirSync(join(cwd, ".git"));
});

afterEach(async () => {
  await mock.close();
});

const rlx = (argv: string[], env: Record<string, string> = {}) => runCli(["--api", mock.origin, ...argv], { home, cwd, env });

describe("positionals from an input file", () => {
  beforeEach(() => {
    serveManifest(mock, manifest, KEY);
    storeKey(home, mock.origin, KEY);
    mock.on("POST", /^\/v1\/widgets\/[^/]+\/paint$/, (req) => ({ body: { id: req.path.split("/")[3], color: req.json().color } }));
    mock.on("POST", "/v1/fits", (req) => ({ body: req.json() }));
  });

  it("takes a positional from the file by its name", async () => {
    writeFileSync(join(cwd, "in.yaml"), "widget: w7\ncolor: red\n");
    const run = await rlx(["widgets", "paint", "--input", "in.yaml"]);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("Painted w7.\n");
  });

  it("lets the command line win over the file", async () => {
    writeFileSync(join(cwd, "in.yaml"), "widget: w7\n");
    const run = await rlx(["widgets", "paint", "w1", "--input", "in.yaml"]);
    expect(run.stdout).toBe("Painted w1.\n");
  });

  it("reads a JSON file, a snake_case key, a number, and a list", async () => {
    writeFileSync(join(cwd, "in.json"), JSON.stringify({ spare_part: "p2", slot: 3, extra: ["a", "b"] }));
    const run = await rlx(["widgets", "fit", "--input", "in.json"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ part: "p2", slot: 3, extra: ["a", "b"] });
  });

  it("fills only the positionals that the command line leaves out", async () => {
    writeFileSync(join(cwd, "in.yaml"), "spare-part: p9\nslot: 4\nextra: z\n");
    const run = await rlx(["widgets", "fit", "p1", "--input", "in.yaml"]);
    expect(JSON.parse(run.stdout)).toEqual({ part: "p1", slot: 4, extra: ["z"] });
  });

  it("checks what is required after the merge", async () => {
    writeFileSync(join(cwd, "in.yaml"), "color: red\n");
    const run = await rlx(["widgets", "paint", "--input", "in.yaml"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("<widget> is required");
    expect(mock.count("POST", /paint/)).toBe(0);
  });

  it("checks the type of a value from the file", async () => {
    writeFileSync(join(cwd, "in.yaml"), "spare_part: p2\nslot: three\nextra: [a]\n");
    const run = await rlx(["widgets", "fit", "--input", "in.yaml"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("whole number");
  });

  it("refuses a value that is a mapping", async () => {
    writeFileSync(join(cwd, "in.yaml"), "widget:\n  id: w7\n");
    const run = await rlx(["widgets", "paint", "--input", "in.yaml"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("not one value");
  });

  it("leaves a file that is not a mapping to the check of what is required", async () => {
    for (const text of ["- a\n- b\n", "widget: [unclosed\n", ""]) {
      writeFileSync(join(cwd, "in.yaml"), text);
      const run = await rlx(["widgets", "paint", "--input", "in.yaml"]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("<widget> is required");
    }
  });

  it("does not read the file of an input option that is not a path", async () => {
    writeFileSync(join(cwd, "in.yaml"), "widget: w7\n");
    const run = await rlx(["widgets", "polish", "--input", "in.yaml"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("<widget> is required");
  });

  it("does not read a file in the folders of rlx", async () => {
    const run = await rlx(["widgets", "paint", "--input", join(home, ".config", "runlocal", "x.yaml")]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("FILE.REFUSED");
  });

  it("parses with fill: the command line wins, and requiredness is checked after", () => {
    expect(parseCommandArgs(paint, [], { fill: { widget: "w2" } })).toMatchObject({ widget: "w2" });
    expect(parseCommandArgs(paint, ["w1"], { fill: { widget: "w2" } })).toMatchObject({ widget: "w1" });
    expect(() => parseCommandArgs(paint, [], { fill: {} })).toThrow(/<widget> is required/);
    expect(() => parseCommandArgs(paint, [], { fill: { widget: ["a"] } })).toThrow(/not one value/);
    expect(() => parseCommandArgs(fit, ["p", "1"], { fill: { extra: [] } })).toThrow(/<extra> is required/);
  });
});

describe("--version", () => {
  beforeEach(() => {
    serveManifest(mock, manifest, KEY);
    storeKey(home, mock.origin, KEY);
  });

  it("is global only before the command name", () => {
    expect(parseGlobals(["--version"]).flags.version).toBe(true);
    expect(parseGlobals(["-V"]).flags.version).toBe(true);
    expect(parseGlobals(["--api", "https://a.example", "--version"]).flags.version).toBe(true);
    const after = parseGlobals(["widgets", "list", "--version"]);
    expect(after.flags.version).toBe(false);
    expect(after.rest).toEqual(["widgets", "list", "--version"]);
    expect(parseGlobals(["widgets", "-V"]).rest).toEqual(["widgets", "-V"]);
  });

  it("prints the version alone", async () => {
    const run = await rlx(["--version"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`${RLX_VERSION}\n`);
  });

  it("is an unknown option after a command name, with a hint", async () => {
    for (const flag of ["--version", "-V"]) {
      const run = await rlx(["widgets", "list", flag]);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain(`Unknown option ${flag}.`);
      expect(run.stderr).toContain("rlx --version prints the version of rlx");
      expect(run.stderr).toContain("rlx widgets list --help");
    }
    expect(mock.count("GET", "/v1/widgets")).toBe(0);
  });

  it("is refused after login, logout, and help", async () => {
    for (const command of ["login", "logout", "help"]) {
      const run = await rlx([command, "--version"]);
      expect(run.code).toBe(1);
      expect(run.stderr).toContain("rlx --version prints the version of rlx");
    }
  });
});

describe("--quiet", () => {
  it("hides a warning, and keeps the result and the error", async () => {
    serveManifest(mock, manifest, KEY);
    storeKey(home, mock.origin, KEY);
    const loud = await rlx(["logout"], { [TEST_KEY_ENV]: KEY });
    expect(loud.stderr).toContain(`${TEST_KEY_ENV} is set`);
    const quiet = await rlx(["logout", "-q"], { [TEST_KEY_ENV]: KEY });
    expect(quiet.code).toBe(0);
    expect(quiet.stderr).toBe("");

    storeKey(home, mock.origin, KEY, Date.now() - 1000);
    const expired = await rlx(["help", "--quiet"]);
    expect(expired.stdout).toContain("Sign in to see your commands.");
    expect(expired.stderr).toBe("");

    const error = await rlx(["widgets", "list", "--quiet"]);
    expect(error.code).toBe(2);
    expect(error.stderr).toContain("rlx login");
  });
});

describe("a refused key", () => {
  const BAD = `tok_${"0f1e".repeat(16)}`;

  beforeEach(() => {
    serveManifest(mock, manifest, KEY);
  });

  it("names the environment variable, and never prints the key", async () => {
    const run = await rlx(["widgets", "list"], { [TEST_KEY_ENV]: BAD });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`The API refused the key from ${TEST_KEY_ENV}: it is invalid or revoked.`);
    expect(run.stderr).toContain(`Set ${TEST_KEY_ENV} to a valid API key`);
    expect(run.stderr).toContain("https://workspace.example");
    expect(run.stderr).not.toContain(BAD);
    expect(run.stderr).not.toContain(BAD.slice(12));
  });

  it("gives the source and the code in JSON", async () => {
    const run = await rlx(["widgets", "list", "--json"], { [TEST_KEY_ENV]: BAD });
    const doc = JSON.parse(run.stdout);
    expect(doc.error).toMatchObject({ code: "AUTH.REQUIRED", status: 401, exit_code: 2 });
    expect(doc.error.message).toContain(TEST_KEY_ENV);
    expect(doc.error.hint).toContain("rlx login");
  });

  it("names the key file, and removes the stored key", async () => {
    storeKey(home, mock.origin, BAD);
    const run = await rlx(["widgets", "list"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`The API refused the stored key in ${join(home, ".rlx-test", "keys.json")}: it is invalid or revoked`);
    expect(run.stderr).toContain("Run: rlx login");
    expect(run.stderr).not.toContain(BAD);
    expect(JSON.parse(readFileSync(join(home, ".rlx-test", "keys.json"), "utf8")).keys[mock.origin]).toBeUndefined();
  });

  it("says it in the help too", async () => {
    const general = await rlx(["help"], { [TEST_KEY_ENV]: BAD });
    expect(general.code).toBe(0);
    // The help itself names the key, in place of the sign-in line (test/polish.test.ts).
    expect(general.stdout).toContain(`The API refused the key from ${TEST_KEY_ENV}`);
    const one = await rlx(["help", "widgets", "list"], { [TEST_KEY_ENV]: BAD });
    expect(one.code).toBe(2);
    expect(one.stderr).toContain(`The API refused the key from ${TEST_KEY_ENV}`);
  });

  it("keeps the error of a request that auth status does not confirm", async () => {
    storeKey(home, mock.origin, KEY);
    mock.on("GET", "/v1/widgets", () => ({ status: 401, body: { error: { code: "WIDGETS.LOCKED", message: "Locked." } } }));
    const run = await rlx(["widgets", "list"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("Error WIDGETS.LOCKED: Locked.");
    expect(JSON.parse(readFileSync(join(home, ".rlx-test", "keys.json"), "utf8")).keys[mock.origin]).toBeDefined();
  });
});
