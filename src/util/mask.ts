// SPDX-License-Identifier: Apache-2.0
// Masks values that look like credentials. Every line that rlx writes goes
// through `mask`, so a credential never reaches the terminal or a log.
//
// A value is masked for what it is (a key that rlx holds, a bearer value, a
// JSON Web Token, a prefixed key, a long random string), or for the name of
// its field (password, secret, token, key, authorization, and the like). A
// field whose name only describes a credential (credential_type, token_kind,
// key_prefix) is not masked for its name, and neither is a short word in a
// field of a weaker name ("token": "session").

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

/** Words of a field name whose value is a secret, whatever it looks like. */
const STRONG_WORDS = new Set(["password", "passwd", "passphrase", "secret", "secrets", "authorization", "apikey", "cookie"]);
/** Pairs of words, side by side, that name a secret. */
const STRONG_PAIRS = new Set([
  "api key", "private key", "access key", "signing key", "secret key",
  "access token", "refresh token", "id token", "session token", "bearer token", "auth token",
  "device code", "client secret",
]);
/** Words of a field name whose value is masked unless it is a short plain word. */
const WEAK_WORDS = new Set(["token", "key", "credential", "credentials", "auth", "signature", "sig"]);
/** Parts of a field name with no separator, such as "githubtoken". */
const STRONG_PARTS = ["password", "passwd", "passphrase", "secret", "apikey", "privatekey", "accesstoken", "refreshtoken", "devicecode"];
const WEAK_PARTS = ["token", "credential"];
/**
 * The last word of a field name that says the value describes a credential
 * and is not one: credential_type, token_kind, key_prefix, secret_name.
 */
const DESCRIBING_WORDS = new Set([
  "type", "types", "kind", "kinds", "hint", "prefix", "suffix", "last4", "name", "names", "label", "count", "length",
  "url", "uri", "endpoint", "env", "var", "file", "path", "mode", "days", "format", "scheme", "method", "status", "state",
  "scope", "scopes", "expires", "expiry", "ttl", "at", "set", "present", "configured", "required", "enabled", "version",
  "header", "field", "source", "policy", "rotation", "created", "updated", "used", "algorithm", "alg",
]);

/** The words of a field name: split at "_", "-", ".", and camelCase. */
function wordsOf(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export type SecretName = "strong" | "weak" | undefined;

/** Whether a field name says that its value is secret: always (strong), or unless the value is a short plain word (weak). */
export function secretName(name: string): SecretName {
  const words = wordsOf(name);
  if (words.length === 0) return undefined;
  if (DESCRIBING_WORDS.has(words[words.length - 1]!) && words.length > 1) return undefined;
  if (words.some((word) => STRONG_WORDS.has(word))) return "strong";
  for (let i = 1; i < words.length; i++) if (STRONG_PAIRS.has(`${words[i - 1]} ${words[i]}`)) return "strong";
  if (words.some((word) => WEAK_WORDS.has(word))) return "weak";
  const joined = words.join("");
  if (STRONG_PARTS.some((part) => joined.includes(part))) return "strong";
  if (WEAK_PARTS.some((part) => joined.includes(part))) return "weak";
  return undefined;
}

/**
 * A short plain value, such as an enum value ("api_key", "session",
 * "RUNLOCAL_API_KEY") or a small number: at most 24 characters, a letter
 * first, few digits, and no random look.
 */
export function plainWord(value: string): boolean {
  if (/^\d{1,10}$/.test(value)) return true;
  if (value.length > 24 || !/^[A-Za-z][A-Za-z0-9_.:/-]*$/.test(value)) return false;
  return (value.match(/[0-9]/g)?.length ?? 0) <= 3;
}

/** The Shannon entropy of a text, in bits for each character. */
function entropy(text: string): number {
  const counts = new Map<string, number>();
  for (const char of text) counts.set(char, (counts.get(char) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / text.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

/**
 * A long random string: at least 40 characters of base64 or base64url, with
 * small letters, capital letters, and digits, high entropy, and the classes
 * of characters mixed as in random text. A hex digest, a ULID, or a long
 * camelCase name is not one.
 */
export function looksRandom(text: string): boolean {
  const body = text.replace(/=+$/, "");
  if (body.length < 40 || !/[a-z]/.test(body) || !/[A-Z]/.test(body) || !/[0-9]/.test(body)) return false;
  if (entropy(body) < 4.3) return false;
  const classes = [...body].flatMap((char) => (/[a-z]/.test(char) ? [0] : /[A-Z]/.test(char) ? [1] : /[0-9]/.test(char) ? [2] : []));
  let changes = 0;
  for (let i = 1; i < classes.length; i++) if (classes[i] !== classes[i - 1]) changes++;
  return changes / (classes.length - 1) >= 0.45;
}

/** Whether the value of a field is masked, by the name of the field and by the value. */
export function secretField(name: string, value: string): boolean {
  if (value.length === 0) return false;
  const kind = secretName(name);
  if (kind === "strong") return true;
  if (kind === "weak") return !plainWord(value);
  return false;
}

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
  // A long random string of base64 or base64url, standing apart.
  [/(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{40,}={0,2}(?![A-Za-z0-9+/=_-])/g, (match) => (looksRandom(match) ? MASK : match)],
  // "name": "value" in JSON, where the name says that the value is secret.
  [
    /("([A-Za-z0-9_.-]{1,64})"\s*:\s*")((?:[^"\\]|\\.)*)(")/g,
    (match, before, name, value, after) => (secretField(name, value) ? `${before}${MASK}${after}` : match),
  ],
  // name=value in a query, a form, or the environment.
  [
    /\b([A-Za-z0-9_.-]{1,64})=([^&\s"']+)/g,
    (match, name, value) => (value !== MASK && secretField(name, value) ? `${name}=${MASK}` : match),
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
