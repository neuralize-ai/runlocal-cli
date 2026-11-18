// SPDX-License-Identifier: Apache-2.0
// Downloads a file from an address that the server gave (a signed URL) into
// a local folder. rlx sends no credential with the request. It writes only
// inside the folder, to a temporary file that it renames when the size and the
// SHA-256 are correct, and it never replaces a different file.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { lstat, mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep, isAbsolute } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { randomBytes } from "node:crypto";
import type { DownloadStep } from "../manifest/schema.js";
import { isSafeForeignUrl } from "../origin.js";
import { CliError, EXIT, serverError, userError } from "../util/errors.js";
import { type Data, type EngineContext, localFile } from "./context.js";
import { renderString } from "./template.js";

export interface Downloaded {
  path: string;
  name: string;
  size: number;
  sha256: string;
  /** False when the same file was there already. */
  written: boolean;
}

/** Checks a relative file path that the server gave. Each part must be a plain name. */
export function safeRelativePath(name: string): string {
  const parts = name.split("/");
  if (
    !name ||
    isAbsolute(name) ||
    name.includes("\\") ||
    name.includes("\0") ||
    parts.some((part) => part === "" || part === "." || part === "..")
  ) {
    throw serverError(`Refused to write "${name}": a file name must be a relative path with plain parts.`, "DOWNLOAD.NAME");
  }
  return parts.join(sep);
}

/**
 * The folder and the file that a download writes. The folder is `dir`, or the
 * current folder. The name must be a relative path with plain parts, it must
 * stay inside the folder, and no part of it that exists can be a symbolic
 * link. Neither can be in a folder of rlx.
 */
export async function downloadTarget(ctx: EngineContext, dirText: string, name: string): Promise<{ folder: string; target: string }> {
  const folder = localFile(ctx, dirText || ".");
  const relativeName = safeRelativePath(name);
  const target = resolve(folder, relativeName);
  const inside = relative(folder, target);
  if (!inside || inside.startsWith("..") || isAbsolute(inside)) {
    throw serverError(`Refused to write "${name}" outside ${dirText || "the current folder"}.`, "DOWNLOAD.NAME");
  }
  let current = folder;
  for (const part of relativeName.split(sep)) {
    current = join(current, part);
    const info = await lstat(current).catch(() => undefined);
    if (!info) break;
    if (info.isSymbolicLink()) {
      throw serverError(`Refused to write "${name}": ${relative(folder, current)} is a symbolic link.`, "DOWNLOAD.NAME");
    }
  }
  localFile(ctx, target);
  return { folder, target };
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

function sizeText(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

export async function runDownload(ctx: EngineContext, step: DownloadStep, data: Data): Promise<Downloaded> {
  const address = renderString(step.url, data, { required: true });
  const name = renderString(step.name, data, { required: true });
  const dirText = step.dir === undefined ? "" : renderString(step.dir, data);
  const { target } = await downloadTarget(ctx, dirText, name);
  const sizeRaw = step.size === undefined ? "" : renderString(step.size, data);
  if (sizeRaw !== "" && !/^\d{1,15}$/.test(sizeRaw)) {
    throw serverError(`"${sizeRaw.slice(0, 40)}" is not a size in bytes.`, "DOWNLOAD.SIZE");
  }
  const expectedSize = sizeRaw === "" ? undefined : Number(sizeRaw);
  const digestRaw = step.digest === undefined ? "" : renderString(step.digest, data);
  const expectedSha = digestRaw ? /^sha256:([0-9a-f]{64})$/.exec(digestRaw)?.[1] : undefined;
  if (digestRaw && !expectedSha) throw serverError(`"${digestRaw}" is not a sha256:<hex> digest.`, "DOWNLOAD.DIGEST");

  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw serverError("The server gave an address that is not valid for the file.", "DOWNLOAD.ADDRESS");
  }
  if (url.origin !== ctx.api.origin && !isSafeForeignUrl(url)) {
    throw new CliError(`Refused to read a file from ${url.origin}: it does not use https.`, { code: "ORIGIN.REFUSED" });
  }

  const existing = await stat(target).catch(() => undefined);
  if (existing) {
    if (!existing.isFile()) throw userError(`${target} is there and is not a file. Choose another folder.`, "DOWNLOAD.EXISTS");
    const sha256 = await sha256Of(target);
    if ((expectedSha && sha256 === expectedSha) || (!expectedSha && existing.size === expectedSize)) {
      ctx.out.info(`${name} is there already.`);
      return { path: target, name, size: existing.size, sha256, written: false };
    }
    throw userError(`${target} is there and is different. Remove it, or choose another folder.`, "DOWNLOAD.EXISTS");
  }

  // A signed address needs no credential, so the request has none. rlx follows no redirect.
  let response: Response;
  try {
    response = await ctx.io.fetch(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(60 * 60_000) });
  } catch (error) {
    throw new CliError(`Could not read ${name}: ${(error as Error).message}. Run the command again.`, {
      exitCode: EXIT.server,
      code: "NETWORK",
    });
  }
  ctx.out.debug(`GET ${url.origin}${url.pathname} -> ${response.status}`);
  if (response.status >= 300 && response.status < 400) {
    await response.body?.cancel();
    throw new CliError(`Refused to follow a redirect for ${name}.`, { exitCode: EXIT.server, code: "ORIGIN.REFUSED", status: response.status });
  }
  if (!response.ok || !response.body) {
    throw serverError(`The store answered ${response.status} for ${name}. Run the command again for a new address.`, "DOWNLOAD.FAILED", response.status);
  }
  const total = expectedSize ?? (Number(response.headers.get("content-length")) || undefined);

  await mkdir(dirname(target), { recursive: true });
  const temp = join(dirname(target), `.${randomBytes(6).toString("hex")}.part`);
  const hash = createHash("sha256");
  let bytes = 0;
  let shown = 0;
  const step10 = total ? Math.max(1, Math.floor(total / 10)) : 64 * 1024 * 1024;
  const counter = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      bytes += chunk.length;
      hash.update(chunk);
      if (bytes - shown >= step10) {
        shown = bytes;
        ctx.out.info(`Downloading ${name}: ${sizeText(bytes)}${total ? ` of ${sizeText(total)}` : ""}...`);
      }
      done(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(temp, { mode: 0o644, flags: "wx" }));
    const sha256 = hash.digest("hex");
    if (expectedSize !== undefined && bytes !== expectedSize) {
      throw serverError(`${name} has ${bytes} bytes, not ${expectedSize}. Run the command again.`, "DOWNLOAD.SIZE");
    }
    if (expectedSha && sha256 !== expectedSha) {
      throw serverError(`The SHA-256 of ${name} is not the one that the server gave. Run the command again.`, "DOWNLOAD.DIGEST");
    }
    await rename(temp, target);
    ctx.out.info(`Downloaded ${name} (${sizeText(bytes)}).`);
    return { path: target, name, size: bytes, sha256, written: true };
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}
