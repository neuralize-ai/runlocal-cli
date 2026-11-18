// SPDX-License-Identifier: Apache-2.0
import type { GlobalFlags, Io, Out } from "../util/io.js";
import { loadClientConfig } from "../auth/clientConfig.js";
import { removeKeyEntry } from "../auth/keyFile.js";
import { readSettings, resolveOrigin, writeSettings } from "../origin.js";
import { dropManifestCaches } from "../manifest/store.js";
import { EXIT } from "../util/errors.js";

/** Removes the stored key of the origin. It does not revoke the key. */
export async function logout(io: Io, out: Out, flags: GlobalFlags): Promise<number> {
  const origin = await resolveOrigin(io, flags.api);
  const config = await loadClientConfig(io, origin, { debug: (line) => out.debug(line) });
  const removed = await removeKeyEntry(io, config.credentials, origin);
  await dropManifestCaches(io, origin);
  const settings = await readSettings(io);
  if (settings.origin === origin) await writeSettings(io, { ...settings, origin: undefined });

  const place = config.workspaceUrl ? ` at ${config.workspaceUrl}` : "";
  if (removed) {
    out.info(
      `Removed the key ${removed.prefix || ""}… of ${origin} from ${config.credentials.keyFile}. ` +
        `rlx did not revoke it: it works until it expires. You can revoke it in the workspace${place}.`,
    );
  } else {
    out.info(`No key is stored for ${origin}.`);
  }
  if (io.env[config.credentials.keyEnv]) {
    out.warn(`${config.credentials.keyEnv} is set, so rlx still has a key. Unset it to sign out fully.`);
  }
  if (flags.json) out.result(JSON.stringify({ signed_out: true, origin, key_removed: Boolean(removed) }));
  return EXIT.ok;
}
