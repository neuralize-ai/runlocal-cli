// SPDX-License-Identifier: Apache-2.0
import { afterEach, describe, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import {
  clearSecrets,
  looksLikeCredential,
  looksRandom,
  mask,
  MASK,
  plainWord,
  registerSecret,
  secretField,
  secretName,
} from "../src/util/mask.js";
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

describe("masking by the name of a field", () => {
  it("does not mask a field that describes a credential", () => {
    const text = '{"authenticated":true,"credential_type":"api_key","token_kind":"session","key_prefix":"tok_ab12","secret_name":"prod"}';
    expect(mask(text)).toBe(text);
    expect(mask("credential_type=api_key&token_type=bearer")).toBe("credential_type=api_key&token_type=bearer");
    expect(mask('{"tokenType":"Bearer","keyEnv":"EXAMPLE_API_KEY","password_hint":"the usual"}')).toBe(
      '{"tokenType":"Bearer","keyEnv":"EXAMPLE_API_KEY","password_hint":"the usual"}',
    );
  });

  it("masks a field whose name is clearly a secret, whatever the value", () => {
    for (const name of ["password", "passwd", "client_secret", "secret", "api_key", "apiKey", "x-api-key", "authorization", "private_key", "access_token", "refreshToken", "device_code", "mysecretvalue"]) {
      expect(mask(`{"${name}":"hunter2"}`)).toBe(`{"${name}":"${MASK}"}`);
      expect(mask(`${name}=hunter2`)).toBe(`${name}=${MASK}`);
    }
  });

  it("masks a field with a weaker name unless the value is a short plain word", () => {
    expect(mask('{"token":"session"}')).toBe('{"token":"session"}');
    expect(mask('{"key":"color"}')).toBe('{"key":"color"}');
    expect(mask('{"token_count":"1200","credential":"api_key"}')).toBe('{"token_count":"1200","credential":"api_key"}');
    expect(mask('{"token":"a1b2c3d4e5f6"}')).toBe(`{"token":"${MASK}"}`);
    expect(mask('{"key":"Zx81-qq0p-77aa-31bc"}')).toBe(`{"key":"${MASK}"}`);
    expect(mask('{"signing_key":"short"}')).toBe(`{"signing_key":"${MASK}"}`);
    expect(mask("key=8f3a91c2d4e5")).toBe(`key=${MASK}`);
  });

  it("classifies names and values", () => {
    expect(secretName("credential_type")).toBeUndefined();
    expect(secretName("token_kind")).toBeUndefined();
    expect(secretName("password")).toBe("strong");
    expect(secretName("Authorization")).toBe("strong");
    expect(secretName("token")).toBe("weak");
    expect(secretName("key")).toBe("weak");
    expect(secretName("name")).toBeUndefined();
    expect(secretName("monkey")).toBeUndefined();
    expect(plainWord("api_key")).toBe(true);
    expect(plainWord("RUNLOCAL_API_KEY")).toBe(true);
    expect(plainWord("abc123def456")).toBe(false);
    expect(secretField("credential_type", "api_key")).toBe(false);
    expect(secretField("api_key", "")).toBe(false);
  });
});

describe("masking by the look of a value", () => {
  it("masks a long random string with no name", () => {
    let masked = 0;
    for (let i = 0; i < 1000; i++) {
      const value = randomBytes(48).toString("base64url");
      if (mask(`value ${value} end`) === `value ${MASK} end`) masked++;
    }
    expect(masked).toBeGreaterThanOrEqual(990);
    expect(mask(`AWS ${"wJ4lrXUtn9EMI/K7MD3NGbP/xRfiCY7aB2kP0qLs"}`)).toBe(`AWS ${MASK}`);
  });

  it("leaves digests, ids, and long names alone", () => {
    const samples = [
      `sha256:${"0123456789abcdef".repeat(4)}`,
      randomUUID(),
      "01ARZ3NDEKTSV4RRFFQ69G5FAV01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "models/ResNet50V2/exports/MobileNetV3LargeQuantizedInt8",
      "Snapdragon8Gen3_QualcommHexagonNPU_v75_MobileNetV2",
      "SomeVeryLongIdentifierNameWith2DigitsAndMore3",
      "j57a3k9xq2m8rv4wz1c6d0bp5ny7hst3e",
    ];
    for (const sample of samples) {
      expect(mask(sample)).toBe(sample);
      expect(looksRandom(sample)).toBe(false);
    }
  });
});
