// SPDX-License-Identifier: Apache-2.0
import { main } from "./main.js";
import { mask } from "./util/mask.js";

const major = Number(process.versions.node.split(".")[0]);
if (major < 22) {
  process.stderr.write(`rlx needs Node.js 22 or later. This is Node.js ${process.versions.node}.\n`);
  process.exit(1);
}

process.on("SIGINT", () => {
  process.stderr.write("\nCancelled.\n");
  process.exit(4);
});

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    process.stderr.write(mask(`Unexpected error: ${(error as Error)?.message ?? String(error)}\n`));
    process.exitCode = 1;
  },
);
