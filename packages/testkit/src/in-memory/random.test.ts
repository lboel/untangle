import { describe, expect, it } from "vitest";

import { DeterministicRandom } from "./random.js";

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("DeterministicRandom", () => {
  it("produces the same sequence for the same seed", () => {
    const a = new DeterministicRandom(7);
    const b = new DeterministicRandom(7);
    const sequenceA = [a.nextFloat(), a.nextFloat(), a.nextFloat()];
    const sequenceB = [b.nextFloat(), b.nextFloat(), b.nextFloat()];
    expect(sequenceA).toEqual(sequenceB);
  });

  it("produces a different sequence for a different seed", () => {
    const a = new DeterministicRandom(1);
    const b = new DeterministicRandom(2);
    expect(a.nextFloat()).not.toBe(b.nextFloat());
  });

  it("nextFloat() stays within [0, 1)", () => {
    const random = new DeterministicRandom(123);
    for (let i = 0; i < 100; i += 1) {
      const value = random.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it("nextInt() stays within [0, maxExclusive)", () => {
    const random = new DeterministicRandom(99);
    for (let i = 0; i < 100; i += 1) {
      const value = random.nextInt(10);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(10);
    }
  });

  it("bytes() returns the requested length", () => {
    expect(new DeterministicRandom(1).bytes(16)).toHaveLength(16);
    expect(new DeterministicRandom(1).bytes(0)).toHaveLength(0);
  });

  it("uuid() produces a well-formed, deterministic RFC-4122 v4-shaped id", () => {
    const random = new DeterministicRandom(42);
    const id = random.uuid();
    expect(id).toMatch(UUID_V4_PATTERN);
    expect(new DeterministicRandom(42).uuid()).toBe(id);
  });

  it("uuid() calls advance the sequence (successive ids differ)", () => {
    const random = new DeterministicRandom(42);
    expect(random.uuid()).not.toBe(random.uuid());
  });
});
