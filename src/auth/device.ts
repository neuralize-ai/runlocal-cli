// SPDX-License-Identifier: Apache-2.0
// The OAuth 2.0 device authorization grant (RFC 8628), with the endpoints
// that client-config states. The tokens stay in memory only.

import type { Io } from "../util/io.js";
import type { ClientConfig } from "./clientConfig.js";
import { CliError, EXIT, cancelled } from "../util/errors.js";
import { registerSecret } from "../util/mask.js";
import { isSafeForeignUrl } from "../origin.js";

export interface DeviceAuthorization {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string | undefined;
  expiresIn: number;
  interval: number;
}

interface TokenAnswer {
  access_token?: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  error?: unknown;
  error_description?: unknown;
}

async function postForm(
  io: Io,
  endpoint: string,
  form: Record<string, string>,
  debug?: (line: string) => void,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const url = new URL(endpoint);
  if (!isSafeForeignUrl(url)) throw new CliError(`The sign-in endpoint must use https: ${url.origin}`);
  debug?.(`POST ${url.origin}${url.pathname}`);
  let response: Response;
  try {
    response = await io.fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams(form).toString(),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new CliError(`Could not reach the sign-in service: ${(error as Error).message}`, {
      exitCode: EXIT.server,
    });
  }
  debug?.(`POST ${url.origin}${url.pathname} -> ${response.status}`);
  let body: Record<string, unknown> = {};
  try {
    body = (await response.json()) as Record<string, unknown>;
  } catch {
    // Not JSON: keep an empty body.
  }
  return { status: response.status, body };
}

export async function startDeviceAuthorization(
  io: Io,
  config: ClientConfig,
  debug?: (line: string) => void,
): Promise<DeviceAuthorization> {
  const { status, body } = await postForm(io, config.deviceAuthorizationEndpoint, { client_id: config.clientId }, debug);
  if (status < 200 || status >= 300 || typeof body.device_code !== "string" || typeof body.user_code !== "string") {
    const reason = typeof body.error_description === "string" ? body.error_description : `HTTP ${status}`;
    throw new CliError(`The sign-in service did not start a sign-in: ${reason}`, { exitCode: EXIT.server });
  }
  registerSecret(body.device_code);
  const verificationUri = typeof body.verification_uri === "string" ? body.verification_uri : "";
  if (!verificationUri) throw new CliError("The sign-in service sent no verification address.", { exitCode: EXIT.server });
  return {
    deviceCode: body.device_code,
    userCode: body.user_code,
    verificationUri,
    verificationUriComplete:
      typeof body.verification_uri_complete === "string" ? body.verification_uri_complete : undefined,
    expiresIn: typeof body.expires_in === "number" ? body.expires_in : 600,
    interval: typeof body.interval === "number" && body.interval > 0 ? body.interval : 5,
  };
}

/** The expiry of a JWT access token, in ms, or undefined when it is not a JWT. */
function jwtExpiry(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as { exp?: unknown };
    return typeof payload.exp === "number" ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

/** A session: an access token and a refresh token, in memory only. */
export class Session {
  private accessToken: string;
  private refreshToken: string | undefined;
  private expiresAt: number;

  constructor(
    private readonly io: Io,
    private readonly config: ClientConfig,
    answer: TokenAnswer,
    private readonly debug?: (line: string) => void,
  ) {
    this.accessToken = "";
    this.refreshToken = undefined;
    this.expiresAt = 0;
    this.accept(answer);
  }

  private accept(answer: TokenAnswer): void {
    if (typeof answer.access_token !== "string" || answer.access_token.length === 0) {
      throw new CliError("The sign-in service sent no access token.", { exitCode: EXIT.server });
    }
    this.accessToken = answer.access_token;
    // The refresh token rotates: keep the new one, and drop the old one.
    this.refreshToken = typeof answer.refresh_token === "string" ? answer.refresh_token : undefined;
    registerSecret(this.accessToken);
    registerSecret(this.refreshToken);
    const fromAnswer = typeof answer.expires_in === "number" ? this.io.now() + answer.expires_in * 1000 : undefined;
    this.expiresAt =
      fromAnswer ?? jwtExpiry(this.accessToken) ?? this.io.now() + this.config.sessionSeconds * 1000;
  }

  /** The access token. It is refreshed first when it expires within a minute. */
  async token(): Promise<string> {
    if (this.expiresAt - this.io.now() < 60_000) await this.refresh();
    return this.accessToken;
  }

  async refresh(): Promise<void> {
    if (!this.refreshToken) {
      throw new CliError("The session expired and cannot be refreshed. Run: rlx login", {
        exitCode: EXIT.notSignedIn,
      });
    }
    const { status, body } = await postForm(
      this.io,
      this.config.tokenEndpoint,
      { grant_type: this.config.refreshGrantType, refresh_token: this.refreshToken, client_id: this.config.clientId },
      this.debug,
    );
    if (status < 200 || status >= 300) {
      throw new CliError("The session could not be refreshed. Run: rlx login", { exitCode: EXIT.notSignedIn });
    }
    this.accept(body as TokenAnswer);
  }
}

/** Polls the token endpoint until the person approves, denies, or the code expires. */
export async function waitForApproval(
  io: Io,
  config: ClientConfig,
  device: DeviceAuthorization,
  debug?: (line: string) => void,
): Promise<Session> {
  let interval = device.interval;
  const deadline = io.now() + device.expiresIn * 1000;
  for (;;) {
    await io.sleep(interval * 1000);
    if (io.now() > deadline) throw new CliError("The sign-in code expired. Run rlx login again.");
    const { status, body } = await postForm(
      io,
      config.tokenEndpoint,
      { grant_type: config.deviceGrantType, device_code: device.deviceCode, client_id: config.clientId },
      debug,
    );
    if (status >= 200 && status < 300 && typeof body.access_token === "string") {
      return new Session(io, config, body as TokenAnswer, debug);
    }
    const error = typeof body.error === "string" ? body.error : "";
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      interval += 5;
      continue;
    }
    if (error === "access_denied") throw cancelled("The sign-in was denied.");
    if (error === "expired_token") throw new CliError("The sign-in code expired. Run rlx login again.");
    const reason = typeof body.error_description === "string" ? body.error_description : error || `HTTP ${status}`;
    throw new CliError(`The sign-in failed: ${reason}`, { exitCode: EXIT.server });
  }
}
