// SPDX-License-Identifier: Apache-2.0
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/main.js";
import type { Io } from "../../src/util/io.js";

export interface CliRun {
  code: number;
  stdout: string;
  stderr: string;
  prompts: string[];
}

export interface CliOptions {
  home: string;
  cwd?: string;
  env?: Record<string, string>;
  interactive?: boolean;
  answers?: string[];
  now?: () => number;
}

export function tempDir(prefix = "rlx-test-"): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

export function testIo(options: CliOptions, out: { stdout: string[]; stderr: string[]; prompts: string[] }): Io {
  const answers = [...(options.answers ?? [])];
  return {
    env: { ...options.env },
    cwd: options.cwd ?? options.home,
    home: options.home,
    interactive: options.interactive ?? false,
    write: (text) => void out.stdout.push(text),
    writeError: (text) => void out.stderr.push(text),
    prompt: async (question) => {
      out.prompts.push(question);
      return answers.shift() ?? "";
    },
    sleep: async () => {},
    now: options.now ?? (() => Date.now()),
    fetch: globalThis.fetch.bind(globalThis),
  };
}

export async function runCli(argv: string[], options: CliOptions): Promise<CliRun> {
  const out = { stdout: [] as string[], stderr: [] as string[], prompts: [] as string[] };
  const code = await main(argv, testIo(options, out));
  return { code, stdout: out.stdout.join(""), stderr: out.stderr.join(""), prompts: out.prompts };
}

/** Writes a key file entry for the origin in the home folder, as login would. */
export function storeKey(home: string, origin: string, key: string, expiresAt = Date.now() + 30 * 86_400_000): void {
  const dir = join(home, ".rlx-test");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(dir, "keys.json"),
    JSON.stringify({ version: 1, keys: { [origin]: { api_key: key, prefix: key.slice(0, 12), expires_at: expiresAt, name: "test" } } }),
    { mode: 0o600 },
  );
}

export const KEY = `tok_${"ab12".repeat(16)}`;
