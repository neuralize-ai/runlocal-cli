// SPDX-License-Identifier: Apache-2.0
import { createHash, randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Io } from "./io.js";

/** The config folder of rlx in the home folder. It never holds a session token. */
export function configDir(io: Io): string {
  const base = io.env.XDG_CONFIG_HOME?.trim() || join(io.home, ".config");
  return join(base, "runlocal");
}

export function shortHash(...parts: string[]): string {
  return createHash("sha256").update(parts.join("\n")).digest("hex").slice(0, 16);
}

export async function ensureDir(path: string, mode = 0o700): Promise<void> {
  await mkdir(path, { recursive: true, mode });
}

/** Writes a file beside the target, sets its mode, then renames it over the target. */
export async function writeFileAtomic(path: string, text: string, mode = 0o600): Promise<void> {
  const temp = join(dirname(path), `.${randomBytes(6).toString("hex")}.tmp`);
  try {
    await writeFile(temp, text, { mode, flag: "wx" });
    await chmod(temp, mode);
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
