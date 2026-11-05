/**
 * `@untangle-code/scanner/node-fs` — the Node.js-specific half of the
 * scanner: a `FileSystemPort` adapter and a genuinely streaming
 * `ContentHasher`. Kept out of the package's main entry point so that
 * entry point stays testable against any `FileSystemPort` (e.g. an
 * in-memory one) without pulling in `node:fs` (see README, "Entscheidungen").
 */
export { NodeFileSystem } from "./node-file-system.js";
export { createNodeStreamingHasher } from "./node-streaming-hasher.js";
