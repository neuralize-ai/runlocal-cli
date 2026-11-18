#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Writes schema/cli-manifest-1.schema.json, the JSON Schema of the command
// manifest, from the validator (src/manifest/jsonSchema.ts builds it from the
// constants of src/manifest/schema.ts).
//
//   node scripts/manifest-schema.mjs           writes the file
//   node scripts/manifest-schema.mjs --check   fails when the file is stale

import { build } from "esbuild";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const target = join(root, "schema", "cli-manifest-1.schema.json");

/** Bundles the TypeScript builder into a temporary module, and runs it. */
async function buildSchema() {
  const dir = await mkdtemp(join(tmpdir(), "rlx-schema-"));
  const outfile = join(dir, "jsonSchema.mjs");
  try {
    await build({
      entryPoints: [join(root, "src", "manifest", "jsonSchema.ts")],
      outfile,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node22",
      define: { RLX_VERSION: '"0.0.0"' },
      logLevel: "warning",
    });
    const { buildJsonSchema } = await import(pathToFileURL(outfile).href);
    return `${JSON.stringify(buildJsonSchema(), null, 2)}\n`;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const text = await buildSchema();
if (process.argv.includes("--check")) {
  const committed = await readFile(target, "utf8").catch(() => "");
  if (committed !== text) {
    console.error(`FAIL ${target.slice(root.length)} is stale. Run: npm run schema`);
    process.exit(1);
  }
  console.log("ok   the JSON Schema of the manifest is up to date");
} else {
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, text);
  console.log(`Wrote ${target.slice(root.length)}`);
}
