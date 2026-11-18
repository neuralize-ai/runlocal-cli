// SPDX-License-Identifier: Apache-2.0
import { hostname } from "node:os";
import type { GlobalFlags, Io, Out } from "../util/io.js";
import { loadClientConfig } from "../auth/clientConfig.js";
import { startDeviceAuthorization, waitForApproval } from "../auth/device.js";
import { setKeyEntry } from "../auth/keyFile.js";
import { AUTH_STATUS_PATH, Api } from "../api.js";
import { readSettings, resolveOrigin, writeSettings } from "../origin.js";
import { loadManifest, dropManifestCaches } from "../manifest/store.js";
import { CliError, EXIT } from "../util/errors.js";
import { registerSecret } from "../util/mask.js";

function date(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The device sign-in, then an offer to store an API key in the key file. */
export async function login(io: Io, out: Out, flags: GlobalFlags, noKey: boolean): Promise<number> {
  const debug = (line: string): void => out.debug(line);
  const origin = await resolveOrigin(io, flags.api);
  const config = await loadClientConfig(io, origin, { refresh: true, debug });

  const device = await startDeviceAuthorization(io, config, debug);
  out.warn(
    [
      "To sign in, open this address in a browser:",
      `  ${device.verificationUriComplete ?? device.verificationUri}`,
      `and check that it shows this code: ${device.userCode}`,
      "Waiting for you to approve the sign-in...",
    ].join("\n"),
  );
  const session = await waitForApproval(io, config, device, debug);
  const api = new Api(io, out, origin, () => session.token());

  const status = (await api.request({ method: "GET", path: AUTH_STATUS_PATH })).body as { email?: unknown } | null;
  const email = typeof status?.email === "string" ? status.email : undefined;
  out.info(`Signed in to ${origin}${email ? ` as ${email}` : ""}.`);

  const settings = await readSettings(io);
  await writeSettings(io, { ...settings, origin });

  const where = `${config.credentials.keyFile} (access ${config.credentials.fileMode.toString(8).padStart(4, "0")})`;
  let stored = false;
  if (!noKey) {
    let approved = flags.yes;
    if (!approved && io.interactive) {
      const answer = (await io.prompt(`Store an API key in ${where}, so that rlx works next time? [Y/n] `))
        .trim()
        .toLowerCase();
      approved = answer === "" || answer === "y" || answer === "yes";
    } else if (!approved) {
      out.info("rlx cannot ask here, so it stores no key. Run rlx login --yes to store one.");
    }
    if (approved) stored = await storeKey(io, out, api, origin, config.credentials, where, config.workspaceUrl);
  }

  if (stored) {
    await dropManifestCaches(io, origin);
    out.info("Run rlx help to see your commands.");
  } else {
    out.info(
      `No key is stored, so the session ends when rlx stops. To use rlx, set ${config.credentials.keyEnv}, or run rlx login again to store a key.`,
    );
  }
  if (flags.json) out.result(JSON.stringify({ signed_in: true, origin, email: email ?? null, key_stored: stored }));
  return EXIT.ok;
}

async function storeKey(
  io: Io,
  out: Out,
  api: Api,
  origin: string,
  convention: Parameters<typeof setKeyEntry>[1],
  where: string,
  workspaceUrl: string | undefined,
): Promise<boolean> {
  const { manifest } = await loadManifest(api, io, "", { cache: false });
  const path = manifest.auth?.api_keys;
  if (!path) {
    out.warn("This API does not offer a key to rlx.");
    return false;
  }
  const name = `rlx on ${hostname()}`.slice(0, 80);
  const created = (await api.request({ method: "POST", path, body: { name } })).body as Record<string, unknown> | null;
  const apiKey = created?.api_key;
  if (typeof apiKey !== "string" || apiKey.length === 0) {
    throw new CliError("The API did not send the new key.", { exitCode: EXIT.server });
  }
  registerSecret(apiKey);
  const prefix = typeof created?.prefix === "string" ? created.prefix : "";
  const expiresAt = typeof created?.expires_at === "number" ? created.expires_at : 0;
  const previous = await setKeyEntry(io, convention, origin, {
    api_key: apiKey,
    prefix,
    expires_at: expiresAt,
    name,
  });
  out.info(`Stored the key ${prefix}… in ${where}.${expiresAt ? ` It expires on ${date(expiresAt)}.` : ""}`);
  if (previous && previous.api_key !== apiKey) {
    const place = workspaceUrl ? ` at ${workspaceUrl}` : "";
    out.info(
      `The old key ${previous.prefix || ""}… was replaced in the file. It works until it expires: you can revoke it in the workspace${place}.`,
    );
  }
  return true;
}
