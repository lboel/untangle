/**
 * Content-hash pipeline (spec.md §12.1): SHA-256 of the raw file bytes is
 * the sole source of truth for "unchanged" decisions; path/size/mtime are
 * fast hints only.
 *
 * `node:crypto` is used directly here — the "no direct node I/O in the
 * core" rule (WP-05 order) is about the *file system* (`node:fs`), so the
 * scanner reads bytes exclusively through `FileSystemPort`. Hashing pure
 * in-memory bytes with `node:crypto` is not I/O.
 */
import { createHash } from "node:crypto";

import type { FileSystemPort, PortCallOptions } from "@untangle-code/domain";

import type { ContentHasher } from "./types.js";

/** SHA-256 hex digest of raw bytes already held in memory. */
export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Default `ContentHasher`: reads the whole file through `FileSystemPort`
 * and hashes the resulting buffer. This is the only option available
 * against the abstract port (it exposes no range/stream read), so it is
 * what every non-Node adapter (in-memory test doubles included) gets by
 * default. Real streaming is available from `./node-fs` for the Node
 * adapter (see README, "Entscheidungen").
 */
export function createPortContentHasher(fs: FileSystemPort): ContentHasher {
  return {
    async hashFile(absolutePath: string, _sizeBytes: number, options?: PortCallOptions) {
      const bytes = await fs.readFile(absolutePath, options);
      return hashBytes(bytes);
    },
  };
}
