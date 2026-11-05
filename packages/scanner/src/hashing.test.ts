import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { createPortContentHasher, hashBytes } from "./hashing.js";
import { MemoryFileSystem } from "./testing/memory-file-system.js";

describe("hashBytes", () => {
  it("matches a plain node:crypto SHA-256 digest", () => {
    const bytes = new TextEncoder().encode("hello world");
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(hashBytes(bytes)).toBe(expected);
  });

  it("is stable across repeated calls on identical bytes", () => {
    const bytes = new TextEncoder().encode("stable content");
    expect(hashBytes(bytes)).toBe(hashBytes(bytes.slice()));
  });

  it("differs for different content", () => {
    const a = new TextEncoder().encode("content A");
    const b = new TextEncoder().encode("content B");
    expect(hashBytes(a)).not.toBe(hashBytes(b));
  });

  it("hashes raw binary bytes (not just decodable UTF-8 text)", () => {
    const bytes = new Uint8Array([0, 1, 2, 0xff, 0xfe, 0x80]);
    const expected = createHash("sha256").update(bytes).digest("hex");
    expect(hashBytes(bytes)).toBe(expected);
  });
});

describe("createPortContentHasher", () => {
  it("hashes the file content read through the port", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/a.ts", "export const a = 1;\n");
    const hasher = createPortContentHasher(fs);

    const hash = await hasher.hashFile("/repo/a.ts", 21);
    expect(hash).toBe(hashBytes(new TextEncoder().encode("export const a = 1;\n")));
  });

  it("produces the same hash for identical content read twice (stability)", async () => {
    const fs = new MemoryFileSystem();
    fs.addFile("/repo/a.ts", "identical content");
    const hasher = createPortContentHasher(fs);

    const first = await hasher.hashFile("/repo/a.ts", 18);
    const second = await hasher.hashFile("/repo/a.ts", 18);
    expect(first).toBe(second);
  });
});
