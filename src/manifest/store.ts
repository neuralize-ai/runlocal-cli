// SPDX-License-Identifier: Apache-2.0
// Reads the command manifest of the signed-in person, and keeps it in the
// config folder for at most one day, for each origin and each credential.

import { createHash } from "node:crypto";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Api } from "../api.js";
import type { Io } from "../util/io.js";
import { configDir, ensureDir, readJsonFile, shortHash, writeFileAtomic } from "../util/files.js";
import { type Manifest, validateManifest } from "./schema.js";

export const MANIFEST_PATH = "/api/v1/cli/manifest";
export const MANIFEST_MAX_AGE_MS = 24 * 60 * 60 * 1000;

interface CachedManifest {
  origin: string;
  fetched_at: number;
  etag?: string;
  manifest: unknown;
}

export function manifestCachePath(io: Io, origin: string, credential: string): string {
  const credentialHash = createHash("sha256").update(credential).digest("hex");
  return join(configDir(io), `manifest-${shortHash(origin, credentialHash)}.json`);
}

export interface LoadedManifest {
  manifest: Manifest;
  fromCache: boolean;
}

/**
 * Returns the manifest. A cached manifest younger than one day is used as it
 * is. An older one is checked with its ETag. `refresh` reads it again.
 * Each answer of the server that states another manifest version drops the cache.
 */
export async function loadManifest(
  api: Api,
  io: Io,
  credential: string,
  options: { refresh?: boolean; cache?: boolean } = {},
): Promise<LoadedManifest> {
  const useCache = options.cache !== false;
  const path = manifestCachePath(io, api.origin, credential);
  const cached = useCache ? await readJsonFile<CachedManifest>(path) : undefined;
  const usable = cached && cached.origin === api.origin ? cached : undefined;

  const watch = (manifest: Manifest): void => {
    api.onManifestVersion = async (version) => {
      if (version !== manifest.version && useCache) await rm(path, { force: true });
    };
  };

  if (usable && !options.refresh && io.now() - usable.fetched_at < MANIFEST_MAX_AGE_MS) {
    try {
      const manifest = validateManifest(usable.manifest);
      watch(manifest);
      return { manifest, fromCache: true };
    } catch {
      // Read it again below.
    }
  }

  const response = await api.request({
    method: "GET",
    path: MANIFEST_PATH,
    ifNoneMatch: !options.refresh ? usable?.etag : undefined,
  });

  if (response.status === 304 && usable) {
    const manifest = validateManifest(usable.manifest);
    await save(io, path, { ...usable, fetched_at: io.now() });
    watch(manifest);
    return { manifest, fromCache: true };
  }

  const manifest = validateManifest(response.body);
  if (useCache) {
    const etag = response.headers.get("etag") ?? undefined;
    await save(io, path, { origin: api.origin, fetched_at: io.now(), etag, manifest });
  }
  watch(manifest);
  return { manifest, fromCache: false };
}

async function save(io: Io, path: string, doc: CachedManifest): Promise<void> {
  await ensureDir(configDir(io));
  await writeFileAtomic(path, JSON.stringify(doc), 0o600);
}

/** Removes each cached manifest of the origin. */
export async function dropManifestCaches(io: Io, origin: string): Promise<void> {
  let names: string[];
  try {
    names = await readdir(configDir(io));
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith("manifest-") || !name.endsWith(".json")) continue;
    const path = join(configDir(io), name);
    const doc = await readJsonFile<CachedManifest>(path);
    if (!doc || doc.origin === origin) await rm(path, { force: true });
  }
}
