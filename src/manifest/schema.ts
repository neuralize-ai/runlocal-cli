// SPDX-License-Identifier: Apache-2.0
// The command manifest that the server sends after the sign-in, and its
// validation. rlx refuses a manifest that it cannot read in full.

import type { Method } from "../api.js";
import { blockedHeader } from "../api.js";
import { CliError, EXIT } from "../util/errors.js";
import { checkTemplate, parsePath } from "../engine/template.js";

export const MANIFEST_SCHEMA = "runlocal.cli-manifest/1";

export const ARG_KINDS = ["positional", "option", "flag"] as const;
export const ARG_TYPES = ["string", "integer", "number", "boolean", "path"] as const;
export type ArgKind = (typeof ARG_KINDS)[number];
export type ArgType = (typeof ARG_TYPES)[number];
/** The kinds of output. */
export const OUTPUT_KINDS = ["table", "json", "markdown"] as const;
/** Short letters that rlx keeps for itself: -y, -q, -h, -V. */
export const RESERVED_SHORTS = ["y", "q", "h", "V"] as const;

export interface Arg {
  name: string;
  kind: ArgKind;
  type?: ArgType;
  required?: boolean;
  default?: string | number | boolean;
  short?: string;
  help?: string;
  choices?: string[];
  /**
   * An option that can be given more than once. Its value is a list. A
   * positional with repeat is the last positional: it takes each word that is
   * left, as a list.
   */
  repeat?: boolean;
}

export interface RequestSpec {
  method: Method;
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
}

export interface Condition {
  /** A path in the value that the condition tests. */
  field: string;
  /** The values that count. Without it, any value other than null or "" counts. */
  in?: unknown[];
}

interface StepBase {
  /** A template. The step runs only when it gives a value that counts as yes. */
  when?: string;
}

export interface HttpStep extends StepBase, RequestSpec {
  op: "http";
  as?: string;
}

export interface UploadParts extends RequestSpec {
  /** Path in the begin answer: the bytes of each part. */
  size: string;
  /** Path in the begin answer: the number of parts. Computed when absent. */
  count?: string;
  /** Path in the parts answer: the list of parts. */
  list: string;
  /** Path in one item of the list: the number of the part. */
  number: string;
  /** Path in one item of the list: the address for the bytes of the part. */
  url: string;
  /** The most part numbers to ask for in one request. */
  batch?: number;
}

export interface UploadStep extends StepBase {
  op: "upload";
  /** A template: the local file. */
  file: string;
  begin: RequestSpec;
  /** On the begin answer: the server holds the bytes already. */
  done?: Condition;
  /** Path in the begin answer: one address for all the bytes. */
  single?: string;
  parts?: UploadParts;
  finish?: RequestSpec;
  as?: string;
}

export interface ReadStep extends StepBase {
  op: "read";
  file: string;
  format?: "json" | "yaml";
  as: string;
}

export interface StateStep extends StepBase {
  op: "state";
  key: string;
  /** A template. With it, the step writes the value; without it, the step reads. */
  set?: string;
  delete?: boolean;
  as?: string;
}

export interface ConfirmStep extends StepBase {
  op: "confirm";
  message: string;
}

export interface EachStep extends StepBase {
  op: "each";
  /** A path to a list. */
  over: string;
  /** The name of the item in the steps. */
  as?: string;
  steps: Step[];
  /** A name in the steps whose value is kept for each item... */
  collect?: string;
  /** ...in a list with this name. */
  into?: string;
}

export interface PollStep extends StepBase {
  op: "poll";
  step: HttpStep;
  until: Condition;
  /** Seconds between two tries. */
  interval?: number;
  /** The most tries. */
  max: number;
  as?: string;
}

/**
 * Writes the bytes at an address that the server gave to a local file. rlx
 * sends no credential with the request, and writes only inside the folder.
 */
export interface DownloadStep extends StepBase {
  op: "download";
  /** A template: the address of the bytes, signed by the server. */
  url: string;
  /** A template: the folder to write into. Without it, the current folder. */
  dir?: string;
  /** A template: the path of the file in the folder. Its parts cannot be "." or "..". */
  name: string;
  /** A template: the size in bytes that the file must have. */
  size?: string;
  /** A template: "sha256:<hex>", the digest that the file must have. */
  digest?: string;
  as?: string;
}

export type Step = HttpStep | UploadStep | ReadStep | StateStep | ConfirmStep | EachStep | PollStep | DownloadStep;

/** Fields that each kind of output can have. */
export interface OutputExtras {
  /** A path: the value that --json prints. Without it, --json prints the value of the output. */
  json?: string;
  /** A template: one line for the person, on standard error, after the result. --json and --quiet hide it. */
  hint?: string;
  /** The name of an option of type path: when it is given, rlx writes the result to that file, not to standard output. */
  save?: string;
}

export type Output =
  | ({ kind: "table"; from: string; columns: [string, string][]; empty?: string } & OutputExtras)
  | ({ kind: "json"; from?: string } & OutputExtras)
  | ({ kind: "markdown"; from?: string; text?: string } & OutputExtras);

/** Help that depends on the positional arguments: --help runs the steps and prints the output after the help. */
export interface Explain {
  steps: Step[];
  output: Output;
}

export interface Command {
  name: string[];
  summary: string;
  description?: string;
  args?: Arg[];
  /** Command lines that --help shows, such as "rlx widgets list --color red". */
  examples?: string[];
  /** The heading under which rlx help lists the command. Commands with no group come last. */
  group?: string;
  steps: Step[];
  output?: Output;
  explain?: Explain;
}

export interface Manifest {
  schema: typeof MANIFEST_SCHEMA;
  version: string;
  auth?: { api_keys?: string };
  commands: Command[];
}

/** Words that the manifest cannot use as the first word of a command. */
export const BUILT_IN_COMMANDS = new Set(["login", "logout", "help"]);
/** Option names that rlx keeps for itself. */
export const GLOBAL_OPTIONS = new Set(["json", "yes", "api", "quiet", "debug", "help", "version", "no-key"]);
/** Names that a step result cannot take. */
export const RESERVED_NAMES = new Set(["args"]);

/** A word of a command name, or the name of an argument. */
export const WORD = /^[a-z][a-z0-9-]{0,39}$/;
/** The name of a step result (as, into). */
export const NAME = /^[a-z_][a-z0-9_]{0,39}$/;
/** The key of a state value: a file name in the state folder. */
export const KEY = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** The name of a request header: a token of HTTP. */
export const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;
export const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
export const OPS = new Set(["http", "upload", "read", "state", "confirm", "each", "poll", "download"]);
/** The most levels of steps: the steps of a command are level 1. */
export const MAX_DEPTH = 4;
/** The most levels of a JSON value in a query or a body. */
export const MAX_VALUE_DEPTH = 32;
/** The fields of the manifest document itself. */
export const MANIFEST_FIELDS = ["schema", "version", "auth", "commands"];

/** A short text for a value in an error message. It never throws. */
function shown(value: unknown): string {
  if (typeof value === "string") return value.length > 60 ? `${value.slice(0, 60)}...` : value;
  try {
    const text = JSON.stringify(value) ?? typeof value;
    return text.length > 60 ? `${text.slice(0, 60)}...` : text;
  } catch {
    return typeof value;
  }
}

class Checker {
  constructor(private readonly where: string[] = []) {}

  at(part: string | number): Checker {
    return new Checker([...this.where, String(part)]);
  }

  fail(message: string): never {
    const where = this.where.length ? ` at ${this.where.join(".")}` : "";
    throw new CliError(`The command manifest is not valid${where}: ${message}`, {
      exitCode: EXIT.server,
      code: "MANIFEST.INVALID",
    });
  }

  object(value: unknown): Record<string, unknown> {
    if (typeof value !== "object" || value === null || Array.isArray(value)) this.fail("expected an object");
    return value as Record<string, unknown>;
  }

  only(value: Record<string, unknown>, allowed: string[]): void {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) this.at(key).fail("unknown field");
  }

  string(value: unknown, pattern?: RegExp): string {
    if (typeof value !== "string" || value.length === 0) this.fail("expected a string");
    if (pattern && !pattern.test(value)) this.fail(`"${shown(value)}" does not match ${pattern}`);
    return value;
  }

  optionalString(value: unknown, pattern?: RegExp): void {
    if (value !== undefined) this.string(value, pattern);
  }

  template(value: unknown): void {
    this.string(value);
    try {
      checkTemplate(value as string);
    } catch (error) {
      this.fail((error as Error).message);
    }
  }

  path(value: unknown): void {
    this.string(value);
    try {
      parsePath(value as string);
    } catch (error) {
      this.fail((error as Error).message);
    }
  }

  /** Checks every string in a JSON value as a template. The value can have at most MAX_VALUE_DEPTH levels. */
  templates(value: unknown, depth = 1): void {
    if (depth > MAX_VALUE_DEPTH) this.fail(`a value is nested more than ${MAX_VALUE_DEPTH} levels deep`);
    if (typeof value === "string") this.template(value);
    else if (Array.isArray(value)) value.forEach((item, i) => this.at(i).templates(item, depth + 1));
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) this.at(key).templates(item, depth + 1);
    }
  }

  boolean(value: unknown): void {
    if (typeof value !== "boolean") this.fail("expected true or false");
  }

  /** Runs a check function at this place. */
  fn(check: (c: Checker, value: unknown) => void, value: unknown): void {
    check(this, value);
  }

  integer(value: unknown, min: number, max: number): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
      this.fail(`expected a whole number from ${min} to ${max}`);
    }
    return value as number;
  }
}

function checkRequest(c: Checker, value: unknown, extra: string[] = []): void {
  const req = c.object(value);
  c.only(req, ["method", "path", "query", "headers", "body", ...extra]);
  if (typeof req.method !== "string" || !METHODS.has(req.method)) c.at("method").fail("expected GET, POST, PUT, PATCH, or DELETE");
  c.at("path").template(req.path);
  if (!(req.path as string).startsWith("/") || (req.path as string).startsWith("//")) {
    c.at("path").fail("a path must start with one /");
  }
  if (req.query !== undefined) {
    const query = c.at("query").object(req.query);
    for (const [key, item] of Object.entries(query)) c.at("query").at(key).templates(item);
  }
  if (req.headers !== undefined) {
    const headers = c.at("headers").object(req.headers);
    for (const [key, item] of Object.entries(headers)) {
      if (!HEADER_NAME.test(key)) c.at("headers").at(key).fail("expected the name of a header");
      if (blockedHeader(key)) c.at("headers").at(key).fail("rlx does not let a manifest set this header");
      c.at("headers").at(key).template(item);
    }
  }
  if (req.body !== undefined) c.at("body").templates(req.body);
}

function checkCondition(c: Checker, value: unknown): void {
  const cond = c.object(value);
  c.only(cond, ["field", "in"]);
  c.at("field").path(cond.field);
  if (cond.in !== undefined && !Array.isArray(cond.in)) c.at("in").fail("expected a list");
  if (cond.in !== undefined) (cond.in as unknown[]).forEach((item, i) => c.at("in").at(i).fn(checkPlain, item));
}

/** A value of a condition list: a string, a number, true, false, or null. A list or an object never matches. */
function checkPlain(c: Checker, value: unknown): void {
  if (value !== null && !["string", "number", "boolean"].includes(typeof value)) c.fail("expected a string, a number, true, false, or null");
}

function checkName(c: Checker, value: unknown): void {
  c.string(value, NAME);
  if (RESERVED_NAMES.has(value as string)) c.fail(`"${value}" is a reserved name`);
}

function checkStep(c: Checker, value: unknown, depth: number): void {
  const step = c.object(value);
  if (typeof step.op !== "string" || !OPS.has(step.op)) {
    c.at("op").fail(`"${shown(step.op)}" is not an operation that this version of rlx knows. Update rlx.`);
  }
  if (step.when !== undefined) c.at("when").template(step.when);
  if (step.as !== undefined) c.at("as").fn(checkName, step.as);
  switch (step.op) {
    case "http":
      checkRequest(c, step, ["op", "as", "when"]);
      break;
    case "upload": {
      c.only(step, ["op", "file", "begin", "done", "single", "parts", "finish", "as", "when"]);
      c.at("file").template(step.file);
      checkRequest(c.at("begin"), step.begin);
      if (step.done !== undefined) checkCondition(c.at("done"), step.done);
      if (step.single !== undefined) c.at("single").path(step.single);
      if (step.parts !== undefined) {
        const parts = c.at("parts").object(step.parts);
        checkRequest(c.at("parts"), parts, ["size", "count", "list", "number", "url", "batch"]);
        for (const field of ["size", "list", "number", "url"]) c.at("parts").at(field).path(parts[field]);
        if (parts.count !== undefined) c.at("parts").at("count").path(parts.count);
        if (parts.batch !== undefined) c.at("parts").at("batch").integer(parts.batch, 1, 1000);
      }
      if (step.single === undefined && step.parts === undefined) c.fail("an upload needs single or parts");
      if (step.finish !== undefined) checkRequest(c.at("finish"), step.finish);
      break;
    }
    case "read":
      c.only(step, ["op", "file", "format", "as", "when"]);
      c.at("file").template(step.file);
      if (step.format !== undefined && step.format !== "json" && step.format !== "yaml") c.at("format").fail("expected json or yaml");
      if (step.as === undefined) c.at("as").fail("a read needs a name");
      break;
    case "state":
      c.only(step, ["op", "key", "set", "delete", "as", "when"]);
      c.at("key").string(step.key, KEY);
      if (step.set !== undefined) c.at("set").template(step.set);
      if (step.delete !== undefined) c.at("delete").boolean(step.delete);
      if (step.delete === true && step.set !== undefined) c.fail("a state step either sets or deletes");
      break;
    case "confirm":
      c.only(step, ["op", "message", "when"]);
      c.at("message").template(step.message);
      break;
    case "each":
      c.only(step, ["op", "over", "as", "steps", "collect", "into", "when"]);
      c.at("over").path(step.over);
      if (step.collect !== undefined) c.at("collect").path(step.collect);
      if (step.into !== undefined) c.at("into").fn(checkName, step.into);
      if ((step.collect === undefined) !== (step.into === undefined)) c.fail("collect and into go together");
      checkSteps(c.at("steps"), step.steps, depth + 1);
      break;
    case "download":
      c.only(step, ["op", "url", "dir", "name", "size", "digest", "as", "when"]);
      c.at("url").template(step.url);
      c.at("name").template(step.name);
      if (step.dir !== undefined) c.at("dir").template(step.dir);
      if (step.size !== undefined) c.at("size").template(step.size);
      if (step.digest !== undefined) c.at("digest").template(step.digest);
      break;
    case "poll": {
      c.only(step, ["op", "step", "until", "interval", "max", "as", "when"]);
      const inner = c.at("step").object(step.step);
      if (inner.op !== "http") c.at("step").fail("poll repeats an http step");
      if (inner.when !== undefined) c.at("step").at("when").fail("poll runs its step on each try; put when on the poll");
      checkStep(c.at("step"), inner, depth + 1);
      checkCondition(c.at("until"), step.until);
      if (step.interval !== undefined) c.at("interval").integer(step.interval, 1, 600);
      c.at("max").integer(step.max, 1, 1000);
      break;
    }
  }
}

function checkSteps(c: Checker, value: unknown, depth: number): void {
  if (depth > MAX_DEPTH) c.fail("steps are nested too deep");
  if (!Array.isArray(value)) c.fail("expected a list of steps");
  (value as unknown[]).forEach((step, i) => checkStep(c.at(i), step, depth));
}

function checkArg(c: Checker, value: unknown): void {
  const arg = c.object(value);
  c.only(arg, ["name", "kind", "type", "required", "default", "short", "help", "choices", "repeat"]);
  c.at("name").string(arg.name, WORD);
  if (GLOBAL_OPTIONS.has(arg.name as string)) c.at("name").fail(`"${arg.name}" is an option of rlx itself`);
  if (!["positional", "option", "flag"].includes(arg.kind as string)) c.at("kind").fail("expected positional, option, or flag");
  if (arg.type !== undefined && !["string", "integer", "number", "boolean", "path"].includes(arg.type as string)) {
    c.at("type").fail("expected string, integer, number, boolean, or path");
  }
  if (arg.required !== undefined) c.at("required").boolean(arg.required);
  if (arg.repeat !== undefined) c.at("repeat").boolean(arg.repeat);
  if (arg.default !== undefined && !["string", "number", "boolean"].includes(typeof arg.default)) {
    c.at("default").fail("expected a string, a number, true, or false");
  }
  if (arg.short !== undefined) {
    if (arg.kind === "positional") c.at("short").fail("a positional has no short letter");
    c.at("short").string(arg.short, /^[a-zA-Z]$/);
    if (["y", "q", "h", "V"].includes(arg.short as string)) c.at("short").fail("this letter is an option of rlx itself");
  }
  if (arg.help !== undefined) c.at("help").string(arg.help);
  if (arg.choices !== undefined && (!Array.isArray(arg.choices) || arg.choices.some((x) => typeof x !== "string"))) {
    c.at("choices").fail("expected a list of strings");
  }
}

/** Checks an output, with the arguments of its command. */
function checkOutput(c: Checker, value: unknown, args: Arg[]): void {
  const out = c.object(value);
  if (out.kind === "table") {
    c.only(out, ["kind", "from", "columns", "empty", "json", "hint", "save"]);
    c.at("from").path(out.from);
    if (!Array.isArray(out.columns) || out.columns.length === 0) c.at("columns").fail("expected a list");
    (out.columns as unknown[][]).forEach((col, j) => {
      const cj = c.at("columns").at(j);
      if (!Array.isArray(col) || col.length !== 2) cj.fail("expected [path, heading]");
      cj.at(0).path(col[0]);
      cj.at(1).string(col[1]);
    });
    if (out.empty !== undefined) c.at("empty").string(out.empty);
  } else if (out.kind === "json") {
    c.only(out, ["kind", "from", "json", "hint", "save"]);
    if (out.from !== undefined) c.at("from").path(out.from);
  } else if (out.kind === "markdown") {
    c.only(out, ["kind", "from", "text", "json", "hint", "save"]);
    if (out.from !== undefined) c.at("from").path(out.from);
    if (out.text !== undefined) c.at("text").template(out.text);
    if ((out.from === undefined) === (out.text === undefined)) c.fail("markdown needs from or text");
  } else {
    c.at("kind").fail("expected table, json, or markdown");
  }
  if (out.json !== undefined) c.at("json").path(out.json);
  if (out.hint !== undefined) c.at("hint").template(out.hint);
  if (out.save !== undefined) {
    const arg = args.find((item) => item.name === out.save);
    if (!arg || arg.kind !== "option" || arg.type !== "path") c.at("save").fail("expected the name of an option of type path");
  }
}

/** Checks a manifest, and returns it typed. Throws a CliError when it is not valid. */
export function validateManifest(value: unknown): Manifest {
  const c = new Checker();
  const doc = c.object(value);
  if (doc.schema !== MANIFEST_SCHEMA) {
    c.at("schema").fail(`expected "${MANIFEST_SCHEMA}", got "${shown(doc.schema)}". Update rlx.`);
  }
  c.only(doc, MANIFEST_FIELDS);
  c.at("version").string(doc.version);
  if (doc.auth !== undefined) {
    const auth = c.at("auth").object(doc.auth);
    c.at("auth").only(auth, ["api_keys"]);
    if (auth.api_keys !== undefined) {
      c.at("auth").at("api_keys").string(auth.api_keys, /^\/(?!\/)/);
    }
  }
  if (!Array.isArray(doc.commands)) c.at("commands").fail("expected a list");
  const seen = new Set<string>();
  (doc.commands as unknown[]).forEach((value, i) => {
    const cc = c.at("commands").at(i);
    const cmd = cc.object(value);
    cc.only(cmd, ["name", "summary", "description", "group", "args", "examples", "steps", "output", "explain"]);
    if (!Array.isArray(cmd.name) || cmd.name.length === 0 || cmd.name.length > 4) cc.at("name").fail("expected a list of 1 to 4 words");
    (cmd.name as unknown[]).forEach((word, j) => cc.at("name").at(j).string(word, WORD));
    const words = cmd.name as string[];
    if (BUILT_IN_COMMANDS.has(words[0]!)) cc.at("name").fail(`"${words[0]}" is a command of rlx itself`);
    const key = words.join(" ");
    if (seen.has(key)) cc.at("name").fail(`"${key}" is listed twice`);
    seen.add(key);
    cc.at("summary").string(cmd.summary);
    if (cmd.description !== undefined) cc.at("description").string(cmd.description);
    if (cmd.args !== undefined) {
      if (!Array.isArray(cmd.args)) cc.at("args").fail("expected a list");
      const names = new Set<string>();
      const shorts = new Set<string>();
      (cmd.args as unknown[]).forEach((arg, j) => {
        checkArg(cc.at("args").at(j), arg);
        const { name, short } = arg as Arg;
        if (names.has(name)) cc.at("args").at(j).fail(`"${name}" is listed twice`);
        names.add(name);
        if (short !== undefined && shorts.has(short)) cc.at("args").at(j).at("short").fail(`-${short} is listed twice`);
        if (short !== undefined) shorts.add(short);
      });
      const positionals = (cmd.args as Arg[]).filter((arg) => arg.kind === "positional");
      positionals.slice(0, -1).forEach((arg) => {
        if (arg.repeat) cc.at("args").fail(`"${arg.name}" repeats, so it must be the last positional`);
      });
    }
    if (cmd.group !== undefined) cc.at("group").string(cmd.group);
    if (cmd.examples !== undefined) {
      if (!Array.isArray(cmd.examples)) cc.at("examples").fail("expected a list");
      (cmd.examples as unknown[]).forEach((example, j) => cc.at("examples").at(j).string(example));
    }
    checkSteps(cc.at("steps"), cmd.steps, 1);
    const args = (cmd.args as Arg[] | undefined) ?? [];
    if (cmd.output !== undefined) checkOutput(cc.at("output"), cmd.output, args);
    if (cmd.explain !== undefined) {
      const explain = cc.at("explain").object(cmd.explain);
      cc.at("explain").only(explain, ["steps", "output"]);
      checkSteps(cc.at("explain").at("steps"), explain.steps, 1);
      checkOutput(cc.at("explain").at("output"), explain.output, args);
    }
  });
  return doc as unknown as Manifest;
}
