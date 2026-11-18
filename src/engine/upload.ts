// SPDX-License-Identifier: Apache-2.0
// Uploads a file: begin, then the bytes (in one write or in parts), then
// finish. The file is read as a stream, never all into memory. The engine
// computes the SHA-256 of the file, and resumes an upload in parts that stopped.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { rm, stat } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { basename, join } from "node:path";
import { pipeline } from "node:stream/promises";
import type { UploadStep } from "../manifest/schema.js";
import { CliError, EXIT, serverError, userError } from "../util/errors.js";
import { configDir, ensureDir, readJsonFile, shortHash, writeFileAtomic } from "../util/files.js";
import { isSafeForeignUrl } from "../origin.js";
import { type Data, type EngineContext, localFile } from "./context.js";
import { buildRequest, holds } from "./request.js";
import { lookup, parsePath, renderString } from "./template.js";

interface UploadRecord {
  origin: string;
  sha256: string;
  size: number;
  begin: unknown;
  part_size: number;
  count: number;
  done: number[];
  etags: Record<string, string>;
}

const PART_TRIES = 3;

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

/**
 * Writes bytes [start, end) of the file to an address that the server gave.
 * The address is signed by the server, so rlx sends no credential with it.
 */
async function putBytes(ctx: EngineContext, address: string, path: string, start: number, end: number): Promise<string> {
  let target: URL;
  try {
    target = new URL(address);
  } catch {
    throw serverError(`The server gave an address that is not valid for the bytes.`, "UPLOAD.ADDRESS");
  }
  if (target.origin !== ctx.api.origin && !isSafeForeignUrl(target)) {
    throw new CliError(`Refused to send bytes to ${target.origin}: it does not use https.`, {
      code: "ORIGIN.REFUSED",
    });
  }
  const send = target.protocol === "https:" ? httpsRequest : httpRequest;
  let lastError: Error | undefined;
  for (let attempt = 1; attempt <= PART_TRIES; attempt++) {
    try {
      const { status, etag } = await new Promise<{ status: number; etag: string }>((resolve, reject) => {
        const req = send(target, { method: "PUT", headers: { "Content-Length": String(end - start) } }, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, etag: String(res.headers.etag ?? "") }));
          res.on("error", reject);
        });
        req.on("error", reject);
        req.setTimeout(10 * 60_000, () => req.destroy(new Error("timed out")));
        if (end > start) {
          const stream = createReadStream(path, { start, end: end - 1, highWaterMark: 1024 * 1024 });
          stream.on("error", (error) => req.destroy(error));
          stream.pipe(req);
        } else {
          req.end();
        }
      });
      ctx.out.debug(`PUT ${target.origin}${target.pathname} (${end - start} bytes) -> ${status}`);
      if (status >= 200 && status < 300) return etag;
      lastError = new Error(`the store answered ${status}`);
      if (status < 500 && status !== 408 && status !== 429) break;
    } catch (error) {
      lastError = error as Error;
    }
    if (attempt < PART_TRIES) await ctx.io.sleep(attempt * 1000);
  }
  throw new CliError(`Could not write the bytes: ${lastError?.message ?? "unknown error"}. Run the command again to resume.`, {
    exitCode: EXIT.server,
    code: "UPLOAD.PART",
  });
}

function recordPath(ctx: EngineContext, id: string): string {
  return join(configDir(ctx.io), "uploads", `${id}.json`);
}

async function saveRecord(ctx: EngineContext, path: string, record: UploadRecord): Promise<void> {
  await ensureDir(join(configDir(ctx.io), "uploads"));
  await writeFileAtomic(path, JSON.stringify(record), 0o600);
}

async function finish(ctx: EngineContext, step: UploadStep, scope: Data): Promise<unknown> {
  if (!step.finish) return scope.begin;
  return (await ctx.api.request(buildRequest(step.finish, scope))).body;
}

async function uploadParts(
  ctx: EngineContext,
  step: UploadStep,
  scope: Data,
  record: UploadRecord,
  path: string,
  filePath: string,
): Promise<unknown> {
  const parts = step.parts!;
  scope.begin = record.begin;
  const pending: number[] = [];
  for (let n = 1; n <= record.count; n++) if (!record.done.includes(n)) pending.push(n);
  const batch = parts.batch ?? 100;
  const name = basename(filePath);
  for (let i = 0; i < pending.length; i += batch) {
    const numbers = pending.slice(i, i + batch);
    const answer = (await ctx.api.request(buildRequest(parts, { ...scope, numbers }))).body;
    const list = lookup(answer, parsePath(parts.list));
    if (!Array.isArray(list)) throw serverError("The server did not list the parts.", "UPLOAD.PARTS");
    const seen = new Set<number>();
    for (const item of list) {
      const n = Number(lookup(item, parsePath(parts.number)));
      const address = lookup(item, parsePath(parts.url));
      if (!numbers.includes(n) || typeof address !== "string") {
        throw serverError("The server listed a part that rlx did not ask for.", "UPLOAD.PARTS");
      }
      const start = (n - 1) * record.part_size;
      const end = Math.min(n * record.part_size, record.size);
      const etag = await putBytes(ctx, address, filePath, start, end);
      seen.add(n);
      record.done.push(n);
      record.etags[String(n)] = etag;
      await saveRecord(ctx, path, record);
      ctx.out.info(`Uploaded ${name}: part ${record.done.length} of ${record.count}.`);
    }
    for (const n of numbers) {
      if (!seen.has(n)) throw serverError(`The server gave no address for part ${n}.`, "UPLOAD.PARTS");
    }
  }
  const etags = Object.entries(record.etags)
    .map(([number, etag]) => ({ number: Number(number), etag }))
    .sort((a, b) => a.number - b.number);
  const result = await finish(ctx, step, { ...scope, etags });
  await rm(path, { force: true });
  return result;
}

export async function runUpload(ctx: EngineContext, step: UploadStep, data: Data): Promise<unknown> {
  const given = renderString(step.file, data, { required: true });
  const filePath = localFile(ctx, given);
  let size: number;
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
    size = info.size;
  } catch {
    throw userError(`No such file: ${given}`, "FILE.MISSING");
  }
  const name = basename(filePath);
  ctx.out.info(`Reading ${name} (${size} bytes) for its SHA-256...`);
  const sha256 = await sha256File(filePath);
  const scope: Data = { ...data, file: { path: given, name, size, sha256 } };

  const beginRequest = buildRequest(step.begin, scope);
  const id = shortHash(ctx.api.origin, beginRequest.method, beginRequest.path, sha256, String(size));
  const path = recordPath(ctx, id);

  if (step.parts) {
    const record = await readJsonFile<UploadRecord>(path);
    if (record && record.origin === ctx.api.origin && record.sha256 === sha256 && record.size === size) {
      ctx.out.info(`Resuming the upload of ${name}: ${record.done.length} of ${record.count} parts are there.`);
      try {
        return await uploadParts(ctx, step, scope, record, path, filePath);
      } catch (error) {
        const status = (error as CliError).status;
        if (status === undefined || ![404, 409, 410].includes(status)) throw error;
        ctx.out.info("The stopped upload cannot go on. Starting it again.");
        await rm(path, { force: true });
      }
    }
  }

  const begin = (await ctx.api.request(beginRequest)).body;
  scope.begin = begin;
  if (step.done && holds(step.done, begin)) {
    ctx.out.info(`The server holds the bytes of ${name} already.`);
    return begin;
  }

  const single = step.single ? lookup(begin, parsePath(step.single)) : undefined;
  if (typeof single === "string" && single) {
    const etag = await putBytes(ctx, single, filePath, 0, size);
    ctx.out.info(`Uploaded ${name}.`);
    return finish(ctx, step, { ...scope, etags: [{ number: 1, etag }] });
  }
  if (!step.parts) throw serverError("The server gave no address for the bytes.", "UPLOAD.ADDRESS");

  const partSize = Number(lookup(begin, parsePath(step.parts.size)));
  if (!Number.isInteger(partSize) || partSize <= 0) throw serverError("The server gave no part size.", "UPLOAD.PARTS");
  const count = step.parts.count
    ? Number(lookup(begin, parsePath(step.parts.count)))
    : Math.max(1, Math.ceil(size / partSize));
  if (!Number.isInteger(count) || count <= 0 || count * partSize < size || (count - 1) * partSize >= Math.max(size, 1)) {
    throw serverError("The part size and the number of parts do not fit the file.", "UPLOAD.PARTS");
  }
  const record: UploadRecord = { origin: ctx.api.origin, sha256, size, begin, part_size: partSize, count, done: [], etags: {} };
  await saveRecord(ctx, path, record);
  return uploadParts(ctx, step, scope, record, path, filePath);
}
