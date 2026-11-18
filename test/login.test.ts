// SPDX-License-Identifier: Apache-2.0
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseClientConfig } from "../src/auth/clientConfig.js";
import { Session } from "../src/auth/device.js";
import { KEY, runCli, storeKey, tempDir, testIo } from "./helpers/cli.js";
import { clientConfigBody, type MockServer, startMock, TEST_KEY_ENV } from "./helpers/mock.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));

const DEVICE_CODE = "device-code-never-shown-1234";
const USER_CODE = "WXYZ-1234";
const NEW_KEY = `tok_${"9f8e".repeat(16)}`;

function jwt(exp: number, n: number): string {
  const part = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part({ exp, n })}.signature${n}`;
}

let mock: MockServer;
let home: string;
let access: string;
let tokenCalls: number;

function serveSignIn(options: { tokenErrors?: string[] } = {}): void {
  const errors = [...(options.tokenErrors ?? ["authorization_pending", "slow_down"])];
  access = jwt(Math.floor(Date.now() / 1000) + 3600, 1);
  mock.on("POST", "/oauth/device", (req) => {
    expect(req.headers["content-type"]).toContain("application/x-www-form-urlencoded");
    expect(req.form().get("client_id")).toBe("client_test");
    return {
      body: {
        device_code: DEVICE_CODE,
        user_code: USER_CODE,
        verification_uri: "https://sign-in.example/device",
        verification_uri_complete: `https://sign-in.example/device?user_code=${USER_CODE}`,
        expires_in: 300,
        interval: 1,
      },
    };
  });
  mock.on("POST", "/oauth/token", (req) => {
    tokenCalls++;
    const form = req.form();
    expect(form.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
    expect(form.get("device_code")).toBe(DEVICE_CODE);
    const error = errors.shift();
    if (error) return { status: 400, body: { error, error_description: error } };
    return { body: { access_token: access, refresh_token: "refresh-one-abcdef" } };
  });
  const authorized = (h: string | undefined) => h === `Bearer ${access}` || h === `Bearer ${NEW_KEY}`;
  mock.on("GET", "/api/v1/auth/status", (req) =>
    authorized(req.headers.authorization)
      ? { body: { authenticated: true, credential_type: "session", email: "person@example.com" } }
      : { status: 401, body: { error: { code: "AUTH.REQUIRED", message: "Sign in." } } },
  );
  mock.on("GET", "/api/v1/cli/manifest", (req) =>
    authorized(req.headers.authorization) ? { body: fixture } : { status: 401, body: {} },
  );
  mock.on("POST", "/v1/keys", (req) => {
    expect(req.headers.authorization).toBe(`Bearer ${access}`);
    expect(req.json().name).toMatch(/^rlx on /);
    return { status: 201, body: { api_key: NEW_KEY, prefix: NEW_KEY.slice(0, 12), expires_at: Date.now() + 90 * 86_400_000 } };
  });
}

beforeEach(async () => {
  mock = await startMock();
  home = tempDir();
  tokenCalls = 0;
});

afterEach(async () => {
  await mock.close();
});

const rlx = (argv: string[], options: { interactive?: boolean; answers?: string[] } = {}) =>
  runCli(["--api", mock.origin, ...argv], { home, ...options });

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => join(d.parentPath, d.name));
}

describe("rlx login", () => {
  it("shows the address and the user code, never the device code, and stores a key", async () => {
    serveSignIn();
    const run = await rlx(["login"], { interactive: true, answers: [""] });
    expect(run.code).toBe(0);
    expect(tokenCalls).toBe(3);
    expect(run.stderr).toContain(`https://sign-in.example/device?user_code=${USER_CODE}`);
    expect(run.stderr).toContain(USER_CODE);
    expect(run.stderr).toContain("Signed in to");
    expect(run.stderr).toContain("person@example.com");
    expect(run.prompts[0]).toContain("~/.rlx-test/keys.json (access 0600)");
    const all = run.stdout + run.stderr;
    for (const secret of [DEVICE_CODE, access, "refresh-one-abcdef", NEW_KEY]) expect(all).not.toContain(secret);

    const dir = join(home, ".rlx-test");
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, "keys.json")).mode & 0o777).toBe(0o600);
    const doc = JSON.parse(readFileSync(join(dir, "keys.json"), "utf8"));
    expect(doc.version).toBe(1);
    expect(doc.keys[mock.origin]).toMatchObject({ api_key: NEW_KEY, prefix: NEW_KEY.slice(0, 12) });

    // No file holds a session token or a refresh token.
    for (const file of [...filesUnder(home)]) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toContain(access);
      expect(text).not.toContain("refresh-one-abcdef");
    }

    // The next run is signed in.
    const help = await rlx(["help"]);
    expect(help.stdout).toContain("widgets list");
  });

  it("--no-key keeps the session only", async () => {
    serveSignIn();
    const run = await rlx(["login", "--no-key"], { interactive: true });
    expect(run.code).toBe(0);
    expect(run.prompts).toEqual([]);
    expect(mock.count("POST", "/v1/keys")).toBe(0);
    expect(existsSync(join(home, ".rlx-test", "keys.json"))).toBe(false);
    expect(run.stderr).toContain("No key is stored");
  });

  it("stores no key when it cannot ask and has no --yes", async () => {
    serveSignIn();
    const run = await rlx(["login"], { interactive: false });
    expect(run.code).toBe(0);
    expect(mock.count("POST", "/v1/keys")).toBe(0);
  });

  it("--yes stores the key without a question", async () => {
    serveSignIn();
    const run = await rlx(["login", "--yes", "--json"]);
    expect(run.code).toBe(0);
    expect(run.prompts).toEqual([]);
    expect(JSON.parse(run.stdout)).toEqual({ signed_in: true, origin: mock.origin, email: "person@example.com", key_stored: true });
  });

  it("replaces an old key, keeps other origins, and says that the old key can be revoked", async () => {
    serveSignIn();
    const dir = join(home, ".rlx-test");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "keys.json"),
      JSON.stringify({
        version: 1,
        keys: {
          [mock.origin]: { api_key: KEY, prefix: "tok_old", expires_at: Date.now() + 86_400_000, name: "old" },
          "https://other.example": { api_key: "other-key-value", prefix: "x", expires_at: 1, name: "other" },
        },
      }),
    );
    const run = await rlx(["login", "--yes"]);
    expect(run.stderr).toContain("revoke it in the workspace at https://workspace.example");
    const doc = JSON.parse(readFileSync(join(dir, "keys.json"), "utf8"));
    expect(doc.keys[mock.origin].api_key).toBe(NEW_KEY);
    expect(doc.keys["https://other.example"].api_key).toBe("other-key-value");
  });

  it("stops with exit 4 when the person denies the sign-in", async () => {
    serveSignIn({ tokenErrors: ["authorization_pending", "access_denied"] });
    const run = await rlx(["login"]);
    expect(run.code).toBe(4);
    expect(run.stderr).toContain("denied");
  });

  it("stops with exit 1 when the code expires", async () => {
    serveSignIn({ tokenErrors: ["expired_token"] });
    const run = await rlx(["login"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("expired");
  });

  it("shows the server's message when the account has no access", async () => {
    serveSignIn();
    mock.on("GET", "/api/v1/auth/status", () => ({ status: 403, body: { error: { code: "AUTH.NOT_INVITED", message: "Ask for access." } } }));
    const run = await rlx(["login"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Error AUTH.NOT_INVITED: Ask for access.");
  });
});

describe("rlx login with the key variable set", () => {
  const ENV_KEY = `tok_${"5c4d".repeat(16)}`;
  const withKey = (argv: string[], key = ENV_KEY) => runCli(["--api", mock.origin, ...argv], { home, env: { [TEST_KEY_ENV]: key } });

  beforeEach(() => {
    serveSignIn();
    mock.on("GET", "/api/v1/auth/status", (req) =>
      req.headers.authorization === `Bearer ${ENV_KEY}`
        ? { body: { authenticated: true, credential_type: "api_key", email: null } }
        : { status: 401, body: { error: { code: "AUTH.REQUIRED", message: "Use a valid key." } } },
    );
  });

  it("checks the key with auth status, and neither starts the device flow nor stores the key", async () => {
    const run = await withKey(["login"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(`Signed in with the key from ${TEST_KEY_ENV}`);
    expect(run.stderr).toContain(`did not store the key in ~/.rlx-test/keys.json`);
    expect(run.stderr).not.toContain(ENV_KEY);
    expect(mock.count("POST", "/oauth/device")).toBe(0);
    expect(mock.count("POST", "/v1/keys")).toBe(0);
    expect(mock.count("GET", "/api/v1/auth/status")).toBe(1);
    expect(existsSync(join(home, ".rlx-test", "keys.json"))).toBe(false);
  });

  it("does not store the key with --yes either, and says so in JSON", async () => {
    const run = await withKey(["login", "--yes", "--json"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ signed_in: true, origin: mock.origin, email: null, key_stored: false, key_source: "env" });
    expect(existsSync(join(home, ".rlx-test", "keys.json"))).toBe(false);
  });

  it("says that the key from the variable is invalid or revoked, without the key", async () => {
    const bad = `tok_${"7a6b".repeat(16)}`;
    const run = await withKey(["login"], bad);
    expect(run.code).toBe(2);
    expect(run.stderr).toContain(`The API refused the key from ${TEST_KEY_ENV}: it is invalid or revoked.`);
    expect(run.stderr).not.toContain(bad);
    expect(mock.count("POST", "/oauth/device")).toBe(0);
  });
});

describe("rlx login with no terminal", () => {
  it("prints the address and the code, and stops waiting with a clear message", async () => {
    serveSignIn({ tokenErrors: Array(10_000).fill("authorization_pending") });
    mock.on("POST", "/oauth/device", () => ({
      body: { device_code: DEVICE_CODE, user_code: USER_CODE, verification_uri: "https://sign-in.example/device", expires_in: 86_400, interval: 5 },
    }));
    let clock = Date.now();
    const run = await runCli(["--api", mock.origin, "login", "--quiet"], {
      home,
      interactive: false,
      now: () => clock,
      sleep: async (ms) => void (clock += ms),
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("https://sign-in.example/device");
    expect(run.stderr).toContain(USER_CODE);
    expect(run.stderr).toContain("at most 10 minutes");
    expect(run.stderr).toContain("Error SIGN_IN.TIMEOUT: No one approved the sign-in within 10 minutes");
    expect(run.stderr).toContain(`set ${TEST_KEY_ENV} to an API key`);
    expect(tokenCalls).toBeLessThanOrEqual(120);
  });
});

describe("the session", () => {
  it("refreshes before expiry, and replaces both tokens each time", async () => {
    const seen: string[] = [];
    let n = 1;
    mock.on("POST", "/oauth/token", (req) => {
      const form = req.form();
      expect(form.get("grant_type")).toBe("refresh_token");
      seen.push(form.get("refresh_token")!);
      n++;
      return { body: { access_token: `access-${n}-abcdefgh`, refresh_token: `refresh-${n}-abcdefgh`, expires_in: 30 } };
    });
    const io = testIo({ home }, { stdout: [], stderr: [], prompts: [] });
    const config = parseClientConfig(clientConfigBody(mock.origin));
    const session = new Session(io, config, { access_token: "access-1-abcdefgh", refresh_token: "refresh-1-abcdefgh", expires_in: 30 });
    expect(await session.token()).toBe("access-2-abcdefgh");
    expect(await session.token()).toBe("access-3-abcdefgh");
    expect(seen).toEqual(["refresh-1-abcdefgh", "refresh-2-abcdefgh"]);
  });

  it("keeps a token that is far from expiry", async () => {
    const io = testIo({ home }, { stdout: [], stderr: [], prompts: [] });
    const config = parseClientConfig(clientConfigBody(mock.origin));
    const session = new Session(io, config, { access_token: jwt(Math.floor(Date.now() / 1000) + 3600, 7), refresh_token: "r" });
    expect(await session.token()).toBe(jwt(Math.floor(Date.now() / 1000) + 3600, 7));
    expect(mock.count("POST", "/oauth/token")).toBe(0);
  });
});

describe("rlx logout", () => {
  it("removes the key of the origin only, and does not revoke it", async () => {
    storeKey(home, mock.origin, KEY);
    const file = join(home, ".rlx-test", "keys.json");
    const doc = JSON.parse(readFileSync(file, "utf8"));
    doc.keys["https://other.example"] = { api_key: "other-key-value", prefix: "x", expires_at: 1, name: "o" };
    writeFileSync(file, JSON.stringify(doc));
    const run = await rlx(["logout"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("did not revoke it");
    expect(run.stderr).toContain("https://workspace.example");
    const after = JSON.parse(readFileSync(file, "utf8"));
    expect(after.keys[mock.origin]).toBeUndefined();
    expect(after.keys["https://other.example"]).toBeDefined();
    expect(mock.requests.filter((r) => r.method !== "GET")).toEqual([]);
    const help = await rlx(["help"]);
    expect(help.stdout).toContain("Sign in to see your commands.");
  });

  it("says when no key is stored", async () => {
    const run = await rlx(["logout"]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("No key is stored");
  });
});
