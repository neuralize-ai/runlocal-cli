// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Api, pinnedUrl } from "../src/api.js";
import { normalizeOrigin } from "../src/origin.js";
import { Out } from "../src/util/io.js";
import { KEY, runCli, storeKey, tempDir, testIo } from "./helpers/cli.js";
import { type MockServer, serveManifest, startMock } from "./helpers/mock.js";

describe("origins", () => {
  it("accepts https, and plain http only on this machine", () => {
    expect(normalizeOrigin("https://api.example.com")).toBe("https://api.example.com");
    expect(normalizeOrigin("https://api.example.com/")).toBe("https://api.example.com");
    expect(normalizeOrigin("http://127.0.0.1:3000")).toBe("http://127.0.0.1:3000");
    expect(() => normalizeOrigin("http://api.example.com")).toThrow(/https/);
    expect(() => normalizeOrigin("https://api.example.com/v1")).toThrow(/no path/);
    expect(() => normalizeOrigin("https://user:pw@api.example.com")).toThrow(/password/);
    expect(() => normalizeOrigin("ftp://api.example.com")).toThrow(/https/);
  });

  it("pins each path to the signed-in origin", () => {
    const origin = "https://api.example.com";
    expect(pinnedUrl(origin, "/v1/widgets").href).toBe("https://api.example.com/v1/widgets");
    for (const path of ["https://other.example/v1", "//other.example/v1", "v1/widgets", "/\\other.example", ""]) {
      expect(() => pinnedUrl(origin, path)).toThrow(/Refused/);
    }
  });
});

describe("request headers", () => {
  it("a header of the manifest replaces a default of the same name in any case", async () => {
    let sent: Headers | undefined;
    const io = testIo({ home: tempDir() }, { stdout: [], stderr: [], prompts: [] });
    io.fetch = (async (_url: unknown, init: RequestInit) => {
      sent = new Headers(init.headers);
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;
    const flags = { json: false, yes: false, quiet: true, debug: false, help: false, version: false, api: undefined };
    const api = new Api(io, new Out(io, flags), "https://api.example.com", async () => KEY);
    await api.request({ method: "POST", path: "/v1/widgets", headers: { "content-type": "text/plain", accept: "text/csv" }, body: "a,b" });
    expect(sent!.get("content-type")).toBe("text/plain");
    expect(sent!.get("accept")).toBe("text/csv");
    await api.request({ method: "POST", path: "/v1/widgets", body: { a: 1 } });
    expect(sent!.get("content-type")).toBe("application/json");
    expect(sent!.get("accept")).toBe("application/json");
  });
});

describe("requests go only to the signed-in origin", () => {
  let mock: MockServer;
  let home: string;

  beforeEach(async () => {
    mock = await startMock();
    home = tempDir();
    storeKey(home, mock.origin, KEY);
  });

  afterEach(async () => {
    await mock.close();
  });

  it("never sends the credential to another origin", async () => {
    const io = testIo({ home }, { stdout: [], stderr: [], prompts: [] });
    let calls = 0;
    io.fetch = (async (...args: Parameters<typeof fetch>) => {
      calls++;
      return globalThis.fetch(...args);
    }) as typeof fetch;
    const api = new Api(io, new Out(io, { json: false, yes: false, quiet: true, debug: false, help: false, version: false, api: undefined }), mock.origin, async () => KEY);
    await expect(api.request({ method: "GET", path: "https://evil.example/steal" })).rejects.toThrow(/Refused/);
    await expect(api.request({ method: "GET", path: "//evil.example/steal" })).rejects.toThrow(/Refused/);
    expect(calls).toBe(0);
  });

  it("does not follow a redirect to another origin", async () => {
    const manifest = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));
    serveManifest(mock, manifest, KEY);
    mock.on("GET", "/v1/notes", () => ({ status: 302, headers: { location: "https://evil.example/steal" } }));
    const run = await runCli(["--api", mock.origin, "notes"], { home });
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("ORIGIN.REFUSED");
  });

  it("does not let a manifest set the Authorization header", async () => {
    const manifest = {
      schema: "runlocal.cli-manifest/1",
      version: "1",
      commands: [{ name: ["x"], summary: "x", steps: [{ op: "http", method: "GET", path: "/v1/x", headers: { authorization: "Bearer other" } }] }],
    };
    serveManifest(mock, manifest, KEY);
    const run = await runCli(["--api", mock.origin, "x"], { home });
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("MANIFEST.INVALID");
  });
});
