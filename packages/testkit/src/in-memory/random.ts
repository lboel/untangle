/**
 * Deterministic `Random` (BUILD_PLAN global rule: no `Math.random()` in
 * domain/analysis logic). Uses the mulberry32 PRNG — pure 32-bit integer
 * arithmetic, so the same seed produces the same sequence on every process
 * and platform.
 */
import type { Random } from "@untangle-code/domain";

export class DeterministicRandom implements Random {
  private state: number;

  public constructor(seed = 42) {
    this.state = seed >>> 0;
  }

  private nextUint32(): number {
    this.state = (this.state + 0x6d2b79f5) | 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return (t ^ (t >>> 14)) >>> 0;
  }

  public nextFloat(): number {
    return this.nextUint32() / 0x100000000;
  }

  public nextInt(maxExclusive: number): number {
    return Math.floor(this.nextFloat() * maxExclusive);
  }

  public bytes(length: number): Uint8Array {
    const out = new Uint8Array(length);
    for (let i = 0; i < length; i += 1) {
      out[i] = this.nextUint32() & 0xff;
    }
    return out;
  }

  public uuid(): string {
    const bytes = Array.from(this.bytes(16));
    const variantByte = bytes[6] ?? 0;
    const clockSeqByte = bytes[8] ?? 0;
    bytes[6] = (variantByte & 0x0f) | 0x40;
    bytes[8] = (clockSeqByte & 0x3f) | 0x80;
    const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
  }
}
