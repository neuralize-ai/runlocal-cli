// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { clearSecrets, looksLikeCredential, mask, MASK, registerSecret } from "../src/util/mask.js";
import { Out } from "../src/util/io.js";
import { testIo, tempDir } from "./helpers/cli.js";

afterEach(() => clearSecrets());

describe("credential masking", () => {
  it("masks a bearer header", () => {
    expect(mask("Authorization: Bearer abc.def-ghi_123")).toBe(`Authorization: Bearer ${MASK}`);
  });

  it("masks a JSON Web Token", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(mask(`token ${jwt} here`)).toBe(`token ${MASK} here`);
  });

  it("keeps only the visible start of a prefixed key", () => {
    const key = `tok_${"0123456789abcdef".repeat(4)}`;
    expect(mask(`key ${key}.`)).toBe("key tok_01234567….");
  });

  it("masks secret fields in JSON and in a query", () => {
    expect(mask('{"refresh_token":"r-1","name":"x","api_key":"k"}')).toBe(`{"refresh_token":"${MASK}","name":"x","api_key":"${MASK}"}`);
    expect(mask("GET /x?device_code=abc&user=me")).toBe(`GET /x?device_code=${MASK}&user=me`);
  });

  it("masks a secret that rlx holds, in any form", () => {
    registerSecret("short-but-secret");
    expect(mask("the value short-but-secret leaked")).toBe(`the value ${MASK} leaked`);
    expect(looksLikeCredential("short-but-secret")).toBe(true);
  });

  it("leaves ordinary text alone", () => {
    const text = "ID  Name\nw1  Alpha  user_01ARZ3NDEKTSV4RRFFQ69G5FAV  sha256:abc";
    expect(mask(text)).toBe(text);
    expect(looksLikeCredential("cursor-42")).toBe(false);
  });

  it("masks every line that rlx writes, with or without --debug", () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io = testIo({ home: tempDir() }, { stdout, stderr, prompts: [] });
    registerSecret("the-held-secret-value");
    const out = new Out(io, { json: false, yes: false, quiet: false, debug: true, help: false, version: false, api: undefined });
    out.result("result the-held-secret-value");
    out.info("info Bearer abcdefgh");
    out.debug("debug the-held-secret-value");
    out.warn("warn the-held-secret-value");
    expect([...stdout, ...stderr].join("")).not.toContain("the-held-secret-value");
    expect(stderr.join("")).not.toContain("abcdefgh");
  });
});

describe("mask regressions", () => {
  it("masks a key, a bearer value, and a JWT next to an underscore", () => {
    const key = `tok_${"Ab12".repeat(10)}`;
    expect(mask(`NAME_${key}`)).toBe("NAME_tok_Ab12Ab12…");
    expect(mask(`${key}_x`)).toBe("tok_Ab12Ab12…_x");
    expect(mask("x_Bearer abcdefghij")).toBe("x_Bearer [masked]");
    expect(mask("x_eyJabcd.efghij.klmnop")).toBe("x_[masked]");
    expect(looksLikeCredential(`a_${key}`)).toBe(true);
  });
});
