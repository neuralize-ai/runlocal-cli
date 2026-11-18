// SPDX-License-Identifier: Apache-2.0
// Masks values that look like credentials. Every line that rlx writes goes
// through `mask`, so a credential never reaches the terminal or a log.

export const MASK = "[masked]";

const known = new Set<string>();

/** Registers a secret that rlx holds, so that it is masked wherever it shows. */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === "string" && value.length >= 8) known.add(value);
}

/** For tests only. */
export function clearSecrets(): void {
  known.clear();
}

const SECRET_NAME =
  "[A-Za-z0-9_-]*(?:token|secret|password|passwd|api_key|apikey|api-key|device_code|private_key|credential)[A-Za-z0-9_-]*";

type Rule = [RegExp, (match: string, ...groups: string[]) => string];

const RULES: Rule[] = [
  // Authorization: Bearer <value>, Basic <value>
  [/(?<![A-Za-z0-9])(Bearer|Basic)(\s+)[A-Za-z0-9._~+/=-]{6,}/gi, (_m, scheme, space) => `${scheme}${space}${MASK}`],
  // JSON Web Tokens.
  [/(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g, () => MASK],
  // A key with a short prefix and a long random body. The prefix and the next
  // eight characters stay, because they are the visible start of a key. The
  // key stands apart from letters and digits; an underscore next to it, as in
  // NAME_tok_..., does not hide it.
  [/(?<![A-Za-z0-9])([a-z]{2,8}_)([A-Za-z0-9]{8})[A-Za-z0-9]{32,}(?![A-Za-z0-9])/g, (_m, prefix, start) => `${prefix}${start}…`],
  // "name": "value" in JSON, where the name says that the value is secret.
  [
    new RegExp(`("${SECRET_NAME}"\\s*:\\s*")((?:[^"\\\\]|\\\\.)+)(")`, "gi"),
    (_m, before, _value, after) => `${before}${MASK}${after}`,
  ],
  // name=value in a query, a form, or the environment.
  [
    new RegExp(`\\b(${SECRET_NAME}=)[^&\\s"']+`, "gi"),
    (_m, before) => `${before}${MASK}`,
  ],
];

/** Returns the text with each value that looks like a credential masked. */
export function mask(text: string): string {
  let out = text;
  for (const secret of known) {
    if (out.includes(secret)) out = out.split(secret).join(MASK);
  }
  for (const [pattern, replace] of RULES) {
    out = out.replace(pattern, replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

/** True when the value is a credential that rlx holds, or looks like one. */
export function looksLikeCredential(value: string): boolean {
  for (const secret of known) if (value.includes(secret)) return true;
  return mask(value) !== value;
}
