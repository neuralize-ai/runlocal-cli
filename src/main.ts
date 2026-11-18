// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import { Api } from "./api.js";
import { findCommand, leadingWords, parseCommandArgs, parseGlobals } from "./args.js";
import { type SignedIn, forgetRefusedKey, requireSignIn } from "./auth/credential.js";
import { keyFilePath } from "./auth/keyFile.js";
import { builtInHelp, commandHelp, generalHelp, helpJson, SIGN_IN_HINT } from "./commands/help.js";
import { login } from "./commands/login.js";
import { logout } from "./commands/logout.js";
import type { EngineContext } from "./engine/context.js";
import { renderHint, renderOutput } from "./engine/output.js";
import { runCommand } from "./engine/run.js";
import { localFile } from "./engine/context.js";
import { writeFileAtomic } from "./util/files.js";
import type { Command, Manifest, Output } from "./manifest/schema.js";
import type { Data } from "./engine/context.js";
import { loadManifest } from "./manifest/store.js";
import { configDir } from "./util/files.js";
import { CliError, EXIT, notSignedIn, userError } from "./util/errors.js";
import { type GlobalFlags, type Io, Out, processIo } from "./util/io.js";

const DEFAULT_FLAGS: GlobalFlags = {
  json: false,
  yes: false,
  quiet: false,
  debug: false,
  help: false,
  version: false,
  api: undefined,
};

function signedApi(io: Io, out: Out, signed: SignedIn): Api {
  return new Api(io, out, signed.origin, async () => signed.token);
}

async function help(io: Io, out: Out, flags: GlobalFlags, words: string[]): Promise<number> {
  const builtIn = words.length ? builtInHelp(words[0]!) : undefined;
  if (builtIn) {
    out.result(builtIn);
    return EXIT.ok;
  }
  let signed: SignedIn | undefined;
  try {
    signed = await requireSignIn(io, out, flags);
  } catch (error) {
    if (error instanceof CliError && error.exitCode !== EXIT.notSignedIn) out.debug(error.message);
  }
  let manifest: Manifest | undefined;
  if (signed) {
    try {
      manifest = (await loadManifest(signedApi(io, out, signed), io, signed.token)).manifest;
    } catch (error) {
      if (error instanceof CliError && error.status === 401) {
        await forgetRefusedKey(io, out, signed);
      } else {
        throw error;
      }
    }
  }
  if (words.length) {
    if (!manifest) throw notSignedIn(`${SIGN_IN_HINT} Run: rlx login`);
    const found = findCommand(manifest.commands, words);
    if (!found) throw userError(`Unknown command: ${words.join(" ")}. Run: rlx help`, "UNKNOWN_COMMAND");
    out.result(flags.json ? JSON.stringify(found.command, null, 2) : commandHelp(found.command));
    return EXIT.ok;
  }
  out.result(flags.json ? JSON.stringify(helpJson(manifest), null, 2) : generalHelp(manifest));
  return EXIT.ok;
}

async function runManifestCommand(io: Io, out: Out, flags: GlobalFlags, rest: string[]): Promise<number> {
  const words = leadingWords(rest);
  let signed: SignedIn;
  try {
    signed = await requireSignIn(io, out, flags);
  } catch (error) {
    if (error instanceof CliError && error.exitCode === EXIT.notSignedIn) {
      throw notSignedIn(`You are not signed in, so rlx has no command "${words[0]}". Run: rlx login`);
    }
    throw error;
  }
  const api = signedApi(io, out, signed);
  try {
    let { manifest, fromCache } = await loadManifest(api, io, signed.token);
    let found = findCommand(manifest.commands, words);
    if (!found && fromCache) {
      manifest = (await loadManifest(api, io, signed.token, { refresh: true })).manifest;
      found = findCommand(manifest.commands, words);
    }
    if (!found) throw userError(`Unknown command: ${words.join(" ")}. Run: rlx help`, "UNKNOWN_COMMAND");
    const ctx: EngineContext = {
      io,
      out,
      api,
      flags,
      protectedPaths: [configDir(io), join(keyFilePath(io, signed.config.credentials), "..")],
    };
    if (flags.help) return await commandHelpWithExplain(ctx, found.command, rest.slice(found.used));
    const args = parseCommandArgs(found.command, rest.slice(found.used));
    const data = await runCommand(ctx, found.command, args);
    await printOutput(ctx, found.command.output, data, args);
    return EXIT.ok;
  } catch (error) {
    if (error instanceof CliError && error.status === 401) await forgetRefusedKey(io, out, signed);
    throw error;
  }
}

/** Prints the output of a command: to standard output, or to the file of its save option. Then the hint. */
async function printOutput(ctx: EngineContext, output: Output | undefined, data: Data, args: Record<string, unknown>): Promise<void> {
  const text = renderOutput(output, data, ctx.flags.json);
  const file = output?.save === undefined ? undefined : args[output.save];
  if (text !== undefined && typeof file === "string" && file) {
    const path = localFile(ctx, file);
    await writeFileAtomic(path, text.endsWith("\n") ? text : `${text}\n`, 0o644);
    ctx.out.info(`Wrote ${file}.`);
  } else if (text !== undefined) {
    ctx.out.result(text);
  }
  if (!ctx.flags.json) {
    const hint = renderHint(output, data);
    if (hint) ctx.out.info(hint);
  }
}

/**
 * The help of a command. A command with explain runs its steps when the
 * positional arguments are given, and prints that output after the help.
 */
async function commandHelpWithExplain(ctx: EngineContext, command: Command, argv: string[]): Promise<number> {
  const help = commandHelp(command);
  const args = command.explain ? parseCommandArgs(command, argv, { lenient: true }) : {};
  const given = (command.args ?? []).some((arg) => arg.kind === "positional" && args[arg.name] !== undefined);
  if (!command.explain || !given) {
    ctx.out.result(ctx.flags.json ? JSON.stringify(command, null, 2) : help);
    return EXIT.ok;
  }
  const data = await runCommand(ctx, { ...command, steps: command.explain.steps }, args);
  const text = renderOutput(command.explain.output, data, ctx.flags.json);
  ctx.out.result(ctx.flags.json ? (text ?? "null") : [help, text].filter(Boolean).join("\n\n"));
  return EXIT.ok;
}

function report(out: Out, flags: GlobalFlags, error: unknown): number {
  const cli = error instanceof CliError ? error : undefined;
  const exitCode = cli?.exitCode ?? EXIT.user;
  const message = cli ? cli.message : `Unexpected error: ${(error as Error)?.message ?? String(error)}`;
  if (!cli && flags.debug && error instanceof Error && error.stack) out.debug(error.stack);
  if (flags.json) {
    out.result(JSON.stringify({
      error: {
        code: cli?.code ?? "ERROR", message, status: cli?.status ?? null, exit_code: exitCode,
        ...(cli?.callId ? { call_id: cli.callId } : {}),
        ...(cli?.hint ? { hint: cli.hint } : {}),
      },
    }));
  } else {
    out.warn(`Error${cli?.code ? ` ${cli.code}` : ""}: ${message}`);
    if (cli?.callId) out.warn(`Call id: ${cli.callId}`);
    if (cli?.hint) out.warn(cli.hint);
  }
  return exitCode;
}

/** Runs rlx with the arguments, and returns the exit code. */
export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  let flags = DEFAULT_FLAGS;
  let out = new Out(io, flags);
  try {
    const parsed = parseGlobals(argv);
    flags = parsed.flags;
    out = new Out(io, flags);
    if (flags.version) {
      out.result(RLX_VERSION);
      return EXIT.ok;
    }
    const words = leadingWords(parsed.rest);
    const first = words[0];
    if ((first === "login" || first === "logout") && flags.help) {
      out.result(builtInHelp(first)!);
      return EXIT.ok;
    }
    if (first === "login" || first === "logout") {
      if (parsed.rest.length > 1) throw userError(`Unknown argument for ${first}: ${parsed.rest[1]}`);
      return first === "login" ? await login(io, out, flags, parsed.noKey) : await logout(io, out, flags);
    }
    if (parsed.noKey) throw userError("--no-key is an option of rlx login.");
    if (first === undefined || first === "help") {
      if (first === undefined && parsed.rest.length > 0) throw userError(`Unknown option: ${parsed.rest[0]}`);
      return await help(io, out, flags, first === "help" ? words.slice(1) : []);
    }
    return await runManifestCommand(io, out, flags, parsed.rest);
  } catch (error) {
    return report(out, flags, error);
  }
}
