// SPDX-License-Identifier: Apache-2.0
// Tests of the second acceptance run: --quiet prints the result alone, a
// refused check exits with 1, the help names a key that the API refused,
// and login and logout name the public website, not the API origin. The
// commands are invented.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { main } from "../src/main.js";
import { validateManifest } from "../src/manifest/schema.js";
import { KEY, runCli, storeKey, tempDir, testIo } from "./helpers/cli.js";
import { type MockServer, serveManifest, startMock, TEST_KEY_ENV } from "./helpers/mock.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));

const manifest = validateManifest({
  ...fixture,
  version: "test.polish",
  commands: [
    ...fixture.commands,
    {
      name: ["kites", "fly"],
      summary: "Fly a kite.",
      args: [{ name: "kite", kind: "positional" }, { name: "check", kind: "flag" }],
      steps: [{ op: "http", method: "POST", path: "/v1/kites/{{args.kite}}/fly", body: { check: "{{args.check}}" }, as: "flown" }],
      output: { kind: "markdown", from: "flown.text", json: "flown", hint: "{{flown.notes}}\n\n{{flown.next_step}}" },
    },
  ],
});

const BAD = `tok_${"0f1e".repeat(16)}`;

let mock: MockServer;
let home: string;

beforeEach(async () => {
  mock = await startMock();
  home = tempDir();
});

afterEach(async () => {
  await mock.close();
});

const rlx = (argv: string[], env: Record<string, string> = {}) => runCli(["--api", mock.origin, ...argv], { home, env });

/** Writes the settings of rlx, as a sign-in that read the discovery file of the website would. */
function settings(value: Record<string, string>): void {
  const dir = join(home, ".config", "runlocal");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "settings.json"), JSON.stringify(value));
}

describe("--quiet", () => {
  beforeEach(() => {
    serveManifest(mock, manifest, KEY);
    storeKey(home, mock.origin, KEY);
    mock.on("POST", "/v1/kites/k1/fly", () => ({
      body: { text: "https://kites.example/k1", notes: "Flew kite k1.\n\nWarnings:\n! The wind is strong.", next_step: "Give the person the link." },
    }));
  });

  it("prints the result alone, and the notes and the next step only without it", async () => {
    const loud = await rlx(["kites", "fly", "k1"]);
    expect(loud.code).toBe(0);
    expect(loud.stdout).toBe("https://kites.example/k1\n");
    expect(loud.stderr).toBe("Flew kite k1.\n\nWarnings:\n! The wind is strong.\n\nGive the person the link.\n");
    for (const flag of ["-q", "--quiet"]) {
      const quiet = await rlx(["kites", "fly", "k1", flag]);
      expect(quiet.code).toBe(0);
      expect(quiet.stdout).toBe("https://kites.example/k1\n");
      expect(quiet.stderr).toBe("");
    }
  });

  it("prints a hint whose notes are empty as the next step alone", async () => {
    mock.on("POST", "/v1/kites/k2/fly", () => ({ body: { text: "https://kites.example/k2", notes: "", next_step: "Give the person the link." } }));
    const run = await rlx(["kites", "fly", "k2"]);
    expect(run.stderr).toBe("Give the person the link.\n");
  });
});

describe("a check that finds a fault", () => {
  beforeEach(() => {
    serveManifest(mock, manifest, KEY);
    storeKey(home, mock.origin, KEY);
    mock.on("POST", "/v1/kites/k3/fly", () => ({
      status: 422,
      body: { error: { code: "KITE.TANGLED", message: "The check found a fault: the line is tangled.\n\nNothing was changed.", hint: "Fix it, and check again." } },
    }));
  });

  it("exits with 1, prints the check and the hint on standard error, and keeps them under --quiet", async () => {
    for (const extra of [[], ["-q"]]) {
      const run = await rlx(["kites", "fly", "k3", "--check", ...extra]);
      expect(run.code).toBe(1);
      expect(run.stdout).toBe("");
      expect(run.stderr).toContain("Error KITE.TANGLED: The check found a fault: the line is tangled.\n\nNothing was changed.");
      expect(run.stderr).toContain("Fix it, and check again.");
    }
    const json = await rlx(["kites", "fly", "k3", "--check", "--json"]);
    expect(json.code).toBe(1);
    expect(JSON.parse(json.stdout).error).toMatchObject({ code: "KITE.TANGLED", status: 422, exit_code: 1, hint: "Fix it, and check again." });
  });
});

describe("the help with a key that the API refuses", () => {
  beforeEach(() => {
    serveManifest(mock, manifest, KEY);
  });

  it("names the key variable in the help itself, in place of the sign-in line, and never prints the key", async () => {
    for (const extra of [[], ["-q"]]) {
      const run = await rlx(["help", ...extra], { [TEST_KEY_ENV]: BAD });
      expect(run.code).toBe(0);
      expect(run.stdout).toContain(`The API refused the key from ${TEST_KEY_ENV}: it is invalid or revoked.\nSet ${TEST_KEY_ENV} to a valid API key`);
      expect(run.stdout).not.toContain("Sign in to see your commands.");
      expect(run.stderr).toBe("");
      expect(run.stdout + run.stderr).not.toContain(BAD);
    }
    const json = JSON.parse((await rlx(["help", "--json"], { [TEST_KEY_ENV]: BAD })).stdout);
    expect(json).toMatchObject({ signed_in: false, key_refused: { source: "env" } });
    expect(json.hint).toContain(`The API refused the key from ${TEST_KEY_ENV}`);
  });

  it("names the key file of a stored key", async () => {
    storeKey(home, mock.origin, BAD);
    const run = await rlx(["help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`The API refused the stored key in ${join(home, ".rlx-test", "keys.json")}: it is invalid or revoked, so rlx removed it.\nRun: rlx login`);
    // Once it is removed, the help asks for a sign-in again.
    expect((await rlx(["help"])).stdout).toContain("Sign in to see your commands.");
  });

  it("names the key when auth status accepts it and the commands are refused", async () => {
    mock.on("GET", "/api/v1/cli/manifest", () => ({ status: 401, body: { error: { code: "AUTH.REQUIRED", message: "Use a valid key." } } }));
    const run = await rlx(["help"], { [TEST_KEY_ENV]: KEY });
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`The API refused the key from ${TEST_KEY_ENV} when rlx read your commands: Use a valid key.\nRun: rlx login`);
    const one = await rlx(["help", "widgets", "list"], { [TEST_KEY_ENV]: KEY });
    expect(one.code).toBe(2);
    expect(one.stderr).toContain(`The API refused the key from ${TEST_KEY_ENV}`);
  });

  it("keeps the sign-in line when no key is set", async () => {
    const run = await rlx(["help"]);
    expect(run.stdout).toContain("Sign in to see your commands.");
    expect(run.stdout).not.toContain("refused");
  });
});

describe("the name of the API origin for people", () => {
  beforeEach(() => {
    serveManifest(mock, manifest, KEY);
  });

  it("is the public website when the website names the origin", async () => {
    settings({ site_origin: mock.origin });
    const login = await rlx(["login"], { [TEST_KEY_ENV]: KEY });
    expect(login.code).toBe(0);
    expect(login.stderr).toContain(`Signed in with the key from ${TEST_KEY_ENV}, to RunLocal (https://www.runlocal.ai) as person@example.com.`);
    expect(login.stderr).not.toContain(mock.origin);
    storeKey(home, mock.origin, KEY);
    const logout = await rlx(["logout"]);
    expect(logout.stderr).toContain("of RunLocal (https://www.runlocal.ai) from");
    expect(logout.stderr).not.toContain(mock.origin);
    expect((await rlx(["logout"])).stderr).toContain("No key is stored for RunLocal (https://www.runlocal.ai).");
    // A program reads the API origin, to send its requests there.
    expect(JSON.parse((await rlx(["logout", "--json"])).stdout)).toMatchObject({ origin: mock.origin });
  });

  it("is the origin itself for any other API, such as one on this machine", async () => {
    settings({ site_origin: "https://api.other.example" });
    const login = await rlx(["login"], { [TEST_KEY_ENV]: KEY });
    expect(login.stderr).toContain(`to ${mock.origin} as person@example.com.`);
    const logout = await rlx(["logout"]);
    expect(logout.stderr).toContain(`No key is stored for ${mock.origin}.`);
  });

  it("names the website after rlx reads its discovery file, and sends the requests to the API origin", async () => {
    const out = { stdout: [] as string[], stderr: [] as string[], prompts: [] as string[] };
    const io = testIo({ home, env: { [TEST_KEY_ENV]: KEY } }, out);
    const asked: string[] = [];
    io.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      asked.push(url.origin);
      if (url.origin === "https://www.runlocal.ai" && url.pathname === "/.well-known/runlocal.json") {
        return new Response(JSON.stringify({ discovery: `${mock.origin}/` }), { headers: { "content-type": "application/json" } });
      }
      return globalThis.fetch(input, init);
    }) as typeof fetch;
    const code = await main(["login"], io);
    expect(code).toBe(0);
    expect(out.stderr.join("")).toContain("to RunLocal (https://www.runlocal.ai) as person@example.com.");
    expect(out.stderr.join("")).not.toContain(mock.origin);
    expect(asked.filter((origin) => origin === "https://www.runlocal.ai")).toHaveLength(1);
    expect(mock.count("GET", "/api/v1/auth/status")).toBe(1);
    expect(JSON.parse(readFileSync(join(home, ".config", "runlocal", "settings.json"), "utf8"))).toEqual({ origin: mock.origin, site_origin: mock.origin });
  });
});
