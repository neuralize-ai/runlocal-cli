// SPDX-License-Identifier: Apache-2.0
import { existsSync, readFileSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KEY, runCli, storeKey, tempDir } from "./helpers/cli.js";
import { type MockServer, serveManifest, startMock } from "./helpers/mock.js";

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

const rlx = (argv: string[], options: { interactive?: boolean; answers?: string[] } = {}) =>
  runCli(["--api", mock.origin, ...argv], { home, cwd, ...options });

describe("http", () => {
  it("sends the query, the credential, and prints a table", async () => {
    mock.on("GET", "/v1/widgets", (req) => {
      expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(req.query.get("color")).toBe("red");
      expect(req.query.has("limit")).toBe(false);
      return { body: { items: [{ id: "w1", name: "Alpha", owner: { name: "Ann" } }] } };
    });
    const run = await rlx(["widgets", "list", "--color", "red"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("ID  Name   Owner\nw1  Alpha  Ann\n");
  });

  it("prints JSON with --json", async () => {
    mock.on("GET", "/v1/widgets/w%201", () => ({ body: { id: "w 1", name: "Spaced" } }));
    const run = await rlx(["widgets", "show", "w 1", "--json"]);
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ id: "w 1", name: "Spaced" });
  });

  it("shows the server's error code and message, with exit 1 for a 4xx", async () => {
    mock.on("GET", "/v1/widgets/nope", () => ({ status: 404, body: { error: { code: "WIDGET.MISSING", message: "No such widget." } } }));
    const run = await rlx(["widgets", "show", "nope"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Error WIDGET.MISSING: No such widget.");
  });

  it("exits 3 for a server error, and gives the error as JSON with --json", async () => {
    mock.on("GET", "/v1/widgets/boom", () => ({ status: 503, body: { error: { code: "SERVICE.DOWN", message: "Try later." } } }));
    const run = await rlx(["widgets", "show", "boom", "--json"]);
    expect(run.code).toBe(3);
    expect(JSON.parse(run.stdout)).toEqual({ error: { code: "SERVICE.DOWN", message: "Try later.", status: 503, exit_code: 3 } });
  });

  it("prints the call id and the hint of the server after the error", async () => {
    mock.on("GET", "/v1/widgets/odd", () => ({
      status: 409,
      headers: { "x-call-id": "call_from_header" },
      body: { error: { code: "WIDGET.ODD", message: "The widget is odd.", call_id: "call_0123456789abcdef0123", hint: "Ask the widget desk." } },
    }));
    const run = await rlx(["widgets", "show", "odd"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toBe("Error WIDGET.ODD: The widget is odd.\nCall id: call_0123456789abcdef0123\nAsk the widget desk.\n");
    const json = await rlx(["widgets", "show", "odd", "--json"]);
    expect(JSON.parse(json.stdout)).toEqual({
      error: { code: "WIDGET.ODD", message: "The widget is odd.", status: 409, exit_code: 1, call_id: "call_0123456789abcdef0123", hint: "Ask the widget desk." },
    });
  });

  it("takes the call id from the header when the body has none, and drops a value with a control character", async () => {
    mock.on("GET", "/v1/widgets/plain", () => ({ status: 500, headers: { "x-call-id": "call_from_header" }, body: { error: { code: "X", message: "Down.", hint: "bad\u001b[31m" } } }));
    const run = await rlx(["widgets", "show", "plain"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toBe("Error X: Down.\nCall id: call_from_header\n");
  });

  it("exits 2 when the key is refused, and removes the stored key", async () => {
    mock.on("GET", "/v1/widgets/x", () => ({ status: 401, body: { error: { code: "AUTH.REQUIRED", message: "Sign in." } } }));
    mock.on("GET", "/api/v1/auth/status", () => ({ status: 401, body: { error: { code: "AUTH.REQUIRED", message: "Sign in." } } }));
    const run = await rlx(["widgets", "show", "x"]);
    expect(run.code).toBe(2);
    const keys = JSON.parse(readFileSync(join(home, ".rlx-test", "keys.json"), "utf8"));
    expect(keys.keys[mock.origin]).toBeUndefined();
  });

  it("refuses a dot segment in a path value", async () => {
    const run = await rlx(["widgets", "show", ".."]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("PATH.INVALID");
  });

  it("exits 1 with a clear message for an unknown command", async () => {
    const run = await rlx(["gizmos", "spin"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("Unknown command: gizmos spin");
  });

  it("shows the help of a command with --help", async () => {
    const run = await rlx(["widgets", "create", "--help"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toContain("Usage: rlx widgets create --name <value>");
  });
});

describe("confirm", () => {
  it("asks, and sends when the answer is yes", async () => {
    mock.on("POST", "/v1/widgets", (req) => ({ status: 201, body: { id: "w9", ...req.json() } }));
    const run = await rlx(["widgets", "create", "--name", "Nine", "--tag", "t1"], { interactive: true, answers: ["y"] });
    expect(run.prompts).toEqual(["Make the widget Nine? [y/N] "]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("Made **Nine** (w9).\n");
    const sent = mock.requests.find((r) => r.method === "POST")!.json();
    expect(sent).toEqual({ name: "Nine", tags: ["t1"], preview: false });
  });

  it("stops with exit 4 when the answer is no", async () => {
    const run = await rlx(["widgets", "create", "--name", "Nine"], { interactive: true, answers: ["n"] });
    expect(run.code).toBe(4);
    expect(mock.count("POST", "/v1/widgets")).toBe(0);
  });

  it("does not ask with --yes", async () => {
    mock.on("POST", "/v1/widgets", () => ({ body: { id: "w9", name: "Nine" } }));
    const run = await rlx(["widgets", "create", "--name", "Nine", "--yes"], { interactive: true });
    expect(run.prompts).toEqual([]);
    expect(run.code).toBe(0);
  });

  it("refuses to go on without a person and without --yes", async () => {
    const run = await rlx(["widgets", "create", "--name", "Nine"], { interactive: false });
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("--yes");
    expect(mock.count("POST", "/v1/widgets")).toBe(0);
  });
});

describe("read and each", () => {
  it("reads YAML and runs the steps for each item", async () => {
    writeFileSync(join(cwd, "widgets.yaml"), "widgets:\n  - id: a\n    name: Alpha\n  - id: b\n    name: Beta\n");
    mock.on("PUT", /^\/v1\/widgets\/[ab]$/, (req) => ({ body: { id: req.path.split("/").pop(), ...req.json() } }));
    const run = await rlx(["widgets", "sync", "-f", "widgets.yaml"]);
    expect(run.code).toBe(0);
    expect(run.stdout).toBe("ID  Name   Position\na   Alpha  0\nb   Beta   1\n");
  });

  it("reads JSON", async () => {
    writeFileSync(join(cwd, "widgets.json"), JSON.stringify({ widgets: [{ id: "a", name: "A" }] }));
    mock.on("PUT", "/v1/widgets/a", (req) => ({ body: { id: "a", ...req.json() } }));
    const run = await rlx(["widgets", "sync", "-f", "widgets.json", "--json"]);
    expect(JSON.parse(run.stdout)).toEqual([{ id: "a", name: "A", position: 0 }]);
  });

  it("reports a file that is not valid", async () => {
    writeFileSync(join(cwd, "bad.json"), "{ not json");
    const run = await rlx(["widgets", "sync", "-f", "bad.json"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("not valid JSON");
  });

  it("refuses to read the key file", async () => {
    const run = await rlx(["widgets", "sync", "-f", join(home, ".rlx-test", "keys.json")]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("FILE.REFUSED");
    expect(run.stdout + run.stderr).not.toContain(KEY);
  });
});

describe("state", () => {
  it("reads the cursor, sends it, and stores the next one in .runlocal", async () => {
    mock.on("GET", "/v1/feed", (req) => {
      const after = req.query.get("after");
      return after === "c1"
        ? { body: { events: [{ at: "t2", text: "Second" }], next: "c2" } }
        : { body: { events: [{ at: "t1", text: "First" }], next: "c1" } };
    });
    const first = await rlx(["feed"]);
    expect(first.stdout).toContain("First");
    expect(readFileSync(join(cwd, ".runlocal", "feed-cursor"), "utf8")).toBe("c1\n");
    const second = await rlx(["feed"]);
    expect(second.stdout).toContain("Second");
    expect(readFileSync(join(cwd, ".runlocal", "feed-cursor"), "utf8")).toBe("c2\n");
  });

  it("uses the project folder from a sub-folder", async () => {
    mock.on("GET", "/v1/feed", () => ({ body: { events: [], next: "c9" } }));
    const sub = join(cwd, "a", "b");
    mkdirSync(sub, { recursive: true });
    const run = await runCli(["--api", mock.origin, "feed"], { home, cwd: sub });
    expect(run.stdout).toBe("Nothing new.\n");
    expect(readFileSync(join(cwd, ".runlocal", "feed-cursor"), "utf8")).toBe("c9\n");
  });

  it("never writes a credential to the state file", async () => {
    mock.on("GET", "/v1/feed", () => ({ body: { events: [], next: KEY } }));
    const run = await rlx(["feed"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("STATE.REFUSED");
    expect(existsSync(join(cwd, ".runlocal", "feed-cursor"))).toBe(false);
  });
});

// Regressions that the fuzz tests found (test/fuzz.test.ts).
describe("file and state regressions", () => {
  it("refuses to read the key file through a symbolic link", async () => {
    symlinkSync(join(home, ".rlx-test", "keys.json"), join(cwd, "innocent.json"));
    const run = await rlx(["widgets", "sync", "-f", "innocent.json"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("FILE.REFUSED");
    expect(run.stdout + run.stderr).not.toContain(KEY);
  });

  it("refuses to read the config folder through a linked folder", async () => {
    mkdirSync(join(home, ".config", "runlocal"), { recursive: true });
    writeFileSync(join(home, ".config", "runlocal", "w.json"), JSON.stringify({ widgets: [] }));
    symlinkSync(join(home, ".config"), join(cwd, "cfg"));
    const run = await rlx(["widgets", "sync", "-f", "cfg/runlocal/w.json"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("FILE.REFUSED");
  });

  it("names the error of a list that is too long", async () => {
    writeFileSync(join(cwd, "many.json"), JSON.stringify({ widgets: Array.from({ length: 10_001 }, (_, i) => ({ id: `w${i}` })) }));
    const run = await rlx(["widgets", "sync", "-f", "many.json"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("EACH.TOO_MANY");
  });

  it("reports a folder as no such file", async () => {
    mkdirSync(join(cwd, "a-folder"));
    const run = await rlx(["widgets", "sync", "-f", "a-folder"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("FILE.MISSING");
  });

  it("refuses a state file that is a symbolic link, and sends nothing", async () => {
    mkdirSync(join(cwd, ".runlocal"));
    symlinkSync(join(home, ".rlx-test", "keys.json"), join(cwd, ".runlocal", "feed-cursor"));
    const run = await rlx(["feed"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("STATE.REFUSED");
    expect(mock.count("GET", "/v1/feed")).toBe(0);
  });

  it("refuses a state folder that is a symbolic link", async () => {
    const elsewhere = tempDir("rlx-elsewhere-");
    writeFileSync(join(elsewhere, "feed-cursor"), "c1\n");
    symlinkSync(elsewhere, join(cwd, ".runlocal"));
    const run = await rlx(["feed"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("STATE.REFUSED");
  });

  it("refuses a state value that looks like a credential, and sends nothing", async () => {
    mkdirSync(join(cwd, ".runlocal"));
    writeFileSync(join(cwd, ".runlocal", "feed-cursor"), `${KEY}\n`);
    const run = await rlx(["feed"]);
    expect(run.code).toBe(1);
    expect(run.stderr).toContain("STATE.REFUSED");
    expect(run.stdout + run.stderr).not.toContain(KEY);
    expect(mock.count("GET", "/v1/feed")).toBe(0);
  });
});

describe("poll", () => {
  it("repeats the request until the field has a value of the list", async () => {
    let calls = 0;
    mock.on("GET", "/v1/builds/b1", () => {
      calls++;
      return { body: { id: "b1", state: calls < 3 ? "running" : "done" } };
    });
    const run = await rlx(["builds", "wait", "b1"]);
    expect(run.code).toBe(0);
    expect(calls).toBe(3);
    expect(run.stdout).toBe("ID  State\nb1  done\n");
  });

  it("stops after the most tries, with exit 3", async () => {
    mock.on("GET", "/v1/builds/b2", () => ({ body: { id: "b2", state: "running" } }));
    const run = await rlx(["builds", "wait", "b2"]);
    expect(run.code).toBe(3);
    expect(run.stderr).toContain("POLL.TIMEOUT");
    expect(mock.count("GET", "/v1/builds/b2")).toBe(4);
  });
});

describe("markdown", () => {
  it("prints a string from the answer", async () => {
    mock.on("GET", "/v1/notes", () => ({ body: { text: "# Notes\n\n- one" } }));
    const run = await rlx(["notes"]);
    expect(run.stdout).toBe("# Notes\n\n- one\n");
  });
});
