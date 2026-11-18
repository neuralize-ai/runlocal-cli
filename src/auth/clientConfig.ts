// SPDX-License-Identifier: Apache-2.0
import { join } from "node:path";
import type { Io } from "../util/io.js";
import { configDir, ensureDir, readJsonFile, shortHash, writeFileAtomic } from "../util/files.js";
import { CliError, EXIT } from "../util/errors.js";

/** The public sign-in configuration that the API states. */
export const CLIENT_CONFIG_PATH = "/api/v1/client-config";

export interface CredentialConvention {
  /** The environment variable that can hold an API key. */
  keyEnv: string;
  /** The key file, in the home folder, as the API states it (for example ~/x/y.json). */
  keyFile: string;
  directoryMode: number;
  fileMode: number;
  renewDays: number;
}

export interface ClientConfig {
  clientId: string;
  deviceAuthorizationEndpoint: string;
  tokenEndpoint: string;
  deviceGrantType: string;
  refreshGrantType: string;
  workspaceUrl: string | undefined;
  sessionSeconds: number;
  credentials: CredentialConvention;
}

const MAX_AGE_MS = 24 * 60 * 60 * 1000;

function str(value: unknown, name: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new CliError(`The sign-in configuration has no ${name}.`, { exitCode: EXIT.server });
  }
  return value;
}

function mode(value: unknown, fallback: number): number {
  if (typeof value === "string" && /^0?[0-7]{3}$/.test(value)) return Number.parseInt(value, 8);
  if (typeof value === "number" && Number.isInteger(value)) return value;
  return fallback;
}

/** Reads the answer of client-config into the values that rlx uses. */
export function parseClientConfig(raw: unknown): ClientConfig {
  if (typeof raw !== "object" || raw === null) {
    throw new CliError("The sign-in configuration is not a JSON object.", { exitCode: EXIT.server });
  }
  const body = raw as Record<string, unknown>;
  // The client id is the field "client_id", or the one field whose name ends with it.
  const idKey =
    "client_id" in body ? "client_id" : Object.keys(body).find((key) => key.endsWith("_client_id"));
  const creds = (body.credentials ?? {}) as Record<string, unknown>;
  const keyFile = str(creds.key_file, "key file");
  if (!keyFile.startsWith("~/") || keyFile.includes("..")) {
    throw new CliError("The sign-in configuration names a key file outside the home folder.", {
      exitCode: EXIT.server,
    });
  }
  return {
    clientId: str(idKey ? body[idKey] : undefined, "client id"),
    deviceAuthorizationEndpoint: str(body.device_authorization_endpoint, "device authorization endpoint"),
    tokenEndpoint: str(body.token_endpoint, "token endpoint"),
    deviceGrantType: str(body.device_grant_type, "device grant type"),
    refreshGrantType: str(body.refresh_grant_type, "refresh grant type"),
    workspaceUrl: typeof body.workspace_url === "string" ? body.workspace_url : undefined,
    sessionSeconds:
      typeof body.session_seconds === "number" && body.session_seconds > 0 ? body.session_seconds : 3600,
    credentials: {
      keyEnv: str(creds.key_env, "key variable"),
      keyFile,
      directoryMode: mode(creds.directory_mode, 0o700),
      fileMode: mode(creds.file_mode, 0o600),
      renewDays: typeof creds.renew_days === "number" ? creds.renew_days : 7,
    },
  };
}

interface CachedConfig {
  origin: string;
  fetched_at: number;
  body: unknown;
}

/**
 * Reads client-config for the origin. The answer is public, so rlx keeps it
 * for one day in the config folder.
 */
export async function loadClientConfig(
  io: Io,
  origin: string,
  options: { refresh?: boolean; debug?: (line: string) => void } = {},
): Promise<ClientConfig> {
  const path = join(configDir(io), `client-config-${shortHash(origin)}.json`);
  if (!options.refresh) {
    const cached = await readJsonFile<CachedConfig>(path);
    if (cached && cached.origin === origin && io.now() - cached.fetched_at < MAX_AGE_MS) {
      try {
        return parseClientConfig(cached.body);
      } catch {
        // Read it again below.
      }
    }
  }
  const url = new URL(CLIENT_CONFIG_PATH, origin);
  let body: unknown;
  try {
    options.debug?.(`GET ${url.href}`);
    const response = await io.fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    options.debug?.(`GET ${url.href} -> ${response.status}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    body = await response.json();
  } catch (error) {
    throw new CliError(`Could not read the sign-in configuration of ${origin}: ${(error as Error).message}`, {
      exitCode: EXIT.server,
    });
  }
  const config = parseClientConfig(body);
  await ensureDir(configDir(io));
  await writeFileAtomic(path, JSON.stringify({ origin, fetched_at: io.now(), body } satisfies CachedConfig));
  return config;
}
