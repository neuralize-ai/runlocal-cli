// SPDX-License-Identifier: Apache-2.0
// Templates are plain interpolation: {{path}} or {{path | filter}}. A path
// names a value in the data of the command, such as args.name or list.items.0.
// A template never runs code, and a value that it inserts is never read as a
// template again.

import { CliError } from "../util/errors.js";

const TAG = /\{\{([^{}]*)\}\}/g;
export const SEGMENT = /^[A-Za-z0-9_-]+$/;
export const FORBIDDEN = new Set(["__proto__", "prototype", "constructor"]);
export const FILTERS = new Set(["default", "json", "join", "length", "string"]);

export interface Filter {
  name: string;
  arg: unknown;
}

export interface Expression {
  path: string[];
  filters: Filter[];
}

export function templateError(message: string): CliError {
  return new CliError(`Template error: ${message}`, { code: "MANIFEST.TEMPLATE" });
}

/** Parses a dotted path such as list.items.0.id. */
export function parsePath(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) throw templateError("an empty path");
  const path = trimmed.split(".");
  for (const segment of path) {
    if (!SEGMENT.test(segment)) throw templateError(`"${trimmed}" is not a path`);
    if (FORBIDDEN.has(segment)) throw templateError(`"${segment}" is not allowed in a path`);
  }
  return path;
}

function parseLiteral(text: string): unknown {
  const trimmed = text.trim();
  if (/^"(?:[^"\\]|\\.)*"$/.test(trimmed)) {
    // A JSON string: a control character or a bad escape is an error of the template.
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      throw templateError(`${trimmed} is not a valid JSON string`);
    }
  }
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const number = Number(trimmed);
    if (!Number.isFinite(number)) throw templateError(`${trimmed.slice(0, 40)}... is too large a number`);
    return number;
  }
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  throw templateError(`"${trimmed}" is not a literal (use "text", a number, true, false, or null)`);
}

/** Parses the inside of one {{ }} tag. */
export function parseExpression(text: string): Expression {
  // Split on "|" outside of quotes.
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\\" && quoted) {
      current += ch + (text[i + 1] ?? "");
      i++;
      continue;
    }
    if (ch === '"') quoted = !quoted;
    if (ch === "|" && !quoted) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (quoted) throw templateError(`an unclosed quote in "{{${text}}}"`);
  parts.push(current);
  const path = parsePath(parts[0]!);
  const filters = parts.slice(1).map((part): Filter => {
    const colon = part.indexOf(":");
    const name = (colon === -1 ? part : part.slice(0, colon)).trim();
    if (!FILTERS.has(name)) throw templateError(`"${name}" is not a filter`);
    const arg = colon === -1 ? undefined : parseLiteral(part.slice(colon + 1));
    return { name, arg };
  });
  return { path, filters };
}

/** Checks each tag of a string. Throws on an error. */
export function checkTemplate(text: string): void {
  for (const match of text.matchAll(TAG)) parseExpression(match[1]!);
  const rest = text.replace(TAG, "");
  if (rest.includes("{{") || rest.includes("}}")) throw templateError(`an unbalanced tag in "${text}"`);
}

/** Looks up a path in the data. Only own fields are read. */
export function lookup(data: unknown, path: string[]): unknown {
  for (const segment of path) {
    if (FORBIDDEN.has(segment)) throw templateError(`"${segment}" is not allowed in a path`);
  }
  let value: unknown = data;
  for (const segment of path) {
    if (value === null || value === undefined) return undefined;
    if (Array.isArray(value)) {
      // Digits index the list; "length" is the number of items; any other name has no value.
      value = /^\d+$/.test(segment) ? value[Number(segment)] : segment === "length" ? value.length : undefined;
    } else if (typeof value === "object") {
      if (!Object.prototype.hasOwnProperty.call(value, segment)) return undefined;
      value = (value as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }
  }
  return value;
}

function applyFilter(value: unknown, filter: Filter): unknown {
  switch (filter.name) {
    case "default":
      return value === undefined || value === null || value === "" ? filter.arg : value;
    case "json":
      return JSON.stringify(value ?? null);
    case "join":
      return Array.isArray(value) ? value.map(stringify).join(typeof filter.arg === "string" ? filter.arg : ",") : value;
    case "length":
      if (Array.isArray(value) || typeof value === "string") return value.length;
      if (value && typeof value === "object") return Object.keys(value).length;
      return 0;
    case "string":
      return stringify(value);
    default:
      throw templateError(`"${filter.name}" is not a filter`);
  }
}

export function stringify(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

export function evaluate(expression: Expression, data: unknown): unknown {
  let value = lookup(data, expression.path);
  for (const filter of expression.filters) value = applyFilter(value, filter);
  return value;
}

export interface RenderOptions {
  /** Encodes each inserted value for a URL path segment. */
  encode?: (value: string) => string;
  /** Fails when a tag has no value. */
  required?: boolean;
}

/**
 * Renders a string. A string that is one tag and nothing else gives the value
 * itself (a number, a list, an object). Any other string gives a string.
 */
export function render(text: string, data: unknown, options: RenderOptions = {}): unknown {
  const whole = /^\{\{([^{}]*)\}\}$/.exec(text);
  if (whole && !options.encode) {
    const value = evaluate(parseExpression(whole[1]!), data);
    if ((value === undefined || value === null) && options.required) throw templateError(`no value for {{${whole[1]!.trim()}}}`);
    return value;
  }
  checkTemplate(text);
  return text.replace(TAG, (_match, inner: string) => {
    const value = evaluate(parseExpression(inner), data);
    if ((value === undefined || value === null) && options.required) {
      throw templateError(`no value for {{${inner.trim()}}}`);
    }
    const str = stringify(value);
    return options.encode ? options.encode(str) : str;
  });
}

/** Renders a string to a string. */
export function renderString(text: string, data: unknown, options: RenderOptions = {}): string {
  return stringify(render(text, data, options));
}

/** Renders each string in a JSON value. A field whose value is undefined is left out. */
export function renderDeep(value: unknown, data: unknown): unknown {
  if (typeof value === "string") return render(value, data);
  if (Array.isArray(value)) return value.map((item) => renderDeep(item, data)).filter((item) => item !== undefined);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (FORBIDDEN.has(key)) continue;
      const rendered = renderDeep(item, data);
      if (rendered !== undefined) out[key] = rendered;
    }
    return out;
  }
  return value;
}

/** True for a value that a `when` or a condition counts as yes. */
export function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false || value === 0 || value === "") return false;
  if (typeof value === "string" && ["false", "0", "no"].includes(value.toLowerCase())) return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}
