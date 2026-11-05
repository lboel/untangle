/**
 * Streaming SHA-256 content hasher for the Node adapter.
 *
 * `FileSystemPort.readFile` (domain) only exposes whole-buffer reads, so
 * the port-based default hasher (`createPortContentHasher`, in the pure
 * core) must materialize a file's bytes to hash them. This implementation
 * hashes straight off `fs.createReadStream` instead, without ever holding
 * the whole file in memory — the genuine "streaming hashing for large
 * files" the WP-05 order asks for (see README, "Entscheidungen").
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

import type { ContentHasher } from "../types.js";

/** `ContentHasher` that streams the file instead of buffering it whole. */
export function createNodeStreamingHasher(): ContentHasher {
  return {
    hashFile(absolutePath, _sizeBytes, options) {
      return new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(absolutePath, { signal: options?.signal });
        stream.on("data", (chunk: string | Buffer) => {
          hash.update(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
        });
        stream.on("error", (error) => {
          reject(error);
        });
        stream.on("end", () => {
          resolve(hash.digest("hex"));
        });
      });
    },
  };
}
