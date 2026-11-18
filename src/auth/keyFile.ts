// SPDX-License-Identifier: Apache-2.0
// The key file in the home folder. It holds API keys only, one entry for each
// API origin, with the access modes that client-config states. It never holds
// a session token or a refresh token.

import { chmod, mkdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Io } from "../util/io.js";
import type { CredentialConvention } from "./clientConfig.js";
import { readJsonFile, writeFileAtomic } from "../util/files.js";
import { userError } from "../util/errors.js";
import { registerSecret } from "../util/mask.js";

export interface KeyEntry {
  api_key: string;
  prefix: string;
  expires_at: number;
  name: string;
  [extra: string]: unknown;
}

export interface KeyFileDocument {
  version: 1;
  keys: Record<string, KeyEntry>;
  [extra: string]: unknown;
}

export function keyFilePath(io: Io, convention: CredentialConvention): string {
  const path = resolve(join(io.home, convention.keyFile.slice(2)));
  if (!path.startsWith(resolve(io.home) + "/")) throw userError("The key file must be in the home folder.");
  return path;
}

export async function readKeyFile(io: Io, convention: CredentialConvention): Promise<KeyFileDocument> {
  const path = keyFilePath(io, convention);
  const doc = await readJsonFile<KeyFileDocument>(path);
  if (!doc || typeof doc !== "object" || typeof doc.keys !== "object" || doc.keys === null) {
    return { version: 1, keys: {} };
  }
  for (const entry of Object.values(doc.keys)) registerSecret(entry?.api_key);
  return doc;
}

async function writeKeyFile(io: Io, convention: CredentialConvention, doc: KeyFileDocument): Promise<void> {
  const path = keyFilePath(io, convention);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: convention.directoryMode });
  await chmod(dir, convention.directoryMode);
  await writeFileAtomic(path, `${JSON.stringify(doc, null, 2)}\n`, convention.fileMode);
}

export async function getKeyEntry(
  io: Io,
  convention: CredentialConvention,
  origin: string,
): Promise<KeyEntry | undefined> {
  const doc = await readKeyFile(io, convention);
  const entry = doc.keys[origin];
  if (!entry || typeof entry.api_key !== "string" || entry.api_key.length === 0) return undefined;
  return entry;
}

/** Sets the entry of one origin. Each other entry stays as it is. */
export async function setKeyEntry(
  io: Io,
  convention: CredentialConvention,
  origin: string,
  entry: KeyEntry,
): Promise<KeyEntry | undefined> {
  const doc = await readKeyFile(io, convention);
  const previous = doc.keys[origin];
  doc.version = 1;
  doc.keys[origin] = { ...(previous ?? {}), ...entry };
  await writeKeyFile(io, convention, doc);
  return previous;
}

/** Removes the entry of one origin. Returns the removed entry. */
export async function removeKeyEntry(
  io: Io,
  convention: CredentialConvention,
  origin: string,
): Promise<KeyEntry | undefined> {
  const doc = await readKeyFile(io, convention);
  const previous = doc.keys[origin];
  if (!previous) return undefined;
  delete doc.keys[origin];
  await writeKeyFile(io, convention, doc);
  return previous;
}

/** The access mode of the key file, or undefined when there is no file. */
export async function keyFileMode(io: Io, convention: CredentialConvention): Promise<number | undefined> {
  try {
    return (await stat(keyFilePath(io, convention))).mode & 0o777;
  } catch {
    return undefined;
  }
}
