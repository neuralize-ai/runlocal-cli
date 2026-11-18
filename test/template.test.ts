// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { checkTemplate, lookup, parsePath, render, renderDeep, renderString, truthy } from "../src/engine/template.js";
import { validateManifest } from "../src/manifest/schema.js";
import { buildRequest } from "../src/engine/request.js";

const data = {
  args: { id: "w-1", count: 3, "dry-run": true, tags: ["a", "b"] },
  list: { items: [{ id: "x" }, { id: "y" }] },
  empty: "",
};

describe("templates", () => {
  it("inserts values into a string", () => {
    expect(renderString("widget {{args.id}} of {{args.count}}", data)).toBe("widget w-1 of 3");
  });

  it("keeps the type of a value when the string is one tag", () => {
    expect(render("{{args.count}}", data)).toBe(3);
    expect(render("{{args.tags}}", data)).toEqual(["a", "b"]);
    expect(render("{{list.items.1}}", data)).toEqual({ id: "y" });
    expect(render("{{args.dry-run}}", data)).toBe(true);
  });

  it("gives undefined for a missing value, and leaves it out of an object", () => {
    expect(render("{{args.nothing}}", data)).toBeUndefined();
    expect(renderDeep({ a: "{{args.nothing}}", b: "{{args.id}}" }, data)).toEqual({ b: "w-1" });
  });

  it("applies the fixed filters", () => {
    expect(render('{{args.nothing | default:"none"}}', data)).toBe("none");
    expect(render("{{args.tags | join:\"+\"}}", data)).toBe("a+b");
    expect(render("{{list.items | length}}", data)).toBe(2);
    expect(render("{{args.tags | json}}", data)).toBe('["a","b"]');
    expect(render("{{args.count | string}}", data)).toBe("3");
  });

  it("encodes values for a path", () => {
    expect(renderString("/v1/widgets/{{args.id}}", { args: { id: "a/b?c" } }, { encode: encodeURIComponent })).toBe(
      "/v1/widgets/a%2Fb%3Fc",
    );
  });

  it("does not read an inserted value as a template again", () => {
    const evil = { args: { id: "{{args.secret}}", secret: "s3cret" } };
    expect(renderString("x {{args.id}}", evil)).toBe("x {{args.secret}}");
  });

  it("truthy reads yes and no values", () => {
    expect(truthy("false")).toBe(false);
    expect(truthy("")).toBe(false);
    expect(truthy([])).toBe(false);
    expect(truthy("x")).toBe(true);
    expect(truthy(1)).toBe(true);
  });
});

describe("templates cannot run code", () => {
  const attempts = [
    "{{process.exit(1)}}",
    "{{ require('child_process') }}",
    "{{args.id; globalThis.pwned = 1}}",
    "{{constructor.constructor}}",
    "{{args.__proto__}}",
    "{{args.prototype}}",
    "{{`${1+1}`}}",
    "{{ (() => 1)() }}",
    "{{args.id | eval}}",
    "{{args.id | constructor}}",
  ];

  for (const attempt of attempts) {
    it(`refuses ${attempt}`, () => {
      expect(() => checkTemplate(attempt)).toThrow(/Template error/);
      expect(() => render(attempt, data)).toThrow(/Template error/);
    });
  }

  it("never touches global state", () => {
    for (const attempt of attempts) {
      try {
        render(attempt, data);
      } catch {
        // expected
      }
    }
    expect((globalThis as Record<string, unknown>).pwned).toBeUndefined();
  });

  it("reads own fields only", () => {
    expect(lookup({}, ["toString"])).toBeUndefined();
    expect(lookup({ a: {} }, ["a", "hasOwnProperty"])).toBeUndefined();
    expect(() => parsePath("a.__proto__.b")).toThrow();
  });

  it("drops forbidden keys from a rendered object", () => {
    const value = JSON.parse('{"__proto__": {"polluted": true}, "ok": 1}');
    const rendered = renderDeep(value, data) as Record<string, unknown>;
    expect(rendered.ok).toBe(1);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("a path that names a global reads the data only", () => {
    expect(render("{{process.env.HOME}}", data)).toBeUndefined();
    expect(render("{{globalThis}}", data)).toBeUndefined();
  });

  it("a manifest with a code template is not valid", () => {
    const manifest = {
      schema: "runlocal.cli-manifest/1",
      version: "1",
      commands: [
        {
          name: ["x"],
          summary: "x",
          steps: [{ op: "http", method: "GET", path: '/v1/x/{{ process.env["HOME"] }}' }],
        },
      ],
    };
    expect(() => validateManifest(manifest)).toThrow(/not valid/);
  });
});

// Regressions that the fuzz tests found (test/fuzz.test.ts).
describe("template regressions", () => {
  it("a bad string literal is a template error, not a crash", () => {
    expect(() => checkTemplate('{{a | default:"\t"}}')).toThrow(/Template error: .* not a valid JSON string/);
    expect(() => checkTemplate('{{a | default:"\\x"}}')).toThrow(/Template error/);
    expect(() => checkTemplate(`{{a | default:${"9".repeat(400)}}}`)).toThrow(/Template error: .*too large/);
  });

  it("length of a list ends the path: a segment after it has no value", () => {
    expect(lookup({ list: [1, 2] }, ["list", "length"])).toBe(2);
    expect(lookup({ list: [1, 2] }, ["list", "length", "0"])).toBeUndefined();
    expect(lookup([], ["length", "x"])).toBeUndefined();
  });

  it("a forbidden segment is refused even after a missing value", () => {
    expect(() => lookup({}, ["missing", "__proto__"])).toThrow(/not allowed/);
  });

  it("a required value that is null is missing, alone or in a string", () => {
    expect(() => render("{{v}}", { v: null }, { required: true })).toThrow(/no value for \{\{v\}\}/);
    expect(() => render("x{{v}}", { v: null }, { required: true })).toThrow(/no value/);
    expect(render("{{v}}", { v: 0 }, { required: true })).toBe(0);
    expect(render("{{v}}", { v: false }, { required: true })).toBe(false);
  });
});

describe("request regressions", () => {
  it("refuses a path value that is not valid Unicode", () => {
    expect(() => buildRequest({ method: "GET", path: "/v1/widgets/{{id}}" }, { id: "a\uD800" })).toThrow(/not a value that can go in an address/);
  });

  it("refuses a header value with a line break", () => {
    const spec = { method: "GET" as const, path: "/v1/widgets", headers: { "X-Note": "{{note}}" } };
    expect(() => buildRequest(spec, { note: "a\r\nX-Other: 1" })).toThrow(/cannot hold/);
    expect(buildRequest(spec, { note: "fine" }).headers).toEqual({ "X-Note": "fine" });
    expect(buildRequest(spec, {}).headers).toEqual({});
  });

});
