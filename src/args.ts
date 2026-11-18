// SPDX-License-Identifier: Apache-2.0
import type { GlobalFlags } from "./util/io.js";
import type { Arg, Command } from "./manifest/schema.js";
import { userError } from "./util/errors.js";

export interface ParsedGlobals {
  flags: GlobalFlags;
  /** The words and options that are not global flags, in their order. */
  rest: string[];
  /** --no-key, an option of login. */
  noKey: boolean;
}

/** The hint for --version or -V after a command name, where it is not an option of rlx. */
export function versionHint(token: string): string {
  return token === "--version" || token === "-V" ? " rlx --version prints the version of rlx: give it first, with no command." : "";
}

/**
 * Takes the global flags out of argv, at any place before "--". --version
 * and -V are global only before the command name: after it, they stay in
 * the rest, for the command to parse (or to refuse as unknown).
 */
export function parseGlobals(argv: string[]): ParsedGlobals {
  const flags: GlobalFlags = {
    json: false,
    yes: false,
    quiet: false,
    debug: false,
    help: false,
    version: false,
    api: undefined,
  };
  let noKey = false;
  const rest: string[] = [];
  let afterCommand = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--") {
      rest.push(...argv.slice(i));
      break;
    }
    switch (arg) {
      case "--json":
        flags.json = true;
        continue;
      case "--yes":
      case "-y":
        flags.yes = true;
        continue;
      case "--quiet":
      case "-q":
        flags.quiet = true;
        continue;
      case "--debug":
        flags.debug = true;
        continue;
      case "--help":
      case "-h":
        flags.help = true;
        continue;
      case "--version":
      case "-V":
        if (afterCommand) break;
        flags.version = true;
        continue;
      case "--no-key":
        noKey = true;
        continue;
      case "--api": {
        const value = argv[i + 1];
        if (value === undefined || value.startsWith("-")) throw userError("--api needs an origin, such as https://api.example.com.");
        flags.api = value;
        i++;
        continue;
      }
    }
    if (arg.startsWith("--api=")) {
      flags.api = arg.slice("--api=".length);
      continue;
    }
    if (!arg.startsWith("-")) afterCommand = true;
    rest.push(arg);
  }
  return { flags, rest, noKey };
}

/** The leading words of argv, before the first option. */
export function leadingWords(rest: string[]): string[] {
  const words: string[] = [];
  for (const arg of rest) {
    if (arg.startsWith("-")) break;
    words.push(arg);
  }
  return words;
}

/** Finds the command whose name is the longest match of the leading words. */
export function findCommand(commands: Command[], words: string[]): { command: Command; used: number } | undefined {
  let best: { command: Command; used: number } | undefined;
  for (const command of commands) {
    const n = command.name.length;
    if (n > words.length) continue;
    if (command.name.every((word, i) => words[i] === word) && (!best || n > best.used)) {
      best = { command, used: n };
    }
  }
  return best;
}

function coerce(arg: Arg, raw: string): unknown {
  const type = arg.type ?? (arg.kind === "flag" ? "boolean" : "string");
  let value: unknown = raw;
  switch (type) {
    case "integer":
      if (!/^-?\d+$/.test(raw)) throw userError(`--${arg.name} needs a whole number, not "${raw}".`);
      value = Number(raw);
      break;
    case "number":
      if (raw.trim() === "" || !Number.isFinite(Number(raw))) throw userError(`--${arg.name} needs a number, not "${raw}".`);
      value = Number(raw);
      break;
    case "boolean":
      if (!["true", "false", "yes", "no", "1", "0"].includes(raw.toLowerCase())) {
        throw userError(`--${arg.name} needs true or false, not "${raw}".`);
      }
      value = ["true", "yes", "1"].includes(raw.toLowerCase());
      break;
  }
  if (arg.choices && !arg.choices.includes(String(value))) {
    throw userError(`${label(arg)} must be one of: ${arg.choices.join(", ")}.`);
  }
  return value;
}

function label(arg: Arg): string {
  return arg.kind === "positional" ? `<${arg.name}>` : `--${arg.name}`;
}

/**
 * Parses the arguments of a command, after its name. `lenient` skips the
 * check of the required arguments, for the help of a command. `fill` gives
 * values of positionals from an input file: the command line wins over it,
 * and the check of the required arguments runs after it.
 */
export function parseCommandArgs(
  command: Command,
  argv: string[],
  options: { lenient?: boolean; fill?: Record<string, unknown> } = {},
): Record<string, unknown> {
  const helpHint = `Run: rlx ${command.name.join(" ")} --help`;
  const specs = command.args ?? [];
  const positionals = specs.filter((a) => a.kind === "positional");
  const byName = new Map(specs.filter((a) => a.kind !== "positional").map((a) => [a.name, a]));
  const byShort = new Map(specs.filter((a) => a.short).map((a) => [a.short!, a]));
  const values: Record<string, unknown> = {};
  const given: string[] = [];
  let onlyPositionals = false;

  const set = (arg: Arg, value: unknown): void => {
    if (arg.repeat) {
      const list = (values[arg.name] as unknown[] | undefined) ?? [];
      list.push(value);
      values[arg.name] = list;
    } else {
      if (values[arg.name] !== undefined) throw userError(`${label(arg)} is given twice.`);
      values[arg.name] = value;
    }
  };

  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]!;
    if (!onlyPositionals && token === "--") {
      onlyPositionals = true;
      continue;
    }
    if (!onlyPositionals && token.startsWith("-") && token !== "-") {
      let name: string;
      let inline: string | undefined;
      let arg: Arg | undefined;
      if (token.startsWith("--")) {
        const eq = token.indexOf("=");
        name = eq === -1 ? token.slice(2) : token.slice(2, eq);
        inline = eq === -1 ? undefined : token.slice(eq + 1);
        arg = byName.get(name);
        if (!arg && name.startsWith("no-") && inline === undefined) {
          const negated = byName.get(name.slice(3));
          if (negated?.kind === "flag") {
            set(negated, false);
            continue;
          }
        }
      } else {
        name = token.slice(1, 2);
        inline = token.length > 2 ? token.slice(2) : undefined;
        arg = byShort.get(name);
      }
      if (!arg) throw userError(`Unknown option ${token}.${versionHint(token)} ${helpHint}`);
      if (arg.kind === "flag") {
        set(arg, inline === undefined ? true : coerce(arg, inline));
        continue;
      }
      const raw = inline ?? argv[++i];
      if (raw === undefined) throw userError(`${label(arg)} needs a value. ${helpHint}`);
      set(arg, coerce(arg, raw));
      continue;
    }
    const last = positionals[positionals.length - 1];
    const arg = positionals[given.length] ?? (last?.repeat && given.length > 0 ? last : undefined);
    if (!arg) throw userError(`Too many arguments: "${token}". ${helpHint}`);
    if (arg.repeat) {
      if (!given.includes(arg.name)) given.push(arg.name);
      values[arg.name] = [...((values[arg.name] as unknown[] | undefined) ?? []), coerce(arg, token)];
    } else {
      given.push(arg.name);
      values[arg.name] = coerce(arg, token);
    }
  }
  if (options.lenient) return values;

  for (const arg of positionals) {
    const value = options.fill?.[arg.name];
    if (values[arg.name] !== undefined || value === undefined || value === null) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    const items = Array.isArray(value) ? value : [value];
    if ((Array.isArray(value) && !arg.repeat) || items.some((item) => !["string", "number", "boolean"].includes(typeof item))) {
      throw userError(`The input file gives ${label(arg)} a value that is not ${arg.repeat ? "a value or a list of values" : "one value"}. ${helpHint}`);
    }
    const coerced = items.map((item) => coerce(arg, String(item)));
    values[arg.name] = arg.repeat ? coerced : coerced[0];
  }

  for (const arg of specs) {
    if (values[arg.name] === undefined && arg.default !== undefined) values[arg.name] = arg.default;
    if (values[arg.name] === undefined && arg.kind === "flag") values[arg.name] = false;
    const required = arg.required ?? arg.kind === "positional";
    if (values[arg.name] === undefined && required) throw userError(`${label(arg)} is required. ${helpHint}`);
  }
  return values;
}
