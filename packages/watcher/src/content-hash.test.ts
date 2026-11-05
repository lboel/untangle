import { FakeClock, MemoryFileSystem } from "@untangle-code/testkit";
import { describe, expect, it } from "vitest";

import { defaultContentHasher, hashBytes } from "./content-hash.js";

describe("hashBytes", () => {
  it("is deterministic for identical bytes", () => {
    const a = hashBytes(new TextEncoder().encode("hello world"));
    const b = hashBytes(new TextEncoder().encode("hello world"));
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs for different bytes", () => {
    const a = hashBytes(new TextEncoder().encode("hello world"));
    const b = hashBytes(new TextEncoder().encode("hello world!"));
    expect(a).not.toBe(b);
  });
});

describe("defaultContentHasher", () => {
  it("hashes a file's current content through FileSystemPort", async () => {
    const clock = new FakeClock();
    const fs = new MemoryFileSystem(clock);
    fs.seedFile("/repo/a.ts", "export const a = 1;");

    const hash = await defaultContentHasher(fs, "/repo/a.ts");
    expect(hash).toBe(hashBytes(new TextEncoder().encode("export const a = 1;")));
  });
});
