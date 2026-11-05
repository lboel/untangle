/**
 * Content-hash pipeline (spec.md §12.1): SHA-256 of the raw file bytes is
 * the sole authority for the unchanged/changed verdict during reconciliation
 * (`reconcileTree` in `./reconciler.ts`).
 *
 * `node:crypto` is used directly here, not through `FileSystemPort` — this
 * mirrors `@untangle-code/scanner`'s `hashing.ts`: hashing bytes already
 * held in memory is not filesystem I/O, so it does not violate the
 * "core reads only through `FileSystemPort`" rule. Reimplemented locally
 * (not imported from `@untangle-code/scanner`) because this package's
 * assigned dependency set is domain-only plus observability/config as
 * needed — `scanner` is not on that list (see README "Entscheidungen").
 */
import { createHash } from "node:crypto";

import type { FileSystemPort, PortCallOptions } from "@untangle-code/domain";

import type { ContentHasher } from "./types.js";

/** SHA-256 hex digest of raw bytes already held in memory. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Default {@link ContentHasher}: reads the whole file through `FileSystemPort` and hashes it. */
export const defaultContentHasher: ContentHasher = async (
  fs: FileSystemPort,
  absolutePath: string,
  options?: PortCallOptions,
): Promise<string> => {
  const bytes = await fs.readFile(absolutePath, options);
  return hashBytes(bytes);
};
