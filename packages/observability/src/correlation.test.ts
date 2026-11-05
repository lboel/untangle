import type { Clock, Random } from "@untangle-code/domain";
import { describe, expect, it } from "vitest";

import { createRequestContext } from "./correlation.js";

class FakeClock implements Clock {
  public constructor(private epochMs: number) {}
  public nowEpochMs(): number {
    return this.epochMs;
  }
  public nowIso(): string {
    return new Date(this.epochMs).toISOString();
  }
}

class FakeRandom implements Random {
  private index = 0;
  public constructor(private readonly uuids: string[]) {}
  public nextFloat(): number {
    return 0.5;
  }
  public nextInt(maxExclusive: number): number {
    return maxExclusive > 0 ? 0 : 0;
  }
  public bytes(length: number): Uint8Array {
    return new Uint8Array(length);
  }
  public uuid(): string {
    const value = this.uuids[this.index] ?? this.uuids[this.uuids.length - 1];
    this.index += 1;
    return value ?? "00000000-0000-0000-0000-000000000000";
  }
}

describe("createRequestContext", () => {
  it("derives ids only from the injected Clock/Random — deterministic given fakes", () => {
    const clock = new FakeClock(1_700_000_000_000);
    const random = new FakeRandom(["11111111-1111-1111-1111-111111111111"]);

    const context = createRequestContext({ clock, random });

    expect(context.requestId).toBe("11111111-1111-1111-1111-111111111111");
    expect(context.createdAtEpochMs).toBe(1_700_000_000_000);
    expect(context.createdAtIso).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("produces the exact same context for the exact same fakes, twice", () => {
    const makeContext = (): ReturnType<typeof createRequestContext> =>
      createRequestContext({
        clock: new FakeClock(42),
        random: new FakeRandom(["22222222-2222-2222-2222-222222222222"]),
      });

    expect(makeContext()).toEqual(makeContext());
  });

  it("produces different ids for different Random sequences at the same time", () => {
    const clock = new FakeClock(0);
    const first = createRequestContext({
      clock,
      random: new FakeRandom(["aaaaaaaa-0000-0000-0000-000000000000"]),
    });
    const second = createRequestContext({
      clock,
      random: new FakeRandom(["bbbbbbbb-0000-0000-0000-000000000000"]),
    });

    expect(first.requestId).not.toBe(second.requestId);
    expect(first.createdAtEpochMs).toBe(second.createdAtEpochMs);
  });
});
