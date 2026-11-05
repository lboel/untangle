import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { hashBytes } from "../hashing.js";

import { createNodeStreamingHasher } from "./node-streaming-hasher.js";

describe("createNodeStreamingHasher", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "untangle-scanner-hasher-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("matches the plain in-memory SHA-256 of the same content", async () => {
    const filePath = path.join(dir, "a.txt");
    const content = "streamed content\n".repeat(100);
    await writeFile(filePath, content, "utf8");

    const hasher = createNodeStreamingHasher();
    const hash = await hasher.hashFile(filePath, content.length);
    expect(hash).toBe(hashBytes(new TextEncoder().encode(content)));
  });

  it("hashes a larger file without error (streamed in chunks)", async () => {
    const filePath = path.join(dir, "big.bin");
    const chunk = new Uint8Array(64 * 1024).fill(7);
    // ~2 MiB, large enough to cross multiple internal stream chunks.
    const parts = Array.from({ length: 32 }, () => chunk);
    const content = Buffer.concat(parts.map((p) => Buffer.from(p)));
    await writeFile(filePath, content);

    const hasher = createNodeStreamingHasher();
    const hash = await hasher.hashFile(filePath, content.byteLength);
    expect(hash).toBe(hashBytes(new Uint8Array(content)));
  });

  it("rejects when the file does not exist", async () => {
    const hasher = createNodeStreamingHasher();
    await expect(hasher.hashFile(path.join(dir, "missing.bin"), 0)).rejects.toThrow();
  });

  it("honors an already-aborted signal", async () => {
    const filePath = path.join(dir, "a.txt");
    await writeFile(filePath, "content", "utf8");
    const controller = new AbortController();
    controller.abort();

    const hasher = createNodeStreamingHasher();
    await expect(hasher.hashFile(filePath, 7, { signal: controller.signal })).rejects.toThrow();
  });
});
