// SPDX-License-Identifier: Apache-2.0
// The one place that sends a request with a credential. Each request goes to
// the signed-in origin, or it is refused.

import type { Io, Out } from "./util/io.js";
import { CliError, EXIT } from "./util/errors.js";
import { registerSecret } from "./util/mask.js";

export const AUTH_STATUS_PATH = "/api/v1/auth/status";

/** The response header in which the server can state the version of the manifest. */
export const MANIFEST_VERSION_HEADER = "x-manifest-version";

/** The response header in which the server can state the id of the call. */
export const CALL_ID_HEADER = "x-call-id";

/** A call id or a hint of the server: printable text of at most `max` characters, else undefined. */
function plainText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  return text && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : undefined;
}

export type Method = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export interface ApiRequest {
  method: Method;
  path: string;
  query?: Record<string, unknown>;
  headers?: Record<string, string>;
  body?: unknown;
  /** Sends If-None-Match; a 304 answer then counts as success. */
  ifNoneMatch?: string;
}

export interface ApiResponse {
  status: number;
  headers: Headers;
  body: unknown;
}

/** Headers that a manifest may not set. */
export const BLOCKED_HEADERS = new Set(["authorization", "cookie", "host", "proxy-authorization", "content-length"]);
/** Header name prefixes that a manifest may not set. */
export const BLOCKED_HEADER_PREFIXES = ["proxy-", "sec-"];

export function blockedHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return BLOCKED_HEADERS.has(lower) || BLOCKED_HEADER_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** Resolves a path against the origin, and refuses any other origin. */
export function pinnedUrl(origin: string, path: string): URL {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\")) {
    throw new CliError(`Refused a request to "${path}": the path must start with one "/".`, {
      code: "ORIGIN.REFUSED",
    });
  }
  const url = new URL(path, origin);
  if (url.origin !== origin) {
    throw new CliError(`Refused a request to ${url.origin}: rlx sends requests only to ${origin}.`, {
      code: "ORIGIN.REFUSED",
    });
  }
  return url;
}

function appendQuery(url: URL, query: Record<string, unknown> | undefined): void {
  if (!query) return;
  for (const [name, value] of Object.entries(query)) {
    const values = Array.isArray(value) ? value : [value];
    for (const item of values) {
      if (item === undefined || item === null || item === "") continue;
      url.searchParams.append(name, typeof item === "object" ? JSON.stringify(item) : String(item));
    }
  }
}

/**
 * Reads an error answer of the API: { error: { code, message } }, with the
 * id of the call (error.call_id, else the X-Call-Id header)
 * and the hint of the server (error.hint), when there are.
 */
export function apiError(status: number, body: unknown, headers?: Headers): CliError {
  const error = (body as { error?: { code?: unknown; message?: unknown; call_id?: unknown; hint?: unknown } } | undefined)?.error;
  const code = typeof error?.code === "string" ? error.code : `HTTP.${status}`;
  const message =
    typeof error?.message === "string"
      ? error.message
      : typeof body === "string" && body.trim()
        ? body.trim().slice(0, 500)
        : `The server answered ${status}.`;
  const exitCode = status === 401 ? EXIT.notSignedIn : status >= 500 || status === 429 ? EXIT.server : EXIT.user;
  const callId = plainText(error?.call_id, 100) ?? plainText(headers?.get(CALL_ID_HEADER), 100);
  const hint = plainText(error?.hint, 300);
  return new CliError(message, { exitCode, code, status, callId, hint });
}

export class Api {
  /** Called with the manifest version that a response states. */
  onManifestVersion: ((version: string) => void | Promise<void>) | undefined;

  constructor(
    readonly io: Io,
    readonly out: Out,
    readonly origin: string,
    private readonly credential: () => Promise<string>,
  ) {}

  async request(req: ApiRequest): Promise<ApiResponse> {
    const url = pinnedUrl(this.origin, req.path);
    appendQuery(url, req.query);
    const token = await this.credential();
    registerSecret(token);
    const headers: Record<string, string> = {
      Accept: "application/json",
      "User-Agent": `rlx/${RLX_VERSION}`,
    };
    // A header of the request replaces a default of the same name, in any case.
    const named = (name: string) => Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
    for (const [name, value] of Object.entries(req.headers ?? {})) {
      if (blockedHeader(name)) throw new CliError(`Refused to set the header ${name}.`, { code: "HEADER.REFUSED" });
      const previous = named(name);
      if (previous !== undefined) delete headers[previous];
      headers[name] = value;
    }
    if (req.ifNoneMatch) headers["If-None-Match"] = req.ifNoneMatch;
    headers.Authorization = `Bearer ${token}`;
    let body: string | undefined;
    if (req.body !== undefined && req.method !== "GET") {
      if (named("Content-Type") === undefined) headers["Content-Type"] = "application/json";
      body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
    }
    const started = this.io.now();
    let response: Response;
    try {
      response = await this.io.fetch(url, {
        method: req.method,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
    } catch (error) {
      throw new CliError(`Could not reach ${this.origin}: ${(error as Error).message}`, {
        exitCode: EXIT.server,
        code: "NETWORK",
      });
    }
    this.out.debug(`${req.method} ${url.pathname}${url.search} -> ${response.status} (${this.io.now() - started} ms)`);
    if (response.status === 304 && req.ifNoneMatch) {
      return { status: 304, headers: response.headers, body: null };
    }
    if (response.status >= 300 && response.status < 400) {
      throw new CliError(`Refused to follow a redirect from ${url.pathname}.`, {
        exitCode: EXIT.server,
        code: "ORIGIN.REFUSED",
        status: response.status,
      });
    }
    const version = response.headers.get(MANIFEST_VERSION_HEADER);
    if (version) await this.onManifestVersion?.(version);
    const text = await response.text();
    let parsed: unknown = text;
    if (text && (response.headers.get("content-type") ?? "").includes("json")) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    } else if (!text) {
      parsed = null;
    }
    if (response.status < 200 || response.status >= 300) throw apiError(response.status, parsed, response.headers);
    return { status: response.status, headers: response.headers, body: parsed };
  }
}
