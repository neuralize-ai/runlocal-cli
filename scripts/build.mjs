// SPDX-License-Identifier: Apache-2.0
// Bundles rlx into one file, dist/rlx.mjs, for `npx @runlocal-ai/cli`.
import { build } from "esbuild";
import { chmod, readFile } from "node:fs/promises";

const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const outfile = new URL("../dist/rlx.mjs", import.meta.url).pathname;

await build({
  entryPoints: [new URL("../src/bin.ts", import.meta.url).pathname],
  outfile,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  minify: false,
  legalComments: "inline",
  // The yaml package is CommonJS; its require of Node built-ins needs a real require.
  banner: {
    js: [
      "#!/usr/bin/env node",
      "// rlx. Copyright 2026 RunLocal. Licensed under the Apache License 2.0; see LICENSE and NOTICE.",
      'import { createRequire as __rlxCreateRequire } from "node:module";',
      "const require = __rlxCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { RLX_VERSION: JSON.stringify(pkg.version) },
  logLevel: "warning",
});
await chmod(outfile, 0o755);
console.log(`Built ${outfile}`);
