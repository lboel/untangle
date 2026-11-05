import { describe, expect, it } from "vitest";

import { AsyncEventChannel } from "./events.js";

async function collect<T>(channel: AsyncEventChannel<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of channel) {
    events.push(event);
  }
  return events;
}

describe("AsyncEventChannel", () => {
  it("yields emitted events in order and ends after close", async () => {
    const channel = new AsyncEventChannel<string>();
    channel.emit("a");
    channel.emit("b");
    const consumer = collect(channel);
    channel.emit("c");
    channel.close();
    expect(await consumer).toEqual(["a", "b", "c"]);
  });

  it("supports a consumer that starts before any event exists", async () => {
    const channel = new AsyncEventChannel<number>();
    const consumer = collect(channel);
    await new Promise<void>((resolve) => setImmediate(resolve));
    channel.emit(1);
    channel.emit(2);
    channel.close();
    expect(await consumer).toEqual([1, 2]);
  });

  it("delivers buffered events before surfacing a failure", async () => {
    const channel = new AsyncEventChannel<string>();
    channel.emit("first");
    const boom = new Error("driver crashed");
    channel.fail(boom);
    const seen: string[] = [];
    let caught: unknown;
    try {
      for await (const event of channel) {
        seen.push(event);
      }
    } catch (error) {
      caught = error;
    }
    expect(seen).toEqual(["first"]);
    expect(caught).toBe(boom);
  });

  it("emit after close throws instead of silently dropping the event", () => {
    const channel = new AsyncEventChannel<string>();
    channel.close();
    expect(() => channel.emit("late")).toThrow(/close/u);
  });

  it("close is idempotent and a second fail does not override the first", async () => {
    const channel = new AsyncEventChannel<string>();
    const first = new Error("first");
    channel.fail(first);
    channel.fail(new Error("second"));
    channel.close();
    await expect(collect(channel)).rejects.toBe(first);
  });
});
