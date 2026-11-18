// SPDX-License-Identifier: Apache-2.0
// The JSON Schema (draft 2020-12) of the command manifest, built from the
// constants of the validator (schema.ts, template.ts, api.ts). The validator
// is the reference: the schema never refuses a manifest that the validator
// accepts, and test/schema.test.ts checks this on a corpus of manifests.
//
// scripts/manifest-schema.mjs writes the result to
// schema/cli-manifest-1.schema.json. Run `npm run schema` after a change here
// or in the validator; `npm test` fails when the committed file is stale.

import { BLOCKED_HEADER_PREFIXES, BLOCKED_HEADERS } from "../api.js";
import { FORBIDDEN, SEGMENT } from "../engine/template.js";
import {
  ARG_KINDS,
  ARG_TYPES,
  BUILT_IN_COMMANDS,
  GLOBAL_OPTIONS,
  HEADER_NAME,
  KEY,
  MANIFEST_FIELDS,
  MANIFEST_SCHEMA,
  MAX_DEPTH,
  MAX_VALUE_DEPTH,
  METHODS,
  NAME,
  OPS,
  RESERVED_NAMES,
  RESERVED_SHORTS,
  WORD,
} from "./schema.js";

type Schema = Record<string, unknown>;

/** The format of a template string. The specification of the manifest defines it; the tests check it with the engine. */
export const TEMPLATE_FORMAT = "rlx-template";

/** The rules that JSON Schema cannot state. The validator checks them. */
export const VALIDATOR_ONLY_RULES = [
  "Two commands cannot have the same name.",
  "Two arguments of a command cannot have the same name or the same short letter.",
  "A positional with repeat must be the last positional.",
  "output.save names an option of the command whose type is path.",
  `A template string has the format "${TEMPLATE_FORMAT}" of the specification of the manifest: a validator that does not know it accepts any string.`,
];

const ref = (name: string): Schema => ({ $ref: `#/$defs/${name}` });
const text: Schema = { type: "string", minLength: 1 };
const template: Schema = { type: "string", minLength: 1, format: TEMPLATE_FORMAT };

function object(properties: Record<string, Schema>, required: string[] = [], extra: Schema = {}): Schema {
  return { type: "object", properties, required, additionalProperties: false, ...extra };
}

/** A regular expression that matches the text in any case of its letters. */
function anyCase(value: string): string {
  return [...value].map((ch) => (/[a-z]/i.test(ch) ? `[${ch.toLowerCase()}${ch.toUpperCase()}]` : ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))).join("");
}

/** A path such as list.items.0.id: plain segments, none of them forbidden, with space around it. */
function pathPattern(): string {
  const plain = SEGMENT.source.replace(/^\^/, "").replace(/\$$/, "").replace(/\+$/, "");
  const forbidden = [...FORBIDDEN].join("|");
  const segment = `(?!(?:${forbidden})(?!${plain}))${plain}+`;
  return `^\\s*${segment}(?:\\.${segment})*\\s*$`;
}

/** A request: method, path, query, headers, body. */
function request(extra: Record<string, Schema> = {}, required: string[] = []): Schema {
  return object(
    {
      method: { enum: [...METHODS] },
      path: { ...template, pattern: "^/(?!/)" },
      query: { type: "object", additionalProperties: ref("value_1") },
      headers: {
        type: "object",
        propertyNames: {
          pattern: HEADER_NAME.source,
          not: {
            pattern: `^(?:${[...BLOCKED_HEADERS].map(anyCase).join("|")})$|^(?:${BLOCKED_HEADER_PREFIXES.map(anyCase).join("|")})`,
          },
        },
        additionalProperties: template,
      },
      body: ref("value_1"),
      ...extra,
    },
    ["method", "path", ...required],
  );
}

/** The fields that a kind of step has, with its required fields. */
function steps(): Record<string, Schema> {
  const name: Schema = { type: "string", pattern: NAME.source, not: { enum: [...RESERVED_NAMES] } };
  const common = { op: {}, when: template };
  const defs: Record<string, Schema> = {
    name,
    path: { type: "string", pattern: pathPattern() },
    condition: object(
      {
        field: ref("path"),
        in: { type: "array", items: { type: ["string", "number", "boolean", "null"] } },
      },
      ["field"],
    ),
    request: request(),
    http: request({ ...common, op: { const: "http" }, as: name }, ["op"]),
    upload: object(
      {
        ...common,
        op: { const: "upload" },
        file: template,
        begin: ref("request"),
        done: ref("condition"),
        single: ref("path"),
        parts: request(
          {
            size: ref("path"),
            count: ref("path"),
            list: ref("path"),
            number: ref("path"),
            url: ref("path"),
            batch: { type: "integer", minimum: 1, maximum: 1000 },
          },
          ["size", "list", "number", "url"],
        ),
        finish: ref("request"),
        as: name,
      },
      ["op", "file", "begin"],
      { anyOf: [{ required: ["single"] }, { required: ["parts"] }] },
    ),
    read: object({ ...common, op: { const: "read" }, file: template, format: { enum: ["json", "yaml"] }, as: name }, ["op", "file", "as"]),
    state: object(
      { ...common, op: { const: "state" }, key: { type: "string", pattern: KEY.source }, set: template, delete: { type: "boolean" }, as: name },
      ["op", "key"],
      { not: { type: "object", required: ["set", "delete"], properties: { set: true, delete: { const: true } } } },
    ),
    confirm: object({ ...common, op: { const: "confirm" }, message: template }, ["op", "message"]),
    poll: object(
      {
        ...common,
        op: { const: "poll" },
        step: { allOf: [ref("http"), { type: "object", properties: { when: false } }] },
        until: ref("condition"),
        interval: { type: "integer", minimum: 1, maximum: 600 },
        max: { type: "integer", minimum: 1, maximum: 1000 },
        as: name,
      },
      ["op", "step", "until", "max"],
    ),
    download: object(
      { ...common, op: { const: "download" }, url: template, dir: template, name: template, size: template, digest: template, as: name },
      ["op", "url", "name"],
    ),
  };
  // An each step holds steps one level deeper. Steps cannot be deeper than MAX_DEPTH.
  const simple = [...OPS].filter((op) => op !== "each");
  for (let level = 1; level <= MAX_DEPTH; level++) {
    defs[`each_${level}`] = object(
      { ...common, op: { const: "each" }, over: ref("path"), as: name, steps: ref(`steps_${level + 1}`), collect: ref("path"), into: name },
      ["op", "over", "steps"],
      { dependentRequired: { collect: ["into"], into: ["collect"] } },
    );
    defs[`step_${level}`] = {
      type: "object",
      required: ["op"],
      properties: { op: { enum: [...OPS] } },
      anyOf: [...simple.map((op) => ref(op)), ref(`each_${level}`)],
    };
    defs[`steps_${level}`] = { type: "array", items: ref(`step_${level}`) };
  }
  defs[`steps_${MAX_DEPTH + 1}`] = { not: {}, $comment: `Steps cannot be nested more than ${MAX_DEPTH} levels deep.` };
  return defs;
}

/** A JSON value of a query or a body, at most MAX_VALUE_DEPTH levels deep. Each string is a template. */
function values(): Record<string, Schema> {
  const defs: Record<string, Schema> = {};
  for (let level = 1; level <= MAX_VALUE_DEPTH; level++) {
    const next = ref(`value_${level + 1}`);
    defs[`value_${level}`] = {
      anyOf: [
        { type: ["number", "boolean", "null"] },
        template,
        { type: "array", items: next },
        { type: "object", additionalProperties: next },
      ],
    };
  }
  defs[`value_${MAX_VALUE_DEPTH + 1}`] = { not: {}, $comment: `A value cannot be nested more than ${MAX_VALUE_DEPTH} levels deep.` };
  return defs;
}

function output(): Schema {
  const extras = { json: ref("path"), hint: template, save: { type: "string", pattern: WORD.source } };
  return {
    oneOf: [
      object(
        {
          kind: { const: "table" },
          from: ref("path"),
          columns: { type: "array", minItems: 1, items: { type: "array", prefixItems: [ref("path"), text], minItems: 2, items: false } },
          empty: text,
          ...extras,
        },
        ["kind", "from", "columns"],
      ),
      object({ kind: { const: "json" }, from: ref("path"), ...extras }, ["kind"]),
      object({ kind: { const: "markdown" }, from: ref("path"), text: template, ...extras }, ["kind"], {
        oneOf: [{ required: ["from"] }, { required: ["text"] }],
      }),
    ],
  };
}

function arg(): Schema {
  return object(
    {
      name: { type: "string", pattern: WORD.source, not: { enum: [...GLOBAL_OPTIONS] } },
      kind: { enum: [...ARG_KINDS] },
      type: { enum: [...ARG_TYPES] },
      required: { type: "boolean" },
      default: { type: ["string", "number", "boolean"] },
      short: { type: "string", pattern: "^[a-zA-Z]$", not: { enum: [...RESERVED_SHORTS] } },
      help: text,
      choices: { type: "array", items: { type: "string" } },
      repeat: { type: "boolean" },
    },
    ["name", "kind"],
    { if: { type: "object", properties: { kind: { const: "positional" } } }, then: { type: "object", properties: { short: false } } },
  );
}

function command(): Schema {
  const word: Schema = { type: "string", pattern: WORD.source };
  return object(
    {
      name: {
        type: "array",
        minItems: 1,
        maxItems: 4,
        prefixItems: [{ ...word, not: { enum: [...BUILT_IN_COMMANDS] } }],
        items: word,
      },
      summary: text,
      description: text,
      group: text,
      args: { type: "array", items: ref("arg") },
      examples: { type: "array", items: text },
      steps: ref("steps_1"),
      output: ref("output"),
      explain: object({ steps: ref("steps_1"), output: ref("output") }, ["steps", "output"]),
    },
    ["name", "summary", "steps"],
  );
}

/** Builds the JSON Schema of the manifest. */
export function buildJsonSchema(): Schema {
  const top: Record<string, Schema> = {
    schema: { const: MANIFEST_SCHEMA },
    version: text,
    auth: object({ api_keys: { type: "string", pattern: "^/(?!/)" } }),
    commands: { type: "array", items: ref("command") },
  };
  if (Object.keys(top).join() !== MANIFEST_FIELDS.join()) throw new Error("The top fields of the schema differ from MANIFEST_FIELDS.");
  return {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: `urn:${MANIFEST_SCHEMA.replace(/[./]/g, ":")}`,
    title: `The rlx command manifest, ${MANIFEST_SCHEMA}`,
    description:
      "Generated from src/manifest/schema.ts by scripts/manifest-schema.mjs. Do not edit. " +
      "The format is frozen. docs/how-rlx-works.md describes the engine.",
    $comment: `Rules that only the validator checks: ${VALIDATOR_ONLY_RULES.join(" ")}`,
    ...object(top, ["schema", "version", "commands"]),
    $defs: { ...steps(), ...values(), arg: arg(), command: command(), output: output() },
  };
}
