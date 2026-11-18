// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY, runCli, storeKey, tempDir } from "./helpers/cli.js";
import { type MockServer, serveManifest, startMock } from "./helpers/mock.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));
const PART = 64 * 1024;

let mock: MockServer;
let home: string;
let cwd: string;
let content: Buffer;
let stored: Map<number, Buffer>;
let failPart: number | undefined;

function sha256(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

/** A mock store for a file in parts: begin, part addresses, PUT of each part, and finish with the SHA-256. */
function serveParts(begin: Record<string, unknown> = {}): void {
  mock.on("POST", "/v1/gadgets/g1/blobs", (req) => {
    const body = req.json();
    expect(body).toEqual({ name: "model.bin", bytes: content.length, sha256: sha256(content) });
    stored = new Map();
    return { body: { blob: "b1", state: "pending", part_bytes: PART, part_count: Math.ceil(content.length / PART), ...begin } };
  });
  mock.on("POST", "/v1/blobs/b1/parts", (req) => {
    const { numbers } = req.json() as { numbers: number[] };
    expect(numbers.length).toBeLessThanOrEqual(2);
    return { body: { parts: numbers.map((n) => ({ n, put_url: `${mock.origin}/store/b1/${n}?signature=s${n}` })) } };
  });
  mock.on("PUT", /^\/store\/b1\/\d+$/, (req) => {
    // A signed address gets no credential.
    expect(req.headers.authorization).toBeUndefined();
    const n = Number(req.path.split("/").pop());
    if (n === failPart) return { status: 500, body: "store down" };
    expect(Number(req.headers["content-length"])).toBe(req.body.length);
    stored.set(n, req.body);
    return { headers: { etag: `"e${n}"` } };
  });
  mock.on("POST", "/v1/blobs/b1/finish", (req) => {
    const joined = Buffer.concat([...stored.entries()].sort((a, b) => a[0] - b[0]).map(([, part]) => part));
    const body = req.json();
    if (sha256(joined) !== body.sha256) {
      return { status: 409, body: { error: { code: "BLOB.MISMATCH", message: "The bytes do not match." } } };
    }
    return { body: { blob: "b1", state: "held", bytes: joined.length, etags: body.etags } };
  });
}

beforeEach(async () => {
  mock = await startMock();
  serveManifest(mock, fixture, KEY);
  home = tempDir();
  cwd = tempDir("rlx-project-");
  storeKey(home, mock.origin, KEY);
  content = randomBytes(PART * 4 + 1234);
  writeFileSync(join(cwd, "model.bin"), content);
  stored = new Map();
  failPart = undefined;
});

afterEach(async () => {
  await mock.close();
});

const upload = () => runCli(["--api", mock.origin, "gadgets", "upload", "model.bin", "--gadget", "g1", "--json"], { home, cwd });

describe("upload", () => {
  it("uploads in parts, with the SHA-256 of the whole file", async () => {
    serveParts();
    const run = await upload();
    expect(run.stderr).not.toContain("Error");
    expect(run.code).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result).toMatchObject({ state: "held", bytes: content.length });
    expect(result.etags).toEqual([1, 2, 3, 4, 5].map((n) => ({ number: n, etag: `"e${n}"` })));
    expect(mock.count("POST", "/v1/blobs/b1/parts")).toBe(3); // batches of 2, 2, 1
    expect(stored.get(5)!.length).toBe(1234);
  });

  it("resumes a stopped upload without beginning again", async () => {
    serveParts();
    failPart = 4;
    const first = await upload();
    expect(first.code).toBe(3);
    expect(first.stdout).toContain("UPLOAD.PART");
    expect(stored.size).toBe(3);
    expect(readdirSync(join(home, ".config", "runlocal", "uploads")).length).toBe(1);

    failPart = undefined;
    const before = mock.requests.length;
    const second = await upload();
    expect(second.code).toBe(0);
    expect(second.stderr).toContain("Resuming the upload of model.bin: 3 of 5 parts are there.");
    const later = mock.requests.slice(before);
    expect(later.filter((r) => r.path === "/v1/gadgets/g1/blobs")).toHaveLength(0);
    const asked = later.filter((r) => r.path === "/v1/blobs/b1/parts").map((r) => r.json().numbers);
    expect(asked).toEqual([[4, 5]]);
    expect(later.filter((r) => r.method === "PUT").map((r) => r.path)).toEqual(["/store/b1/4", "/store/b1/5"]);
    expect(JSON.parse(second.stdout).state).toBe("held");
    expect(readdirSync(join(home, ".config", "runlocal", "uploads"))).toEqual([]);
  });

  it("begins again when the server no longer knows the stopped upload", async () => {
    serveParts();
    failPart = 2;
    expect((await upload()).code).toBe(3);
    failPart = undefined;
    mock.on("POST", "/v1/blobs/b1/parts", (req) => {
      // The first call after the resume fails; the next begin makes it work again.
      if (mock.count("POST", "/v1/gadgets/g1/blobs") === 1) {
        return { status: 409, body: { error: { code: "BLOB.GONE", message: "No upload." } } };
      }
      const { numbers } = req.json() as { numbers: number[] };
      return { body: { parts: numbers.map((n) => ({ n, put_url: `${mock.origin}/store/b1/${n}` })) } };
    });
    const run = await upload();
    expect(run.code).toBe(0);
    expect(run.stderr).toContain("Starting it again");
    expect(mock.count("POST", "/v1/gadgets/g1/blobs")).toBe(2);
  });

  it("finish refuses bytes that do not match the checksum", async () => {
    serveParts();
    mock.on("PUT", /^\/store\/b1\/\d+$/, (req) => {
      const n = Number(req.path.split("/").pop());
      stored.set(n, n === 2 ? Buffer.alloc(req.body.length) : req.body);
      return {};
    });
    const run = await upload();
    expect(run.code).toBe(1); // a 409 is a user error
    expect(run.stdout).toContain("BLOB.MISMATCH");
  });

  it("writes a small file with one PUT", async () => {
    content = randomBytes(1000);
    writeFileSync(join(cwd, "model.bin"), content);
    let received: Buffer | undefined;
    mock.on("POST", "/v1/gadgets/g1/blobs", () => ({ body: { blob: "b1", put_url: `${mock.origin}/store/one?signature=x` } }));
    mock.on("PUT", "/store/one", (req) => {
      expect(req.headers.authorization).toBeUndefined();
      received = req.body;
      return { headers: { etag: '"one"' } };
    });
    mock.on("POST", "/v1/blobs/b1/finish", (req) => ({ body: { ok: sha256(received!) === req.json().sha256 } }));
    const run = await upload();
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ ok: true });
  });

  it("writes nothing when the server holds the bytes already", async () => {
    mock.on("POST", "/v1/gadgets/g1/blobs", () => ({ body: { blob: "b1", state: "held" } }));
    const run = await upload();
    expect(run.code).toBe(0);
    expect(mock.requests.filter((r) => r.method === "PUT")).toHaveLength(0);
    expect(JSON.parse(run.stdout)).toEqual({ blob: "b1", state: "held" });
  });

  it("refuses an address that is plain http on another host", async () => {
    mock.on("POST", "/v1/gadgets/g1/blobs", () => ({ body: { blob: "b1", put_url: "http://store.example/x" } }));
    const run = await upload();
    expect(run.code).toBe(1);
    expect(run.stdout).toContain("ORIGIN.REFUSED");
  });

  it("reports a missing file", async () => {
    const run = await runCli(["--api", mock.origin, "gadgets", "upload", "nope.bin", "--gadget", "g1"], { home, cwd });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("No such file: nope.bin");
  });
});
