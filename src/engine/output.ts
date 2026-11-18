// SPDX-License-Identifier: Apache-2.0
import type { Output } from "../manifest/schema.js";
import type { Data } from "./context.js";
import { lookup, parsePath, renderString, stringify } from "./template.js";

function cell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "-";
  return stringify(value).replace(/\s+/g, " ");
}

/** Lays out rows as a plain text table, with a heading line. */
export function formatTable(rows: unknown[], columns: [string, string][]): string {
  const paths = columns.map(([path]) => parsePath(path));
  const lines = [columns.map(([, heading]) => heading), ...rows.map((row) => paths.map((path) => cell(lookup(row, path))))];
  const widths = columns.map((_, i) => Math.max(...lines.map((line) => line[i]!.length)));
  return lines
    .map((line) => line.map((text, i) => (i === line.length - 1 ? text : text.padEnd(widths[i]!))).join("  ").trimEnd())
    .join("\n");
}

/**
 * Returns the text that a command prints. With --json, it is the JSON of the
 * value that the output names (or of the value at output.json), for a program to read.
 */
export function renderOutput(output: Output | undefined, data: Data, json: boolean): string | undefined {
  if (!output) return json ? JSON.stringify({ ok: true }) : undefined;
  if (json && output.json !== undefined) return JSON.stringify(lookup(data, parsePath(output.json)) ?? null, null, 2);
  if (output.kind === "markdown" && output.text !== undefined) {
    const text = renderString(output.text, data);
    return json ? JSON.stringify({ text }) : text;
  }
  const value = output.from === undefined ? withoutArgs(data) : lookup(data, parsePath(output.from));
  if (json || output.kind === "json") return JSON.stringify(value ?? null, null, 2);
  if (output.kind === "markdown") return stringify(value);
  const rows = Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
  if (rows.length === 0) return output.empty ?? "Nothing to show.";
  return formatTable(rows, output.columns);
}

function withoutArgs(data: Data): Data {
  const { args: _args, ...rest } = data;
  return rest;
}

/** The hint of an output, or undefined when it has none or it is empty. */
export function renderHint(output: Output | undefined, data: Data): string | undefined {
  if (!output?.hint) return undefined;
  const text = renderString(output.hint, data).trim();
  return text || undefined;
}
