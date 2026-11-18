// SPDX-License-Identifier: Apache-2.0
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY, runCli, storeKey, tempDir } from "./helpers/cli.js";
import { type MockServer, serveManifest, startMock, TEST_KEY_ENV } from "./helpers/mock.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));

let mock: MockServer;
let home: string;

beforeEach(async () => {
  mock = await startMock();
  serveManifest(mock, fixture, KEY);
  home = tempDir();
});

afterEach(async () => {
  await mock.close();
});

const rlx = (argv: string[], options: { env?: Record<string, string>; now?: () => number } = {}) =>
  runCli(["--api", mock.origin, ...argv], { home, ...options });

describe("help before the sign-in", () => {
  it("shows only login, logout, and help", async () => {
    const run = await rlx(["help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("login");
    expect(run.stdout).toContain("logout");
    expect(run.stdout).toContain("Sign in to see your commands.");
    expect(run.stdout).not.toContain("widgets");
    expect(mock.count("GET", "/api/v1/cli/manifest")).toBe(0);
  });

  it("is the same with no command", async () => {
    const run = await rlx([]);
    expect(run.stdout).toContain("Sign in to see your commands.");
  });

  it("gives JSON with --json", async () => {
    const run = await rlx(["help", "--json"]);
    const doc = JSON.parse(run.stdout);
    expect(doc.signed_in).toBe(false);
    expect(doc.commands.map((c: { name: string[] }) => c.name.join(" "))).toEqual(["login", "logout", "help"]);
  });

  it("any other command exits 2", async () => {
    const run = await rlx(["widgets", "list"]);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("rlx login");
  });

  it("an expired key counts as not signed in", async () => {
    storeKey(home, mock.origin, KEY, Date.now() - 1000);
    const run = await rlx(["help"]);
    expect(run.stdout).toContain("Sign in to see your commands.");
    expect(run.stderr).toContain("expired");
  });
});

describe("help after the sign-in", () => {
  it("shows the commands of the manifest", async () => {
    storeKey(home, mock.origin, KEY);
    const run = await rlx(["help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toMatch(/widgets list +List the widgets\./);
    expect(run.stdout).toContain("gadgets upload");
    expect(run.stdout).not.toContain("Sign in to see your commands.");
  });

  it("takes the key from the environment variable that client-config names", async () => {
    const run = await rlx(["help"], { env: { [TEST_KEY_ENV]: KEY } });
    expect(run.stdout).toContain("widgets list");
  });

  it("shows one command", async () => {
    storeKey(home, mock.origin, KEY);
    const run = await rlx(["help", "widgets", "sync"]);
    expect(run.stdout).toContain("Usage: rlx widgets sync --file <path>");
  });

  it("warns when the key expires soon", async () => {
    storeKey(home, mock.origin, KEY, Date.now() + 2 * 86_400_000);
    const run = await rlx(["help"]);
    expect(run.stderr).toContain("Run rlx login to replace it.");
  });
});

describe("the manifest cache", () => {
  const cacheFiles = () => readdirSync(join(home, ".config", "runlocal")).filter((n) => n.startsWith("manifest-"));

  beforeEach(() => storeKey(home, mock.origin, KEY));

  it("keeps the manifest for a day, in a file only the owner reads", async () => {
    await rlx(["help"]);
    await rlx(["help"]);
    expect(mock.count("GET", "/api/v1/cli/manifest")).toBe(1);
    const [file] = cacheFiles();
    expect(statSync(join(home, ".config", "runlocal", file!)).mode & 0o777).toBe(0o600);
    expect(readFileSync(join(home, ".config", "runlocal", file!), "utf8")).not.toContain(KEY);
  });

  it("checks an old manifest with its ETag", async () => {
    let conditional: string | undefined;
    mock.on("GET", "/api/v1/cli/manifest", (req) => {
      conditional = req.headers["if-none-match"] as string | undefined;
      return conditional === '"v1"' ? { status: 304 } : { body: fixture, headers: { etag: '"v1"' } };
    });
    await rlx(["help"]);
    const later = Date.now() + 25 * 3600_000;
    const run = await rlx(["help"], { now: () => later });
    expect(conditional).toBe('"v1"');
    expect(run.stdout).toContain("widgets list");
    expect(mock.count("GET", "/api/v1/cli/manifest")).toBe(2);
  });

  it("reads the manifest again when the server states a new version", async () => {
    mock.on("GET", "/v1/notes", () => ({ body: { text: "hi" }, headers: { "x-manifest-version": "test.2" } }));
    await rlx(["notes"]);
    expect(cacheFiles()).toEqual([]);
    await rlx(["help"]);
    expect(mock.count("GET", "/api/v1/cli/manifest")).toBe(2);
  });

  it("reads the manifest again for a command that the cache does not have", async () => {
    await rlx(["help"]);
    const newer = { ...fixture, version: "test.3", commands: [...fixture.commands, { name: ["fresh"], summary: "New.", steps: [], output: { kind: "markdown", text: "fresh" } }] };
    serveManifest(mock, newer, KEY);
    const run = await rlx(["fresh"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("fresh\n");
  });

  it("keeps one cache for each credential", async () => {
    await rlx(["help"]);
    const other = `tok_${"cd34".repeat(16)}`;
    serveManifest(mock, fixture, other);
    await rlx(["help"], { env: { [TEST_KEY_ENV]: other } });
    expect(cacheFiles()).toHaveLength(2);
  });
});
