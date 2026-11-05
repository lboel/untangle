import { randomUUID } from "node:crypto";
import { open, rename, rm } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import { createGraphExplorerHtml } from "./html.js";
import type {
  GraphExplorerInputV1,
  GraphExplorerWriteOptions,
  GraphExplorerWriteResult,
} from "./types.js";

const DEFAULT_FILE_MODE = 0o600;

/** Writes the complete artifact to a sibling temporary file before renaming it. */
export async function writeGraphExplorerHtml(
  outputPath: string,
  input: GraphExplorerInputV1,
  options: GraphExplorerWriteOptions = {},
): Promise<GraphExplorerWriteResult> {
  if (typeof outputPath !== "string" || outputPath.trim() === "") {
    throw new TypeError("outputPath must be a non-empty string");
  }
  const mode = validateMode(options.mode ?? DEFAULT_FILE_MODE);
  const artifact = createGraphExplorerHtml(input, options);
  const targetPath = resolve(outputPath);
  const temporaryPath = resolve(
    dirname(targetPath),
    `.${basename(targetPath)}.tmp-${String(process.pid)}-${randomUUID()}`,
  );
  let temporaryExists = false;

  try {
    const handle = await open(temporaryPath, "wx", mode);
    temporaryExists = true;
    try {
      await handle.writeFile(artifact.html, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, targetPath);
    temporaryExists = false;
  } finally {
    if (temporaryExists) await rm(temporaryPath, { force: true });
  }

  return {
    path: targetPath,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    limits: artifact.limits,
    views: artifact.views,
  };
}

function validateMode(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0o777) {
    throw new RangeError("mode must be an integer between 0o000 and 0o777");
  }
  return value;
}
