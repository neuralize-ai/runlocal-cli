// SPDX-License-Identifier: Apache-2.0
// The JSON Schema of the manifest (schema/cli-manifest-1.schema.json) and the
// validator (src/manifest/schema.ts) must agree. The validator is the
// reference: the schema never refuses a manifest that the validator accepts,
// and when the schema accepts a manifest that the validator refuses, the
// reason is one of the rules that JSON Schema cannot state.

import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import * as Ajv2020Module from "ajv/dist/2020.js";
import { checkTemplate } from "../src/engine/template.js";
import { buildJsonSchema, TEMPLATE_FORMAT, VALIDATOR_ONLY_RULES } from "../src/manifest/jsonSchema.js";
import { validateManifest } from "../src/manifest/schema.js";
import { CliError } from "../src/util/errors.js";

const SEED = Number(process.env.RLX_FUZZ_SEED ?? 20261117);
const RUNS = Number(process.env.RLX_FUZZ_RUNS ?? 400);

const committed = JSON.parse(readFileSync(new URL("../schema/cli-manifest-1.schema.json", import.meta.url), "utf8"));
const fixture = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));

type AjvClass = typeof import("ajv/dist/2020.js").default;
const Ajv2020 = ((Ajv2020Module as unknown as { default: AjvClass | { default: AjvClass } }).default as { default?: AjvClass }).default
  ?? ((Ajv2020Module as unknown as { default: AjvClass }).default);
// strictTuples is off: a command name is one word that cannot be a built-in, then up to three more words.
// strictRequired is off: anyOf and oneOf name fields that the object around them defines.
const ajv = new Ajv2020({ strict: true, strictTuples: false, strictRequired: false, allowUnionTypes: true });
ajv.addFormat(TEMPLATE_FORMAT, {
  type: "string",
  validate: (text: string) => {
    try {
      checkTemplate(text);
      return true;
    } catch {
      return false;
    }
  },
});
const schemaAccepts = ajv.compile(committed);

/** The message of the validator, or undefined when it accepts the manifest. */
function validatorSays(manifest: unknown): string | undefined {
  try {
    validateManifest(manifest);
    return undefined;
  } catch (error) {
    if (!(error instanceof CliError)) throw error;
    return error.message;
  }
}

/** The validator messages of the rules that only the validator checks. */
const VALIDATOR_ONLY = /is listed twice|so it must be the last positional|save: expected the name of an option of type path/;

function agree(manifest: unknown): void {
  const message = validatorSays(manifest);
  const accepted = schemaAccepts(manifest);
  if (message === undefined && !accepted) {
    throw new Error(`The schema refuses a manifest that the validator accepts: ${ajv.errorsText(schemaAccepts.errors)}`);
  }
  if (message !== undefined && accepted && !VALIDATOR_ONLY.test(message)) {
    throw new Error(`The schema accepts a manifest that the validator refuses: ${message}`);
  }
}

describe("the JSON Schema of the manifest", () => {
  it("is up to date: run npm run schema after a change", () => {
    expect(committed).toEqual(JSON.parse(JSON.stringify(buildJsonSchema())));
  });

  it("names each rule that only the validator checks", () => {
    expect(committed.$comment).toContain(VALIDATOR_ONLY_RULES[0]);
    expect(VALIDATOR_ONLY_RULES).toHaveLength(5);
  });

  it("accepts the fixture, as the validator does", () => {
    expect(validatorSays(fixture)).toBeUndefined();
    expect(schemaAccepts(fixture)).toBe(true);
  });

  it("states the rules that it can, and leaves the others to the validator", () => {
    const withCommand = (command: Record<string, unknown>) => ({ schema: "runlocal.cli-manifest/1", version: "1", commands: [{ name: ["x"], summary: "x", steps: [], ...command }] });
    const both: unknown[] = [
      { ...fixture, schema: "runlocal.cli-manifest/2" },
      { ...fixture, extra: 1 },
      withCommand({ name: ["login"] }),
      withCommand({ args: [{ name: "yes", kind: "flag" }] }),
      withCommand({ args: [{ name: "a", kind: "flag", short: "y" }] }),
      withCommand({ steps: [{ op: "exec" }] }),
      withCommand({ steps: [{ op: "http", method: "GET", path: "/x", headers: { "Proxy-Thing": "1" } }] }),
      withCommand({ steps: [{ op: "http", method: "GET", path: "/{{args.__proto__}}" }] }),
      withCommand({ steps: [{ op: "each", over: "a", steps: [{ op: "each", over: "a", steps: [{ op: "each", over: "a", steps: [{ op: "each", over: "a", steps: [] }] }] }] }] }),
    ];
    for (const manifest of both) {
      expect(validatorSays(manifest)).toBeDefined();
      expect(schemaAccepts(manifest)).toBe(false);
    }
    const validatorOnly: unknown[] = [
      { ...fixture, commands: [fixture.commands[0], fixture.commands[0]] },
      withCommand({ args: [{ name: "a", kind: "option" }, { name: "a", kind: "flag" }] }),
      withCommand({ args: [{ name: "a", kind: "positional", repeat: true }, { name: "b", kind: "positional" }] }),
      withCommand({ output: { kind: "json", save: "out" } }),
    ];
    for (const manifest of validatorOnly) {
      expect(validatorSays(manifest)).toMatch(VALIDATOR_ONLY);
      expect(schemaAccepts(manifest)).toBe(true);
    }
  });

  // ---- A fuzzed corpus: the fixture with one change at a random place ----

  /** Every place in the fixture: [path to the parent, key]. */
  function places(value: unknown, path: (string | number)[] = []): (string | number)[][] {
    if (Array.isArray(value)) return [path, ...value.flatMap((item, i) => places(item, [...path, i]))];
    if (value && typeof value === "object") return [path, ...Object.entries(value).flatMap(([key, item]) => places(item, [...path, key]))];
    return [path];
  }
  const all = places(fixture).filter((path) => path.length > 0);

  /** Values near the edges of the rules. */
  const edge = fc.constantFrom<unknown>(
    "", "x", "/v1/x", "//x", "/x/{{args.id}}", "{{a}}", "{{a.__proto__}}", "{{", "}}", "{{a | eval}}", "{{a | default:1}}", "a.b", "a..b", "args", "login",
    "y", "Y", "z", "json", "-", "GET", "TRACE", "table", "markdown", "html", "positional", "option", "flag", "path", "integer", "../x", "a/b", "k", "K",
    "http", "each", "poll", "read", "state", "upload", "download", "confirm", "exec", "yaml", "xml", "Authorization", "X-Ok", "X Bad",
    0, 1, 2, 4, 5, 32, 600, 601, 1000, 1001, -1, 1.5, true, false, null, [], {}, ["a"], ["login"], ["a", "b", "c", "d", "e"], [["a", "A"]], [["a"]], [1],
    { op: "http", method: "GET", path: "/x" }, { op: "each", over: "a", steps: [] }, { field: "a" }, { field: "a", in: [{}] },
    { kind: "json" }, { kind: "markdown" }, { kind: "markdown", from: "a", text: "b" }, { name: "a", kind: "flag" }, { name: "a", kind: "positional", short: "a" },
  );
  const change = fc.oneof(
    fc.record({ kind: fc.constant("set" as const), value: fc.oneof(edge, fc.jsonValue({ maxDepth: 2 })) }),
    fc.record({ kind: fc.constant("delete" as const) }),
    fc.record({ kind: fc.constant("add" as const), field: fc.constantFrom("x", "as", "when", "op", "steps", "from", "text", "short", "required", "delete", "set", "single", "parts", "into", "collect", "description"), value: edge }),
  );

  it("agrees with the validator on the fixture with one change at any place", () => {
    fc.assert(
      fc.property(fc.constantFrom(...all), change, (place, edit) => {
        const copy = structuredClone(fixture);
        let parent = copy;
        for (const part of place.slice(0, -1)) parent = parent[part];
        const key = place.at(-1)!;
        if (edit.kind === "set") parent[key] = structuredClone(edit.value);
        else if (edit.kind === "delete") Array.isArray(parent) ? parent.splice(Number(key), 1) : delete parent[key];
        else {
          const target = parent[key];
          if (!target || typeof target !== "object" || Array.isArray(target)) return;
          target[edit.field] = structuredClone(edit.value);
        }
        agree(copy);
      }),
      { seed: SEED, numRuns: RUNS * 5 },
    );
  });

  it("agrees with the validator on random JSON", () => {
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 4 }), (value) => agree(value)),
      { seed: SEED, numRuns: RUNS },
    );
  });
});
