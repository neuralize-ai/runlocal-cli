// SPDX-License-Identifier: Apache-2.0
// The input file of a command: an option named "input" of type path, whose
// file is a YAML or JSON mapping of option names to values. The steps of the
// command send the file on; the engine reads it only for the positionals
// that the command line leaves out, so that the file can give them by name,
// and the check of the required arguments runs after that.

import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Arg, Command } from "../manifest/schema.js";
import { type EngineContext, localFile } from "./context.js";

/** The name of the option that names an input file. */
export const INPUT_OPTION = "input";
/** The largest input file that the engine reads for positionals. */
export const MAX_INPUT_BYTES = 256 * 1024;
const INPUT_EXTENSIONS = new Set([".yaml", ".yml", ".json"]);

/** The option of a command that names its input file, if it has one. */
export function inputOption(command: Command): Arg | undefined {
  return (command.args ?? []).find((arg) => arg.name === INPUT_OPTION && arg.kind === "option" && arg.type === "path");
}

/** The key of an argument in an input file: its name, or its name in snake_case. */
function keysOf(name: string): string[] {
  const snake = name.replace(/-/g, "_");
  return snake === name ? [name] : [snake, name];
}

/**
 * The values of the positionals that the command line leaves out, from the
 * input file of the command. It is empty when the command has no input
 * option, when no positional is left out, or when the file is not a YAML or
 * JSON mapping: then the steps report the file, or the check of the required
 * arguments reports what is missing.
 */
export async function positionalsFromInput(
  ctx: EngineContext,
  command: Command,
  given: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const option = inputOption(command);
  const file = option ? given[option.name] : undefined;
  const missing = (command.args ?? []).filter((arg) => arg.kind === "positional" && given[arg.name] === undefined);
  if (typeof file !== "string" || !file || missing.length === 0) return {};
  const path = localFile(ctx, file);
  if (!INPUT_EXTENSIONS.has(extname(path).toLowerCase())) return {};
  let doc: unknown;
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_INPUT_BYTES) return {};
    const text = await readFile(path, "utf8");
    doc = extname(path).toLowerCase() === ".json" ? JSON.parse(text) : parseYaml(text, { maxAliasCount: 50 });
  } catch {
    return {};
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return {};
  const values: Record<string, unknown> = {};
  for (const arg of missing) {
    const key = keysOf(arg.name).find((name) => Object.hasOwn(doc as object, name));
    if (key !== undefined) values[arg.name] = (doc as Record<string, unknown>)[key];
  }
  return values;
}
