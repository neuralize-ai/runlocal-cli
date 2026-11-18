// SPDX-License-Identifier: Apache-2.0
import type { ApiRequest } from "../api.js";
import type { Condition, RequestSpec } from "../manifest/schema.js";
import type { Data } from "./context.js";
import { lookup, parsePath, renderDeep, renderString } from "./template.js";
import { userError } from "../util/errors.js";

/** A lone surrogate: a string with one is not valid Unicode. */
const LONE_SURROGATE = /\p{Surrogate}/u;

/**
 * Encodes one value for a URL path. A value cannot be empty, ".", or "..", and
 * it must be valid Unicode (a lone surrogate cannot be encoded).
 */
export function encodePathValue(value: string): string {
  if (value === "" || value === "." || value === ".." || LONE_SURROGATE.test(value)) {
    throw userError(`${JSON.stringify(value)} is not a value that can go in an address.`, "PATH.INVALID");
  }
  return encodeURIComponent(value);
}

/** A header value: no control character other than tab, and no character above U+00FF. */
const HEADER_VALUE = /^[\t\x20-\x7e\x80-\xff]*$/;

/** Builds a request from its spec and the data. Values in the path are URL-encoded. */
export function buildRequest(spec: RequestSpec, data: Data): ApiRequest {
  const path = renderString(spec.path, data, { encode: encodePathValue, required: true });
  const query = spec.query ? (renderDeep(spec.query, data) as Record<string, unknown>) : undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(spec.headers ?? {})) {
    const rendered = renderString(value, data);
    if (!HEADER_VALUE.test(rendered)) {
      throw userError(`The value of the header ${name} has a character that a header cannot hold.`, "HEADER.INVALID");
    }
    if (rendered) headers[name] = rendered;
  }
  const body = spec.body === undefined ? undefined : renderDeep(spec.body, data);
  return { method: spec.method, path, query, headers, body };
}

/** Tests a condition on a value. */
export function holds(condition: Condition, value: unknown): boolean {
  const field = lookup(value, parsePath(condition.field));
  if (condition.in) return condition.in.some((item) => item === field);
  return field !== undefined && field !== null && field !== "";
}
