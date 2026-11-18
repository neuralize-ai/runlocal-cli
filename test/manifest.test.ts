// SPDX-License-Identifier: Apache-2.0
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findCommand, parseCommandArgs, parseGlobals } from "../src/args.js";
import { renderOutput, formatTable } from "../src/engine/output.js";
import { type Manifest, validateManifest } from "../src/manifest/schema.js";
import { commandHelp } from "../src/commands/help.js";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8")) as Manifest;

function withCommand(command: unknown): unknown {
  return { schema: "runlocal.cli-manifest/1", version: "1", commands: [command] };
}

const base = { name: ["x"], summary: "x", steps: [] };

function nested(levels: number): unknown {
  let value: unknown = "{{args.id}}";
  for (let i = 0; i < levels; i++) value = { v: value };
  return value;
}

describe("manifest validation", () => {
  it("accepts the fixture", () => {
    expect(validateManifest(fixture).commands.length).toBe(13);
  });

  const bad: [string, unknown, RegExp][] = [
    ["another schema", { ...fixture, schema: "runlocal.cli-manifest/2" }, /Update rlx/],
    ["no version", { ...fixture, version: undefined }, /version/],
    ["an unknown op", withCommand({ ...base, steps: [{ op: "exec", cmd: "ls" }] }), /not an operation/],
    ["a built-in name", withCommand({ ...base, name: ["login"] }), /command of rlx itself/],
    ["a global option", withCommand({ ...base, args: [{ name: "api", kind: "option" }] }), /option of rlx itself/],
    ["an absolute URL path", withCommand({ ...base, steps: [{ op: "http", method: "GET", path: "https://other.example/x" }] }), /one \//],
    ["a protocol-relative path", withCommand({ ...base, steps: [{ op: "http", method: "GET", path: "//other.example/x" }] }), /one \//],
    ["an Authorization header", withCommand({ ...base, steps: [{ op: "http", method: "GET", path: "/x", headers: { Authorization: "x" } }] }), /header/],
    ["an unknown method", withCommand({ ...base, steps: [{ op: "http", method: "TRACE", path: "/x" }] }), /GET, POST/],
    ["an unknown field", withCommand({ ...base, steps: [{ op: "http", method: "GET", path: "/x", script: "x" }] }), /unknown field/],
    ["a reserved result name", withCommand({ ...base, steps: [{ op: "http", method: "GET", path: "/x", as: "args" }] }), /reserved/],
    ["a state key with a slash", withCommand({ ...base, steps: [{ op: "state", key: "../x" }] }), /does not match/],
    ["a poll of a non-http step", withCommand({ ...base, steps: [{ op: "poll", step: { op: "read", file: "x", as: "y" }, until: { field: "a" }, max: 2 }] }), /repeats an http step/],
    ["deep nesting", withCommand({ ...base, steps: [{ op: "each", over: "a", steps: [{ op: "each", over: "a", steps: [{ op: "each", over: "a", steps: [{ op: "each", over: "a", steps: [] }] }] }] }] }), /too deep/],
    ["two commands with one name", { ...fixture, commands: [fixture.commands[0], fixture.commands[0]] }, /twice/],
    ["a bad output", withCommand({ ...base, output: { kind: "html", from: "x" } }), /table, json, or markdown/],
    // Regressions that the fuzz tests found (test/fuzz.test.ts).
    ["an unknown field at the top", { ...fixture, script: "x" }, /at script: unknown field/],
    ["a schema that is an object", { ...fixture, schema: JSON.parse('{"toString": 1}') }, /at schema: expected/],
    ["an op that is an object", withCommand({ ...base, steps: [{ op: JSON.parse('{"valueOf": 1, "toString": 1}') }] }), /not an operation/],
    ["a body nested too deep", withCommand({ ...base, steps: [{ op: "http", method: "POST", path: "/x", body: nested(40) }] }), /nested more than 32/],
    ["a required that is not true or false", withCommand({ ...base, args: [{ name: "a", kind: "option", required: "no" }] }), /required: expected true or false/],
    ["a repeat that is not true or false", withCommand({ ...base, args: [{ name: "a", kind: "option", repeat: 1 }] }), /repeat: expected true or false/],
    ["a default that is an object", withCommand({ ...base, args: [{ name: "a", kind: "option", default: { x: 1 } }] }), /default: expected a string/],
    ["a short letter on a positional", withCommand({ ...base, args: [{ name: "a", kind: "positional", short: "a" }] }), /no short letter/],
    ["one short letter twice", withCommand({ ...base, args: [{ name: "a", kind: "option", short: "a" }, { name: "b", kind: "flag", short: "a" }] }), /-a is listed twice/],
    ["a header name that is not a token", withCommand({ ...base, steps: [{ op: "http", method: "GET", path: "/x", headers: { "X Bad": "1" } }] }), /name of a header/],
    ["when on the step of a poll", withCommand({ ...base, steps: [{ op: "poll", step: { op: "http", method: "GET", path: "/x", when: "{{a}}" }, until: { field: "a" }, max: 2 }] }), /put when on the poll/],
    ["a state step that sets and deletes", withCommand({ ...base, steps: [{ op: "state", key: "k", set: "{{a}}", delete: true }] }), /either sets or deletes/],
    ["a list in a condition", withCommand({ ...base, steps: [{ op: "poll", step: { op: "http", method: "GET", path: "/x" }, until: { field: "a", in: [["done"]] }, max: 2 }] }), /in\.0: expected a string/],
  ];

  for (const [what, manifest, error] of bad) {
    it(`refuses ${what}`, () => {
      expect(() => validateManifest(manifest)).toThrow(error);
    });
  }

  it("keeps a body 32 levels deep", () => {
    expect(() => validateManifest(withCommand({ ...base, steps: [{ op: "http", method: "POST", path: "/x", body: nested(31) }] }))).not.toThrow();
  });
});

describe("command resolution", () => {
  it("takes the longest name that matches", () => {
    const commands = [
      { ...base, name: ["widgets"] },
      { ...base, name: ["widgets", "list"] },
    ];
    expect(findCommand(commands, ["widgets", "list", "x"])?.command.name).toEqual(["widgets", "list"]);
    expect(findCommand(commands, ["widgets", "other"])?.command.name).toEqual(["widgets"]);
    expect(findCommand(commands, ["gizmos"])).toBeUndefined();
  });
});

describe("arguments", () => {
  const create = fixture.commands.find((c) => c.name.join(" ") === "widgets create")!;
  const list = fixture.commands.find((c) => c.name.join(" ") === "widgets list")!;
  const show = fixture.commands.find((c) => c.name.join(" ") === "widgets show")!;

  it("parses options, repeated options, and flags", () => {
    expect(parseCommandArgs(create, ["--name", "w", "--tag", "a", "--tag=b", "--dry-run"])).toEqual({
      name: "w",
      tag: ["a", "b"],
      "dry-run": true,
    });
    expect(parseCommandArgs(create, ["--name=w", "--no-dry-run"])).toMatchObject({ "dry-run": false });
  });

  it("parses short options and types", () => {
    expect(parseCommandArgs(list, ["-n", "5", "--color", "red"])).toEqual({ limit: 5, color: "red" });
    expect(() => parseCommandArgs(list, ["-n", "five"])).toThrow(/whole number/);
    expect(() => parseCommandArgs(list, ["--color", "green"])).toThrow(/one of/);
  });

  it("reports missing, unknown, and extra arguments", () => {
    expect(() => parseCommandArgs(create, [])).toThrow(/--name is required/);
    expect(() => parseCommandArgs(create, ["--name", "w", "--other"])).toThrow(/Unknown option/);
    expect(() => parseCommandArgs(show, [])).toThrow(/<id> is required/);
    expect(() => parseCommandArgs(show, ["a", "b"])).toThrow(/Too many/);
  });

  it("takes the global flags out at any place", () => {
    const parsed = parseGlobals(["widgets", "--json", "list", "-y", "--api=https://a.example", "--quiet", "--debug", "-n", "2"]);
    expect(parsed.rest).toEqual(["widgets", "list", "-n", "2"]);
    expect(parsed.flags).toMatchObject({ json: true, yes: true, quiet: true, debug: true, api: "https://a.example" });
  });
});

describe("outputs", () => {
  const list = fixture.commands[0]!;
  const data = { args: {}, widgets: { items: [{ id: "w1", name: "Alpha", owner: { name: "Ann" } }, { id: "w22", name: "B", owner: null }] } };

  it("lays out a table", () => {
    expect(renderOutput(list.output, data, false)).toBe(["ID   Name   Owner", "w1   Alpha  Ann", "w22  B      -"].join("\n"));
  });

  it("prints the value as JSON with --json", () => {
    expect(JSON.parse(renderOutput(list.output, data, true)!)).toEqual(data.widgets.items);
  });

  it("prints the empty text for no rows", () => {
    expect(renderOutput(list.output, { widgets: { items: [] } }, false)).toBe("No widgets.");
  });

  it("formats a table of plain rows", () => {
    expect(formatTable([{ a: 1 }], [["a", "A"]])).toBe("A\n1");
  });

  it("shows the help of a command", () => {
    const text = commandHelp(fixture.commands[0]!);
    expect(text).toContain("Usage: rlx widgets list [--color <string>] [--limit <integer>]");
    expect(text).toContain("One of: red, blue.");
  });
});
