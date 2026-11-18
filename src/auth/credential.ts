// SPDX-License-Identifier: Apache-2.0
import type { GlobalFlags, Io, Out } from "../util/io.js";
import { type ClientConfig, loadClientConfig } from "./clientConfig.js";
import { type KeyEntry, getKeyEntry, keyFilePath, removeKeyEntry } from "./keyFile.js";
import { resolveOrigin } from "../origin.js";
import { registerSecret } from "../util/mask.js";
import { notSignedIn } from "../util/errors.js";
import { AUTH_STATUS_PATH, Api } from "../api.js";
import { dropManifestCaches } from "../manifest/store.js";

export interface SignedIn {
  origin: string;
  config: ClientConfig;
  token: string;
  source: "env" | "file";
  entry?: KeyEntry;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The API key to use: the environment variable that client-config names, then
 * the entry of the origin in the key file, when it has not expired.
 */
export async function currentCredential(
  io: Io,
  out: Out,
  origin: string,
  config: ClientConfig,
): Promise<SignedIn | undefined> {
  const fromEnv = io.env[config.credentials.keyEnv]?.trim();
  if (fromEnv) {
    registerSecret(fromEnv);
    return { origin, config, token: fromEnv, source: "env" };
  }
  const entry = await getKeyEntry(io, config.credentials, origin);
  if (!entry) return undefined;
  const left = entry.expires_at - io.now();
  if (typeof entry.expires_at === "number" && left <= 0) {
    out.warn(`Your stored key for ${origin} has expired. Run: rlx login`);
    return undefined;
  }
  if (typeof entry.expires_at === "number" && left < config.credentials.renewDays * DAY_MS) {
    const date = new Date(entry.expires_at).toISOString().slice(0, 10);
    out.info(`Your key expires on ${date}. Run rlx login to replace it.`);
  }
  return { origin, config, token: entry.api_key, source: "file", entry };
}

/** Finds the origin, its sign-in configuration, and a credential, or throws "not signed in". */
export async function requireSignIn(io: Io, out: Out, flags: GlobalFlags): Promise<SignedIn> {
  const origin = await resolveOrigin(io, flags.api);
  const config = await loadClientConfig(io, origin, { debug: (line) => out.debug(line) });
  const signed = await currentCredential(io, out, origin, config);
  if (!signed) throw notSignedIn();
  return signed;
}

/**
 * Called when the API refused the credential. A stored key that auth status
 * also refuses is expired or revoked: rlx removes its entry.
 */
export async function forgetRefusedKey(io: Io, out: Out, signed: SignedIn): Promise<void> {
  if (signed.source !== "file") return;
  const api = new Api(io, out, signed.origin, async () => signed.token);
  try {
    await api.request({ method: "GET", path: AUTH_STATUS_PATH });
    return;
  } catch (error) {
    if ((error as { status?: number }).status !== 401) return;
  }
  await removeKeyEntry(io, signed.config.credentials, signed.origin);
  await dropManifestCaches(io, signed.origin);
  out.warn(
    `The API refused the stored key (expired or revoked), so rlx removed it from ${keyFilePath(io, signed.config.credentials)}.`,
  );
}
