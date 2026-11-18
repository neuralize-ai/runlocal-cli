// SPDX-License-Identifier: Apache-2.0
// Runs the steps of a manifest command. The engine knows a fixed set of
// operations. It never downloads code and never runs code from the manifest.

import { lstat, mkdir, readFile, rm, stat } from "node:fs/promises";
import { extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { type Command, type HttpStep, type Step, KEY } from "../manifest/schema.js";
import { CliError, EXIT, cancelled, userError } from "../util/errors.js";
import { looksLikeCredential } from "../util/mask.js";
import { writeFileAtomic } from "../util/files.js";
import { type Data, type EngineContext, localFile, projectRoot } from "./context.js";
import { lookup, parsePath, render, renderString, truthy } from "./template.js";
import { buildRequest, holds } from "./request.js";
import { runUpload } from "./upload.js";
import { runDownload } from "./download.js";

const MAX_READ_BYTES = 16 * 1024 * 1024;
const MAX_STATE_BYTES = 4096;
const MAX_EACH_ITEMS = 10_000;
const STATE_DIR = ".runlocal";

async function runHttp(ctx: EngineContext, step: HttpStep, data: Data): Promise<unknown> {
  const response = await ctx.api.request(buildRequest(step, data));
  return response.body;
}

async function runRead(ctx: EngineContext, file: string, format: string | undefined): Promise<unknown> {
  const path = localFile(ctx, file);
  let size: number;
  try {
    const info = await stat(path);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    throw userError(`No such file: ${file}`, "FILE.MISSING");
  }
  if (size > MAX_READ_BYTES) throw userError(`${file} is larger than ${MAX_READ_BYTES} bytes.`, "FILE.TOO_LARGE");
  const text = await readFile(path, "utf8");
  const kind = format ?? ([".yaml", ".yml"].includes(extname(path).toLowerCase()) ? "yaml" : "json");
  try {
    return kind === "yaml" ? parseYaml(text, { maxAliasCount: 100 }) : JSON.parse(text);
  } catch (error) {
    throw userError(`${file} is not valid ${kind.toUpperCase()}: ${(error as Error).message}`, "FILE.INVALID");
  }
}

function stateRefused(key: string, why: string): CliError {
  return userError(`Refused to use the state ${key}: ${why}.`, "STATE.REFUSED");
}

/**
 * The file of a state key, in the state folder of the project. The key must
 * be a plain file name, and neither the folder nor the file can be a
 * symbolic link: a cloned project could point it at a credential.
 */
async function statePath(ctx: EngineContext, key: string): Promise<string> {
  if (typeof key !== "string" || !KEY.test(key)) throw stateRefused(String(key).slice(0, 80), "it is not a plain key");
  const folder = join(projectRoot(ctx.io.cwd), STATE_DIR);
  const path = join(folder, key);
  for (const item of [folder, path]) {
    const info = await lstat(item).catch(() => undefined);
    if (info?.isSymbolicLink()) throw stateRefused(key, `${item} is a symbolic link`);
    if (info && item === path && !info.isFile()) throw stateRefused(key, `${item} is not a file`);
  }
  return path;
}

/** Reads a state value. It is undefined when it is not there. A value that looks like a credential is refused. */
export async function readState(ctx: EngineContext, key: string): Promise<string | undefined> {
  const path = await statePath(ctx, key);
  let text: string;
  try {
    if ((await stat(path)).size > MAX_STATE_BYTES) throw stateRefused(key, `it is larger than ${MAX_STATE_BYTES} bytes`);
    text = (await readFile(path, "utf8")).replace(/\n$/, "");
  } catch (error) {
    if (error instanceof CliError) throw error;
    return undefined;
  }
  if (looksLikeCredential(text)) throw stateRefused(key, "its value looks like a credential");
  return text;
}

async function writeState(ctx: EngineContext, key: string, value: unknown): Promise<void> {
  const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
  if (Buffer.byteLength(text) > MAX_STATE_BYTES) {
    throw userError(`The value for the state ${key} is larger than ${MAX_STATE_BYTES} bytes.`, "STATE.TOO_LARGE");
  }
  // The state folder of a project can go into git: it never holds a credential.
  if (looksLikeCredential(text)) {
    throw userError(`Refused to write a value that looks like a credential to the state ${key}.`, "STATE.REFUSED");
  }
  const path = await statePath(ctx, key);
  await mkdir(join(projectRoot(ctx.io.cwd), STATE_DIR), { recursive: true });
  await writeFileAtomic(path, `${text}\n`, 0o644);
}

async function confirm(ctx: EngineContext, message: string): Promise<void> {
  if (ctx.flags.yes) return;
  if (!ctx.io.interactive) {
    throw new CliError(`${message}\nThis needs a confirmation. Run the command again with --yes to confirm.`, {
      exitCode: EXIT.user,
      code: "CONFIRM.NEEDED",
    });
  }
  const answer = (await ctx.io.prompt(`${message} [y/N] `)).trim().toLowerCase();
  if (answer !== "y" && answer !== "yes") throw cancelled();
}

/** Runs one step. A step with `as` keeps its result in the data under that name. */
export async function runStep(ctx: EngineContext, step: Step, data: Data): Promise<void> {
  if (step.when !== undefined && !truthy(render(step.when, data))) return;
  switch (step.op) {
    case "http": {
      const result = await runHttp(ctx, step, data);
      if (step.as) data[step.as] = result;
      return;
    }
    case "upload": {
      const result = await runUpload(ctx, step, data);
      if (step.as) data[step.as] = result;
      return;
    }
    case "download": {
      const result = await runDownload(ctx, step, data);
      if (step.as) data[step.as] = result;
      return;
    }
    case "read":
      data[step.as] = await runRead(ctx, renderString(step.file, data, { required: true }), step.format);
      return;
    case "state": {
      if (step.delete) {
        await rm(await statePath(ctx, step.key), { force: true });
      } else if (step.set !== undefined) {
        await writeState(ctx, step.key, render(step.set, data));
      }
      if (step.as) data[step.as] = await readState(ctx, step.key);
      return;
    }
    case "confirm":
      await confirm(ctx, renderString(step.message, data));
      return;
    case "each": {
      const list = lookup(data, parsePath(step.over));
      if (list === undefined || list === null) {
        if (step.into) data[step.into] = [];
        return;
      }
      if (!Array.isArray(list)) throw userError(`${step.over} is not a list.`, "EACH.NOT_A_LIST");
      if (list.length > MAX_EACH_ITEMS) throw userError(`${step.over} has more than ${MAX_EACH_ITEMS} items.`, "EACH.TOO_MANY");
      const name = step.as ?? "item";
      const collected: unknown[] = [];
      for (let index = 0; index < list.length; index++) {
        const scope: Data = { ...data, [name]: list[index], index };
        for (const inner of step.steps) await runStep(ctx, inner, scope);
        if (step.collect) collected.push(lookup(scope, parsePath(step.collect)));
      }
      if (step.into) data[step.into] = collected;
      return;
    }
    case "poll": {
      const interval = (step.interval ?? 5) * 1000;
      for (let attempt = 1; attempt <= step.max; attempt++) {
        const result = await runHttp(ctx, step.step, data);
        if (holds(step.until, result)) {
          if (step.as) data[step.as] = result;
          if (step.step.as) data[step.step.as] = result;
          return;
        }
        if (attempt < step.max) {
          ctx.out.info(`Waiting (${attempt} of ${step.max})...`);
          await ctx.io.sleep(interval);
        }
      }
      throw new CliError(`The server did not reach the state after ${step.max} tries.`, {
        exitCode: EXIT.server,
        code: "POLL.TIMEOUT",
      });
    }
  }
}

/** Runs all the steps of a command, and returns the data. */
export async function runCommand(ctx: EngineContext, command: Command, args: Record<string, unknown>): Promise<Data> {
  const data: Data = { args };
  for (const step of command.steps) await runStep(ctx, step, data);
  return data;
}
