// SPDX-License-Identifier: Apache-2.0
// Fuzz tests of the template engine, the request builder, the file and state
// checks, and the manifest validator. They use fast-check with a fixed seed,
// so that a run in CI is the same each time. Set RLX_FUZZ_SEED and
// RLX_FUZZ_RUNS to explore more:
//
//   RLX_FUZZ_SEED=$RANDOM RLX_FUZZ_RUNS=20000 npx vitest run test/fuzz.test.ts

import { existsSync, lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { type Api, pinnedUrl } from "../src/api.js";
import { type EngineContext, localFile, realPath } from "../src/engine/context.js";
import { buildRequest } from "../src/engine/request.js";
import { downloadTarget, safeRelativePath } from "../src/engine/download.js";
import { runStep } from "../src/engine/run.js";
import { configDir } from "../src/util/files.js";
import { Out } from "../src/util/io.js";
import { clearSecrets, mask, MASK, registerSecret } from "../src/util/mask.js";
import { tempDir, testIo } from "./helpers/cli.js";
import {
  checkTemplate,
  evaluate,
  lookup,
  parsePath,
  render,
  renderDeep,
  renderString,
  stringify,
  truthy,
} from "../src/engine/template.js";
import { KEY as STATE_KEY, validateManifest } from "../src/manifest/schema.js";
import { CliError } from "../src/util/errors.js";

const SEED = Number(process.env.RLX_FUZZ_SEED ?? 20261117);
const RUNS = Number(process.env.RLX_FUZZ_RUNS ?? 400);
fc.configureGlobal({ seed: SEED, numRuns: RUNS });

const ORIGIN = "https://api.example.com";
const FORBIDDEN = ["__proto__", "constructor", "prototype"];
const FILTER_NAMES = ["default", "json", "join", "length", "string"];
const fixture = JSON.parse(readFileSync(new URL("./fixtures/manifest.json", import.meta.url), "utf8"));

/** Runs fn, and fails unless it returns or throws a CliError (an error that rlx shows). */
function onlyCliErrors(fn: () => unknown): unknown {
  try {
    return fn();
  } catch (error) {
    if (!(error instanceof CliError)) throw new Error(`Not a CliError: ${String(error)}`, { cause: error });
    return error;
  }
}

/** The own keys of Object.prototype, to check that nothing pollutes it. */
const prototypeKeys = () => Object.getOwnPropertyNames(Object.prototype).sort().join(",");
const cleanPrototype = prototypeKeys();

// ---- Arbitraries ----

const anyText = fc.oneof(
  fc.string({ unit: "binary", maxLength: 40 }),
  fc.string({ unit: "grapheme", maxLength: 20 }),
  fc.string({ maxLength: 20 }),
);

const segment = fc.oneof(
  fc.constantFrom(...FORBIDDEN, "length", "0", "00", "1", "args", "id", "a", "b", "-", "_", "items", "toString", "hasOwnProperty"),
  fc.stringMatching(/^[A-Za-z0-9_-]{1,6}$/),
  anyText,
);

const pathText = fc
  .tuple(fc.array(segment, { minLength: 0, maxLength: 6 }), fc.constantFrom("", " ", "  "))
  .map(([parts, pad]) => `${pad}${parts.join(".")}${pad}`);

const literal = fc.oneof(
  fc.string({ unit: "binary", maxLength: 12 }).map((text) => JSON.stringify(text)),
  fc.integer().map(String),
  fc.double({ noNaN: true, noDefaultInfinity: true }).map(String),
  fc.constantFrom("true", "false", "null", '"\\x"', '"\\u12"', '"a\nb"', '"\t"', "1".repeat(400), "-0", '""', "x", "{}"),
  anyText,
);

const filter = fc
  .tuple(fc.constantFrom(...FILTER_NAMES, "eval", "constructor", "", " json "), fc.option(literal, { nil: undefined }))
  .map(([name, arg]) => (arg === undefined ? name : `${name}:${arg}`));

const tag = fc
  .tuple(pathText, fc.array(filter, { maxLength: 3 }))
  .map(([path, filters]) => `{{${[path, ...filters].join(" | ")}}}`);

const templateText = fc
  .array(fc.oneof(tag, anyText, fc.constantFrom("{{", "}}", "{", "}", "|", '"', "{{{", "}}}", "{{a}", "{a}}")), { maxLength: 6 })
  .map((parts) => parts.join(""));

const polluted = () => JSON.parse('{"__proto__": {"polluted": true}, "constructor": {"prototype": {"polluted": true}}, "ok": 1}');

const data = fc
  .record({ args: fc.dictionary(segment, fc.jsonValue({ maxDepth: 3 })), list: fc.jsonValue({ maxDepth: 4 }), v: fc.jsonValue({ maxDepth: 2 }) })
  .map((record) => ({ ...record, evil: polluted(), empty: "", nothing: null }));

// ---- The template engine ----

describe("fuzz: templates", () => {
  it("only ever returns, or throws a CliError, for any template and any data", () => {
    fc.assert(
      fc.property(templateText, data, (text, values) => {
        onlyCliErrors(() => checkTemplate(text));
        onlyCliErrors(() => render(text, values));
        onlyCliErrors(() => renderString(text, values));
        onlyCliErrors(() => render(text, values, { required: true }));
        onlyCliErrors(() => render(text, values, { encode: (value) => `<${value}>` }));
        onlyCliErrors(() => renderDeep({ a: text, b: [text, { c: text }] }, values));
        expect(prototypeKeys()).toBe(cleanPrototype);
        expect(({} as Record<string, unknown>).polluted).toBeUndefined();
      }),
    );
  });

  it("accepts a path only when each segment is plain and allowed", () => {
    fc.assert(
      fc.property(pathText, (text) => {
        const result = onlyCliErrors(() => parsePath(text));
        if (result instanceof CliError) return;
        for (const part of result as string[]) {
          expect(part).toMatch(/^[A-Za-z0-9_-]+$/);
          expect(FORBIDDEN).not.toContain(part);
        }
      }),
    );
  });

  it("refuses a forbidden segment at any place of a path, in a template and in a lookup", () => {
    fc.assert(
      fc.property(
        fc.array(fc.stringMatching(/^[a-z0-9_]{1,5}$/), { maxLength: 4 }),
        fc.array(fc.stringMatching(/^[a-z0-9_]{1,5}$/), { maxLength: 4 }),
        fc.constantFrom(...FORBIDDEN),
        (before, after, bad) => {
          const path = [...before, bad, ...after];
          expect(() => parsePath(path.join("."))).toThrow(/not allowed/);
          expect(() => checkTemplate(`x {{${path.join(".")}}} y`)).toThrow(/not allowed/);
          expect(() => lookup(polluted(), path)).toThrow(/not allowed/);
        },
      ),
    );
  });

  it("reads own fields of the data only, as a plain walk does", () => {
    // The reference: own fields of objects, digits index a list, and length of a list.
    const walk = (value: unknown, path: string[]): unknown => {
      let current = value;
      for (const part of path) {
        if (current === null || current === undefined) return undefined;
        if (Array.isArray(current)) current = /^\d+$/.test(part) ? current[Number(part)] : part === "length" ? current.length : undefined;
        else if (typeof current === "object") current = Object.hasOwn(current, part) ? (current as Record<string, unknown>)[part] : undefined;
        else return undefined;
      }
      return current;
    };
    const plainSegment = fc.oneof(fc.constantFrom("length", "0", "1", "00", "a", "b", "toString", "valueOf"), fc.stringMatching(/^[a-z0-9]{1,3}$/));
    fc.assert(
      fc.property(fc.jsonValue({ maxDepth: 5 }), fc.array(plainSegment, { minLength: 1, maxLength: 6 }), (value, path) => {
        const got = lookup(value, path);
        expect(got).toEqual(walk(value, path));
        expect(typeof got).not.toBe("function");
      }),
    );
  });

  it("handles deep nesting, huge strings, and unicode", () => {
    let deep: unknown = "bottom";
    const path: string[] = [];
    for (let i = 0; i < 5000; i++) {
      deep = { n: deep };
      path.push("n");
    }
    expect(lookup(deep, path)).toBe("bottom");
    expect(render(`{{${path.join(".")}}}`, deep)).toBe("bottom");
    const huge = "x".repeat(2_000_000);
    expect(renderString(`a {{v}} b`, { v: huge })).toHaveLength(huge.length + 4);
    expect(() => parsePath("a".repeat(100_000))).not.toThrow();
    expect(() => parsePath("ä.b")).toThrow(/not a path/);
    expect(renderString("{{v}}🙂", { v: "日本\u{1F600}\uD800" })).toBe("日本\u{1F600}\uD800🙂");
    expect(() => checkTemplate(`${"{".repeat(10_000)}x${"}".repeat(10_000)}`)).toThrow(/Template error/);
  });

  it("never reads an inserted value as a template again", () => {
    fc.assert(
      fc.property(templateText, (inner) => {
        expect(renderString("<{{v}}>", { v: inner })).toBe(`<${inner}>`);
      }),
    );
  });
});

describe("fuzz: filters on any type", () => {
  const value = fc.oneof(fc.jsonValue({ maxDepth: 3 }), fc.constant(undefined));
  const arg = fc.oneof(fc.jsonValue({ maxDepth: 0 }), fc.constant(undefined));

  it("default gives the argument for a missing, null, or empty value, else the value", () => {
    fc.assert(
      fc.property(value, arg, (v, a) => {
        const got = evaluate({ path: ["v"], filters: [{ name: "default", arg: a }] }, { v });
        expect(got).toEqual(v === undefined || v === null || v === "" ? a : v);
      }),
    );
  });

  it("json always gives a string of JSON", () => {
    fc.assert(
      fc.property(value, (v) => {
        const got = evaluate({ path: ["v"], filters: [{ name: "json", arg: undefined }] }, { v });
        expect(typeof got).toBe("string");
        expect(got).toBe(JSON.stringify(v ?? null));
      }),
    );
  });

  it("join gives a string for a list, and the value itself for anything else", () => {
    fc.assert(
      fc.property(value, arg, (v, a) => {
        const got = evaluate({ path: ["v"], filters: [{ name: "join", arg: a }] }, { v });
        if (Array.isArray(v)) expect(got).toBe(v.map(stringify).join(typeof a === "string" ? a : ","));
        else expect(got).toEqual(v);
      }),
    );
  });

  it("length always gives a whole number", () => {
    fc.assert(
      fc.property(value, (v) => {
        const got = evaluate({ path: ["v"], filters: [{ name: "length", arg: undefined }] }, { v });
        expect(Number.isInteger(got)).toBe(true);
        if (typeof v === "string" || Array.isArray(v)) expect(got).toBe(v.length);
        else if (v && typeof v === "object") expect(got).toBe(Object.keys(v).length);
        else expect(got).toBe(0);
      }),
    );
  });

  it("string always gives a string", () => {
    fc.assert(
      fc.property(value, (v) => {
        const got = evaluate({ path: ["v"], filters: [{ name: "string", arg: undefined }] }, { v });
        expect(got).toBe(stringify(v));
      }),
    );
  });

  it("truthy never throws, and says no to the empty values", () => {
    fc.assert(
      fc.property(value, (v) => {
        const got = truthy(v);
        if (v === undefined || v === null || v === false || v === 0 || v === "") expect(got).toBe(false);
        if (Array.isArray(v) && v.length === 0) expect(got).toBe(false);
      }),
    );
  });
});

describe("fuzz: missing values", () => {
  const absent = fc.stringMatching(/^[a-z]{1,8}$/).map((name) => `missing_${name}`);

  it("a missing value is undefined alone, empty in a string, and an error when it is required", () => {
    fc.assert(
      fc.property(absent, data, (name, values) => {
        expect(render(`{{${name}}}`, values)).toBeUndefined();
        expect(render(`{{args.${name}.deeper}}`, values)).toBeUndefined();
        expect(renderString(`a{{${name}}}b`, values)).toBe("ab");
        expect(() => render(`{{${name}}}`, values, { required: true })).toThrow(/no value/);
        expect(() => render(`a{{${name}}}b`, values, { required: true })).toThrow(/no value/);
        expect(renderDeep({ x: `{{${name}}}`, y: [`{{${name}}}`, 1] }, values)).toEqual({ y: [1] });
      }),
    );
  });

  it("a null value is missing when it is required, alone or in a string", () => {
    expect(() => render("{{nothing}}", { nothing: null }, { required: true })).toThrow(/no value/);
    expect(() => render("a{{nothing}}", { nothing: null }, { required: true })).toThrow(/no value/);
  });
});

// ---- Requests ----

describe("fuzz: values in a request path", () => {
  const nasty = fc.oneof(
    fc.string({ unit: "binary", maxLength: 30 }),
    fc.constantFrom("", ".", "..", "...", "%2e", "%2e%2e", ".%2e", "%2E%2E", "%252e", "/", "../..", "..%2f", "\\..", "..\\", "?x=1", "#top", "a/../b", "%00", "\uD800", "\uDC00x"),
    fc.array(fc.constantFrom("..", "/", "%2e", ".", "\\", "?", "#", "%", "a"), { maxLength: 8 }).map((parts) => parts.join("")),
  );
  const value = fc.oneof(nasty, fc.integer(), fc.boolean(), fc.array(nasty, { maxLength: 3 }), fc.dictionary(nasty, nasty, { maxKeys: 2 }));

  it("a value never changes the segments of the path", () => {
    fc.assert(
      fc.property(value, value, (id, part) => {
        const spec = { method: "GET" as const, path: "/v1/widgets/{{args.id}}/parts/{{args.part}}x" };
        const built = onlyCliErrors(() => buildRequest(spec, { args: { id, part } }));
        if (built instanceof CliError) {
          expect(built.code).toMatch(/^(PATH\.INVALID|MANIFEST\.TEMPLATE)$/);
          return;
        }
        const url = pinnedUrl(ORIGIN, (built as { path: string }).path);
        const segments = url.pathname.split("/");
        expect(segments.slice(0, 3)).toEqual(["", "v1", "widgets"]);
        expect(segments).toHaveLength(6);
        expect(segments[4]).toBe("parts");
        expect(decodeURIComponent(segments[3]!)).toBe(stringify(id));
        expect(decodeURIComponent(segments[5]!)).toBe(`${stringify(part)}x`);
        expect(url.search).toBe("");
        expect(url.hash).toBe("");
      }),
    );
  });

  it("a whole segment of dots, or an empty one, is refused", () => {
    for (const id of ["", ".", ".."]) {
      expect(() => buildRequest({ method: "GET", path: "/v1/widgets/{{args.id}}" }, { args: { id } })).toThrow(/address/);
    }
  });
});

// ---- Files and state ----

describe("fuzz: download names", () => {
  const name = fc.oneof(
    fc.array(fc.oneof(fc.constantFrom("..", ".", "", "a", "b.txt", "%2e%2e", "...", "\\", "\0", "C:", "~"), fc.string({ unit: "grapheme", maxLength: 5 })), { maxLength: 6 }).map((parts) => parts.join("/")),
    fc.constantFrom("/etc/passwd", "../x", "a/../../x", "a/./b", "a//b", "a\\..\\b", "\0", "x\0y", "./x", "x/", "/"),
    fc.string({ unit: "binary", maxLength: 20 }),
  );

  it("a name gives a path inside the folder, or is refused", () => {
    fc.assert(
      fc.property(name, (text) => {
        const result = onlyCliErrors(() => safeRelativePath(text));
        if (result instanceof CliError) {
          expect(result.code).toBe("DOWNLOAD.NAME");
          return;
        }
        const parts = (result as string).split("/");
        expect(text.startsWith("/")).toBe(false);
        for (const part of parts) {
          expect(part === "" || part === "." || part === "..").toBe(false);
          expect(part).not.toContain("\\");
          expect(part).not.toContain("\0");
        }
      }),
    );
  });
});

// ---- Local files: download names, upload and read files, and state ----

/**
 * A home folder with the folders of rlx, a project, and symbolic links that
 * point out of the project and into the folders of rlx.
 */
function layout() {
  const home = tempDir("rlx-fuzz-home-");
  const cwd = join(home, "project");
  const outside = tempDir("rlx-fuzz-outside-");
  const keys = join(home, ".rlx-test");
  mkdirSync(join(cwd, ".git"), { recursive: true });
  mkdirSync(join(cwd, "out", "sub"), { recursive: true });
  mkdirSync(keys, { recursive: true });
  writeFileSync(join(keys, "keys.json"), "{}");
  writeFileSync(join(cwd, "plain.txt"), "plain");
  const io = testIo({ home, cwd }, { stdout: [], stderr: [], prompts: [] });
  mkdirSync(configDir(io), { recursive: true });
  symlinkSync(outside, join(cwd, "link-out"));
  symlinkSync(configDir(io), join(cwd, "link-conf"));
  symlinkSync(keys, join(cwd, "out", "link-keys"));
  symlinkSync(join(keys, "keys.json"), join(cwd, "key-link"));
  symlinkSync(join(cwd, "plain.txt"), join(cwd, "out", "link-file"));
  const flags = { json: false, yes: true, quiet: true, debug: false, help: false, version: false, api: undefined };
  const ctx: EngineContext = {
    io,
    out: new Out(io, flags),
    api: { origin: ORIGIN } as Api,
    flags,
    protectedPaths: [configDir(io), keys],
  };
  return { home, cwd, outside, keys, ctx };
}

function within(path: string, folder: string): boolean {
  const rel = relative(folder, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

describe("fuzz: local files", () => {
  let place: ReturnType<typeof layout>;
  beforeAll(() => {
    place = layout();
  });
  const refusedReal = () => place.ctx.protectedPaths.map((path) => realPath(path));

  const part = fc.constantFrom("..", ".", "", "out", "sub", "link-out", "link-conf", "link-keys", "link-file", "key-link", "keys.json", ".config", "runlocal", ".rlx-test", "%2e%2e", "a.bin", "\\", "\0");
  const relativeText = fc.array(part, { minLength: 1, maxLength: 5 }).map((parts) => parts.join("/"));

  it("a download writes inside its folder, never through a symbolic link, never into a folder of rlx", async () => {
    const dirs = fc.constantFrom("", "out", "out/sub", "link-out", "link-conf", "../.config/runlocal", "out/link-keys", "..", ".rlx-test");
    await fc.assert(
      fc.asyncProperty(dirs, fc.oneof(relativeText, fc.constantFrom("/etc/passwd", "../x", "a/../../x")), async (dir, name) => {
        let result: { folder: string; target: string };
        try {
          result = await downloadTarget(place.ctx, dir, name);
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
          expect(["DOWNLOAD.NAME", "FILE.REFUSED"]).toContain(error.code);
          return;
        }
        const { folder, target } = result;
        expect(within(target, folder)).toBe(true);
        expect(within(realPath(target), realPath(folder))).toBe(true);
        for (const refused of refusedReal()) expect(within(realPath(target), refused)).toBe(false);
        let current = folder;
        for (const item of relative(folder, target).split(sep)) {
          current = join(current, item);
          if (existsSync(current) || lstatSync(current, { throwIfNoEntry: false })) {
            expect(lstatSync(current).isSymbolicLink()).toBe(false);
          }
        }
      }),
      { numRuns: Math.min(RUNS, 300) },
    );
  });

  it("a file that a step reads or writes is never in a folder of rlx, by ../, an absolute path, or a symbolic link", () => {
    const start = fc.constantFrom("", "/", "~", "../", "./");
    fc.assert(
      fc.property(start, relativeText, (prefix, rest) => {
        const text = prefix === "~" ? join(place.home, rest) : prefix === "/" ? join(place.cwd, rest) : `${prefix}${rest}`;
        const result = onlyCliErrors(() => localFile(place.ctx, text));
        if (result instanceof CliError) {
          expect(["FILE.REFUSED", undefined]).toContain(result.code);
          return;
        }
        for (const refused of refusedReal()) {
          expect(within(realPath(result as string), refused)).toBe(false);
          expect(within(result as string, refused)).toBe(false);
        }
      }),
    );
  });

  it("a state key is a plain name in the state folder, or it is refused", async () => {
    const key = fc.oneof(
      fc.stringMatching(/^[a-z0-9][a-z0-9._-]{0,10}$/),
      fc.constantFrom("..", ".", "", "../x", "a/b", "a\\b", "%2e%2e", "x\0", "A", "é", "-x", ".hidden", "k".repeat(65), "__proto__"),
      fc.string({ unit: "binary", maxLength: 12 }),
    );
    await fc.assert(
      fc.asyncProperty(key, async (name) => {
        const data: Record<string, unknown> = { args: {}, v: "cursor-1" };
        try {
          await runStep(place.ctx, { op: "state", key: name, set: "{{v}}", as: "got" }, data);
        } catch (error) {
          if (!(error instanceof CliError)) throw error;
          expect(error.code).toBe("STATE.REFUSED");
          expect(STATE_KEY.test(name)).toBe(false);
          return;
        }
        expect(STATE_KEY.test(name)).toBe(true);
        expect(data.got).toBe("cursor-1");
        expect(readFileSync(join(place.cwd, ".runlocal", name), "utf8")).toBe("cursor-1\n");
      }),
      { numRuns: Math.min(RUNS, 300) },
    );
  });

  it("a state value that looks like a credential is never written", async () => {
    const apart = fc.constantFrom(" ", "\n", "=", ":", '"', "'", ",", "_", "/", "(");
    const edge = (text: fc.Arbitrary<string>, side: "before" | "after") =>
      fc.tuple(text, apart).map(([words, mark]) => (side === "before" ? `${words}${mark}` : `${mark}${words}`));
    const alnum = fc.stringMatching(/^[A-Za-z0-9]{40,60}$/);
    const secret = fc.oneof(
      fc.tuple(fc.stringMatching(/^[a-z]{2,8}$/), alnum).map(([prefix, body]) => `${prefix}_${body}`),
      alnum.map((body) => `Bearer ${body}`),
      fc.tuple(alnum, alnum, alnum).map(([a, b, c]) => `eyJ${a}.${b}.${c}`),
      fc.tuple(fc.constantFrom("token", "api_key", "password", "client_secret", "device_code"), alnum).map(([name, body]) => `{"${name}": "${body}"}`),
      fc.tuple(fc.constantFrom("token", "apikey", "passwd", "private_key"), alnum).map(([name, body]) => `x=1&${name}=${body}`),
      alnum.map((body) => {
        const held = `held-${body}`;
        registerSecret(held);
        return `before ${held} after`;
      }),
    );
    let attempt = 0;
    await fc.assert(
      // A credential stands apart from the letters and digits around it.
      fc.asyncProperty(edge(fc.string({ maxLength: 10 }), "before"), secret, edge(fc.string({ maxLength: 10 }), "after"), async (before, value, after) => {
        const key = `fuzz-secret-${++attempt}`;
        try {
          await runStep(place.ctx, { op: "state", key, set: "{{v}}" }, { args: {}, v: `${before}${value}${after}` });
        } catch (error) {
          expect(error).toBeInstanceOf(CliError);
          expect((error as CliError).code).toMatch(/^STATE\.(REFUSED|TOO_LARGE)$/);
          expect(existsSync(join(place.cwd, ".runlocal", key))).toBe(false);
          return;
        }
        throw new Error(`Wrote ${before}${value}${after} to the state`);
      }),
      { numRuns: Math.min(RUNS, 300) },
    );
  });
});

// ---- The manifest validator ----

describe("fuzz: the manifest validator", () => {
  const strange = fc.oneof(
    fc.jsonValue({ maxDepth: 3 }),
    fc.constant(JSON.parse('{"toString": 1}')),
    fc.constant(JSON.parse('{"valueOf": 1, "toString": 1}')),
    fc.constant(JSON.parse('{"__proto__": {"polluted": true}}')),
  );

  it("never throws anything but a CliError for random JSON", () => {
    fc.assert(
      fc.property(strange, (value) => {
        const result = onlyCliErrors(() => validateManifest(value));
        if (result instanceof CliError) expect(result.code).toBe("MANIFEST.INVALID");
      }),
    );
  });

  /** A manifest shape with random values in each place. */
  const shaped = fc.record(
    {
      schema: fc.oneof(fc.constant("runlocal.cli-manifest/1"), strange),
      version: fc.oneof(fc.constant("1"), strange),
      auth: fc.oneof(fc.record({ api_keys: fc.oneof(fc.constant("/v1/keys"), strange) }), strange),
      commands: fc.array(
        fc.record(
          {
            name: fc.oneof(fc.constant(["widgets", "list"]), strange),
            summary: fc.oneof(fc.constant("x"), strange),
            args: fc.oneof(
              fc.array(fc.record({ name: fc.oneof(fc.constant("id"), strange), kind: fc.oneof(fc.constantFrom("positional", "option", "flag"), strange), type: strange, required: strange, default: strange, short: strange, repeat: strange, choices: strange }, { requiredKeys: ["name", "kind"] }), { maxLength: 3 }),
              strange,
            ),
            steps: fc.oneof(
              fc.array(fc.record({ op: fc.oneof(fc.constantFrom("http", "upload", "read", "state", "confirm", "each", "poll", "download"), strange), method: strange, path: fc.oneof(fc.constant("/v1/x"), strange), as: strange, when: strange, body: strange, step: strange, steps: strange, until: strange, key: strange, set: strange, delete: strange, file: strange, url: strange, name: strange, max: strange }, { requiredKeys: ["op"] }), { maxLength: 3 }),
              strange,
            ),
            output: strange,
          },
          { requiredKeys: ["name", "summary", "steps"] },
        ),
        { maxLength: 3 },
      ),
    },
    { requiredKeys: ["schema", "version", "commands"] },
  );

  it("never throws anything but a CliError for a manifest with random values", () => {
    fc.assert(
      fc.property(shaped, (value) => {
        onlyCliErrors(() => validateManifest(value));
      }),
    );
  });

  it("refuses values nested too deep, and does not overflow the stack", () => {
    let body: unknown = "{{args.id}}";
    for (let i = 0; i < 100_000; i++) body = [body];
    const manifest = { schema: "runlocal.cli-manifest/1", version: "1", commands: [{ name: ["x"], summary: "x", steps: [{ op: "http", method: "POST", path: "/v1/x", body }] }] };
    const result = onlyCliErrors(() => validateManifest(manifest));
    expect(result).toBeInstanceOf(CliError);
  });

  /** The places of the fixture that are objects of the format (not request data). */
  function formatObjects(value: unknown, path: (string | number)[] = []): (string | number)[][] {
    if (Array.isArray(value)) return value.flatMap((item, i) => formatObjects(item, [...path, i]));
    if (!value || typeof value !== "object") return [];
    const found = [path];
    for (const [key, item] of Object.entries(value)) {
      if (["body", "query", "headers", "in"].includes(key)) continue;
      found.push(...formatObjects(item, [...path, key]));
    }
    return found;
  }
  const places = formatObjects(fixture);

  it("refuses an unknown field in any object of the format", () => {
    const unknownField = fc.oneof(
      fc.stringMatching(/^[a-z_]{1,10}$/).map((name) => `x_${name}`),
      fc.constantFrom("script", "exec", "eval", "code", "run", "shell", "template", "filter", "redirect", "credential", "__proto__", "constructor"),
    );
    fc.assert(
      fc.property(fc.constantFrom(...places), unknownField, fc.jsonValue({ maxDepth: 1 }), (place, field, value) => {
        const copy = structuredClone(fixture);
        let target = copy;
        for (const part of place) target = target[part];
        fc.pre(!Object.hasOwn(target, field));
        // A known field of another object is still unknown here, unless this object allows it.
        const before = onlyCliErrors(() => validateManifest(copy));
        expect(before).not.toBeInstanceOf(CliError);
        Object.defineProperty(target, field, { value, enumerable: true, configurable: true, writable: true });
        const after = onlyCliErrors(() => validateManifest(copy));
        if (!(after instanceof CliError)) {
          throw new Error(`Accepted the field ${field} at ${place.join(".") || "the top"}`);
        }
      }),
    );
  });
});

describe("fuzz: masking", () => {
  const alnum = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const chars = (alphabet: string, min: number, max: number) =>
    fc.string({ unit: fc.constantFrom(...alphabet), minLength: min, maxLength: max });
  /** A JSON string value: no quote, backslash, or control character. */
  const value = fc.string({ minLength: 1, maxLength: 60 }).filter((text) => !/["\\\u0000-\u001f]/.test(text));
  const strongName = fc.constantFrom("password", "client_secret", "api_key", "apiKey", "authorization", "private_key", "access_token", "refresh_token", "device_code", "x-api-key");
  const describing = fc.constantFrom("type", "kind", "prefix", "hint", "name", "url", "env", "count");
  const plain = fc.oneof(
    fc.constantFrom("api_key", "session", "bearer", "basic", "oauth", "RUNLOCAL_API_KEY", "user", "service"),
    fc.stringMatching(/^[a-z][a-z_]{0,15}$/),
    fc.nat({ max: 1_000_000 }).map(String),
  );

  it("never throws, is stable on its own output, and never lets a held secret through", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 200 }), chars(alnum, 8, 30), (text, secret) => {
        clearSecrets();
        registerSecret(secret);
        const once = mask(`${text} ${secret} ${text}`);
        expect(once).not.toContain(secret);
        expect(mask(once)).toBe(once);
        clearSecrets();
      }),
    );
  });

  it("masks any value of a field whose name is clearly a secret", () => {
    fc.assert(
      fc.property(strongName, value, (name, secret) => {
        expect(mask(`{"${name}": "${secret}"}`)).toBe(`{"${name}": "${MASK}"}`);
      }),
    );
  });

  it("leaves a plain value of a field that describes a credential", () => {
    fc.assert(
      fc.property(fc.constantFrom("credential", "token", "key", "secret", "password", "api_key"), describing, plain, (word, last, text) => {
        const json = `{"${word}_${last}":"${text}"}`;
        expect(mask(json)).toBe(json);
        expect(mask(`${word}_${last}=${text}`)).toBe(`${word}_${last}=${text}`);
      }),
    );
  });

  it("leaves a plain word in a field of a weaker name, and masks a value with digits in it", () => {
    fc.assert(
      fc.property(fc.constantFrom("token", "key", "credential", "auth"), plain, chars(alnum, 4, 30), (name, word, body) => {
        expect(mask(`{"${name}":"${word}"}`)).toBe(`{"${name}":"${word}"}`);
        const keyish = `${body}4821`;
        expect(mask(`{"${name}":"${keyish}"}`)).toBe(`{"${name}":"${MASK}"}`);
      }),
    );
  });

  it("keeps the visible start of a prefixed key, and masks the rest", () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z]{2,8}$/), chars(alnum, 40, 80), (prefix, body) => {
        const out = mask(`key ${prefix}_${body} end`);
        expect(out).toBe(`key ${prefix}_${body.slice(0, 8)}… end`);
      }),
    );
  });

  it("leaves hex digests and UUIDs with no name", () => {
    fc.assert(
      fc.property(chars("0123456789abcdef", 64, 64), fc.uuid(), (hex, uuid) => {
        expect(mask(`sha256:${hex} ${uuid}`)).toBe(`sha256:${hex} ${uuid}`);
      }),
    );
  });
});
