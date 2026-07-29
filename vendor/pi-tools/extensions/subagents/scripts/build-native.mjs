import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = resolve(packageRoot, "native/safe-writer.c");
const output = resolve(
  process.env.PI_SAFE_WRITER_BUILD_OUTPUT ??
    resolve(packageRoot, "native/bin/pi-safe-writer"),
);
const temporary = `${output}.tmp-${process.pid}`;
mkdirSync(dirname(output), { recursive: true });
rmSync(temporary, { force: true });

const result = spawnSync(
  process.env.CC || "cc",
  [
    "-std=c11",
    "-O2",
    "-Wall",
    "-Wextra",
    "-Werror",
    ...(process.env.PI_SAFE_WRITER_TESTING
      ? ["-DPI_SAFE_WRITER_TESTING=1"]
      : []),
    source,
    "-o",
    temporary,
  ],
  { stdio: "inherit" },
);
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
chmodSync(temporary, 0o755);
renameSync(temporary, output);
console.log(`built ${output}`);
