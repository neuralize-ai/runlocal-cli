// SPDX-License-Identifier: Apache-2.0
import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Api } from "../api.js";
import type { GlobalFlags, Io, Out } from "../util/io.js";
import { userError } from "../util/errors.js";

export interface EngineContext {
  io: Io;
  out: Out;
  api: Api;
  flags: GlobalFlags;
  /** Folders and files that a step may never read: the key file and the config folder. */
  protectedPaths: string[];
}

/** The data that templates read: args, and the result of each named step. */
export type Data = Record<string, unknown>;

function inside(path: string, folder: string): boolean {
  return path === folder || path.startsWith(folder.endsWith(sep) ? folder : folder + sep);
}

/**
 * The real path of a path: each symbolic link of the part that exists is
 * resolved, and the part that does not exist yet is added as it is.
 */
export function realPath(path: string): string {
  const full = resolve(path);
  try {
    return realpathSync.native(full);
  } catch {
    const parent = dirname(full);
    return parent === full ? full : join(realPath(parent), basename(full));
  }
}

/**
 * Resolves a local file or folder that a step reads or writes, and refuses
 * the folders of rlx: the path itself, and its real path after each symbolic
 * link, cannot be in one of them.
 */
export function localFile(ctx: EngineContext, path: string): string {
  if (!path) throw userError("No file was given.");
  if (path.includes("\0")) throw userError("A file name cannot hold a NUL character.", "FILE.REFUSED");
  const full = resolve(ctx.io.cwd, path);
  const real = realPath(full);
  for (const protectedPath of ctx.protectedPaths) {
    const folders = [resolve(protectedPath), realPath(protectedPath)];
    if (folders.some((folder) => inside(full, folder) || inside(real, folder))) {
      throw userError(`Refused to use ${path}: rlx keeps credentials there.`, "FILE.REFUSED");
    }
  }
  return full;
}

/** The folder of the project: the nearest folder up with .runlocal or .git, else the current folder. */
export function projectRoot(cwd: string): string {
  for (const marker of [".runlocal", ".git"]) {
    let dir = resolve(cwd);
    for (;;) {
      if (existsSync(join(dir, marker))) return dir;
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return resolve(cwd);
}
