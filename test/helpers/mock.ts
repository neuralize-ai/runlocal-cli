// SPDX-License-Identifier: Apache-2.0
// A local mock API for the tests. Its routes are invented, except the public
// paths that rlx itself names.

import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: IncomingHttpHeaders;
  body: Buffer;
  json(): any;
  form(): URLSearchParams;
}

export interface MockAnswer {
  status?: number;
  headers?: Record<string, string>;
  body?: unknown;
}

export type Handler = (req: MockRequest) => MockAnswer | Promise<MockAnswer>;

export interface MockServer {
  origin: string;
  requests: MockRequest[];
  on(method: string, path: string | RegExp, handler: Handler): void;
  count(method: string, path: string | RegExp): number;
  close(): Promise<void>;
}

export const TEST_KEY_ENV = "RLX_TEST_KEY";
export const TEST_KEY_FILE = "~/.rlx-test/keys.json";

export function clientConfigBody(origin: string): Record<string, unknown> {
  return {
    example_client_id: "client_test",
    device_authorization_endpoint: `${origin}/oauth/device`,
    token_endpoint: `${origin}/oauth/token`,
    device_grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    refresh_grant_type: "refresh_token",
    workspace_url: "https://workspace.example",
    session_seconds: 3600,
    credentials: {
      key_env: TEST_KEY_ENV,
      key_file: TEST_KEY_FILE,
      directory_mode: "0700",
      file_mode: "0600",
      renew_days: 7,
    },
  };
}

function matches(pattern: string | RegExp, path: string): boolean {
  return typeof pattern === "string" ? pattern === path : pattern.test(path);
}

export async function startMock(): Promise<MockServer> {
  const routes: { method: string; path: string | RegExp; handler: Handler }[] = [];
  const requests: MockRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const body = Buffer.concat(chunks);
      const recorded: MockRequest = {
        method: req.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        headers: req.headers,
        body,
        json: () => JSON.parse(body.toString("utf8")),
        form: () => new URLSearchParams(body.toString("utf8")),
      };
      requests.push(recorded);
      // The newest route wins, so a test can replace a default.
      const route = [...routes].reverse().find((r) => r.method === recorded.method && matches(r.path, recorded.path));
      let answer: MockAnswer;
      try {
        answer = route
          ? await route.handler(recorded)
          : { status: 404, body: { error: { code: "TEST.NOT_FOUND", message: `No route ${recorded.method} ${recorded.path}` } } };
      } catch (error) {
        answer = { status: 500, body: { error: { code: "TEST.HANDLER", message: String(error) } } };
      }
      const status = answer.status ?? 200;
      const headers: Record<string, string> = { ...answer.headers };
      let text = "";
      if (answer.body !== undefined && answer.body !== null) {
        if (typeof answer.body === "string") {
          text = answer.body;
          headers["content-type"] ??= "text/plain";
        } else {
          text = JSON.stringify(answer.body);
          headers["content-type"] ??= "application/json";
        }
      }
      res.writeHead(status, headers);
      res.end(text);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  const mock: MockServer = {
    origin,
    requests,
    on(method, path, handler) {
      routes.push({ method, path, handler });
    },
    count(method, path) {
      return requests.filter((r) => r.method === method && matches(path, r.path)).length;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
  mock.on("GET", "/api/v1/client-config", () => ({ body: clientConfigBody(origin) }));
  return mock;
}

/** Adds the manifest route, and an auth status that accepts `key`. */
export function serveManifest(mock: MockServer, manifest: unknown, key: string, headers: Record<string, string> = {}): void {
  const authorized = (req: MockRequest) => req.headers.authorization === `Bearer ${key}`;
  const unauthorized = { status: 401, body: { error: { code: "AUTH.REQUIRED", message: "Use a valid key." } } };
  mock.on("GET", "/api/v1/cli/manifest", (req) => (authorized(req) ? { body: manifest, headers } : unauthorized));
  mock.on("GET", "/api/v1/auth/status", (req) =>
    authorized(req) ? { body: { authenticated: true, email: "person@example.com" } } : unauthorized,
  );
}
