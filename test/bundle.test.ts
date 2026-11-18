// SPDX-License-Identifier: Apache-2.0
import { execFile } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { KEY, storeKey, tempDir } from "./helpers/cli.js";
import { type MockServer, serveManifest, startMock } from "./helpers/mock.js";

const bundle = fileURLToPath(new URL("../dist/rlx.mjs", import.meta.url));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));
const run = promisify(execFile);

async function rlx(args: string[], env: Record<string, string>, cwd: string): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [bundle, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, cwd });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code: number; stdout: string; stderr: string };
    return { code: e.code, stdout: e.stdout, stderr: e.stderr };
  }
}

// npm test builds the bundle first. A run of vitest alone skips this file.
describe.skipIf(!existsSync(bundle))("the bundle", () => {
  let mock: MockServer;
  let home: string;

  beforeAll(async () => {
    mock = await startMock();
    serveManifest(mock, fixture, KEY);
    home = tempDir();
  });

  afterAll(async () => {
    await mock.close();
  });

  it("starts with no dependency installed, and shows the help before the sign-in", async () => {
    const result = await rlx(["--api", mock.origin, "help"], { HOME: home }, home);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("Sign in to see your commands.");
  });

  it("exits 2 for a command before the sign-in", async () => {
    const result = await rlx(["--api", mock.origin, "widgets", "list"], { HOME: home }, home);
    expect(result.code).toBe(2);
  });

  it("runs a manifest command that reads YAML", async () => {
    storeKey(home, mock.origin, KEY);
    writeFileSync(join(home, "w.yaml"), "widgets:\n  - id: a\n    name: A\n");
    mock.on("PUT", "/v1/widgets/a", (req) => ({ body: { id: "a", ...req.json() } }));
    const result = await rlx(["--api", mock.origin, "widgets", "sync", "-f", "w.yaml", "--json"], { HOME: home }, home);
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([{ id: "a", name: "A", position: 0 }]);
  });
});
