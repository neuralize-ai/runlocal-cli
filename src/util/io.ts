// SPDX-License-Identifier: Apache-2.0
import { createInterface } from "node:readline/promises";
import { homedir } from "node:os";
import { mask } from "./mask.js";

/** What rlx needs from its surroundings. The tests give their own. */
export interface Io {
  env: Record<string, string | undefined>;
  cwd: string;
  home: string;
  /** True when a person can answer a prompt. */
  interactive: boolean;
  write(text: string): void;
  writeError(text: string): void;
  /** Asks one question and returns the answer. */
  prompt(question: string): Promise<string>;
  sleep(ms: number): Promise<void>;
  now(): number;
  fetch: typeof fetch;
}

export function processIo(): Io {
  return {
    env: process.env,
    cwd: process.cwd(),
    home: homedir(),
    interactive: Boolean(process.stdin.isTTY && process.stderr.isTTY),
    write: (text) => process.stdout.write(text),
    writeError: (text) => process.stderr.write(text),
    prompt: async (question) => {
      const rl = createInterface({ input: process.stdin, output: process.stderr });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    now: () => Date.now(),
    fetch: globalThis.fetch.bind(globalThis),
  };
}

export interface GlobalFlags {
  json: boolean;
  yes: boolean;
  quiet: boolean;
  debug: boolean;
  help: boolean;
  version: boolean;
  api: string | undefined;
}

/** The output of rlx: each line is masked before it is written. */
export class Out {
  constructor(
    readonly io: Io,
    readonly flags: GlobalFlags,
  ) {}

  /** The result of a command, on standard output. */
  result(text: string): void {
    this.io.write(mask(text.endsWith("\n") ? text : `${text}\n`));
  }

  /** A message for the person, on standard error. --quiet hides it. */
  info(text: string): void {
    if (this.flags.quiet) return;
    this.io.writeError(mask(`${text}\n`));
  }

  /** A warning, on standard error. --quiet does not hide it. */
  warn(text: string): void {
    this.io.writeError(mask(`${text}\n`));
  }

  debug(text: string): void {
    if (!this.flags.debug) return;
    this.io.writeError(mask(`[debug] ${text}\n`));
  }
}
