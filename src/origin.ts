// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import type { Io } from "./util/io.js";
import { configDir, ensureDir, readJsonFile, writeFileAtomic } from "./util/files.js";
import { CliError, EXIT, userError } from "./util/errors.js";

/** The public website. Its discovery file names the API origin. */
export const WEBSITE = "https://www.runlocal.ai";
/** The name of the service, for people. */
export const SITE_NAME = "RunLocal";
const DISCOVERY_FILE = "/.well-known/runlocal.json";

function isLoopback(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

/**
 * Returns the origin (scheme, host and port) of an address. Only https is
 * accepted, except on this machine (localhost), where http is accepted too.
 */
export function normalizeOrigin(input: string): string {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw userError(`Not an address: ${input}. Give an origin such as https://api.example.com.`);
  }
  if (url.username || url.password) throw userError("Do not put a user name or a password in the address.");
  if (url.protocol !== "https:" && !(url.protocol === "http:" && isLoopback(url.hostname))) {
    throw userError(`Use https for ${url.origin}. Plain http is only for localhost.`);
  }
  if ((url.pathname !== "/" && url.pathname !== "") || url.search || url.hash) {
    throw userError(`Give an origin with no path: ${url.origin}`);
  }
  return url.origin;
}

/** True when a URL may receive a request without a credential (a signed URL). */
export function isSafeForeignUrl(url: URL): boolean {
  return url.protocol === "https:" || (url.protocol === "http:" && isLoopback(url.hostname));
}

interface Settings {
  origin?: string;
  /** The API origin that the public website named, the last time rlx read its discovery file. */
  site_origin?: string;
}

function settingsPath(io: Io): string {
  return join(configDir(io), "settings.json");
}

export async function readSettings(io: Io): Promise<Settings> {
  return (await readJsonFile<Settings>(settingsPath(io))) ?? {};
}

export async function writeSettings(io: Io, settings: Settings): Promise<void> {
  await ensureDir(configDir(io));
  await writeFileAtomic(settingsPath(io), `${JSON.stringify(settings, null, 2)}\n`);
}

/** Reads the API origin from the discovery file of the public website, and keeps it as the origin of the website. */
async function discoverOrigin(io: Io): Promise<string> {
  const origin = await readDiscovery(io);
  const settings = await readSettings(io);
  if (settings.site_origin !== origin) await writeSettings(io, { ...settings, site_origin: origin });
  return origin;
}

async function readDiscovery(io: Io): Promise<string> {
  let body: { discovery?: unknown };
  try {
    const response = await io.fetch(new URL(DISCOVERY_FILE, WEBSITE), {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = (await response.json()) as { discovery?: unknown };
  } catch (error) {
    throw new CliError(
      `Could not find the API address (${(error as Error).message}). Give it with --api <origin>.`,
      { exitCode: EXIT.server },
    );
  }
  if (typeof body.discovery !== "string") {
    throw new CliError("The website did not name the API address. Give it with --api <origin>.", {
      exitCode: EXIT.server,
    });
  }
  return normalizeOrigin(new URL(body.discovery).origin);
}

/**
 * How rlx names an API origin for people: the public website, such as
 * "RunLocal (https://www.runlocal.ai)", when the website names that origin;
 * else the origin itself. rlx still sends each request to the API origin.
 * When rlx has not read the discovery file yet, it reads it once (not for an
 * origin on this machine); when it cannot, it names the origin.
 */
export async function originName(io: Io, origin: string): Promise<string> {
  const settings = await readSettings(io);
  let site = settings.site_origin;
  if (site === undefined && !isLoopback(new URL(origin).hostname)) site = await discoverOrigin(io).catch(() => undefined);
  return site === origin ? `${SITE_NAME} (${WEBSITE})` : origin;
}

/**
 * The API origin to use: --api, else the origin of the last sign-in, else the
 * origin that the public website names.
 */
export async function resolveOrigin(io: Io, flag: string | undefined): Promise<string> {
  if (flag) return normalizeOrigin(flag);
  const settings = await readSettings(io);
  if (settings.origin) return normalizeOrigin(settings.origin);
  return discoverOrigin(io);
}
